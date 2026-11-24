/*
 * Voice dictation's main-process half.
 *
 * Two things live here that must not live in the renderer:
 *
 *   - the Groq API key, encrypted by the operating system's keystore;
 *   - the HTTP request that uses it, so the key never reaches a page.
 *
 * The browser preview has no main process and uses sessionStorage plus a
 * direct fetch. The desktop app uses these handlers. The permission gate in
 * main.js reads `voiceInputState` so the microphone is refused until the shop
 * has turned the feature on in Settings.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const GROQ_TRANSCRIBE = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODELS = 'https://api.groq.com/openai/v1/models';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const KEY_FILE = 'voice-groq-key.json';
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_KEY_LENGTH = 256;

/* Read by main.js's permission handlers. A renderer can turn it on, but only
 * after the shop has opted in; the microphone is denied in every other case. */
const voiceInputState = { enabled: false };

const ALLOWED_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/x-flac',
]);

let installed = false;

function defaultIpcMain() {
  const electron = require('electron');
  if (!electron || typeof electron === 'string' || !electron.ipcMain) {
    throw new Error('voice-ipc must be started inside Electron');
  }
  return require('./ipc-guard').guard(electron.ipcMain);
}

function extensionFor(type) {
  if (type === 'audio/mp4' || type === 'audio/m4a' || type === 'audio/x-m4a') return 'm4a';
  if (type === 'audio/ogg') return 'ogg';
  if (type === 'audio/mpeg' || type === 'audio/mp3') return 'mp3';
  if (type === 'audio/wav' || type === 'audio/x-wav') return 'wav';
  if (type === 'audio/flac' || type === 'audio/x-flac') return 'flac';
  return 'webm';
}

function secureStorageState(safeStorage) {
  try {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
      return { secure: false, reason: 'unavailable' };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { secure: false, reason: 'unavailable' };
    }
    /* On a Linux box without a keyring Electron falls back to a hard-coded
       key called basic_text. It is encryption in name only, so a Groq key is
       not written there. It stays in the main process for this run instead. */
    if (typeof safeStorage.getSelectedStorageBackend === 'function' &&
        safeStorage.getSelectedStorageBackend() === 'basic_text') {
      return { secure: false, reason: 'basic_text' };
    }
    return { secure: true, reason: '' };
  } catch (error) {
    return { secure: false, reason: error.message };
  }
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function readJson(response) {
  try { return await response.json(); } catch (error) { return null; }
}

function groqFailure(status, detail) {
  const message = (detail && detail.error && (detail.error.message || detail.error.code)) ||
    `Groq returned ${status}.`;
  const code = status === 401 ? 'key_invalid'
    : status === 413 ? 'too_large'
      : status === 429 ? 'rate_limited'
        : 'groq_error';
  return { success: false, code: code, status: status, error: message };
}

