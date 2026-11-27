/*
 * Local credential storage for the AI assistant.
 *
 * The renderer never sees a key after it has been saved. When the operating
 * system gives Electron a real keystore the key is encrypted there; on a till
 * without one it is kept in main-process memory for this run only and is never
 * written to disk. Credentials are deliberately not part of sync.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { normaliseSettings } = require('./provider-registry');

const TRANSCRIPTION_SLOT = 'transcription';
const SETTINGS_FILE = 'ai-settings.json';
const TOKEN_STATE_FILE = 'ai-token-state.json';
const TRANSCRIPTION_FILE = 'ai-groq-key.json';
const LEGACY_TRANSCRIPTION_FILES = ['voice-groq-key.json'];
const MAX_PROVIDER_TOKENS = 10;

function slotFileName(slot) {
  if (slot === TRANSCRIPTION_SLOT) return TRANSCRIPTION_FILE;
  const id = String(slot || '').replace(/^provider:/, '').replace(/[^a-z0-9_-]/gi, '');
  if (!id) return '';
  return `ai-provider-${id}.json`;
}

/* Provider tokens keep their historical slot names: slot 0 is the old primary
   and slot 1 is the old backup. Further slots are numbered from 2. The runtime
   walks the slots in order and falls back to the next usable token. */
function providerTokenSlot(providerID, index = 0) {
  const id = String(providerID || '').trim();
  if (!id) return '';
  return index > 0 ? `provider:${id}:${index + 1}` : `provider:${id}`;
}

function secureStorageState(safeStorage) {
  try {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
      return { secure: false, reason: 'unavailable' };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { secure: false, reason: 'unavailable' };
    }
    /* Electron's basic_text backend is encryption in name only. Never write a
       provider key there; keep it in memory for this run instead. */
    if (typeof safeStorage.getSelectedStorageBackend === 'function' &&
        safeStorage.getSelectedStorageBackend() === 'basic_text') {
      return { secure: false, reason: 'basic_text' };
    }
    return { secure: true, reason: '' };
  } catch (error) {
    return { secure: false, reason: error.message };
  }
}

