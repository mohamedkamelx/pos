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
  isReasoningLevel,
  listProviders,
} = require('./ai/provider-registry');
const {
  MAX_PROVIDER_TOKENS,
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

/* A click on a card arrives as an answer object, never as prose the model
   has to re-read. Only the ids travel: the question, the option and, for an
   image, the attachments that were picked. Anything malformed is dropped so
   the turn falls back to ordinary text instead of deciding on a guess. */
function readChatAnswer(payload) {
  const raw = payload && payload.answer;
  if (!raw || typeof raw !== 'object') return null;
  const clarificationId = typeof raw.clarificationId === 'string'
    ? raw.clarificationId.trim().slice(0, 60) : '';
  if (!clarificationId) return null;
  const answer = { clarificationId };
  if (typeof raw.optionId === 'string') answer.optionId = raw.optionId.trim().slice(0, 40);
  if (typeof raw.slot === 'string') answer.slot = raw.slot.trim().slice(0, 40);
  if (typeof raw.value === 'string') answer.value = raw.value.trim().slice(0, 160);
  if (Array.isArray(raw.attachmentIds)) {
    answer.attachmentIds = raw.attachmentIds
      .map((id) => (typeof id === 'string' ? id.trim().slice(0, 80) : ''))
      .filter(Boolean)
      .slice(0, MAX_ATTACHMENTS);
  }
  return answer;
}

/* The images this message carries. Only the ids the page sent with the
   message are used, so an attachment from an earlier request can never be
   pulled into a plan built now. */
function readAttachedIds(payload) {
  const raw = payload && payload.attachedIds;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((id) => (typeof id === 'string' ? id.trim().slice(0, 80) : ''))
    .filter(Boolean)
    .slice(0, MAX_ATTACHMENTS);
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
  /* The same handlers serve the desktop renderer over IPC and a phone on the
     shop Wi-Fi over the local API. Keeping one map means a phone cannot reach
     a path the desktop does not have, and a new handler is not silently
     desktop-only. */
  const handlers = new Map();
  const handle = (channel, handler) => {
    handlers.set(channel, handler);
    ipcMain.handle(channel, handler);
  };
  const keyStore = createKeyStore({ app, safeStorage });
  const runtime = (runtimeFactory || createOpenCodeRuntime)({
    baseDir: path.join(app.getPath('userData'), 'ai'),
    keyStore,
    logger,
    fetchImpl,
    apiBaseUrl,
  });

  function providerTokens(providerID) {
    return keyStore.providerTokenStatuses(providerID);
  }

  function tokenResponse(providerID) {
    const tokens = providerTokens(providerID);
    const activeToken = keyStore.getActiveProviderToken(providerID);
    const configured = tokens.some((token) => token.configured);
    const active = tokens.find((token) => token.index === activeToken) || tokens[0] || null;
    return {
      configured,
      secure: active ? active.secure : true,
      session: tokens.some((token) => token.session),
      reason: active && active.configured
        ? ''
        : (tokens.find((token) => token.unreadable) ? 'unreadable' : ''),
      tokens,
      tokenCount: tokens.length,
      activeToken,
      backupConfigured: tokens.length > 1,
      backupSecure: active ? active.secure : true,
    };
  }

  function providerStatus() {
    const settings = keyStore.getSettings();
    const provider = getProvider(settings.provider) || getProvider(DEFAULT_PROVIDER);
    const model = getModel(provider.id, settings.model) || provider.models[0];
    return {
      ...tokenResponse(provider.id),
      provider: provider.id,
      providerLabel: provider.label,
      model: model.id,
      modelLabel: model.label,
      reasoning: settings.reasoning,
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

  handle('ai:set-enabled', async (_event, enabled) => {
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
    const slots = keyStore.providerTokenSlots(provider.id);
    const readable = slots
      .map((index) => keyStore.read(providerTokenSlot(provider.id, index)))
      .find((token) => token.key);
    if (!readable) {
      const unreadable = slots
        .map((index) => keyStore.read(providerTokenSlot(provider.id, index)))
        .some((token) => token.error === 'unreadable');
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

  handle('ai:key-status', () => status());

  handle('ai:validate-key', async (_event, raw) => {
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

  handle('ai:save-key', async (_event, raw) => {
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

  handle('ai:clear-key', async () => {
    try {
      keyStore.clear(TRANSCRIPTION_SLOT);
    } catch (error) {
      return failure('key_remove_failed', 'The key file could not be removed.');
    }
    aiInputState.enabled = false;
    await stopRuntime();
    return { success: true, configured: false };
  });

  handle('ai:validate-provider-key', async (_event, payload) => {
    const provider = payload && payload.provider;
    const key = payload && payload.key;
    if (typeof provider !== 'string' || typeof key !== 'string') {
      return failure('provider_key_invalid', 'Enter a valid provider token.');
    }
    return validateProviderKey(provider, key.trim(), fetchImpl);
  });

  handle('ai:save-provider-key', async (_event, payload) => {
    const providerID = payload && payload.provider;
    const provider = getProvider(providerID);
    const key = payload && typeof payload.key === 'string' ? payload.key.trim() : '';
    const requestedIndex = payload && Number.isInteger(payload.index) ? payload.index : null;
    const legacyBackup = !!(payload && payload.backup === true);
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
      if (requestedIndex !== null || legacyBackup) {
        stored = keyStore.setProviderToken(
          provider.id,
          requestedIndex !== null ? requestedIndex : 1,
          key,
        );
      } else {
        stored = keyStore.addProviderToken(provider.id, key);
      }
    } catch (error) {
      return failure('provider_key_save_failed', 'The provider token could not be saved.');
    }
    if (!stored || stored.ok === false) {
      return failure(
        stored && stored.code === 'token_limit' ? 'token_limit' : 'provider_key_save_failed',
        stored && stored.code === 'token_limit'
          ? `You can save up to ${MAX_PROVIDER_TOKENS} provider tokens.`
          : 'The provider token could not be saved.',
      );
    }

    const settings = keyStore.getSettings();
    if (typeof runtime.updateSettings === 'function') runtime.updateSettings(settings);
    const activeToken = keyStore.getActiveProviderToken(provider.id);
    /* Saving the token that is already active must restart so the new secret
       replaces the old one. A new inactive token is picked up on the next turn. */
    let restarted = false;
    let warning = '';
    if (settings.provider === provider.id && runtime.isRunning() &&
        stored.index === activeToken) {
      try {
        await runtime.restart();
        restarted = true;
      } catch (error) {
        warning = 'The token was saved, but the assistant could not restart. Turn it off and on again.';
        await stopRuntime();
      }
    }

    return {
      success: true,
      index: stored.index,
      ...tokenResponse(provider.id),
      provider: provider.id,
      model: settings.model,
      secure: stored.secure,
      session: stored.session,
      restarted,
      ...(warning ? { warning } : {}),
    };
  });

  handle('ai:set-active-provider-key', async (_event, payload) => {
    const provider = getProvider(payload && payload.provider);
    const index = payload && Number.isInteger(payload.index) ? payload.index : -1;
    if (!provider) {
      return failure('provider_invalid', 'Choose a supported model provider.');
    }
    if (!keyStore.setActiveProviderToken(provider.id, index)) {
      return failure('provider_key_missing', 'That provider token is not saved.');
    }

    const settings = keyStore.getSettings();
    let restarted = false;
    let warning = '';
    if (settings.provider === provider.id && runtime.isRunning()) {
      try {
        await runtime.restart();
        restarted = true;
      } catch (error) {
        warning = 'The token was selected, but the assistant could not restart. Turn it off and on again.';
        await stopRuntime();
      }
    }
    return {
      success: true,
      ...tokenResponse(provider.id),
      provider: provider.id,
      restarted,
      ...(warning ? { warning } : {}),
    };
  });

  handle('ai:clear-provider-key', async (_event, payload) => {
    const provider = getProvider(payload && payload.provider);
    const legacyBackup = !!(payload && payload.backup === true);
    const index = payload && Number.isInteger(payload.index)
      ? payload.index
      : (legacyBackup ? 1 : 0);
    if (!provider) {
      return failure('provider_invalid', 'Choose a supported model provider.');
    }
    const previousActive = keyStore.getActiveProviderToken(provider.id);
    let removed;
    try {
      removed = keyStore.removeProviderToken(provider.id, index);
    } catch (error) {
      return failure('provider_key_remove_failed', 'The provider token could not be removed.');
    }
    if (!removed || removed.ok === false) {
      return failure('provider_key_remove_failed', 'The provider token could not be removed.');
    }

    const settings = keyStore.getSettings();
    const summary = tokenResponse(provider.id);
    let restarted = false;
    let warning = '';

    if (settings.provider === provider.id && runtime.isRunning() &&
        (previousActive === index || !summary.configured)) {
      if (!summary.configured) {
        await stopRuntime();
        warning = 'The provider token was removed. Save a token before turning chat on again.';
      } else {
        try {
          await runtime.restart();
          restarted = true;
        } catch (error) {
          warning = 'The token was removed, but the assistant could not restart. Turn it off and on again.';
          await stopRuntime();
        }
      }
    }

    return {
      success: true,
      index,
      ...summary,
      provider: provider.id,
      restarted,
      ...(warning ? { warning } : {}),
    };
  });

  handle('ai:set-provider-model', async (_event, payload) => {
    const provider = getProvider(payload && payload.provider);
    if (!provider) {
      return failure('provider_invalid', 'Choose a supported model provider.');
    }
    const model = getModel(provider.id, payload && payload.model);
    if (!model) {
      return failure('model_unavailable', 'Choose a model this provider offers.');
    }

    const current = keyStore.getSettings();
    const next = keyStore.setSettings({
      provider: provider.id,
      model: model.id,
      reasoning: current.reasoning,
    });
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
      reasoning: next.reasoning,
      restarted,
      ...(warning ? { warning } : {}),
    };
  });

  handle('ai:set-reasoning', async (_event, payload) => {
    const requested = String((payload && payload.reasoning) || '').trim().toLowerCase();
    if (!isReasoningLevel(requested)) {
      return failure('reasoning_invalid', 'Choose a valid thinking level.');
    }

    const current = keyStore.getSettings();
    const next = keyStore.setSettings({ ...current, reasoning: requested });
    if (typeof runtime.updateSettings === 'function') runtime.updateSettings(next);
    let restarted = false;
    let warning = '';
    if (runtime.isRunning()) {
      try {
        await runtime.restart();
        restarted = true;
      } catch (error) {
        warning = 'The thinking level was saved, but the assistant could not restart. Turn it off and on again.';
        await stopRuntime();
      }
    }
    return {
      success: true,
      reasoning: next.reasoning,
      restarted,
      ...(warning ? { warning } : {}),
    };
  });

  handle('ai:transcribe', async (_event, payload) => {
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

  handle('ai:chat', async (_event, payload) => {
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
    const slots = keyStore.providerTokenSlots(provider.id);
    const activeIndex = keyStore.getActiveProviderToken(provider.id);
    let chatKey = keyStore.read(providerTokenSlot(provider.id, activeIndex));
    if (!chatKey.key) {
      const fallback = slots.find((index) => keyStore.read(providerTokenSlot(provider.id, index)).key);
      if (fallback !== undefined) {
        keyStore.setActiveProviderToken(provider.id, fallback);
        chatKey = keyStore.read(providerTokenSlot(provider.id, fallback));
      }
    }
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
        answer: readChatAnswer(payload),
        attachedIds: readAttachedIds(payload),
        authToken,
        branchId,
        username,
        conversationId,
        onProgress: (progress) => {
          /* Progress is advisory. A closed window or a failed send must not
             turn a working request into an error. */
          try {
            const sender = _event && _event.sender;
            if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) return;
            sender.send('ai:chat-progress', {
              conversationId,
              stage: String((progress && progress.stage) || ''),
              at: Number(progress && progress.at) || Date.now(),
            });
          } catch (error) {
            /* no UI to update */
          }
        },
      });
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  handle('ai:attach', async (_event, payload) => {
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

  handle('ai:remove-attachment', async (_event, payload) => {
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

  handle('ai:confirm-plan', async (event, payload) => {
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

  handle('ai:cancel-plan', async (_event, payload) => {
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

  handle('ai:reset-chat', async (_event, payload) => {
    const conversationId = typeof (payload && payload.conversationId) === 'string'
      ? payload.conversationId.trim() : '';
    try {
      await runtime.resetChat({ conversationId });
      return { success: true };
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  /*
   * The local API is a second door to the same room.
   *
   * A phone on the shop Wi-Fi has no electronAPI, so it cannot use the IPC
   * bridge. The API server runs in this same main process; this object lets
   * its authenticated /ai routes call the exact handlers above instead of
   * duplicating the key store, provider calls or runtime.
   *
   * Only the API process can see this. It is never exposed to a page, and a
   * request still passes the API's session and branch-write checks first.
   */
  const bridge = {
    invoke(channel, payload, event) {
      const handler = handlers.get(channel);
      if (!handler) {
        return failure('bridge_unknown', 'That assistant action is not available.');
      }
      const safeEvent = event || {
        sender: { isDestroyed: () => true, send: () => {} },
      };
      return handler(safeEvent, payload);
    },
  };
  aiInputState.bridge = bridge;
  if (typeof global !== 'undefined') {
    global.__posnicAiBridge = bridge;
  }

  if (app && typeof app.once === 'function') {
    app.once('before-quit', () => {
      if (typeof global !== 'undefined' && global.__posnicAiBridge === bridge) {
        global.__posnicAiBridge = null;
      }
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
