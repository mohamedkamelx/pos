/*
 * Arabic speech-to-text, entirely on this computer.
 *
 * Transformers.js and ONNX Runtime Web run inside this worker so a model load
 * or a 30-second decode never freezes the till. The worker is a real ES module
 * because the vendored Transformers.js build is one; the frontend bundle that
 * starts it is not.
 *
 * The first run downloads the quantised Whisper weights from Hugging Face and
 * the browser cache keeps them afterwards. Nothing is uploaded: the audio never
 * leaves the renderer's memory except as a Float32Array transferred here.
 */

/*
 * The worker is served from two layouts:
 *
 *   dashboard  /public/static/voice/  -> vendor at /public/script/vendor/
 *   Voice Lab  /static/voice/         -> vendor at /static/script/vendor/
 *
 * A single relative import cannot name both. Detect the mount from the
 * worker's own URL so the vendored runtime and its WASM are loaded from the
 * tree beside this mount, not from a 404 at the site root.
 */
const workerPath = new URL(import.meta.url).pathname;
const vendorPrefix = workerPath.startsWith('/public/') ? '../../' : '../';
const vendorBase = new URL(`${vendorPrefix}script/vendor/transformers/`, import.meta.url);
const { pipeline, env } = await import(new URL('transformers.min.js', vendorBase).href);

const MODELS = {
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
};

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

const wasm = env.backends && env.backends.onnx && env.backends.onnx.wasm;
if (wasm) {
  wasm.wasmPaths = vendorBase.href;
  /* Threads need SharedArrayBuffer, which needs a cross-origin-isolated page.
     The local API does not send COOP/COEP, so this normally runs single
     threaded. Say that plainly rather than letting ORT throw. */
  wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
    : 1;
}

let current = null;

function send(message) {
  self.postMessage(message);
}

function status(id, payload) {
  send(Object.assign({ type: 'status', id }, payload));
}

function progressFor(id) {
  return (event) => {
    status(id, {
      status: event.status,
      file: event.file || '',
      progress: Number.isFinite(event.progress) ? event.progress : null,
      loaded: event.loaded || 0,
      total: event.total || 0,
    });
  };
}

async function getPipeline(model, id) {
  const modelId = MODELS[model] || MODELS.small;
  if (current && current.modelId === modelId) return current.pipe;

  if (current) {
    try {
      await current.pipe.dispose();
    } catch (error) {
      /* A failed dispose only costs memory; the new worker request can go on. */
    }
    current = null;
  }

  status(id, { status: 'loading', model: modelId });
  const pipe = await pipeline('automatic-speech-recognition', modelId, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: progressFor(id),
  });
  current = { modelId, pipe };
  status(id, { status: 'ready', model: modelId });
  return pipe;
}

self.onmessage = async (event) => {
  const message = event.data || {};
  const id = message.id;

  if (message.type === 'load') {
    try {
      await getPipeline(message.model, id);
    } catch (error) {
      send({
        type: 'error',
        id,
        error: { name: error && error.name, message: error && error.message },
      });
    }
    return;
  }

  if (message.type !== 'transcribe') return;

  try {
    const pipe = await getPipeline(message.model, id);
    const audio = message.audio;
    if (!(audio instanceof Float32Array) || audio.length < 1600) {
      throw new Error('The recording was too short to transcribe.');
    }
    if (message.onProgress !== false) status(id, { status: 'transcribing' });

    const output = await pipe(audio, {
      language: 'ar',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
      max_new_tokens: 256,
    });

    const text = String((output && output.text) || '').trim();
    send({ type: 'result', id, text });
  } catch (error) {
    send({
      type: 'error',
      id,
      error: { name: error && error.name, message: error && error.message },
    });
  }
};