function createKeyStore({ app, safeStorage }) {
  const userData = app.getPath('userData');
  const settingsPath = path.join(userData, SETTINGS_FILE);
  const tokenStatePath = path.join(userData, TOKEN_STATE_FILE);
  const sessionKeys = new Map();

  function storageState() {
    return secureStorageState(safeStorage);
  }

  function fileNameFor(slot) {
    return path.join(userData, slotFileName(slot));
  }

  function readTokenState() {
    try {
      const state = JSON.parse(fs.readFileSync(tokenStatePath, 'utf8'));
      if (!state || typeof state !== 'object' || !state.providers ||
          typeof state.providers !== 'object') {
        return { v: 1, providers: {} };
      }
      return state;
    } catch (error) {
      return { v: 1, providers: {} };
    }
  }

  function writeTokenState(state) {
    fs.mkdirSync(path.dirname(tokenStatePath), { recursive: true });
    fs.writeFileSync(tokenStatePath, JSON.stringify({ v: 1, ...state }), { mode: 0o600 });
    try { fs.chmodSync(tokenStatePath, 0o600); } catch (error) { /* mode already set */ }
  }

  function hasSecret(slot) {
    return sessionKeys.has(slot) || fs.existsSync(fileNameFor(slot));
  }

  function providerTokenSlots(providerID) {
    const slots = [];
    for (let index = 0; index < MAX_PROVIDER_TOKENS; index += 1) {
      if (hasSecret(providerTokenSlot(providerID, index))) slots.push(index);
    }
    return slots;
  }

  function getActiveProviderToken(providerID) {
    const slots = providerTokenSlots(providerID);
    if (!slots.length) return 0;
    const state = readTokenState();
    const entry = state.providers[providerID];
    const requested = entry && Number.isInteger(entry.active) ? entry.active : slots[0];
    if (slots.includes(requested) && read(providerTokenSlot(providerID, requested)).key) {
      return requested;
    }
    const readable = slots.find((index) => read(providerTokenSlot(providerID, index)).key);
    return readable !== undefined ? readable : (slots.includes(requested) ? requested : slots[0]);
  }

  function setActiveProviderToken(providerID, index) {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PROVIDER_TOKENS) return false;
    if (!read(providerTokenSlot(providerID, index)).key) return false;
    const state = readTokenState();
    state.providers[providerID] = { ...(state.providers[providerID] || {}), active: index };
    writeTokenState(state);
    return true;
  }

  function addProviderToken(providerID, key) {
    const slots = providerTokenSlots(providerID);
    if (slots.length >= MAX_PROVIDER_TOKENS) {
      return { ok: false, code: 'token_limit' };
    }
    let index = 0;
    while (slots.includes(index)) index += 1;
    const stored = write(providerTokenSlot(providerID, index), key);
    if (!slots.length) setActiveProviderToken(providerID, index);
    return { ok: true, index, ...stored };
  }

  function setProviderToken(providerID, index, key) {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PROVIDER_TOKENS) {
      return { ok: false, code: 'token_invalid' };
    }
    const hadTokens = providerTokenSlots(providerID).length > 0;
    const stored = write(providerTokenSlot(providerID, index), key);
    if (!hadTokens) setActiveProviderToken(providerID, index);
    return { ok: true, index, ...stored };
  }

  function removeProviderToken(providerID, index) {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PROVIDER_TOKENS) {
      return { ok: false, code: 'token_invalid' };
    }
    clear(providerTokenSlot(providerID, index));
    const slots = providerTokenSlots(providerID);
    const state = readTokenState();
    if (!slots.length) {
      delete state.providers[providerID];
    } else {
      const entry = state.providers[providerID] || {};
      if (entry.active === index || !slots.includes(entry.active)) entry.active = slots[0];
      state.providers[providerID] = entry;
    }
    writeTokenState(state);
    return { ok: true, active: slots.length ? state.providers[providerID].active : 0 };
  }

  function providerTokenStatuses(providerID) {
    return providerTokenSlots(providerID).map((index) => {
      const loaded = status(providerTokenSlot(providerID, index));
      return {
        index,
        configured: loaded.configured,
        secure: loaded.secure,
        session: loaded.session,
        unreadable: loaded.reason === 'unreadable',
      };
    });
  }

  function readEncrypted(filePath) {
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!record || !record.ct) return { key: '', error: 'unreadable' };
      const key = safeStorage.decryptString(Buffer.from(record.ct, 'base64'));
      if (typeof key === 'string' && key) return { key, error: null };
      return { key: '', error: 'unreadable' };
    } catch (error) {
      return { key: '', error: 'unreadable' };
    }
  }

  function read(slot) {
    const sessionKey = sessionKeys.get(slot);
    if (sessionKey) return { key: sessionKey, error: null, session: true };

    const state = storageState();
    if (!state.secure) return { key: '', error: null, session: false };

    const filePath = fileNameFor(slot);
    if (fs.existsSync(filePath)) {
      const loaded = readEncrypted(filePath);
      return { key: loaded.key, error: loaded.error, session: false };
    }

    if (slot === TRANSCRIPTION_SLOT) {
      for (const legacyName of LEGACY_TRANSCRIPTION_FILES) {
        const legacyPath = path.join(userData, legacyName);
        if (!fs.existsSync(legacyPath)) continue;
        const loaded = readEncrypted(legacyPath);
        return { key: loaded.key, error: loaded.error, session: false };
      }
    }

    return { key: '', error: null, session: false };
  }

  function write(slot, key) {
    const state = storageState();
    if (!state.secure) {
      sessionKeys.set(slot, key);
      return { secure: false, session: true };
    }

    const filePath = fileNameFor(slot);
    const encrypted = safeStorage.encryptString(key).toString('base64');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      v: 1,
      alg: 'safeStorage',
      ct: encrypted,
    }), { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch (error) { /* mode already set */ }
    sessionKeys.delete(slot);
    return { secure: true, session: false };
  }

  function clear(slot) {
    sessionKeys.delete(slot);
    const filePath = fileNameFor(slot);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (slot === TRANSCRIPTION_SLOT) {
      for (const legacyName of LEGACY_TRANSCRIPTION_FILES) {
        const legacyPath = path.join(userData, legacyName);
        if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
      }
    }
  }

  function status(slot) {
    const state = storageState();
    const loaded = read(slot);
    return {
      configured: !!loaded.key,
      secure: state.secure,
      session: !!loaded.session,
      reason: loaded.error || state.reason || '',
    };
  }

  function getSettings() {
    let raw = {};
    try {
      if (fs.existsSync(settingsPath)) {
        raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
      }
    } catch (error) {
      raw = {};
    }
    return normaliseSettings(raw);
  }

  function setSettings(settings) {
    const normalised = normaliseSettings(settings);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ v: 1, ...normalised }), { mode: 0o600 });
    try { fs.chmodSync(settingsPath, 0o600); } catch (error) { /* mode already set */ }
    return normalised;
  }

  return {
    addProviderToken,
    clear,
    getActiveProviderToken,
    getSecret: (slot) => read(slot).key,
    getSettings,
    providerTokenSlots,
    providerTokenStatuses,
    read,
    removeProviderToken,
    setActiveProviderToken,
    setProviderToken,
    setSecret: write,
    setSettings,
    status,
    storageState,
  };
}

module.exports = {
  MAX_PROVIDER_TOKENS,
  TRANSCRIPTION_SLOT,
  createKeyStore,
  providerTokenSlot,
  secureStorageState,
  slotFileName,
};