function createVoiceIpc({ ipcMain: suppliedIpcMain, app, safeStorage, systemPreferences, fetchImpl } = {}) {
  if (installed) return voiceInputState;
  installed = true;

  const ipcMain = suppliedIpcMain || defaultIpcMain();
  const fetch = fetchImpl || global.fetch;
  const keyPath = path.join(app.getPath('userData'), KEY_FILE);

  /* A Linux till without a keyring has no safe place to write the key. It is
     still allowed for this run, held only in the main process, and never
     written to disk or handed back to the renderer. A restart asks again. */
  let sessionKey = '';

  function storage() {
    return secureStorageState(safeStorage);
  }

  function readKey() {
    if (fs.existsSync(keyPath)) {
      const state = storage();
      if (state.secure) {
        try {
          const record = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
          if (record && record.ct) {
            const key = safeStorage.decryptString(Buffer.from(record.ct, 'base64'));
            if (typeof key === 'string' && key) return { key: key, error: null, session: false };
          }
          if (!sessionKey) return { key: '', error: 'unreadable' };
        } catch (error) {
          if (!sessionKey) return { key: '', error: 'unreadable' };
        }
      }
    }
    if (sessionKey) return { key: sessionKey, error: null, session: true };
    return { key: '', error: null };
  }

  function writeKey(key) {
    const encrypted = safeStorage.encryptString(key).toString('base64');
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, JSON.stringify({
      v: 1,
      alg: 'safeStorage',
      ct: encrypted,
    }), { mode: 0o600 });
    try { fs.chmodSync(keyPath, 0o600); } catch (error) { /* mode already set */ }
  }

  async function validateKey(key) {
    const response = await fetch(GROQ_MODELS, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: timeoutSignal(20000),
    });
    if (response.status === 401) {
      return { success: false, code: 'key_invalid', status: 401, error: 'Groq did not accept that key.' };
    }
    if (!response.ok) {
      return { success: false, code: 'groq_error', status: response.status,
        error: `Groq returned ${response.status}.` };
    }
    return { success: true };
  }

  ipcMain.handle('voice:set-enabled', async (_event, enabled) => {
    const next = enabled === true;
    if (!next) {
      voiceInputState.enabled = false;
      return { success: true, enabled: false };
    }
    /* macOS has a second, operating-system layer (TCC) above Chromium's own
       permission handler. Ask for it when the shop turns voice input on rather
       than letting the first dictation fail with a bare NotAllowedError. */
    if (process.platform === 'darwin' && systemPreferences &&
        typeof systemPreferences.askForMediaAccess === 'function') {
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (granted === false) {
          voiceInputState.enabled = false;
          return { success: false, enabled: false, code: 'mic_denied',
            error: 'Microphone access was not allowed in the operating system.' };
        }
      } catch (error) {
        /* A missing usage description or an old Electron reports this as an
           exception. Leave Chromium's own denial to speak, rather than making
           the whole switch unusable on a transient check. */
      }
    }
    voiceInputState.enabled = true;
    return { success: true, enabled: true };
  });

  ipcMain.handle('voice:key-status', () => {
    const state = storage();
    const loaded = readKey();
    return {
      success: true,
      configured: !!loaded.key,
      secure: state.secure,
      session: !!loaded.session,
      reason: loaded.error || state.reason || '',
    };
  });

  ipcMain.handle('voice:validate-key', async (_event, raw) => {
    if (raw != null && typeof raw !== 'string') {
      return { success: false, code: 'key_invalid', error: 'Enter a valid Groq API key.' };
    }
    /* An empty box means "check the key you already saved" in the desktop
       app. Validating it here keeps the stored secret in main; the renderer
       never receives it back. */
    let key = typeof raw === 'string' ? raw.trim() : '';
    if (!key) {
      const stored = readKey();
      if (!stored.key) {
        return { success: false, code: 'key_missing',
          error: 'Add your Groq API key in Settings > Voice.' };
      }
      key = stored.key;
    }
    if (key.length > MAX_KEY_LENGTH) {
      return { success: false, code: 'key_invalid', error: 'Enter a valid Groq API key.' };
    }
    try {
      return await validateKey(key);
    } catch (error) {
      return { success: false, code: 'network_error',
        error: 'Could not reach Groq to check the key. Check the internet connection.' };
    }
  });

  ipcMain.handle('voice:save-key', async (_event, raw) => {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key || key.length > MAX_KEY_LENGTH) {
      return { success: false, code: 'key_invalid', error: 'Enter a valid Groq API key.' };
    }
    let checked;
    try {
      checked = await validateKey(key);
    } catch (error) {
      return { success: false, code: 'network_error',
        error: 'Could not reach Groq to check the key. Check the internet connection.' };
    }
    if (!checked.success) return checked;

    const state = storage();
    if (!state.secure) {
      sessionKey = key;
      return { success: true, configured: true, secure: false, session: true };
    }
    try {
      writeKey(key);
    } catch (error) {
      return { success: false, code: 'key_save_failed',
        error: 'The key could not be saved on this computer.' };
    }
    sessionKey = '';
    return { success: true, configured: true, secure: true, session: false };
  });

  ipcMain.handle('voice:clear-key', () => {
    sessionKey = '';
    try {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    } catch (error) {
      return { success: false, error: 'The key file could not be removed.' };
    }
    return { success: true, configured: false };
  });

  ipcMain.handle('voice:transcribe', async (_event, payload) => {
    if (!voiceInputState.enabled) {
      return { success: false, code: 'disabled', error: 'Voice input is off.' };
    }
    const loaded = readKey();
    if (!loaded.key) {
      return { success: false, code: 'key_missing',
        error: loaded.error === 'unreadable'
          ? 'The saved Groq key could not be read. Enter it again.'
          : 'Add your Groq API key in Settings > Voice.' };
    }

    const audio = payload && payload.audio;
    let buffer = null;
    if (Buffer.isBuffer(audio)) buffer = audio;
    else if (audio instanceof ArrayBuffer) buffer = Buffer.from(audio);
    else if (audio && ArrayBuffer.isView(audio)) {
      buffer = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
    }
    if (!buffer || !buffer.length) {
      return { success: false, code: 'empty_recording', error: 'No audio was captured.' };
    }
    if (buffer.length > MAX_AUDIO_BYTES) {
      return { success: false, code: 'too_large', error: 'That recording is too large.' };
    }

    const mimeType = String((payload && payload.mimeType) || 'audio/webm').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(mimeType)) {
      return { success: false, code: 'audio_unsupported', error: 'That audio format is not supported.' };
    }

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), `dictation.${extensionFor(mimeType)}`);
    form.append('model', GROQ_MODEL);
    form.append('language', 'ar');
    form.append('response_format', 'json');
    form.append('temperature', '0');

    try {
      const response = await fetch(GROQ_TRANSCRIBE, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loaded.key}` },
        body: form,
        signal: timeoutSignal(90000),
      });
      if (!response.ok) return groqFailure(response.status, await readJson(response));
      const data = await readJson(response);
      const text = String((data && data.text) || '').trim();
      if (!text) {
        return { success: false, code: 'empty_transcript', error: 'No speech was recognised.' };
      }
      return { success: true, text: text };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        return { success: false, code: 'network_error', error: 'Groq took too long to answer.' };
      }
      return { success: false, code: 'network_error',
        error: 'Could not reach Groq. Check the internet connection.' };
    }
  });

  return voiceInputState;
}

module.exports = {
  setupVoiceIPC: createVoiceIpc,
  voiceInputState,
};
