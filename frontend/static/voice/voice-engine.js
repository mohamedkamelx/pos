/*
 * One dictation engine, two ways to turn Arabic speech into text.
 *
 * local  - Whisper through Transformers.js in a Web Worker. The model and the
 *          audio stay on this computer. The first use downloads the weights.
 * groq   - Groq's hosted whisper-large-v3-turbo. Audio leaves the till. In the
 *          desktop app the API key lives in main-process safeStorage and the
 *          renderer never holds it; in a browser preview the key is kept for
 *          this tab only.
 *
 * No UI lives here, which is what lets the POS and the Voice Lab page use the
 * same code. The UI above this file chooses a target field and shows the bar.
 */
(function (global) {
  'use strict';

  var MODELS = {
    base: 'onnx-community/whisper-base',
    small: 'onnx-community/whisper-small',
  };
  var GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
  var GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
  var MAX_SECONDS = 30;

  function codedError(code, message, extra) {
    var error = new Error(message || code);
    error.code = code || 'voice_error';
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) error[key] = extra[key];
      }
    }
    return error;
  }

  function asError(error) {
    if (error && error.code) return error;
    return codedError('voice_error', (error && error.message) || 'Voice input failed.');
  }

  function hasIpc() {
    return !!(global.electronAPI && global.electronAPI.voice &&
      typeof global.electronAPI.voice.transcribe === 'function');
  }

  function isSupported() {
    return !!(global.navigator && navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof global.MediaRecorder !== 'undefined');
  }

  function isLocalSupported() {
    return typeof global.Worker !== 'undefined' && typeof global.WebAssembly !== 'undefined';
  }

  function timeoutSignal(ms, existing) {
    if (existing) return existing;
    if (typeof AbortController === 'undefined') return undefined;
    var controller = new AbortController();
    setTimeout(function () { controller.abort(); }, ms);
    return controller.signal;
  }

  /* ---------------------------------------------------------------- audio --- */

  function downmix(buffer) {
    var channels = buffer.numberOfChannels || 1;
    var frames = buffer.length;
    var out = new Float32Array(frames);
    for (var channel = 0; channel < channels; channel += 1) {
      var data = buffer.getChannelData(channel);
      for (var i = 0; i < frames; i += 1) out[i] += data[i] / channels;
    }
    return out;
  }

  function trimSilence(samples, rate) {
    var threshold = 0.008;
    var first = 0;
    var last = samples.length - 1;
    while (first < last && Math.abs(samples[first]) < threshold) first += 1;
    while (last > first && Math.abs(samples[last]) < threshold) last -= 1;
    if (first >= last) return samples;
    var pad = Math.round(rate * 0.12);
    first = Math.max(0, first - pad);
    last = Math.min(samples.length - 1, last + pad);
    return samples.slice(first, last + 1);
  }

  function normalisePeak(samples) {
    var peak = 0;
    for (var i = 0; i < samples.length; i += 1) {
      var value = Math.abs(samples[i]);
      if (value > peak) peak = value;
    }
    if (peak <= 0.00001) return samples;
    var gain = Math.min(4, 0.95 / peak);
    for (var j = 0; j < samples.length; j += 1) samples[j] *= gain;
    return samples;
  }

  /**
   * Decode a recorder or file blob into the mono 16 kHz Float32Array Whisper
   * expects. Resampling happens through OfflineAudioContext so the renderer's
   * normal audio output is untouched.
   */
  async function decodeTo16k(blob) {
    var Ctx = global.AudioContext || global.webkitAudioContext;
    var Offline = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!Ctx || !Offline) throw codedError('audio_unsupported', 'Audio decoding is not available here.');

    var bytes = await blob.arrayBuffer();
    var context;
    try {
      context = new Ctx({ sampleRate: 16000 });
    } catch (error) {
      context = new Ctx();
    }

    var decoded;
    try {
      decoded = await context.decodeAudioData(bytes.slice(0));
    } catch (error) {
      try { await context.close(); } catch (e) { /* already gone */ }
      throw codedError('audio_decode_failed', 'That recording could not be read.');
    }

    var mono = downmix(decoded);
    if (context.close) {
      try { await context.close(); } catch (error) { /* not fatal */ }
    }

    var rate = decoded.sampleRate || 16000;
    if (rate !== 16000) {
      var length = Math.max(1, Math.ceil(decoded.duration * 16000));
      var offline = new Offline(1, length, 16000);
      var source = offline.createBufferSource();
      var buffer = offline.createBuffer(1, decoded.length, rate);
      buffer.copyToChannel(mono, 0);
      source.buffer = buffer;
      source.connect(offline.destination);
      source.start(0);
      var rendered = await offline.startRendering();
      mono = rendered.getChannelData(0).slice();
    }

    return normalisePeak(trimSilence(mono, 16000));
  }

  /* ------------------------------------------------------------- recorder --- */

  function pickMime() {
    if (typeof global.MediaRecorder === 'undefined' ||
        typeof global.MediaRecorder.isTypeSupported !== 'function') return '';
    var candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      if (global.MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  /**
   * Start a microphone recording. The callbacks are the interface:
   *   onState('requesting'|'recording'|'stopping'|'cancelled'|'error')
   *   onTick(seconds)
   *   onComplete({ blob, mimeType, duration })
   *   onError(error)
   *
   * stop() finishes and calls onComplete. cancel() discards. maxSeconds caps a
   * single clip; dictation is meant to be a sentence or two, not a meeting.
   */
  function createRecorder(options) {
    options = options || {};
    var maxSeconds = options.maxSeconds || MAX_SECONDS;
    var onState = options.onState || function () {};
    var onTick = options.onTick || function () {};
    var onComplete = options.onComplete || function () {};
    var onError = options.onError || function () {};

    var stream = null;
    var recorder = null;
    var chunks = [];
    var timer = null;
    var startedAt = 0;
    var state = 'idle';
    var cancelled = false;
    var stopResolve = null;

    function setState(next) {
      state = next;
      onState(next);
    }

    function release() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (stream) {
        stream.getTracks().forEach(function (track) {
          try { track.stop(); } catch (error) { /* already stopped */ }
        });
        stream = null;
      }
    }

    function finish() {
      if (state === 'cancelled' || state === 'error') {
        if (stopResolve) stopResolve(null);
        return;
      }
      var duration = Math.min(maxSeconds, (Date.now() - startedAt) / 1000);
      var blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
      release();
      if (cancelled) {
        setState('cancelled');
        if (stopResolve) stopResolve(null);
        return;
      }
      setState('stopped');
      if (stopResolve) stopResolve(blob);
      if (blob.size > 0) {
        onComplete({ blob: blob, mimeType: blob.type, duration: duration });
      } else {
        onError(codedError('empty_recording', 'No audio was captured.'));
      }
    }

    function stop() {
      if (state !== 'requesting' && state !== 'recording') {
        return stopResolve ? Promise.resolve(null) : Promise.resolve(null);
      }
      if (state === 'requesting' && !recorder) {
        cancelled = true;
        release();
        setState('cancelled');
        return Promise.resolve(null);
      }
      setState('stopping');
      return new Promise(function (resolve) {
        stopResolve = resolve;
        try {
          if (recorder && recorder.state !== 'inactive') recorder.stop();
          else finish();
        } catch (error) {
          release();
          setState('error');
          onError(codedError('recorder_failed', error.message));
          resolve(null);
        }
      });
    }

    function cancel() {
      cancelled = true;
      if (state === 'idle' || state === 'stopped' || state === 'cancelled' || state === 'error') {
        release();
        return;
      }
      if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch (error) { /* stop already happened */ }
      } else {
        release();
        setState('cancelled');
      }
    }

    async function start() {
      if (!isSupported()) throw codedError('unsupported', 'Voice recording is not available in this browser.');
      cancelled = false;
      chunks = [];
      setState('requesting');
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
      } catch (error) {
        setState('error');
        var denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
        var busy = error && error.name === 'NotReadableError';
        throw codedError(
          denied ? 'mic_denied' : busy ? 'mic_busy' : 'mic_unavailable',
          error && error.message ? error.message : 'Microphone access failed.'
        );
      }

      if (cancelled) {
        release();
        setState('cancelled');
        return;
      }

      var mimeType = pickMime();
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
      } catch (error) {
        release();
        setState('error');
        throw codedError('recorder_failed', error.message);
      }

      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = function (event) {
        release();
        setState('error');
        onError(codedError('recorder_failed', (event.error && event.error.message) || 'Recording stopped unexpectedly.'));
      };
      recorder.onstop = finish;

      startedAt = Date.now();
      recorder.start(250);
      setState('recording');
      onTick(0);
      timer = setInterval(function () {
        var seconds = (Date.now() - startedAt) / 1000;
        onTick(seconds);
        if (seconds >= maxSeconds) stop();
      }, 200);
      return recorder;
    }

    return {
      start: start,
      stop: stop,
      cancel: cancel,
      get state() { return state; },
      get seconds() { return startedAt ? (Date.now() - startedAt) / 1000 : 0; },
    };
  }

  /* ---------------------------------------------------------- local Whisper --- */

  var local = {
    worker: null,
    pending: new Map(),
    sequence: 0,
    busy: false,
    loading: null,
  };

  function workerUrl() {
    /* The dashboard is served from /public/, while the Voice Lab can be served
       from a static root. A page may set this to the worker it was shipped
       with; otherwise the dashboard's relative layout is used. */
    if (global.POSNIC_VOICE_WORKER_URL) return global.POSNIC_VOICE_WORKER_URL;
    return new URL('static/voice/voice-worker.js', global.document.baseURI).href;
  }

  function resetLocal(error) {
    if (local.worker) {
      try { local.worker.terminate(); } catch (e) { /* already gone */ }
      local.worker = null;
    }
    local.pending.forEach(function (entry) {
      entry.reject(error || codedError('cancelled', 'Dictation cancelled.'));
    });
    local.pending.clear();
    local.busy = false;
  }

  function ensureWorker() {
    if (local.worker) return local.worker;
    if (!isLocalSupported()) throw codedError('unsupported', 'The local engine is not available here.');
    local.worker = new Worker(workerUrl(), { type: 'module' });
    local.worker.onmessage = function (event) {
      var message = event.data || {};
      var entry = local.pending.get(message.id);
      if (!entry) return;

      if (message.type === 'status') {
        if (entry.onProgress) entry.onProgress(message);
        if (entry.kind === 'load' && message.status === 'ready') {
          local.pending.delete(message.id);
          local.busy = false;
          entry.resolve({ model: message.model });
        }
        return;
      }

      local.pending.delete(message.id);
      local.busy = false;
      if (message.type === 'result') {
        entry.resolve({ text: String(message.text || '').trim(), provider: 'local' });
      } else if (message.type === 'error') {
        var detail = message.error || {};
        entry.reject(codedError(detail.name || 'local_error', detail.message || 'The local engine failed.'));
      }
    };
    local.worker.onerror = function (event) {
      resetLocal(codedError('worker_error', (event && event.message) || 'The local engine could not start.'));
    };
    return local.worker;
  }

  function localRequest(kind, payload, onProgress) {
    if (local.busy) {
      return Promise.reject(codedError('busy', 'The local engine is already working.'));
    }
    var worker;
    try {
      worker = ensureWorker();
    } catch (error) {
      return Promise.reject(asError(error));
    }
    local.busy = true;
    var id = ++local.sequence;
    return new Promise(function (resolve, reject) {
      local.pending.set(id, { kind: kind, resolve: resolve, reject: reject, onProgress: onProgress });
      try {
        worker.postMessage(Object.assign({ type: kind, id: id }, payload),
          payload && payload.audio ? [payload.audio.buffer] : []);
      } catch (error) {
        local.pending.delete(id);
        local.busy = false;
        reject(codedError('worker_error', error.message));
      }
    });
  }

  function loadLocalModel(model, onProgress) {
    if (local.loading) return local.loading;
    local.loading = localRequest('load', { model: model || 'small' }, onProgress)
      .finally(function () { local.loading = null; });
    return local.loading;
  }

  async function transcribeLocal(blob, options) {
    options = options || {};
    var audio = await decodeTo16k(blob);

    /* A recording may finish while the first model download is still going.
       Wait for it rather than refusing a dictation the user already spoke. */
    if (local.loading) {
      try { await local.loading; } catch (error) { throw asError(error); }
    }

    return localRequest('transcribe', {
      audio: audio,
      model: options.model || 'small',
      language: 'ar',
    }, options.onProgress);
  }

  function cancelLocal() {
    local.loading = null;
    resetLocal(codedError('cancelled', 'Dictation cancelled.'));
  }

  /* ------------------------------------------------------------------ Groq --- */

  function extensionFor(mimeType) {
    var type = String(mimeType || '').split(';')[0].toLowerCase();
    if (type === 'audio/mp4' || type === 'audio/m4a' || type === 'audio/x-m4a') return 'm4a';
    if (type === 'audio/ogg') return 'ogg';
    if (type === 'audio/wav' || type === 'audio/x-wav') return 'wav';
    if (type === 'audio/mpeg' || type === 'audio/mp3') return 'mp3';
    if (type === 'audio/flac' || type === 'audio/x-flac') return 'flac';
    return 'webm';
  }

  async function groqFailure(response) {
    var detail = null;
    try { detail = await response.json(); } catch (error) { /* not JSON */ }
    var message = (detail && detail.error && (detail.error.message || detail.error.code)) ||
      ('Groq returned ' + response.status + '.');
    var code = response.status === 401 ? 'key_invalid'
      : response.status === 413 ? 'too_large'
        : response.status === 429 ? 'rate_limited'
          : 'groq_error';
    var error = codedError(code, message, { status: response.status });
    var retry = response.headers.get('retry-after');
    if (retry) error.retryAfter = retry;
    throw error;
  }

  async function transcribeGroq(blob, options) {
    options = options || {};
    if (hasIpc()) {
      var bytes = new Uint8Array(await blob.arrayBuffer());
      var result = await global.electronAPI.voice.transcribe({
        audio: bytes,
        mimeType: blob.type || 'audio/webm',
        language: options.language || 'ar',
      });
      if (!result || result.success === false) {
        throw codedError((result && result.code) || 'groq_error',
          (result && result.error) || 'Groq transcription failed.',
          { status: result && result.status });
      }
      return { text: String(result.text || '').trim(), provider: 'groq' };
    }

    var key = String(options.apiKey || '').trim();
    if (!key) throw codedError('key_missing', 'Add your Groq API key in Settings > Voice.');

    var form = new FormData();
    form.append('file', blob, 'dictation.' + extensionFor(blob.type));
    form.append('model', options.model || 'whisper-large-v3-turbo');
    form.append('language', options.language || 'ar');
    form.append('response_format', 'json');
    form.append('temperature', '0');

    var response;
    try {
      response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key },
        body: form,
        signal: timeoutSignal(90000, options.signal),
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw codedError('cancelled', 'Transcription cancelled.');
      throw codedError('network_error', 'Could not reach Groq. Check the internet connection.');
    }
    if (!response.ok) await groqFailure(response);
    var data = await response.json();
    var text = String((data && data.text) || '').trim();
    if (!text) throw codedError('empty_transcript', 'No speech was recognised.');
    return { text: text, provider: 'groq' };
  }

  async function validateGroqKey(key) {
    key = String(key || '').trim();
    if (!key) throw codedError('key_missing', 'Enter a Groq API key.');
    var response;
    try {
      response = await fetch(GROQ_MODELS_URL, {
        headers: { Authorization: 'Bearer ' + key },
        signal: timeoutSignal(20000),
      });
    } catch (error) {
      throw codedError('network_error', 'Could not reach Groq. Check the internet connection.');
    }
    if (response.status === 401) throw codedError('key_invalid', 'Groq did not accept that key.');
    if (!response.ok) throw codedError('groq_error', 'Groq returned ' + response.status + '.');
    return true;
  }

  global.PosnicVoice = {
    models: MODELS,
    maxSeconds: MAX_SECONDS,
    isSupported: isSupported,
    isLocalSupported: isLocalSupported,
    hasIpc: hasIpc,
    decodeTo16k: decodeTo16k,
    createRecorder: createRecorder,
    local: {
      load: loadLocalModel,
      transcribe: transcribeLocal,
      cancel: cancelLocal,
      get busy() { return local.busy; },
    },
    groq: {
      transcribe: transcribeGroq,
      validateKey: validateGroqKey,
    },
    error: codedError,
  };
})(window);
