/*
 * Voice dictation: the UI half.
 *
 * The engine above this file (PosnicPro's static/voice/voice-engine.js) does
 * the recording and the two providers. This file decides where the transcript
 * goes: the field that was focused, the universal-search input, or the test
 * box in Settings.
 *
 * The feature is off by default. Turning it on is the only thing that lets the
 * desktop permission handler grant the microphone, and it is device-local:
 * a shop's API key and model cache belong to the till, not to the cloud.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'voice_input_settings';
  var SESSION_KEY = 'posnic_voice_groq_key';
  var DEFAULTS = { enabled: false, provider: 'local', localModel: 'small' };
  var settings = Object.assign({}, DEFAULTS);
  var active = null;
  var lastField = null;
  var settingsBound = false;

  function t(key, fallback) {
    try {
      return PosnicPro.i18n.t(key, fallback);
    } catch (error) {
      return fallback;
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function loadSettings() {
    var raw = null;
    try {
      raw = PosnicPro.local.get(STORAGE_KEY);
    } catch (error) {
      raw = null;
    }
    var parsed = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch (error) { parsed = {}; }
    var merged = Object.assign({}, DEFAULTS, parsed && typeof parsed === 'object' ? parsed : {});
    if (merged.provider !== 'groq') merged.provider = 'local';
    if (merged.localModel !== 'base') merged.localModel = 'small';
    merged.enabled = merged.enabled === true;
    return merged;
  }

  function saveSettings(patch) {
    settings = Object.assign({}, settings, patch || {});
    try {
      PosnicPro.local.set(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      /* A locked-down browser can refuse storage; the session still works. */
    }
    return syncMainPermission();
  }

  function syncMainPermission() {
    try {
      if (window.electronAPI && window.electronAPI.voice && window.electronAPI.voice.setEnabled) {
        return window.electronAPI.voice.setEnabled(!!settings.enabled);
      }
    } catch (error) {
      /* The browser preview has no bridge; nothing to sync. */
    }
    return Promise.resolve();
  }

  function sessionKey() {
    try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch (error) { return ''; }
  }

  function setSessionKey(key) {
    try {
      if (key) sessionStorage.setItem(SESSION_KEY, key);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (error) {
      /* Session storage can be disabled; the key then lasts only this call. */
    }
  }

  function hasIpc() {
    return !!(window.PosnicVoice && PosnicVoice.hasIpc());
  }

  function isEligible(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.disabled || element.readOnly) return false;
    /* v1 leaves numbers, phone numbers and email addresses alone. The type
       attribute is not enough: several legacy forms use type=text with a
       numeric inputmode, and a phone keyboard is still a phone field. */
    var inputMode = String(element.getAttribute('inputmode') || '').toLowerCase();
    var autocomplete = String(element.getAttribute('autocomplete') || '').toLowerCase();
    if (inputMode === 'numeric' || inputMode === 'decimal' ||
        inputMode === 'tel' || inputMode === 'email') return false;
    if (autocomplete === 'tel' || autocomplete === 'email' || autocomplete === 'cc-number') return false;
    if (element.isContentEditable) return true;
    if (element.tagName === 'TEXTAREA') return true;
    if (element.tagName !== 'INPUT') return false;
    var type = String(element.getAttribute('type') || 'text').toLowerCase();
    return type === 'text' || type === 'search' || type === 'url';
  }

  function isVisible(element) {
    return !!(element && element.isConnected && element.getClientRects().length > 0);
  }

  /* A field the operator is standing in, even when v1 deliberately refuses it
     (numbers, phone, email, password, dates). Falling back to the last text
     field in that case would put a dictated phone number into a customer's
     name box, so the distinction matters. */
  function isFieldLike(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.isContentEditable) return true;
    return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' ||
      element.tagName === 'SELECT';
  }

  function currentField() {
    var focused = document.activeElement;
    if (isEligible(focused) && isVisible(focused)) return focused;
    if (isFieldLike(focused)) return null;
    if (isEligible(lastField) && isVisible(lastField)) return lastField;
    return null;
  }

  function insertText(target, text) {
    text = String(text || '').trim();
    if (!text) return false;
    /* The form may have closed, or the field may have become read-only, while
       the clip was being transcribed. Copy the text rather than writing into
       a field the operator cannot see. */
    if (!target || !target.isConnected || !isEligible(target) || !isVisible(target)) return false;

    try { target.focus({ preventScroll: false }); } catch (error) { target.focus(); }

    if (target.isContentEditable) {
      var selection = window.getSelection();
      if (selection && selection.rangeCount && target.contains(selection.anchorNode)) {
        var range = selection.getRangeAt(0);
        range.deleteContents();
        var node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        target.textContent += text;
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    var start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length;
    var end = typeof target.selectionEnd === 'number' ? target.selectionEnd : start;
    var before = target.value.slice(0, start);
    var needsSpace = start === end && !!before && !/\s$/.test(before) && !/^[\s.,!?؟،؛:]/.test(text);
    var insertion = needsSpace ? ' ' + text : text;

    if (typeof target.setRangeText === 'function') {
      target.setRangeText(insertion, start, end, 'end');
    } else {
      target.value = target.value.slice(0, start) + insertion + target.value.slice(end);
      try { target.selectionStart = target.selectionEnd = start + insertion.length; } catch (error) { /* no selection API */ }
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function copyText(text) {
    var done = function () {
      toast('success', t('lang_voice_copied', 'Transcript copied to the clipboard.'));
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', 'readonly');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    box.style.pointerEvents = 'none';
    document.body.appendChild(box);
    box.select();
    try {
      if (document.execCommand('copy')) done();
      else toast('warning', t('lang_voice_copy_failed', 'The transcript could not be copied.'));
    } catch (error) {
      toast('warning', t('lang_voice_copy_failed', 'The transcript could not be copied.'));
    }
    box.remove();
  }

  function toast(kind, message) {
    if (!message) return;
    try {
      if (PosnicPro.alert) {
        PosnicPro.alert(kind === 'warning' ? 'warning' : kind, message);
        return;
      }
    } catch (error) { /* fall through */ }
    if (window.console && console.warn) console.warn('[voice]', message);
  }

  function errorText(error) {
    var code = (error && error.code) || 'voice_error';
    var messages = {
      unsupported: t('lang_voice_not_available', 'Voice input is not available here.'),
      disabled: t('lang_voice_disabled', 'Turn on voice input in Settings > Voice first.'),
      mic_denied: t('lang_voice_mic_denied', 'Microphone access was not allowed.'),
      mic_busy: t('lang_voice_mic_busy', 'The microphone is being used by another application.'),
      mic_unavailable: t('lang_voice_mic_unavailable', 'No microphone was found.'),
      key_missing: t('lang_voice_key_missing', 'Add your Groq API key in Settings > Voice.'),
      key_invalid: t('lang_voice_groq_invalid', 'Groq did not accept that key.'),
      key_save_failed: t('lang_voice_key_save_failed', 'The key could not be saved on this computer.'),
      rate_limited: t('lang_voice_rate_limited', 'The Groq free limit was reached. Wait a minute and try again.'),
      network_error: t('lang_voice_network', 'Could not reach Groq. Check the internet connection.'),
      empty_transcript: t('lang_voice_empty', 'No speech was recognised. Try again a little closer to the microphone.'),
      empty_recording: t('lang_voice_empty', 'No speech was recognised. Try again a little closer to the microphone.'),
      audio_decode_failed: t('lang_voice_audio_failed', 'That recording could not be read. Try again.'),
      audio_unsupported: t('lang_voice_audio_failed', 'That recording could not be read. Try again.'),
      too_large: t('lang_voice_too_large', 'That recording is too large. Keep it under 30 seconds.'),
      busy: t('lang_voice_busy', 'The local model is still preparing. Try again in a moment.'),
      worker_error: t('lang_voice_local_failed', 'The local model could not run. Try downloading it again, or use Groq.'),
      local_error: t('lang_voice_local_failed', 'The local model could not run. Try downloading it again, or use Groq.'),
      recorder_failed: t('lang_voice_recorder_failed', 'The recording stopped unexpectedly. Try again.'),
      cancelled: t('lang_voice_cancelled', 'Dictation cancelled.'),
    };
    if (messages[code]) return messages[code];
    return (error && error.message) || t('lang_voice_failed', 'Voice input failed. Try again.');
  }

  function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest;
  }

  function setPaletteButton(listening) {
    var button = byId('cmdk-voice');
    if (!button) return;
    var label = listening
      ? t('lang_voice_stop_mic', 'Stop dictation')
      : t('lang_voice_mic', 'Dictate');
    button.classList.toggle('is-listening', !!listening);
    button.setAttribute('aria-pressed', listening ? 'true' : 'false');
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.setAttribute('data-t-aria-label', listening ? 'lang_voice_stop_mic' : 'lang_voice_mic');
    button.setAttribute('data-t-title', listening ? 'lang_voice_stop_mic' : 'lang_voice_mic');
  }

  function makeBar(host, inline) {
    var el = document.createElement('div');
    el.className = 'posnic-voice-bar' + (inline ? ' posnic-voice-bar--inline' : '');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', t('lang_voice_input', 'Voice input'));
    el.innerHTML =
      '<span class="posnic-voice-pulse" aria-hidden="true"></span>' +
      '<span class="posnic-voice-text"></span>' +
      '<span class="posnic-voice-time"></span>' +
      '<button type="button" class="posnic-voice-stop">' +
      '<i class="feather icon-square" aria-hidden="true"></i></button>' +
      '<button type="button" class="posnic-voice-cancel">' +
      '<i class="feather icon-x" aria-hidden="true"></i></button>';

    var text = el.querySelector('.posnic-voice-text');
    var time = el.querySelector('.posnic-voice-time');
    var stop = el.querySelector('.posnic-voice-stop');
    var cancel = el.querySelector('.posnic-voice-cancel');
    text.setAttribute('aria-live', 'polite');
    stop.setAttribute('aria-label', t('lang_voice_stop', 'Stop and transcribe'));
    stop.setAttribute('title', t('lang_voice_stop', 'Stop and transcribe'));
    stop.setAttribute('data-t-aria-label', 'lang_voice_stop');
    stop.setAttribute('data-t-title', 'lang_voice_stop');
    cancel.setAttribute('aria-label', t('lang_voice_cancel', 'Cancel'));
    cancel.setAttribute('title', t('lang_voice_cancel', 'Cancel'));
    cancel.setAttribute('data-t-aria-label', 'lang_voice_cancel');
    cancel.setAttribute('data-t-title', 'lang_voice_cancel');

    function mount() {
      if (!host) {
        document.body.appendChild(el);
        return;
      }
      if (host.id === 'cmdk-box') {
        var field = host.querySelector('.cmdk-field');
        if (field && field.nextSibling) host.insertBefore(el, field.nextSibling);
        else host.appendChild(el);
        return;
      }
      if (host.id === 'voice_test_bar') {
        host.replaceChildren(el);
        return;
      }
      host.appendChild(el);
    }

    mount();
    return {
      el: el,
      stop: stop,
      cancel: cancel,
      setLabel: function (value) { text.textContent = value || ''; },
      setTime: function (value) { time.textContent = value || ''; },
      setState: function (state) {
        el.classList.toggle('is-busy', state === 'transcribing' || state === 'stopping');
        el.classList.toggle('is-error', state === 'error');
        /* While the microphone prompt is open there is nothing to stop, but
           Cancel still dismisses the request. */
        stop.disabled = state !== 'recording';
      },
      remove: function () { if (el.parentNode) el.parentNode.removeChild(el); },
    };
  }

  function paletteHost(input) {
    return input && input.closest ? input.closest('#cmdk-box') : null;
  }

  function ensureGroqReady() {
    /* In the desktop app the main process is the only owner of the key. Ask it
       first; a stale tab-scoped key left in session storage must not make the
       renderer believe a key exists when main has none. */
    if (hasIpc() && window.electronAPI.voice.keyStatus) {
      return window.electronAPI.voice.keyStatus().then(function (status) {
        if (status && status.configured) return '';
        throw window.PosnicVoice.error('key_missing', 'Add your Groq API key in Settings > Voice.');
      }, function () {
        throw window.PosnicVoice.error('key_missing', 'Add your Groq API key in Settings > Voice.');
      });
    }
    var key = sessionKey();
    if (key) return Promise.resolve(key);
    return Promise.reject(window.PosnicVoice.error('key_missing', 'Add your Groq API key in Settings > Voice.'));
  }

  async function start(options) {
    options = options || {};
    if (!window.PosnicVoice) return null;
    if (active) cancelActive();

    if (!settings.enabled) {
      toast('warning', errorText({ code: 'disabled' }));
      throw window.PosnicVoice.error('disabled', 'Voice input is off.');
    }
    if (!window.PosnicVoice.isSupported()) {
      toast('error', errorText({ code: 'unsupported' }));
      throw window.PosnicVoice.error('unsupported', 'Voice input is not available.');
    }
    if (settings.provider === 'local' && !window.PosnicVoice.isLocalSupported()) {
      toast('error', errorText({ code: 'unsupported' }));
      throw window.PosnicVoice.error('unsupported', 'The local engine is not available.');
    }

    var target = options.target || currentField();
    if (target && target.jquery) target = target[0];
    var host = options.host || paletteHost(target);
    if (host && host.jquery) host = host[0];
    if (!host && target && target.closest) {
      var dialog = target.closest('dialog[open]');
      if (dialog) host = dialog;
    }
    var inline = !!host;

    var bar = makeBar(host, !!inline);
    var a = {
      target: target,
      onText: options.onText || null,
      onState: options.onState || null,
      onError: options.onError || null,
      source: options.source || 'field',
      palette: !!options.palette,
      provider: settings.provider,
      recorder: null,
      abort: null,
      apiKey: '',
      phase: 'requesting',
      cancelled: false,
      bar: bar,
      finishTimer: null,
    };
    active = a;
    setPaletteButton(a.palette);
    bar.setState('requesting');
    bar.setLabel(t('lang_voice_mic_wait', 'Waiting for the microphone...'));
    bar.setTime('0:00 / ' + formatTime(window.PosnicVoice.maxSeconds));
    bar.stop.onclick = function () { stopActive(); };
    bar.cancel.onclick = function () { cancelActive(); };
    if (a.onState) a.onState('requesting');

    try {
      if (a.provider === 'groq') a.apiKey = await ensureGroqReady();
      if (active !== a) return null;

      var recorder = window.PosnicVoice.createRecorder({
        maxSeconds: window.PosnicVoice.maxSeconds,
        onState: function (state) {
          if (active !== a || a.cancelled) return;
          a.phase = state;
          bar.setState(state);
          if (state === 'recording') {
            bar.setLabel(t('lang_voice_listening', 'Listening...'));
          } else if (state === 'stopping') {
            bar.setLabel(t('lang_voice_finishing', 'Finishing...'));
          }
          if (a.onState) a.onState(state);
        },
        onTick: function (seconds) {
          if (active === a) bar.setTime(formatTime(seconds) + ' / ' + formatTime(window.PosnicVoice.maxSeconds));
        },
        onComplete: function (payload) {
          if (active === a) transcribeActive(a, payload);
        },
        onError: function (error) {
          if (active === a && !a.cancelled) handleError(a, error);
        },
      });
      a.recorder = recorder;
      await recorder.start();
      return a;
    } catch (error) {
      if (active === a) handleError(a, error);
      throw error;
    }
  }

  function transcribeActive(a, payload) {
    if (active !== a) return;
    a.phase = 'transcribing';
    a.bar.setState('transcribing');
    a.bar.setLabel(t('lang_voice_transcribing', 'Transcribing...'));
    if (a.onState) a.onState('transcribing');

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    a.abort = controller;

    var progress = function (message) {
      if (active !== a) return;
      if (!message) return;
      if (message.status === 'progress' && message.progress != null) {
        var percent = Math.max(0, Math.min(100, Math.round(message.progress)));
        a.bar.setLabel(t('lang_voice_downloading', 'Downloading model {percent}%').replace('{percent}', percent));
      } else if (message.status === 'loading') {
        a.bar.setLabel(t('lang_voice_model_loading', 'Loading model...'));
      } else if (message.status === 'ready' || message.status === 'transcribing') {
        a.bar.setLabel(t('lang_voice_transcribing', 'Transcribing...'));
      }
    };

    var promise;
    if (a.provider === 'local') {
      promise = window.PosnicVoice.local.transcribe(payload.blob, {
        model: settings.localModel,
        onProgress: progress,
      });
    } else {
      promise = window.PosnicVoice.groq.transcribe(payload.blob, {
        apiKey: a.apiKey || undefined,
        language: 'ar',
        signal: controller ? controller.signal : undefined,
      });
    }

    promise.then(function (result) {
      if (active !== a) return;
      var text = String((result && result.text) || '').trim();
      if (!text) throw window.PosnicVoice.error('empty_transcript', 'No speech was recognised.');
      var inserted = false;
      if (a.onText) {
        a.onText(text);
        inserted = true;
      } else {
        inserted = insertText(a.target, text);
      }
      if (!inserted) copyText(text);
      a.phase = 'done';
      a.bar.setState('done');
      a.bar.setLabel(t('lang_voice_done', 'Done'));
      a.bar.setTime('');
      if (a.onState) a.onState('done');
      a.finishTimer = setTimeout(function () {
        if (active === a) finishActive(a, 'done');
      }, 700);
    }).catch(function (error) {
      if (active !== a) return;
      if (error && error.code === 'cancelled') {
        finishActive(a, 'cancelled');
        return;
      }
      handleError(a, error);
    });
  }

  function handleError(a, error) {
    if (!a || active !== a) return;
    var message = errorText(error);
    a.phase = 'error';
    a.bar.setState('error');
    a.bar.setLabel(message);
    a.bar.setTime('');
    toast('error', message);
    if (a.onError) a.onError(error);
    if (a.onState) a.onState('error');
    a.finishTimer = setTimeout(function () {
      if (active === a) finishActive(a, 'error', false);
    }, 4500);
  }

  function finishActive(a, reason, notify) {
    if (!a) return;
    if (active === a) active = null;
    if (reason === 'cancelled') a.cancelled = true;
    if (a.finishTimer) clearTimeout(a.finishTimer);
    if (a.bar) a.bar.remove();
    setPaletteButton(false);
    if (notify !== false && a.onState) a.onState(reason || 'cancelled');
  }

  function stopActive() {
    if (!active) return;
    var a = active;
    if (a.phase === 'transcribing' || a.phase === 'stopping' || a.phase === 'done') return;
    if (a.phase === 'requesting') {
      if (a.recorder) a.recorder.cancel();
      finishActive(a, 'cancelled');
      return;
    }
    if (a.recorder) a.recorder.stop();
  }

  function cancelActive() {
    if (!active) return;
    var a = active;
    a.cancelled = true;
    if (a.recorder) a.recorder.cancel();
    if (a.abort) {
      try { a.abort.abort(); } catch (error) { /* already complete */ }
    }
    if (a.phase === 'transcribing' && a.provider === 'local' && window.PosnicVoice) {
      window.PosnicVoice.local.cancel();
    }
    finishActive(a, 'cancelled');
  }

  function togglePalette(input) {
    if (active && active.palette) {
      if (active.phase === 'recording' || active.phase === 'requesting') stopActive();
      else cancelActive();
      return;
    }
    if (active) cancelActive();
    start({
      target: input,
      host: paletteHost(input),
      palette: true,
      source: 'palette',
    }).catch(function () { /* handleError already spoke */ });
  }

  /* --------------------------------------------------------------- Settings --- */

  function panel(id) { return byId(id); }

  function applyProviderPanels() {
    var localPanel = panel('voice_local_panel');
    var groqPanel = panel('voice_groq_panel');
    var modelGroup = panel('voice_model_group');
    var hint = panel('voice_engine_hint');
    if (!localPanel || !groqPanel) return;
    localPanel.hidden = settings.provider !== 'local';
    groqPanel.hidden = settings.provider !== 'groq';
    if (modelGroup) modelGroup.hidden = settings.provider !== 'local';
    if (hint) {
      hint.textContent = settings.provider === 'local'
        ? t('lang_voice_engine_local_hint', 'Runs on this computer. No account, and offline after the model downloads.')
        : t('lang_voice_engine_groq_hint', 'Free Groq account. Audio is sent to Groq, and accuracy is higher.');
    }
  }

  function modelSizeText() {
    return settings.localModel === 'base'
      ? t('lang_voice_download_size_base', 'About 75 MB once, then cached')
      : t('lang_voice_download_size', 'About 240 MB once, then cached');
  }

  function refreshModelSize() {
    var status = panel('voice_local_status');
    if (status) status.textContent = modelSizeText();
  }

  function setGroqStatus(message, isError) {
    var el = panel('voice_groq_status');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('text-danger', !!isError);
  }

  function setTestStatus(message, isError) {
    var el = panel('voice_test_status');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('text-danger', !!isError);
  }

  function refreshPlatformHint() {
    var el = panel('voice_platform_hint');
    if (!el) return;
    el.textContent = hasIpc()
      ? t('lang_voice_platform_desktop', 'Desktop app: the key is kept by the app and never synced. It uses this computer\'s secure keystore when one is available.')
      : t('lang_voice_platform_browser', 'Browser preview: the key stays in this tab\'s session storage. The desktop app keeps it in the app or the system keystore.');
  }

  async function refreshKeyStatus() {
    var status = panel('voice_groq_status');
    if (!status) return;
    if (hasIpc() && window.electronAPI.voice.keyStatus) {
      try {
        var result = await window.electronAPI.voice.keyStatus();
        if (result && result.configured && result.session) {
          setGroqStatus(t('lang_voice_groq_session_fallback', 'This system has no secure keystore. The key is kept for this session only.'));
        } else {
          setGroqStatus(result && result.configured
            ? t('lang_voice_groq_saved', 'Key saved on this computer.')
            : t('lang_voice_groq_none', 'No key saved yet.'));
        }
      } catch (error) {
        setGroqStatus(errorText(error), true);
      }
      return;
    }
    setGroqStatus(sessionKey()
      ? t('lang_voice_groq_session', 'Key kept for this browser tab only.')
      : t('lang_voice_groq_none', 'No key saved yet.'));
  }

  function refreshSettings() {
    if (!panel('v-pills-voice')) return;
    var enabled = panel('voice_enabled');
    var provider = panel('voice_provider');
    var model = panel('voice_local_model');
    if (enabled) enabled.checked = !!settings.enabled;
    if (provider) provider.value = settings.provider;
    if (model) model.value = settings.localModel;
    applyProviderPanels();
    refreshPlatformHint();
    refreshKeyStatus();
    updateTestButton('idle');
  }

  function updateTestButton(state) {
    var button = panel('voice_test_record');
    if (!button) return;
    var label = button.querySelector('span');
    if (!label) return;
    if (state === 'requesting') {
      label.textContent = t('lang_voice_cancel', 'Cancel');
      button.disabled = false;
      setTestStatus(t('lang_voice_mic_wait', 'Waiting for the microphone...'));
    } else if (state === 'recording') {
      label.textContent = t('lang_voice_stop', 'Stop and transcribe');
      button.disabled = false;
      setTestStatus(t('lang_voice_listening', 'Listening...'));
    } else if (state === 'stopping') {
      label.textContent = t('lang_voice_finishing', 'Finishing...');
      button.disabled = true;
    } else if (state === 'stopped' || state === 'transcribing') {
      label.textContent = t('lang_voice_transcribing', 'Transcribing...');
      button.disabled = true;
      setTestStatus(t('lang_voice_transcribing', 'Transcribing...'));
    } else if (state === 'done') {
      label.textContent = t('lang_voice_start', 'Start recording');
      button.disabled = false;
      setTestStatus(t('lang_voice_done', 'Done'));
    } else if (state === 'error') {
      label.textContent = t('lang_voice_start', 'Start recording');
      button.disabled = false;
    } else if (state === 'cancelled') {
      label.textContent = t('lang_voice_start', 'Start recording');
      button.disabled = false;
      setTestStatus('');
    } else {
      label.textContent = t('lang_voice_start', 'Start recording');
      button.disabled = false;
      if (state === 'idle') setTestStatus('');
    }
  }

  async function loadModel() {
    var button = panel('voice_local_load');
    var status = panel('voice_local_status');
    var wrap = panel('voice_local_progress_wrap');
    var bar = panel('voice_local_progress');
    if (!window.PosnicVoice || !window.PosnicVoice.isLocalSupported()) {
      setTestStatus(errorText({ code: 'unsupported' }), true);
      return;
    }
    if (button) button.disabled = true;
    if (wrap) wrap.hidden = false;
    if (bar) bar.style.width = '0%';
    if (status) status.textContent = t('lang_voice_model_loading', 'Loading model...');
    try {
      await window.PosnicVoice.local.load(settings.localModel, function (message) {
        if (!message) return;
        if (message.status === 'progress' && message.progress != null) {
          var percent = Math.max(0, Math.min(100, Math.round(message.progress)));
          if (bar) bar.style.width = percent + '%';
          if (status) status.textContent = t('lang_voice_downloading', 'Downloading model {percent}%').replace('{percent}', percent);
        } else if (message.status === 'loading') {
          if (status) status.textContent = t('lang_voice_model_loading', 'Loading model...');
        } else if (message.status === 'ready') {
          if (bar) bar.style.width = '100%';
          if (status) status.textContent = t('lang_voice_model_ready', 'Model ready.');
        }
      });
      if (bar) bar.style.width = '100%';
      if (status) status.textContent = t('lang_voice_model_ready', 'Model ready.');
      setTestStatus(t('lang_voice_model_ready', 'Model ready.'));
    } catch (error) {
      if (status) status.textContent = errorText(error);
      if (bar) bar.style.width = '0%';
      toast('error', errorText(error));
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function saveGroqKey() {
    var input = panel('voice_groq_key');
    var button = panel('voice_groq_save');
    if (!input) return;
    var key = String(input.value || '').trim();
    if (!key) {
      setGroqStatus(errorText({ code: 'key_missing' }), true);
      return;
    }
    if (button) button.disabled = true;
    setGroqStatus(t('lang_voice_key_checking', 'Checking key...'));
    try {
      if (hasIpc() && window.electronAPI.voice.saveKey) {
        var result = await window.electronAPI.voice.saveKey(key);
        if (!result || result.success === false) {
          throw window.PosnicVoice.error((result && result.code) || 'key_invalid',
            (result && result.error) || 'Groq did not accept that key.');
        }
        input.value = '';
        if (result.session) {
          setGroqStatus(t('lang_voice_groq_session_fallback', 'This system has no secure keystore. The key is kept for this session only.'), false);
        } else {
          setGroqStatus(t('lang_voice_groq_saved', 'Key saved on this computer.'));
        }
      } else {
        await window.PosnicVoice.groq.validateKey(key);
        setSessionKey(key);
        input.value = '';
        setGroqStatus(t('lang_voice_groq_session', 'Key kept for this browser tab only.'));
      }
      refreshPlatformHint();
      refreshKeyStatus();
    } catch (error) {
      setGroqStatus(errorText(error), true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function validateGroqKey() {
    var input = panel('voice_groq_key');
    var key = String((input && input.value) || '').trim() || sessionKey();
    /* The desktop app can check a saved key without handing it back to this
       page: pass an empty string and let the main process use its copy. */
    if (!key && !hasIpc()) {
      setGroqStatus(errorText({ code: 'key_missing' }), true);
      return false;
    }
    setGroqStatus(t('lang_voice_key_checking', 'Checking key...'));
    try {
      if (hasIpc() && window.electronAPI.voice.validateKey) {
        var result = await window.electronAPI.voice.validateKey(key);
        if (!result || result.success === false) {
          throw window.PosnicVoice.error((result && result.code) || 'key_invalid',
            (result && result.error) || 'Groq did not accept that key.');
        }
      } else {
        await window.PosnicVoice.groq.validateKey(key);
      }
      setGroqStatus(t('lang_voice_groq_valid', 'Key works.'));
      return true;
    } catch (error) {
      setGroqStatus(errorText(error), true);
      return false;
    }
  }

  async function removeGroqKey() {
    try {
      if (hasIpc() && window.electronAPI.voice.clearKey) await window.electronAPI.voice.clearKey();
    } catch (error) { /* still clear the session copy */ }
    setSessionKey('');
    var input = panel('voice_groq_key');
    if (input) input.value = '';
    setGroqStatus(t('lang_voice_groq_removed', 'Key removed.'));
    refreshPlatformHint();
    refreshKeyStatus();
  }

  function bindTestButton() {
    var button = panel('voice_test_record');
    if (!button) return;
    button.addEventListener('click', function () {
      if (active && active.source === 'settings') {
        if (active.phase === 'recording' || active.phase === 'requesting') stopActive();
        else cancelActive();
        return;
      }
      if (!settings.enabled) {
        setTestStatus(errorText({ code: 'disabled' }), true);
        return;
      }
      var textarea = panel('voice_test_text');
      setTestStatus('');
      updateTestButton('requesting');
      start({
        target: textarea,
        host: panel('voice_test_bar'),
        source: 'settings',
        onText: function (text) {
          textarea.value = text;
          try { textarea.focus(); } catch (error) { /* not fatal */ }
          setTestStatus(t('lang_voice_done', 'Done'));
        },
        onState: function (state) { updateTestButton(state); },
        onError: function (error) { setTestStatus(errorText(error), true); },
      }).catch(function (error) {
        setTestStatus(errorText(error), true);
        updateTestButton('error');
      });
    });
  }

  function bindSettings() {
    if (settingsBound || !panel('v-pills-voice')) return;
    settingsBound = true;

    var enabled = panel('voice_enabled');
    if (enabled) {
      enabled.addEventListener('change', function () {
        var want = !!enabled.checked;
        saveSettings({ enabled: want }).then(function (result) {
          if (want && result && result.success === false) {
            enabled.checked = false;
            saveSettings({ enabled: false });
            var message = errorText(result);
            setTestStatus(message, true);
            toast('error', message);
          }
        }).catch(function () {
          /* An old main process without voice IPC leaves the UI usable in a
             browser preview; dictation itself will report the failure. */
        });
        if (!want) cancelActive();
      });
    }

    var provider = panel('voice_provider');
    if (provider) {
      provider.addEventListener('change', function () {
        saveSettings({ provider: provider.value === 'groq' ? 'groq' : 'local' });
        applyProviderPanels();
        refreshKeyStatus();
        refreshPlatformHint();
      });
    }

    var model = panel('voice_local_model');
    if (model) {
      model.addEventListener('change', function () {
        saveSettings({ localModel: model.value === 'base' ? 'base' : 'small' });
        refreshModelSize();
        var wrap = panel('voice_local_progress_wrap');
        if (wrap) wrap.hidden = true;
        var bar = panel('voice_local_progress');
        if (bar) bar.style.width = '0%';
      });
    }

    var load = panel('voice_local_load');
    if (load) load.addEventListener('click', loadModel);

    var saveKey = panel('voice_groq_save');
    if (saveKey) saveKey.addEventListener('click', saveGroqKey);

    var validate = panel('voice_groq_validate');
    if (validate) validate.addEventListener('click', validateGroqKey);

    var remove = panel('voice_groq_remove');
    if (remove) remove.addEventListener('click', removeGroqKey);

    var keyInput = panel('voice_groq_key');
    if (keyInput) {
      keyInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          saveGroqKey();
        }
      });
    }

    bindTestButton();
    refreshModelSize();

    if (window.jQuery) {
      window.jQuery(document).on('shown.bs.tab', '#v-pills-voice-tab', function () {
        refreshSettings();
      });
    }
  }

  function bindShortcut() {
    document.addEventListener('keydown', function (event) {
      if (event.repeat) return;
      /* event.key follows the active keyboard layout. On an Arabic layout the
         physical V key does not produce "v", so match the key code too. */
      if (String(event.key || '').toLowerCase() !== 'v' && event.code !== 'KeyV') return;
      var isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
      /* The hint names Ctrl+Alt+V everywhere, so honour it on macOS too; the
         platform's own Command+Option+V is accepted beside it. */
      var combo = (event.ctrlKey && event.altKey) ||
        (isMac && event.metaKey && event.altKey);
      if (!combo) return;
      event.preventDefault();
      if (active) {
        if (active.phase === 'recording' || active.phase === 'requesting') stopActive();
        else cancelActive();
        return;
      }
      start({ target: currentField(), source: 'shortcut' }).catch(function () { /* handleError spoke */ });
    });
  }

  function bindFocusMemory() {
    document.addEventListener('focusin', function (event) {
      if (isEligible(event.target)) lastField = event.target;
    });
  }

  function init() {
    settings = loadSettings();
    syncMainPermission();
    bindFocusMemory();
    bindShortcut();
    bindSettings();
    refreshSettings();

    document.addEventListener('visibilitychange', function () {
      if (document.hidden && active) cancelActive();
    });
    window.addEventListener('beforeunload', function () {
      if (active) cancelActive();
    });
    window.addEventListener('hashchange', function () {
      if (active && !active.palette) cancelActive();
    });
  }

  window.PosnicPro = window.PosnicPro || {};
  PosnicPro.voice = {
    start: start,
    stop: stopActive,
    cancel: cancelActive,
    togglePalette: togglePalette,
    refresh: refreshSettings,
    settings: function () { return Object.assign({}, settings); },
    save: saveSettings,
    isActive: function () { return !!active; },
    isRecording: function () {
      return !!active && (active.phase === 'requesting' || active.phase === 'recording');
    },
    isTranscribing: function () { return !!active && active.phase === 'transcribing'; },
    insertText: insertText,
    errorText: errorText,
  };

  ready(init);
})();
