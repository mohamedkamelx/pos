/*
 * The AI assistant's main-process bridge.
 *
 * The Groq Whisper key, the chat provider token, all network calls and the
 * embedded OpenCode runtime stay here. The renderer receives status flags, a
 * transcript and a reply - never a stored secret.
 *
 * The browser preview has no main process and deliberately has no AI bridge.
 * `aiInputState` is read by main.js's permission handlers, so the microphone is
 * refused until the shop has explicitly turned the assistant on.
 */

'use strict';

const path = require('path');
const {
  DEFAULT_PROVIDER,
  getModel,
  getProvider,
  listProviders,
} = require('./ai/provider-registry');
const {
  TRANSCRIPTION_SLOT,
  createKeyStore,
  providerTokenSlot,
} = require('./ai/key-store');
const {
  MAX_KEY_LENGTH,
  transcribe,
  validateGroqKey,
} = require('./ai/transcriber');
const { validateProviderKey } = require('./ai/provider-client');
const { createOpenCodeRuntime } = require('./ai/opencode-runtime');
const { MAX_ATTACHMENTS } = require('./ai/attachments');

const MAX_MESSAGE_CHARS = 4000;
const MAX_CONVERSATION_CHARS = 100;

/* Read by main.js's permission handlers. A renderer can turn it on, but only
 * after both credentials exist and the chat-only runtime has started. */
const aiInputState = { enabled: false };

let installed = false;

function defaultIpcMain() {
  const electron = require('electron');
  if (!electron || typeof electron === 'string' || !electron.ipcMain) {
    throw new Error('ai-ipc must be started inside Electron');
  }
  return require('./ipc-guard').guard(electron.ipcMain);
}

function failure(code, error, extra) {
  return {
    success: false,
    code: code || 'failed',
    error: error || 'The assistant could not complete that request.',
    ...(extra || {}),
  };
}

function runtimeFailure(error) {
  const code = (error && error.code) || 'provider_error';
  const fallbacks = {
    chat_timeout: 'The assistant took too long to reply.',
    empty_reply: 'The assistant returned an empty reply. Try again.',
    model_unavailable: 'The selected model is not available. Choose another model.',
    provider_error: 'The model provider returned an error.',
    rate_limited: 'The provider limit was reached. Try again later.',
    provider_key_missing: 'Save a provider token before turning on chat.',
    provider_key_unreadable: 'The saved provider token could not be read. Enter it again.',
    runtime_failed: 'The embedded assistant could not start. Try again.',
  };
  const message = error && error.message ? String(error.message).slice(0, 300) : fallbacks[code];
  const retryAfterMs = Number(error && error.retryAfterMs);
  return failure(
    code,
    message || fallbacks[code] || 'The assistant could not answer. Try again.',
    retryAfterMs > 0 ? { retryAfterMs } : undefined,
  );
}

