/*
 * Groq Whisper transcription.
 *
 * Only this module talks to Groq for speech-to-text. It receives a decrypted
 * key from the main process and never exposes it to the renderer.
 */

'use strict';

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GROQ_TRANSCRIBE = `${GROQ_BASE}/audio/transcriptions`;
const GROQ_MODELS = `${GROQ_BASE}/models`;
const TRANSCRIBE_MODEL = 'whisper-large-v3';
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_KEY_LENGTH = 256;

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

function extensionFor(type) {
  if (type === 'audio/mp4' || type === 'audio/m4a' || type === 'audio/x-m4a') return 'm4a';
  if (type === 'audio/ogg') return 'ogg';
  if (type === 'audio/mpeg' || type === 'audio/mp3') return 'mp3';
  if (type === 'audio/wav' || type === 'audio/x-wav') return 'wav';
  if (type === 'audio/flac' || type === 'audio/x-flac') return 'flac';
  return 'webm';
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

function shortError(detail) {
  const message = detail && detail.error && (detail.error.message || detail.error.code);
  return typeof message === 'string' ? message.slice(0, 300) : '';
}

function groqFailure(status, detail) {
  const code = status === 401 ? 'key_invalid'
    : status === 404 ? 'model_unavailable'
      : status === 413 ? 'too_large'
        : status === 429 ? 'rate_limited'
          : 'provider_error';
  return {
    success: false,
    code,
    status,
    error: shortError(detail) || `Groq returned ${status}.`,
  };
}

function validKeyShape(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH;
}

async function validateGroqKey(key, fetchImpl) {
  const fetch = fetchImpl || global.fetch;
  if (!validKeyShape(key)) {
    return { success: false, code: 'key_invalid', error: 'Enter a valid Groq API key.' };
  }
  try {
    const response = await fetch(GROQ_MODELS, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: timeoutSignal(20000),
    });
    if (response.status === 401 || response.status === 403) {
      return { success: false, code: 'key_invalid', status: response.status,
        error: 'Groq did not accept that key.' };
    }
    if (!response.ok) {
      return { success: false, code: 'provider_error', status: response.status,
        error: `Groq returned ${response.status}.` };
    }
    return { success: true };
  } catch (error) {
    return { success: false, code: 'network_error',
      error: 'Could not reach Groq to check the key. Check the internet connection.' };
  }
}

function audioBuffer(audio) {
  if (Buffer.isBuffer(audio)) return audio;
  if (audio instanceof ArrayBuffer) return Buffer.from(audio);
  if (audio && ArrayBuffer.isView(audio)) {
    return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  }
  return null;
}

async function transcribe({ key, audio, mimeType, language, fetchImpl } = {}) {
  const fetch = fetchImpl || global.fetch;
  if (!validKeyShape(key)) {
    return { success: false, code: 'key_missing', error: 'Add your Groq Whisper key first.' };
  }

  const buffer = audioBuffer(audio);
  if (!buffer || !buffer.length) {
    return { success: false, code: 'empty_recording', error: 'No audio was captured.' };
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    return { success: false, code: 'too_large', error: 'That recording is too large.' };
  }

  const type = String(mimeType || 'audio/webm').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(type)) {
    return { success: false, code: 'audio_unsupported', error: 'That audio format is not supported.' };
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), `recording.${extensionFor(type)}`);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('language', typeof language === 'string' && /^[a-z]{2}$/i.test(language) ? language : 'ar');
  form.append('response_format', 'json');
  form.append('temperature', '0');

  try {
    const response = await fetch(GROQ_TRANSCRIBE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: timeoutSignal(90000),
    });
    if (!response.ok) return groqFailure(response.status, await readJson(response));
    const data = await readJson(response);
    const text = String((data && data.text) || '').trim();
    if (!text) {
      return { success: false, code: 'empty_transcript', error: 'No speech was recognised.' };
    }
    return { success: true, text, model: TRANSCRIBE_MODEL };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return { success: false, code: 'network_error', error: 'Groq took too long to answer.' };
    }
    return { success: false, code: 'network_error',
      error: 'Could not reach Groq. Check the internet connection.' };
  }
}

module.exports = {
  ALLOWED_TYPES,
  MAX_AUDIO_BYTES,
  MAX_KEY_LENGTH,
  TRANSCRIBE_MODEL,
  groqFailure,
  transcribe,
  validateGroqKey,
};