function createAiIpc({
  ipcMain: suppliedIpcMain,
  app,
  safeStorage,
  systemPreferences,
  fetchImpl,
  fallbackFetchImpl,
  runtimeFactory,
  apiBaseUrl,
  logger,
} = {}) {
  if (installed) return aiInputState;
  installed = true;

  const ipcMain = suppliedIpcMain || defaultIpcMain();
  const keyStore = createKeyStore({ app, safeStorage });
  const runtime = (runtimeFactory || createOpenCodeRuntime)({
    baseDir: path.join(app.getPath('userData'), 'ai'),
    keyStore,
    logger,
    fetchImpl,
    apiBaseUrl,
  });

  function providerStatus() {
    const settings = keyStore.getSettings();
    const provider = getProvider(settings.provider) || getProvider(DEFAULT_PROVIDER);
    const model = getModel(provider.id, settings.model) || provider.models[0];
    const chat = keyStore.status(providerTokenSlot(provider.id));
    const backup = keyStore.status(providerTokenSlot(provider.id, 1));
    return {
      configured: chat.configured,
      secure: chat.secure,
      session: chat.session,
      reason: chat.reason,
      backupConfigured: backup.configured,
      backupSecure: backup.secure,
      activeToken: typeof runtime.activeToken === 'function'
        ? runtime.activeToken(provider.id)
        : 'primary',
      provider: provider.id,
      providerLabel: provider.label,
      model: model.id,
      modelLabel: model.label,
    };
  }

  function status() {
    const transcription = keyStore.status(TRANSCRIPTION_SLOT);
    return {
      success: true,
      enabled: aiInputState.enabled,
      secure: transcription.secure,
      session: transcription.session,
      transcription,
      chat: providerStatus(),
      providers: listProviders(),
    };
  }

  async function stopRuntime() {
    try { await runtime.stop(); } catch (error) { /* already stopped */ }
  }

  ipcMain.handle('ai:set-enabled', async (_event, enabled) => {
    const next = enabled === true;
    if (!next) {
      aiInputState.enabled = false;
      await stopRuntime();
      return { success: true, enabled: false };
    }

    const transcription = keyStore.read(TRANSCRIPTION_SLOT);
    if (!transcription.key) {
      return failure(
        transcription.error === 'unreadable' ? 'key_unreadable' : 'key_missing',
        transcription.error === 'unreadable'
          ? 'The saved Groq Whisper key could not be read. Enter it again.'
          : 'Add your Groq Whisper key before turning on the assistant.',
      );
    }

    const settings = keyStore.getSettings();
    const provider = getProvider(settings.provider) || getProvider(DEFAULT_PROVIDER);
    const primary = keyStore.read(providerTokenSlot(provider.id));
    const backup = keyStore.read(providerTokenSlot(provider.id, 1));
    const chat = primary.key ? primary : backup;
    if (!chat.key) {
      const unreadable = primary.error === 'unreadable' || backup.error === 'unreadable';
      return failure(
        unreadable ? 'provider_key_unreadable' : 'provider_key_missing',
        unreadable
          ? 'The saved provider token could not be read. Enter it again.'
          : 'Save a provider token before turning on chat.',
      );
    }

    try {
      await runtime.start();
    } catch (error) {
      return runtimeFailure(error);
    }

    /* macOS has an operating-system microphone layer above Chromium's own
       permission handler. Ask when the shop turns the assistant on so the
       first recording does not fail with a bare NotAllowedError. Typed chat
       remains available when the OS refuses the microphone. */
    if (process.platform === 'darwin' && systemPreferences &&
        typeof systemPreferences.askForMediaAccess === 'function') {
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (granted === false) {
          aiInputState.enabled = true;
          return { success: true, enabled: true, micDenied: true, code: 'mic_denied',
            error: 'Microphone access was not allowed in the operating system.' };
        }
      } catch (error) {
        /* Leave Chromium's own denial to speak rather than breaking the whole
           switch on a transient OS check. */
      }
    }

    aiInputState.enabled = true;
    return { success: true, enabled: true };
  });

  ipcMain.handle('ai:key-status', () => status());

  ipcMain.handle('ai:validate-key', async (_event, raw) => {
    if (raw != null && typeof raw !== 'string') {
      return failure('key_invalid', 'Enter a valid Groq API key.');
    }
    let key = typeof raw === 'string' ? raw.trim() : '';
    if (!key) {
      const stored = keyStore.read(TRANSCRIPTION_SLOT);
      if (!stored.key) {
        return failure('key_missing', 'Add your Groq Whisper key on the AI page.');
      }
      key = stored.key;
    }
    if (key.length > MAX_KEY_LENGTH) {
      return failure('key_invalid', 'Enter a valid Groq API key.');
    }
    return validateGroqKey(key, fetchImpl);
  });

  ipcMain.handle('ai:save-key', async (_event, raw) => {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key || key.length > MAX_KEY_LENGTH) {
      return failure('key_invalid', 'Enter a valid Groq API key.');
    }
    const checked = await validateGroqKey(key, fetchImpl);
    if (!checked.success) return checked;

    let stored;
    try {
      stored = keyStore.setSecret(TRANSCRIPTION_SLOT, key);
    } catch (error) {
      return failure('key_save_failed', 'The key could not be saved on this computer.');
    }
    return {
      success: true,
      configured: true,
      secure: stored.secure,
      session: stored.session,
    };
  });

  ipcMain.handle('ai:clear-key', async () => {
    try {
      keyStore.clear(TRANSCRIPTION_SLOT);
    } catch (error) {
      return failure('key_remove_failed', 'The key file could not be removed.');
    }
    aiInputState.enabled = false;
    await stopRuntime();
    return { success: true, configured: false };
  });

  ipcMain.handle('ai:validate-provider-key', async (_event, payload) => {
    const provider = payload && payload.provider;
    const key = payload && payload.key;
    if (typeof provider !== 'string' || typeof key !== 'string') {
      return failure('provider_key_invalid', 'Enter a valid provider token.');
    }
    return validateProviderKey(provider, key.trim(), fetchImpl);
  });

  ipcMain.handle('ai:save-provider-key', async (_event, payload) => {
    const providerID = payload && payload.provider;
    const provider = getProvider(providerID);
    const key = payload && typeof payload.key === 'string' ? payload.key.trim() : '';
    const backup = !!(payload && payload.backup === true);
    if (!provider) {
      return failure('provider_invalid', 'Choose a supported model provider.');
    }
    if (!key || key.length > MAX_KEY_LENGTH) {
      return failure('provider_key_invalid', 'Enter a valid provider token.');
    }
    const checked = await validateProviderKey(provider.id, key, fetchImpl);
    if (!checked.success) return checked;

    let stored;
    try {
      stored = keyStore.setSecret(providerTokenSlot(provider.id, backup ? 1 : 0), key);
    } catch (error) {
      return failure('provider_key_save_failed', 'The provider token could not be saved.');
    }

    const settings = keyStore.getSettings();
    if (typeof runtime.updateSettings === 'function') runtime.updateSettings(settings);
    /* A newly saved primary token should be tried again before the backup.
       A backup is read lazily on the next quota failure, so it needs no restart. */
    if (!backup && typeof runtime.usePrimaryToken === 'function') {
      runtime.usePrimaryToken(provider.id);
    }
    let restarted = false;
    let warning = '';
    const activeIsBackup = typeof runtime.activeToken === 'function' &&
      runtime.activeToken(provider.id) === 'backup';
    /* Saving a new backup while the backup is already the active token must
       restart so the new secret replaces the exhausted one. An inactive
       backup is picked up lazily on the next quota failure. */
    if (settings.provider === provider.id && runtime.isRunning() &&
        (!backup || activeIsBackup)) {
      try {
        await runtime.restart();
        restarted = true;
      } catch (error) {
        warning = 'The token was saved, but the assistant could not restart. Turn it off and on again.';
        await stopRuntime();
      }
    }

    const primary = keyStore.status(providerTokenSlot(provider.id));
    const backupStatus = keyStore.status(providerTokenSlot(provider.id, 1));
    return {
      success: true,
      configured: primary.configured,
      backupConfigured: backupStatus.configured,
      backup,
      provider: provider.id,
      model: settings.model,
      secure: stored.secure,
      session: stored.session,
      restarted,
      ...(warning ? { warning } : {}),
    };
  });

  ipcMain.handle('ai:clear-provider-key', async (_event, payload) => {
    const provider = getProvider(payload && payload.provider);
    const backup = !!(payload && payload.backup === true);
    if (!provider) {
      return failure('provider_invalid', 'Choose a supported model provider.');
    }
    try {
      keyStore.clear(providerTokenSlot(provider.id, backup ? 1 : 0));
    } catch (error) {
      return failure('provider_key_remove_failed', 'The provider token could not be removed.');
    }

    const settings = keyStore.getSettings();
    const primary = keyStore.status(providerTokenSlot(provider.id));
    const backupStatus = keyStore.status(providerTokenSlot(provider.id, 1));
    let restarted = false;
    let warning = '';

    if (backup) {
      /* Removing the backup while it is the active token must put the primary
         back in use. Removing an inactive backup needs no runtime change. */
      const activeIsBackup = typeof runtime.activeToken === 'function' &&
        runtime.activeToken(provider.id) === 'backup';
      if (activeIsBackup && typeof runtime.usePrimaryToken === 'function') {
        runtime.usePrimaryToken(provider.id);
      }
      if (activeIsBackup && settings.provider === provider.id && runtime.isRunning()) {
        if (!primary.configured) {
          await stopRuntime();
          warning = 'The backup token was removed. Save a provider token before turning chat on again.';
        } else {
          try {
            await runtime.restart();
            restarted = true;
          } catch (error) {
            warning = 'The backup token was removed, but the assistant could not restart. Turn it off and on again.';
            await stopRuntime();
          }
        }
      }
    } else if (settings.provider === provider.id) {
      await stopRuntime();
    }

    return {
      success: true,
      configured: primary.configured,
      backupConfigured: backupStatus.configured,
      backup,
      provider: provider.id,
      restarted,
      ...(warning ? { warning } : {}),
    };
  });

  ipcMain.handle('ai:set-provider-model', async (_event, payload) => {
    const provider = getProvider(payload && payload.provider);
    if (!provider) {
      return failure('provider_invalid', 'Choose a supported model provider.');
    }
    const model = getModel(provider.id, payload && payload.model);
    if (!model) {
      return failure('model_unavailable', 'Choose a model this provider offers.');
    }

    const next = keyStore.setSettings({ provider: provider.id, model: model.id });
    if (typeof runtime.updateSettings === 'function') runtime.updateSettings(next);
    let restarted = false;
    let warning = '';
    if (runtime.isRunning()) {
      try {
        await runtime.restart();
        restarted = true;
      } catch (error) {
        warning = 'The model was saved, but the assistant could not restart. Save that provider token, then turn it off and on again.';
        await stopRuntime();
      }
    }
    return {
      success: true,
      provider: next.provider,
      model: next.model,
      restarted,
      ...(warning ? { warning } : {}),
    };
  });

  ipcMain.handle('ai:transcribe', async (_event, payload) => {
    if (!aiInputState.enabled) {
      return failure('disabled', 'The AI assistant is off.');
    }
    const loaded = keyStore.read(TRANSCRIPTION_SLOT);
    if (!loaded.key) {
      return failure(
        loaded.error === 'unreadable' ? 'key_unreadable' : 'key_missing',
        loaded.error === 'unreadable'
          ? 'The saved Groq Whisper key could not be read. Enter it again.'
          : 'Add your Groq Whisper key on the AI page.',
      );
    }
    const result = await transcribe({
      key: loaded.key,
      audio: payload && payload.audio,
      mimeType: payload && payload.mimeType,
      language: payload && payload.language,
      fetchImpl,
      fallbackFetchImpl,
    });
    if (!result.success && typeof logger === 'function') {
      logger('[AI transcription] code=' + result.code
        + (result.status ? ' status=' + result.status : '')
        + (result.usedFallback ? ' fallback=chromium' : '')
        + (result.detail ? ' detail=' + result.detail : ''));
    }
    return result;
  });

  ipcMain.handle('ai:chat', async (_event, payload) => {
    if (!aiInputState.enabled) {
      return failure('disabled', 'The AI assistant is off.');
    }

    const message = typeof (payload && payload.message) === 'string'
      ? payload.message.trim() : '';
    if (!message) {
      return failure('empty_message', 'Type or dictate a message first.');
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return failure('message_too_long', 'That message is too long. Keep it under 4,000 characters.');
    }

    /* The renderer owns the signed-in session. These two values are used only
       by the read-only tools and are never written to disk or returned. */
    const authToken = typeof (payload && payload.authToken) === 'string'
      ? payload.authToken.trim() : '';
    const branchId = typeof (payload && payload.branchId) === 'string'
      ? payload.branchId.trim() : '';
    const username = typeof (payload && payload.username) === 'string'
      ? payload.username.trim() : '';
    const conversationId = typeof (payload && payload.conversationId) === 'string'
      ? payload.conversationId.trim() : '';
    if (conversationId.length > MAX_CONVERSATION_CHARS) {
      return failure('conversation_invalid', 'The chat session could not be used. Reload the page and try again.');
    }
    const history = Array.isArray(payload && payload.history)
      ? payload.history.slice(-16).map((item) => ({
          role: item && item.role === 'assistant' ? 'assistant' : 'user',
          content: typeof (item && item.content) === 'string' ? item.content.slice(0, 4000) : '',
        })).filter((item) => item.content)
      : [];
    if (authToken.length > 4096) {
      return failure('auth_invalid', 'Your session could not be used. Sign in again.');
    }
    if (branchId.length > 80) {
      return failure('branch_invalid', 'The active branch could not be used. Choose a branch and try again.');
    }
    if (username.length > 120) {
      return failure('user_invalid', 'Your account could not be used. Sign in again.');
    }

    const settings = keyStore.getSettings();
    const provider = getProvider(settings.provider);
    if (!provider) {
      return failure('provider_invalid', 'Choose a supported model provider.');
    }
    const chatKey = keyStore.read(`provider:${provider.id}`);
    if (!chatKey.key) {
      return failure(
        chatKey.error === 'unreadable' ? 'provider_key_unreadable' : 'provider_key_missing',
        chatKey.error === 'unreadable'
          ? 'The saved provider token could not be read. Enter it again.'
          : 'Save a provider token before turning on chat.',
      );
    }

    try {
      return await runtime.chat({
        message,
        reset: payload && payload.reset === true,
        history,
        authToken,
        branchId,
        username,
        conversationId,
      });
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  ipcMain.handle('ai:attach', async (_event, payload) => {
    if (!aiInputState.enabled) {
      return failure('disabled', 'The AI assistant is off.');
    }
    const conversationId = typeof (payload && payload.conversationId) === 'string'
      ? payload.conversationId.trim() : '';
    if (!conversationId || conversationId.length > MAX_CONVERSATION_CHARS) {
      return failure('conversation_invalid', 'The chat session is missing. Reload the page and try again.');
    }
    const files = payload && Array.isArray(payload.files) ? payload.files : [];
    if (!files.length || files.length > MAX_ATTACHMENTS) {
      return failure('attachment_invalid', `Attach between 1 and ${MAX_ATTACHMENTS} images.`);
    }
    const result = runtime.attach({ conversationId, files });
    if (!result || result.success === false) {
      return failure(result && result.code, result && result.error);
    }
    return result;
  });

  ipcMain.handle('ai:remove-attachment', async (_event, payload) => {
    const conversationId = typeof (payload && payload.conversationId) === 'string'
      ? payload.conversationId.trim() : '';
    const id = typeof (payload && payload.id) === 'string' ? payload.id.trim() : '';
    if (!conversationId || !id) {
      return failure('attachment_invalid', 'That image could not be removed.');
    }
    const result = runtime.removeAttachment({ conversationId, id });
    if (!result || result.success === false) {
      return failure(result && result.code, result && result.error);
    }
    return result;
  });

  ipcMain.handle('ai:confirm-plan', async (event, payload) => {
    if (!aiInputState.enabled) {
      return failure('disabled', 'The AI assistant is off.');
    }
    const planId = typeof (payload && payload.planId) === 'string'
      ? payload.planId.trim() : '';
    const conversationId = typeof (payload && payload.conversationId) === 'string'
      ? payload.conversationId.trim() : '';
    const authToken = typeof (payload && payload.authToken) === 'string'
      ? payload.authToken.trim() : '';
    const branchId = typeof (payload && payload.branchId) === 'string'
      ? payload.branchId.trim() : '';
    if (!planId || planId.length > 80) {
      return failure('plan_invalid', 'That change preview is not available. Ask me to prepare it again.');
    }
    if (!conversationId || conversationId.length > MAX_CONVERSATION_CHARS) {
      return failure('conversation_invalid', 'The chat session is missing. Reload the page and try again.');
    }
    if (!authToken || authToken.length > 4096) {
      return failure('auth_required', 'Sign in again before confirming this change.');
    }
    if (!branchId || branchId.length > 80) {
      return failure('branch_invalid', 'Choose a branch before confirming this change.');
    }

    const send = (progress) => {
      try {
        if (event && event.sender && !event.sender.isDestroyed()) {
          event.sender.send('ai:plan-progress', progress);
        }
      } catch (error) {
        /* The window closed while the plan was running. */
      }
    };

    try {
      return await runtime.confirmPlan({
        planId,
        conversationId,
        authToken,
        branchId,
        onProgress: send,
      });
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  ipcMain.handle('ai:cancel-plan', async (_event, payload) => {
    const planId = typeof (payload && payload.planId) === 'string'
      ? payload.planId.trim() : '';
    const conversationId = typeof (payload && payload.conversationId) === 'string'
      ? payload.conversationId.trim() : '';
    if (!planId || !conversationId) {
      return failure('plan_invalid', 'That change preview is not available.');
    }
    try {
      return runtime.cancelPlan({ planId, conversationId });
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  ipcMain.handle('ai:reset-chat', async (_event, payload) => {
    const conversationId = typeof (payload && payload.conversationId) === 'string'
      ? payload.conversationId.trim() : '';
    try {
      await runtime.resetChat({ conversationId });
      return { success: true };
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  if (app && typeof app.once === 'function') {
    app.once('before-quit', () => {
      stopRuntime();
    });
  }

  return aiInputState;
}

module.exports = {
  createAiIpc,
  setupAiIPC: createAiIpc,
  aiInputState,
  runtimeFailure,
};
