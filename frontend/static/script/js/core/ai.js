/*
 * AI assistant page.
 *
 * The page owns the conversation and the microphone button. Everything
 * sensitive stays in the main process: the two credentials, the transcription
 * request, the embedded assistant runtime and the history bound. This file
 * only collects a clip, asks the bridge for a transcript, and shows the reply.
 *
 * The feature is off by default. Turning it on is the only thing that lets the
 * desktop permission handler grant the microphone. The keys belong to the
 * shop's own Groq and model-provider accounts, not to Posnic.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'ai_assistant_settings';
  var MAX_SECONDS = 30;
  var MAX_MESSAGE_CHARS = 4000;
  var MAX_ATTACHMENTS = 8;
  var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  var MAX_AUDIO_BYTES = 12 * 1024 * 1024;
  var IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/bmp'];
  var REASONING_LEVELS = ['low', 'medium', 'high'];

  /* Used when the main process does not return a provider list yet. The ids
     are the contract's stable model ids, not display-only guesses. */
  var FALLBACK_PROVIDERS = [
    {
      id: 'groq',
      label: 'Groq',
      models: [
        { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
        { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
        { id: 'qwen/qwen3.8-27b', label: 'Qwen3.8 27B' }
      ]
    },
    {
      id: 'nvidia',
      label: 'NVIDIA',
      models: [
        { id: 'moonshotai/kimi-k3.1-pro', label: 'moonshotai/kimi-k3.1-pro' },
        { id: 'mistralai/mistral-large-4-1t-a52b', label: 'mistralai/mistral-large-4-1t-a52b' }
      ]
    }
  ];

  var state = {
    initialized: false,
    enabled: false,
    httpBridge: true,
    setupOpen: false,
    busy: false,
    recording: false,
    messages: [],
    stream: null,
    recorder: null,
    chunks: [],
    timer: null,
    autoStop: null,
    startedAt: 0,
    cancelled: false,
    transcriptionBusy: false,
    providerBusy: false,
    reasoningBusy: false,
    selectionSeq: 0,
    chatGeneration: 0,
    conversationId: '',
    attachments: [],
    attachmentBusy: false,
    /* The card option that opened the picker, held until a file is chosen:
       the file itself is the answer to that question. */
    pendingChoice: null,
    /* Images picked since the last message was sent. Only these travel as
       the message's attachments, so a picture used for one product can never
       be pulled into the plan of the next one. */
    pendingAttachmentIds: [],
    planBusy: false,
    offPlanProgress: null,
    offChatProgress: null,
    transcription: {
      configured: false,
      secure: true,
      session: false,
      unreadable: false
    },
    chat: {
      configured: false,
      provider: '',
      model: '',
      providerLabel: '',
      modelLabel: '',
      secure: true,
      session: false,
      unreadable: false,
      tokens: [],
      tokenCount: 0,
      activeToken: 0,
      reasoning: 'medium'
    },
    providers: [],
    provider: '',
    model: ''
  };

  var el = {};

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

  function secureVoiceUrl() {
    var location = global.location;
    if (!location || !location.hostname) return '';
    if (location.protocol === 'https:') return '';
    return 'https://' + location.hostname + ':5443/';
  }

  function hasIpc() {
    return !!(global.electronAPI && global.electronAPI.ai &&
      typeof global.electronAPI.ai.keyStatus === 'function' &&
      typeof global.electronAPI.ai.setEnabled === 'function' &&
      typeof global.electronAPI.ai.chat === 'function' &&
      typeof global.electronAPI.ai.transcribe === 'function');
  }

  /*
   * A phone has no electronAPI. The till's API exposes the same assistant
   * behind the signed-in session, so the page can still use it on the shop
   * Wi-Fi. The flag is cleared after a 503 from a standalone API, which keeps
   * the desktop-only note for a plain browser preview.
   */
  function hasHttpBridge() {
    return !hasIpc() &&
      state.httpBridge !== false &&
      !!global.location &&
      /^https?:$/.test(global.location.protocol);
  }

  function hasBridge() {
    return hasIpc() || hasHttpBridge();
  }

  function httpRequest(path, body) {
    var headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      var token = sessionToken();
      if (token) headers.Authorization = 'Bearer ' + token;
    } catch (error) { /* storage can be unavailable */ }
    try {
      if (PosnicPro.csrfToken) headers['X-XSRF-TOKEN'] = PosnicPro.csrfToken;
    } catch (error) { /* older page boot */ }
    try {
      var branch = activeBranch();
      if (branch) headers['X-Branch-Id'] = branch;
    } catch (error) { /* no branch yet */ }

    return global.fetch('/ai/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (response) {
      try {
        var fresh = response.headers && response.headers.get && response.headers.get('X-CSRF-TOKEN');
        if (fresh) PosnicPro.csrfToken = fresh;
      } catch (error) { /* token is optional on a read */ }
      return response.json().catch(function () {
        return { success: false, code: 'bad_response', error: 'The assistant did not answer.' };
      }).then(function (data) {
        if (response.status === 503 && data && data.code === 'bridge_unavailable') {
          state.httpBridge = false;
        }
        return data;
      });
    }).catch(function () {
      return {
        success: false,
        code: 'network_error',
        error: t('lang_ai_network', 'Could not reach the provider. Check the internet connection.'),
      };
    });
  }

  /* JSON cannot carry an ArrayBuffer, so the HTTP bridge sends the clip as
     base64 and the API decodes it back to a Buffer for the transcriber. */
  function base64Audio(payload) {
    var audio = payload && payload.audio;
    if (!audio || typeof audio === 'string') return payload;
    var bytes;
    if (audio instanceof ArrayBuffer ||
        Object.prototype.toString.call(audio) === '[object ArrayBuffer]') {
      bytes = new Uint8Array(audio);
    } else if (ArrayBuffer.isView(audio)) {
      bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
    } else {
      return payload;
    }
    var binary = '';
    var chunk = 0x8000;
    for (var offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
    }
    return Object.assign({}, payload, {
      audio: global.btoa(binary),
      audioEncoding: 'base64',
    });
  }

  var httpApi = {
    keyStatus: function () { return httpRequest('status'); },
    setEnabled: function (enabled) { return httpRequest('enabled', { enabled: enabled === true }); },
    chat: function (payload) { return httpRequest('chat', payload || {}); },
    transcribe: function (payload) { return httpRequest('transcribe', base64Audio(payload || {})); },
    attach: function (payload) { return httpRequest('attach', payload || {}); },
    removeAttachment: function (payload) { return httpRequest('remove-attachment', payload || {}); },
    resetChat: function (payload) { return httpRequest('reset-chat', payload || {}); },
    confirmPlan: function (payload) { return httpRequest('confirm-plan', payload || {}); },
    cancelPlan: function (payload) { return httpRequest('cancel-plan', payload || {}); },
    setReasoning: function (reasoning) { return httpRequest('reasoning', { reasoning: reasoning }); },
    setProviderModel: function (provider, model) {
      return httpRequest('provider-model', { provider: provider, model: model });
    },
  };

  function api() {
    return hasIpc() ? global.electronAPI.ai : httpApi;
  }

  function canAttach() {
    return !!(hasBridge() && api() && typeof api().attach === 'function');
  }

  function newConversationId() {
    return 'conv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function loadSettings() {
    var raw = null;
    try { raw = PosnicPro.local.get(STORAGE_KEY); } catch (error) { raw = null; }
    var parsed = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch (error) { parsed = {}; }
    state.enabled = !!(parsed && parsed.enabled === true);
  }

  function saveSettings() {
    try {
      PosnicPro.local.set(STORAGE_KEY, JSON.stringify({ enabled: state.enabled }));
    } catch (error) {
      /* A locked-down browser can refuse storage; the page still works. */
    }
  }

  function setStatus(text, isError) {
    hideRetry();
    if (!el.status) return;
    el.status.textContent = text || '';
    el.status.className = 'small ' + (isError ? 'text-danger' : 'text-muted');
  }

  /* The runtime reports what it is doing while a slow model is still working.
     A stale event from an earlier chat must not repaint this one. */
  function showChatProgress(progress) {
    if (!state.busy) return;
    if (!progress || progress.conversationId !== state.conversationId) return;
    var stage = String(progress.stage || '');
    var labels = {
      understanding: ['lang_ai_progress_understanding', 'Reading your request...'],
      reading_shop: ['lang_ai_progress_reading', 'Checking live shop data...'],
      preparing_plan: ['lang_ai_progress_planning', 'Preparing the steps...'],
      waiting_model: ['lang_ai_progress_waiting', 'Waiting for the assistant...'],
      working: ['lang_ai_progress_working', 'Working on it...'],
      slow: ['lang_ai_progress_slow', 'Still working. The model is taking longer than usual.']
    };
    if (stage === 'done' || !labels[stage]) return;
    setStatus(t(labels[stage][0], labels[stage][1]));
  }

  function showRetry() {
    if (el.retry) el.retry.hidden = false;
  }

  function hideRetry() {
    if (el.retry) el.retry.hidden = true;
  }

  function setSetupStatus(text) {
    if (!el.setupStatus) return;
    el.setupStatus.textContent = text || '';
  }

  function setSetupError(text) {
    if (!el.setupError) return;
    el.setupError.textContent = text || '';
    el.setupError.hidden = !text;
  }

  function setConnectionStatus(text, isError) {
    if (!el.connectionStatus) return;
    el.connectionStatus.textContent = text || '';
    el.connectionStatus.className = 'small d-block mt-2 ' + (isError ? 'text-danger' : 'text-muted');
  }

  function setStateText(node, text, isError) {
    if (!node) return;
    node.textContent = text || '';
    node.className = 'small d-block ' + (isError ? 'text-danger' : 'text-muted');
  }

  function formatTime(seconds) {
    var total = Math.max(0, Math.floor(seconds));
    return '0:' + (total < 10 ? '0' : '') + total;
  }

  function messageFor(result, context) {
    var modelEntry = context === 'chat'
      ? ['lang_ai_model_unavailable_chat', 'The selected model is not available for this provider. Choose another model.']
      : ['lang_ai_model_unavailable', 'The Groq transcription model is not available. Try again later.'];
    var map = {
      disabled: ['lang_ai_disabled', 'Turn the assistant on first.'],
      key_missing: ['lang_ai_key_missing', 'Add your Groq Whisper key first.'],
      key_invalid: ['lang_ai_key_invalid', 'Groq did not accept that key.'],
      key_unreadable: ['lang_ai_key_unreadable', 'The saved key could not be read. Enter it again.'],
      key_save_failed: ['lang_ai_key_save_failed', 'The key could not be saved on this computer.'],
      key_required: ['lang_ai_key_required', 'Add your own Groq key to turn the assistant on.'],
      provider_key_missing: ['lang_ai_provider_key_required', 'Enter the provider token.'],
      provider_key_required: ['lang_ai_provider_key_required', 'Enter the provider token.'],
      provider_key_invalid: ['lang_ai_provider_key_invalid', 'The provider did not accept that token.'],
      provider_key_save_failed: ['lang_ai_provider_key_save_failed', 'The provider token could not be saved on this computer.'],
      provider_key_unreadable: ['lang_ai_key_unreadable', 'The saved provider token could not be read. Enter it again.'],
      provider_missing: ['lang_ai_provider_missing', 'No provider token saved.'],
      token_limit: ['lang_ai_token_limit', 'The token limit was reached. Remove a token first.'],
      token_invalid: ['lang_ai_token_required', 'Enter a token.'],
      token_required: ['lang_ai_token_required', 'Enter a token.'],
      token_save_failed: ['lang_ai_token_save_failed', 'The token could not be saved on this computer.'],
      token_switch_failed: ['lang_ai_token_switch_failed', 'The token could not be selected.'],
      token_remove_failed: ['lang_ai_token_remove_failed', 'The token could not be removed.'],
      provider_error: ['lang_ai_provider_error', 'The provider could not answer. Try again.'],
      provider_unavailable: ['lang_ai_provider_error', 'The provider could not answer. Try again.'],
      request_too_large: ['lang_ai_request_too_large', 'The provider limits one request to about 8,000 tokens. Start a new chat, lower the thinking level, or choose a provider with a larger request limit.'],
      provider_model_unavailable: modelEntry,
      model_unavailable: modelEntry,
      model_unavailable_chat: modelEntry,
      reasoning_invalid: ['lang_ai_reasoning_invalid', 'Choose a valid thinking level.'],
      runtime_starting: ['lang_ai_runtime_starting', 'The assistant is still starting. Try again in a moment.'],
      runtime_failed: ['lang_ai_runtime_failed', 'The assistant could not start. Try again.'],
      runtime_error: ['lang_ai_runtime_failed', 'The assistant could not start. Try again.'],
      chat_timeout: ['lang_ai_chat_timeout', 'The assistant took too long to answer. Try again.'],
      request_timeout: ['lang_ai_chat_timeout', 'The assistant took too long to answer. Try again.'],
      rate_limited: ['lang_ai_rate_limited', 'The provider limit was reached. Try again in about {minutes} minutes.'],
      network_error: ['lang_ai_network', 'Could not reach the provider. Check the internet connection.'],
      empty_message: [null, 'Type or dictate a message first.'],
      empty_transcript: ['lang_ai_empty_transcript', 'No speech was recognised. Try again a little closer to the microphone.'],
      empty_recording: ['lang_ai_empty_transcript', 'No speech was recognised. Try again a little closer to the microphone.'],
      audio_unsupported: ['lang_ai_audio_failed', 'That recording could not be read. Try again.'],
      too_large: ['lang_ai_too_large', 'That recording is too large. Keep it under 30 seconds.'],
      empty_reply: ['lang_ai_empty_reply', 'The assistant returned an empty reply. Try again.'],
      message_too_long: ['lang_ai_message_too_long', 'That message is too long. Keep it under 4,000 characters.'],
      mic_denied: ['lang_ai_mic_denied', 'Microphone access was not allowed. You can still type.'],
      mic_busy: ['lang_ai_mic_busy', 'The microphone is being used by another application.'],
      mic_unavailable: ['lang_ai_mic_unavailable', 'No microphone was found.'],
      recorder_failed: ['lang_ai_recorder_failed', 'The recording stopped unexpectedly. Try again.'],
      attachment_invalid: ['lang_ai_attach_failed', 'That image could not be attached.'],
      attachment_type: ['lang_ai_attachment_type', 'Choose a PNG, JPEG, GIF or BMP image.'],
      attachment_too_large: ['lang_ai_attachment_too_large', 'Each image must be 5 MB or smaller.'],
      attachments_too_large: ['lang_ai_attachment_too_large', 'Each image must be 5 MB or smaller.'],
      too_many_attachments: ['lang_ai_too_many_images', 'Attach up to 8 images.'],
      attachment_missing: ['lang_ai_attachment_missing', 'That image is no longer available. Attach it again.'],
      plan_not_found: ['lang_ai_plan_expired', 'That change expired. Ask me to prepare it again.'],
      plan_expired: ['lang_ai_plan_expired', 'That change expired. Ask me to prepare it again.'],
      plan_running: ['lang_ai_plan_running', 'That change is already running.'],
      plan_cancelled: ['lang_ai_plan_cancelled', 'That change was cancelled.'],
      plan_invalid: ['lang_ai_plan_expired', 'That change is no longer available.'],
      conversation_invalid: ['lang_ai_failed', 'The chat session could not be used. Reload the page and try again.']
    };
    /* The main process may still use the shorter key_* codes for the chat
       provider. Keep the transcription wording out of chat replies. */
    if (context === 'chat') {
      map.key_missing = map.provider_key_missing;
      map.key_invalid = map.provider_key_invalid;
      map.key_unreadable = map.provider_key_unreadable;
      map.key_save_failed = map.provider_key_save_failed;
      map.key_required = map.provider_key_required;
    }
    if (result && result.code === 'rate_limited' && Number(result.retryAfterMs) > 0) {
      var minutes = Math.max(1, Math.ceil(Number(result.retryAfterMs) / 60000));
      var rateText = t('lang_ai_rate_limited', map.rate_limited[1]);
      if (rateText.indexOf('{minutes}') !== -1) {
        return rateText.replace(/\{minutes\}/g, String(minutes));
      }
      return rateText;
    }
    var entry = result && map[result.code];
    if (entry) return entry[0] ? t(entry[0], entry[1]) : entry[1];
    if (result && result.error) return result.error;
    return t('lang_ai_failed', 'The assistant could not answer. Try again.');
  }

  function micError(error) {
    var name = error && error.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return t('lang_ai_mic_denied', 'Microphone access was not allowed. You can still type.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return t('lang_ai_mic_unavailable', 'No microphone was found.');
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return t('lang_ai_mic_busy', 'The microphone is being used by another application.');
    }
    return t('lang_ai_recorder_failed', 'The recording stopped unexpectedly. Try again.');
  }

  function normalizeProvider(raw) {
    if (!raw || !raw.id) return null;
    var models = [];
    var rawModels = Array.isArray(raw.models) ? raw.models : [];
    rawModels.forEach(function (model) {
      if (!model) return;
      if (typeof model === 'string') {
        models.push({ id: model, label: model });
        return;
      }
      if (!model.id) return;
      models.push({ id: String(model.id), label: String(model.label || model.id) });
    });
    return {
      id: String(raw.id),
      label: String(raw.label || raw.id),
      models: models
    };
  }

  function hasModel(provider, modelId) {
    if (!provider || !modelId) return false;
    for (var index = 0; index < provider.models.length; index += 1) {
      if (provider.models[index].id === modelId) return true;
    }
    return false;
  }

  function mergeProviders(rawList) {
    var out = [];
    function addProvider(raw) {
      var provider = normalizeProvider(raw);
      if (!provider) return;
      var existing = null;
      for (var index = 0; index < out.length; index += 1) {
        if (out[index].id === provider.id) {
          existing = out[index];
          break;
        }
      }
      if (!existing) {
        out.push(provider);
        return;
      }
      if (provider.label && provider.label !== provider.id) existing.label = provider.label;
      provider.models.forEach(function (model) {
        if (!hasModel(existing, model.id)) existing.models.push(model);
      });
    }
    if (Array.isArray(rawList)) rawList.forEach(addProvider);
    if (!out.length) FALLBACK_PROVIDERS.forEach(addProvider);
    return out;
  }

  function findProvider(id) {
    if (!id) return null;
    for (var index = 0; index < state.providers.length; index += 1) {
      if (state.providers[index].id === id) return state.providers[index];
    }
    return null;
  }

  function firstModelId(providerId) {
    var provider = findProvider(providerId);
    return provider && provider.models.length ? provider.models[0].id : '';
  }

  function ensureProvider(id, label, model, modelLabel) {
    if (!id) return null;
    var provider = findProvider(id);
    if (!provider) {
      provider = { id: id, label: label || id, models: [] };
      state.providers.push(provider);
    } else if (label && (!provider.label || provider.label === provider.id)) {
      provider.label = label;
    }
    if (model && !hasModel(provider, model)) {
      provider.models.push({ id: model, label: modelLabel || model });
    }
    return provider;
  }

  function labelForProvider(id) {
    if (state.chat.provider === id && state.chat.providerLabel) return state.chat.providerLabel;
    var provider = findProvider(id);
    return provider ? provider.label : (id || '');
  }

  function labelForModel(providerId, modelId) {
    if (state.chat.model === modelId && state.chat.modelLabel) return state.chat.modelLabel;
    var provider = findProvider(providerId);
    if (!provider || !modelId) return modelId || '';
    for (var index = 0; index < provider.models.length; index += 1) {
      if (provider.models[index].id === modelId) return provider.models[index].label || modelId;
    }
    return modelId;
  }

  function renderProviderOptions() {
    if (!el.provider) return;
    el.provider.textContent = '';
    state.providers.forEach(function (provider) {
      var option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label || provider.id;
      el.provider.append(option);
    });
    if (!state.provider && state.providers.length) {
      state.provider = state.providers[0].id;
    }
    if (state.provider) el.provider.value = state.provider;
  }

  function renderModelOptions() {
    if (!el.model) return;
    var provider = findProvider(state.provider);
    var models = provider ? provider.models.slice() : [];
    if (state.model && !hasModel({ models: models }, state.model)) {
      models.push({ id: state.model, label: state.chat.modelLabel || state.model });
    }
    el.model.textContent = '';
    models.forEach(function (model) {
      var option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.label || model.id;
      el.model.append(option);
    });
    if (!state.model && models.length) state.model = models[0].id;
    if (state.model) el.model.value = state.model;
    el.model.disabled = !models.length;
  }

  function chatConfiguredForSelection() {
    return !!(state.chat.configured &&
      (!state.chat.provider || state.chat.provider === state.provider));
  }

  function credentialsReady() {
    return !!(state.transcription.configured && chatConfiguredForSelection() && state.provider);
  }

  function updateTranscriptionState() {
    var text;
    var isError = false;
    if (!state.transcription.configured) {
      if (state.transcription.unreadable) {
        text = t('lang_ai_key_unreadable', 'The saved key could not be read. Enter it again.');
        isError = true;
      } else {
        text = t('lang_ai_transcription_missing', 'No speech key saved.');
      }
    } else if (state.transcription.session || !state.transcription.secure) {
      text = t('lang_ai_key_session', 'No secure keystore is available. The key stays only until Posnic quits.');
    } else {
      text = t('lang_ai_transcription_saved', 'Speech key saved on this computer.');
    }
    setStateText(el.transcriptionState, text, isError);
  }

  function updateProviderState() {
    var configured = chatConfiguredForSelection() && state.chat.tokenCount > 0;
    var text;
    var isError = false;
    if (!configured) {
      if (state.chat.unreadable) {
        text = t('lang_ai_key_unreadable', 'The saved provider token could not be read. Enter it again.');
        isError = true;
      } else {
        text = t('lang_ai_provider_missing', 'No provider token saved.');
      }
    } else if (state.chat.session || !state.chat.secure) {
      text = t('lang_ai_provider_key_session', 'No secure keystore is available. The provider token stays only until Posnic quits.');
    } else {
      text = t('lang_ai_provider_saved', 'Provider tokens saved on this computer.');
    }
    setStateText(el.settingsTokenState, text, isError);
    renderTokens();
  }

  function tokenLabel(position) {
    return t('lang_ai_token_label', 'Token {number}').replace(/\{number\}/g, String(position + 1));
  }

  function renderTokenList(container) {
    if (!container) return;
    container.textContent = '';
    if (!state.chat.tokenCount) {
      var empty = document.createElement('small');
      empty.className = 'text-muted d-block';
      empty.textContent = t('lang_ai_token_none', 'No provider token saved.');
      container.append(empty);
      return;
    }
    state.chat.tokens.forEach(function (token, position) {
      var row = document.createElement('div');
      row.className = 'd-flex align-items-center justify-content-between border rounded px-2 py-1 mb-1';
      var label = document.createElement('span');
      label.className = 'small';
      label.textContent = tokenLabel(position);
      if (token.index === state.chat.activeToken) {
        var badge = document.createElement('span');
        badge.className = 'badge badge-primary ml-2';
        badge.textContent = t('lang_ai_token_active', 'Active');
        label.append(badge);
      }
      row.append(label);
      if (hasIpc()) {
        var actions = document.createElement('span');
        if (token.index !== state.chat.activeToken) {
          var use = document.createElement('button');
          use.type = 'button';
          use.className = 'btn btn-link p-0 mr-2 small';
          use.textContent = t('lang_ai_token_use', 'Use');
          use.disabled = state.providerBusy;
          use.addEventListener('click', function () { useProviderToken(token.index); });
          actions.append(use);
        }
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-link p-0 text-danger small';
        remove.textContent = t('lang_ai_token_remove', 'Remove');
        remove.disabled = state.providerBusy;
        remove.addEventListener('click', function () { removeProviderToken(token.index); });
        actions.append(remove);
        row.append(actions);
      }
      container.append(row);
    });
  }

  function renderTokens() {
    renderTokenList(el.settingsTokens);
  }

  function reasoningLabel(level) {
    if (level === 'low') return t('lang_ai_reasoning_low', 'Fast');
    if (level === 'high') return t('lang_ai_reasoning_high', 'Thorough');
    return t('lang_ai_reasoning_medium', 'Balanced');
  }

  function setReasoningState(text, isError) {
    if (!el.reasoningState) return;
    el.reasoningState.textContent = text || '';
    el.reasoningState.className =
      'small d-block mt-2 ' + (isError ? 'text-danger' : 'text-muted');
  }

  function renderReasoning() {
    var index = REASONING_LEVELS.indexOf(state.chat.reasoning);
    if (index < 0) index = 1;
    if (el.reasoning) {
      el.reasoning.value = String(index);
      el.reasoning.disabled = !state.enabled || state.busy || state.reasoningBusy;
    }
    if (el.reasoningValue) {
      el.reasoningValue.textContent = reasoningLabel(state.chat.reasoning);
    }
  }

  function onReasoningInput() {
    if (!el.reasoning) return;
    var level = REASONING_LEVELS[Number(el.reasoning.value)] || 'medium';
    if (el.reasoningValue) el.reasoningValue.textContent = reasoningLabel(level);
  }

  async function saveReasoning() {
    if (!hasBridge() || !el.reasoning || state.reasoningBusy) return;
    if (typeof api().setReasoning !== 'function') return;
    var level = REASONING_LEVELS[Number(el.reasoning.value)] || 'medium';
    if (level === state.chat.reasoning) {
      renderReasoning();
      return;
    }
    var previous = state.chat.reasoning;
    state.reasoningBusy = true;
    updateControls();
    setReasoningState(t('lang_ai_reasoning_saving', 'Saving...'), false);
    try {
      var result = await api().setReasoning(level);
      if (!result || result.success === false) {
        state.chat.reasoning = previous;
        renderReasoning();
        setReasoningState(messageFor(result, 'chat'), true);
        return;
      }
      state.chat.reasoning = REASONING_LEVELS.indexOf(result.reasoning) >= 0
        ? result.reasoning
        : level;
      renderReasoning();
      setReasoningState(
        result.warning || t('lang_ai_reasoning_saved', 'Thinking level saved.'),
        !!result.warning,
      );
    } catch (error) {
      state.chat.reasoning = previous;
      renderReasoning();
      setReasoningState(
        t('lang_ai_reasoning_failed', 'The thinking level could not be saved.'),
        true,
      );
    } finally {
      state.reasoningBusy = false;
      updateControls();
    }
  }

  function updateSetupState() {
    var ready = credentialsReady();
    updateTranscriptionState();
    updateProviderState();
    if (el.turnOn) el.turnOn.disabled = !ready || state.busy;
    if (el.disable) el.disable.hidden = !state.enabled;
    setSetupStatus(ready
      ? t('lang_ai_setup_ready', 'Both credentials are saved. Turn on the assistant when you are ready.')
      : t('lang_ai_setup_incomplete', 'Save both credentials to turn on the assistant.'));
  }

  function applyStatus(status, resetSelection) {
    status = status || {};
    var transcription = status.transcription || {};
    state.transcription.configured = !!transcription.configured;
    state.transcription.secure = transcription.secure !== false;
    state.transcription.session = !!transcription.session;
    state.transcription.unreadable =
      transcription.reason === 'unreadable' || transcription.unreadable === true;

    var chat = status.chat || {};
    state.chat.configured = !!chat.configured;
    if (chat.provider) state.chat.provider = String(chat.provider);
    else if (resetSelection) state.chat.provider = '';
    if (chat.model) state.chat.model = String(chat.model);
    else if (resetSelection) state.chat.model = '';
    if (chat.providerLabel) state.chat.providerLabel = String(chat.providerLabel);
    else if (resetSelection) state.chat.providerLabel = '';
    if (chat.modelLabel) state.chat.modelLabel = String(chat.modelLabel);
    else if (resetSelection) state.chat.modelLabel = '';
    state.chat.secure = chat.secure !== false;
    state.chat.session = !!chat.session;
    state.chat.unreadable =
      chat.reason === 'unreadable' || chat.unreadable === true;
    state.chat.tokens = Array.isArray(chat.tokens) ? chat.tokens : [];
    state.chat.tokenCount = Number.isInteger(chat.tokenCount)
      ? chat.tokenCount
      : state.chat.tokens.length;
    state.chat.activeToken = Number.isInteger(chat.activeToken)
      ? chat.activeToken
      : (state.chat.tokens[0] ? state.chat.tokens[0].index : 0);
    state.chat.reasoning = REASONING_LEVELS.indexOf(String(chat.reasoning)) >= 0
      ? String(chat.reasoning)
      : 'medium';

    state.providers = mergeProviders(status.providers);
    ensureProvider(state.chat.provider, state.chat.providerLabel, state.chat.model, state.chat.modelLabel);

    if (resetSelection || !state.provider) {
      state.provider = state.chat.provider || (state.providers[0] && state.providers[0].id) || '';
    }
    if (resetSelection || !state.model) {
      state.model = state.chat.model || firstModelId(state.provider) || '';
    }
    ensureProvider(state.provider, '', state.model, state.chat.model === state.model ? state.chat.modelLabel : '');

    renderProviderOptions();
    renderModelOptions();
    renderReasoning();
    updateSetupState();
  }

  function showInitial() {
    el.setupCard.hidden = false;
    el.chatCard.hidden = true;
    el.settingsCard.hidden = true;
    el.enable.hidden = false;
    el.setupForm.hidden = true;
    setSetupError('');
    setSetupStatus('');
  }

  function showSetupForm(focus) {
    el.setupCard.hidden = false;
    el.chatCard.hidden = true;
    el.settingsCard.hidden = false;
    if (el.settingsColumn) {
      el.settingsColumn.classList.add('order-first');
      el.settingsColumn.classList.add('order-xl-last');
    }
    el.enable.hidden = true;
    el.setupForm.hidden = false;
    setSetupError('');
    updateSetupState();
    if (focus === 'transcription' && el.transcriptionKey) {
      setTimeout(function () { el.transcriptionKey.focus(); }, 0);
    } else if (focus === 'provider' && el.settingsTokenKey) {
      setTimeout(function () { el.settingsTokenKey.focus(); }, 0);
    }
  }

  function showChat() {
    el.setupCard.hidden = true;
    el.chatCard.hidden = false;
    el.settingsCard.hidden = false;
    if (el.settingsColumn) {
      el.settingsColumn.classList.remove('order-first');
      el.settingsColumn.classList.add('order-xl-last');
    }
    setSetupError('');
    setConnectionStatus('');
    /* A phone can use the assistant, but the keys stay on the till. Hide
       controls that would only return desktop_only. */
    if (!hasIpc()) {
      if (el.removeKey) el.removeKey.hidden = true;
      if (el.settingsAddGroup) el.settingsAddGroup.hidden = true;
    }
    if (el.disable) el.disable.hidden = !state.enabled;
    renderMessages();
    renderAttachments();
    renderReasoning();
    updateControls();
  }

  function showDesktopOnly() {
    el.setupCard.hidden = false;
    el.chatCard.hidden = true;
    el.settingsCard.hidden = true;
    el.enable.hidden = true;
    el.setupForm.hidden = true;
    setSetupStatus('');
    setSetupError(t('lang_ai_desktop_only', 'The AI assistant is available in the Posnic desktop app.'));
  }

  function showSetupCardError(message) {
    el.setupCard.hidden = false;
    el.chatCard.hidden = true;
    el.settingsCard.hidden = true;
    el.enable.hidden = true;
    el.setupForm.hidden = true;
    setSetupStatus('');
    setSetupError(message);
  }

  async function refresh() {
    if (!hasBridge()) {
      showDesktopOnly();
      return;
    }

    var status;
    try {
      status = await api().keyStatus();
    } catch (error) {
      showSetupCardError(t('lang_ai_failed', 'The assistant could not be loaded. Try again.'));
      return;
    }
    if (status && status.code === 'bridge_unavailable') {
      state.httpBridge = false;
      showDesktopOnly();
      return;
    }
    if (!status || status.success === false) {
      showSetupCardError(status && status.error
        ? status.error
        : t('lang_ai_failed', 'The assistant could not be loaded. Try again.'));
      return;
    }

    applyStatus(status, true);
    var ready = credentialsReady();

    /*
     * The till owns the assistant. A phone follows the till's on/off state
     * instead of writing its own local preference back over it, and it never
     * asks for a key here - the setup form is a desktop action.
     */
    if (hasHttpBridge()) {
      if (!ready) {
        showSetupCardError(t(
          'lang_ai_desktop_setup',
          'Configure the AI assistant in the Posnic desktop app.',
        ));
        return;
      }
      if (status.enabled === true) {
        state.enabled = true;
        saveSettings();
        showChat();
        return;
      }
      if (state.enabled) {
        state.enabled = false;
        saveSettings();
      }
      showInitial();
      return;
    }

    if (state.enabled && ready) {
      var permission = await enableInput();
      if (!permission || permission.success === false || permission.enabled === false) {
        state.enabled = false;
        saveSettings();
        showSetupForm();
        setSetupError(permission
          ? messageFor(permission, 'transcription')
          : t('lang_ai_failed', 'The assistant could not be turned on.'));
        return;
      }
      if (permission.micDenied) {
        setStatus(t('lang_ai_mic_denied', 'Microphone access was not allowed. You can still type.'));
      }
      showChat();
      return;
    }

    if (state.enabled && !ready) {
      state.enabled = false;
      saveSettings();
      if (status && status.enabled === true) {
        try { await api().setEnabled(false); } catch (error) { /* already off */ }
      }
      showSetupForm();
      return;
    }

    if (status && status.enabled === true) {
      try { await api().setEnabled(false); } catch (error) { /* already off */ }
    }

    if (!state.transcription.configured && !state.chat.configured && !state.setupOpen) {
      showInitial();
      return;
    }
    showSetupForm();
  }

  async function enableInput() {
    try {
      return await api().setEnabled(true);
    } catch (error) {
      return { success: false, error: t('lang_ai_failed', 'The assistant could not be turned on.') };
    }
  }

  function revealSetup() {
    if (hasHttpBridge()) {
      if (!credentialsReady()) {
        showSetupCardError(t(
          'lang_ai_desktop_setup',
          'Configure the AI assistant in the Posnic desktop app.',
        ));
        return;
      }
      turnOn();
      return;
    }
    if (!hasIpc()) return;
    state.setupOpen = true;
    showSetupForm(state.transcription.configured ? 'provider' : 'transcription');
  }

  async function turnOn() {
    if (!hasBridge() || state.busy) return;
    if (!credentialsReady()) {
      setSetupStatus(t('lang_ai_setup_incomplete', 'Save both credentials to turn on the assistant.'));
      return;
    }

    setSetupError('');
    if (el.turnOn) el.turnOn.disabled = true;
    var permission = await enableInput();
    if (!permission || permission.success === false || permission.enabled === false) {
      state.enabled = false;
      saveSettings();
      setSetupError(permission
        ? messageFor(permission, 'transcription')
        : t('lang_ai_failed', 'The assistant could not be turned on.'));
      updateSetupState();
      return;
    }

    state.enabled = true;
    state.setupOpen = false;
    saveSettings();
    if (permission.micDenied) {
      setStatus(t('lang_ai_mic_denied', 'Microphone access was not allowed. You can still type.'));
    }
    showChat();
  }

  async function disableFeature() {
    if (state.recording) {
      state.cancelled = true;
      stopRecording();
    }
    state.enabled = false;
    state.setupOpen = true;
    saveSettings();
    if (hasBridge()) {
      try { await api().setEnabled(false); } catch (error) { /* already off */ }
    }
    /* The key fields only work on the till. A phone returns to the initial
       card, where it can turn the assistant back on once the till is set up. */
    if (hasHttpBridge()) {
      showInitial();
      return;
    }
    showSetupForm();
  }

  async function saveTranscriptionKey() {
    if (!hasIpc() || state.transcriptionBusy) return;
    var key = String((el.transcriptionKey && el.transcriptionKey.value) || '').trim();
    if (!key && !state.transcription.configured) {
      setSetupError(t('lang_ai_key_missing', 'Enter your Groq Whisper key.'));
      setStateText(el.transcriptionState, t('lang_ai_key_missing', 'Enter your Groq Whisper key.'), true);
      if (el.transcriptionKey) el.transcriptionKey.focus();
      return;
    }

    state.transcriptionBusy = true;
    setSetupError('');
    setStateText(el.transcriptionState, t('lang_ai_key_checking', 'Checking key...'), false);
    if (el.transcriptionSave) el.transcriptionSave.disabled = true;
    try {
      var result = key
        ? await api().saveKey(key)
        : await api().validateKey('');
      if (!result || !result.success) {
        setStateText(el.transcriptionState, '', false);
        setSetupError(messageFor(result, 'transcription'));
        return;
      }
      if (key && el.transcriptionKey) el.transcriptionKey.value = '';
      state.transcription.configured = result.configured !== false;
      state.transcription.secure = result.secure !== false;
      state.transcription.session = !!result.session;
      state.transcription.unreadable = false;
      updateSetupState();
      } catch (error) {
      setStateText(el.transcriptionState, '', false);
      setSetupError(t('lang_ai_key_save_failed', 'The key could not be saved on this computer.'));
    } finally {
      state.transcriptionBusy = false;
      if (el.transcriptionSave) el.transcriptionSave.disabled = false;
    }
  }

  async function saveProviderKey() {
    if (!hasIpc() || state.providerBusy) return;
    if (!state.provider || !state.model) {
      setStateText(el.settingsTokenState, t('lang_ai_provider_missing', 'No provider token saved.'), true);
      return;
    }

    var key = String((el.settingsTokenKey && el.settingsTokenKey.value) || '').trim();
    if (!key) {
      setStateText(el.settingsTokenState, t('lang_ai_token_required', 'Enter a token.'), true);
      if (el.settingsTokenKey) el.settingsTokenKey.focus();
      return;
    }

    state.providerBusy = true;
    setSetupError('');
    setStateText(el.settingsTokenState, t('lang_ai_token_checking', 'Checking token...'), false);
    if (el.settingsTokenSave) el.settingsTokenSave.disabled = true;
    try {
      var selection = await api().setProviderModel(state.provider, state.model);
      if (!selection || selection.success === false) {
        setStateText(el.settingsTokenState, messageFor(selection, 'chat'), true);
        return;
      }

      var result = await api().saveProviderKey(state.provider, key);
      if (!result || !result.success) {
        setStateText(el.settingsTokenState, messageFor(result, 'chat'), true);
        return;
      }

      if (el.settingsTokenKey) el.settingsTokenKey.value = '';
      var status = await api().keyStatus();
      if (status && status.success !== false) applyStatus(status, false);
      setStateText(
        el.settingsTokenState,
        result.warning || t('lang_ai_token_saved', 'Token saved on this computer.'),
        !!result.warning,
      );
    } catch (error) {
      setStateText(el.settingsTokenState, t('lang_ai_token_save_failed', 'The token could not be saved on this computer.'), true);
    } finally {
      state.providerBusy = false;
      if (el.settingsTokenSave) el.settingsTokenSave.disabled = false;
      renderTokens();
    }
  }

  async function persistSelection() {
    if (!hasIpc() || !state.provider || !state.model) return;
    if (typeof api().setProviderModel !== 'function') return;
    state.selectionSeq += 1;
    var seq = state.selectionSeq;
    try {
      var result = await api().setProviderModel(state.provider, state.model);
      if (seq !== state.selectionSeq) return;
      if (!result || result.success === false) {
        setStateText(el.settingsTokenState,
          result && result.error
            ? result.error
            : t('lang_ai_provider_error', 'The provider could not be updated. Try again.'),
          true);
        return;
      }
      state.chat.provider = result.provider || state.provider;
      state.chat.model = result.model || state.model;
      var status = await api().keyStatus();
      if (seq !== state.selectionSeq) return;
      if (status && status.success !== false) {
        applyStatus(status, false);
      }
    } catch (error) {
      if (seq !== state.selectionSeq) return;
      setStateText(el.settingsTokenState, t('lang_ai_provider_error', 'The provider could not be updated. Try again.'), true);
    }
  }

  function onProviderChange() {
    if (!el.provider) return;
    state.provider = el.provider.value;
    if (state.chat.provider !== state.provider) {
      state.chat.configured = false;
      state.chat.unreadable = false;
    }
    state.model = firstModelId(state.provider);
    renderModelOptions();
    updateSetupState();
    persistSelection();
  }

  function onModelChange() {
    if (!el.model) return;
    state.model = el.model.value;
    updateSetupState();
    persistSelection();
  }

  async function removeTranscription() {
    if (!hasIpc()) return;
    if (state.recording) {
      state.cancelled = true;
      stopRecording();
    }
    var ok = global.confirm
      ? global.confirm(t('lang_ai_remove_key_confirm', 'Remove the saved key from this computer?'))
      : true;
    if (!ok) return;

    try {
      var result = await api().clearKey();
      if (!result || !result.success) {
        setConnectionStatus(result && result.error
          ? result.error
          : t('lang_ai_failed', 'The key could not be removed.'), true);
        return;
      }
      state.transcription.configured = false;
      state.transcription.session = false;
      state.transcription.unreadable = false;
      state.enabled = false;
      state.setupOpen = true;
      saveSettings();
      try { await api().setEnabled(false); } catch (error) { /* already off */ }
      showSetupForm();
      setStateText(el.transcriptionState, t('lang_ai_key_removed', 'Key removed.'), false);
    } catch (error) {
      setConnectionStatus(t('lang_ai_failed', 'The key could not be removed.'), true);
    }
  }

  async function useProviderToken(index) {
    if (!hasIpc() || state.providerBusy) return;
    var provider = state.chat.provider || state.provider;
    if (!provider || typeof api().setActiveProviderKey !== 'function') return;
    state.providerBusy = true;
    renderTokens();
    setConnectionStatus('');
    try {
      var result = await api().setActiveProviderKey(provider, index);
      if (!result || !result.success) {
        setConnectionStatus(result && result.error
          ? result.error
          : t('lang_ai_token_switch_failed', 'The token could not be selected.'), true);
        return;
      }
      var status = await api().keyStatus();
      if (status && status.success !== false) applyStatus(status, false);
      setConnectionStatus(t('lang_ai_token_switched', 'The selected token is active now.'), false);
      if (result.warning) setConnectionStatus(result.warning, true);
    } catch (error) {
      setConnectionStatus(t('lang_ai_token_switch_failed', 'The token could not be selected.'), true);
    } finally {
      state.providerBusy = false;
      renderTokens();
    }
  }

  async function removeProviderToken(index) {
    if (!hasIpc() || state.providerBusy) return;
    var provider = state.chat.provider || state.provider;
    if (!provider) {
      setConnectionStatus(t('lang_ai_provider_key_none', 'No provider token saved.'), true);
      return;
    }
    var ok = global.confirm
      ? global.confirm(t('lang_ai_token_remove_confirm', 'Remove this token from this computer?'))
      : true;
    if (!ok) return;

    state.providerBusy = true;
    renderTokens();
    try {
      var result = await api().clearProviderKey(provider, index);
      if (!result || !result.success) {
        setConnectionStatus(result && result.error
          ? result.error
          : t('lang_ai_token_remove_failed', 'The token could not be removed.'), true);
        return;
      }
      var status = await api().keyStatus();
      if (status && status.success !== false) applyStatus(status, false);
      if (result.warning) setConnectionStatus(result.warning, true);
      else setConnectionStatus(t('lang_ai_token_removed', 'Token removed.'), false);
      if (result.configured === false) {
        state.enabled = false;
        saveSettings();
        try { await api().setEnabled(false); } catch (error) { /* already off */ }
        showSetupForm();
      }
    } catch (error) {
      setConnectionStatus(t('lang_ai_token_remove_failed', 'The token could not be removed.'), true);
    } finally {
      state.providerBusy = false;
      renderTokens();
    }
  }

  function renderAttachments() {
    if (!el.attachments) return;
    el.attachments.textContent = '';
    el.attachments.hidden = !state.attachments.length;
    state.attachments.forEach(function (attachment) {
      var chip = document.createElement('span');
      chip.className = 'posnic-ai-attachment';
      if (attachment.preview) {
        var image = document.createElement('img');
        image.src = attachment.preview;
        image.alt = '';
        chip.append(image);
      }
      var name = document.createElement('span');
      name.className = 'posnic-ai-attachment-name';
      name.textContent = attachment.name || '';
      chip.append(name);
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'posnic-ai-attachment-remove';
      remove.setAttribute('aria-label', t('lang_ai_remove_attachment', 'Remove image'));
      remove.title = t('lang_ai_remove_attachment', 'Remove image');
      remove.textContent = '×';
      remove.addEventListener('click', function () {
        removeAttachment(attachment.id);
      });
      chip.append(remove);
      el.attachments.append(chip);
    });
  }

  function readAttachment(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve({
          name: String(file.name || 'image'),
          mime: String(file.type || ''),
          data: String(reader.result || '')
        });
      };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(file);
    });
  }

  async function attachFiles(files) {
    if (!canAttach() || state.attachmentBusy || state.busy) return;
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    if (state.attachments.length + list.length > MAX_ATTACHMENTS) {
      setStatus(messageFor({ code: 'too_many_attachments' }), true);
      return;
    }
    for (var index = 0; index < list.length; index += 1) {
      var file = list[index];
      if (IMAGE_TYPES.indexOf(String(file.type || '').toLowerCase()) === -1) {
        setStatus(messageFor({ code: 'attachment_type' }), true);
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setStatus(messageFor({ code: 'attachment_too_large' }), true);
        return;
      }
    }

    state.attachmentBusy = true;
    updateControls();
    setStatus(t('lang_ai_attaching', 'Attaching image...'));
    try {
      var payload = await Promise.all(list.map(readAttachment));
      if (payload.some(function (item) { return !item; })) {
        setStatus(messageFor({ code: 'attachment_invalid' }), true);
        return;
      }
      var result = await api().attach({
        conversationId: state.conversationId,
        files: payload
      });
      if (!result || !result.success) {
        setStatus(messageFor(result, 'chat'), true);
        return;
      }
      var saved = Array.isArray(result.attachments) ? result.attachments : [];
      saved.forEach(function (attachment, position) {
        var local = payload[position] || {};
        state.attachments.push({
          id: attachment.id,
          name: attachment.name || local.name || 'image',
          size: attachment.size || 0,
          mime: attachment.mime || local.mime || '',
          preview: local.data || ''
        });
      });
      /* Only the files picked just now are this message's attachments. They
         stay queued until a message actually carries them, and are dropped
         from the queue by that send. */
      state.pendingAttachmentIds = state.pendingAttachmentIds
        .concat(saved.map(function (attachment) { return attachment.id; }))
        .filter(function (id, index, all) {
          return !!id && all.indexOf(id) === index;
        });
      renderAttachments();
      setStatus('');
      /* The operator attached the image the card asked for. That file is the
         answer, so it goes back with the card's ids instead of as a sentence
         about having attached something. */
      var choice = state.pendingChoice;
      if (choice && choice.answer && choice.answer.clarificationId) {
        var ids = state.pendingAttachmentIds.slice();
        if (!ids.length && saved.length) {
          ids = saved.map(function (attachment) { return attachment.id; });
        }
        if (!ids.length) {
          /* Nothing was stored, so there is no image to answer with: report
             the failure and keep the card live instead of claiming an
             attachment that does not exist. */
          setStatus(t('lang_ai_attach_failed', 'That image could not be attached.'), true);
          return;
        }
        state.pendingChoice = null;
        var accepted = await sendMessage(choice.label || t('lang_ai_use_image', 'Use the attached image.'), {
          answer: {
            clarificationId: choice.answer.clarificationId,
            optionId: choice.answer.optionId || '',
            attachmentIds: ids
          }
        });
        /* Retire the card only when the answer actually went out. */
        if (accepted && choice.payload) choice.payload.answered = true;
        return;
      }
      state.pendingChoice = null;
    } catch (error) {
      setStatus(t('lang_ai_attach_failed', 'That image could not be attached.'), true);
    } finally {
      state.attachmentBusy = false;
      updateControls();
    }
  }

  async function removeAttachment(id) {
    if (!canAttach() || !id || state.attachmentBusy) return;
    state.attachmentBusy = true;
    updateControls();
    try {
      var result = await api().removeAttachment({
        conversationId: state.conversationId,
        id: id
      });
      if (!result || !result.success) {
        setStatus(messageFor(result, 'chat'), true);
        return;
      }
      state.attachments = state.attachments.filter(function (attachment) {
        return attachment.id !== id;
      });
      state.pendingAttachmentIds = state.pendingAttachmentIds.filter(function (pending) {
        return pending !== id;
      });
      renderAttachments();
      setStatus('');
    } catch (error) {
      setStatus(t('lang_ai_remove_failed', 'That image could not be removed.'), true);
    } finally {
      state.attachmentBusy = false;
      updateControls();
    }
  }

  async function newChat() {
    var previous = state.conversationId;
    /* Invalidate any reply still in flight so it cannot repaint this chat. */
    state.chatGeneration += 1;
    state.busy = false;
    state.planBusy = false;
    state.messages.length = 0;
    state.attachments = [];
    state.pendingChoice = null;
    state.pendingAttachmentIds = [];
    state.conversationId = newConversationId();
    renderAttachments();
    renderMessages();
    updateControls();
    hideRetry();
    setStatus('');
    if (el.prompt) {
      el.prompt.value = '';
      el.prompt.focus();
    }
    if (hasBridge() && typeof api().resetChat === 'function') {
      try { await api().resetChat({ conversationId: previous }); } catch (error) { /* renderer is already clear */ }
    }
  }

  /* A typed confirmation after a preview is the same decision as pressing
     Confirm. Keep it out of the model: the model may only propose, while the
     main process owns execution. */
  var CONFIRM_COMMANDS = [
    'confirm', 'confirm it', 'confirmed', 'yes confirm', 'yes confirm it',
    'go ahead', 'do it', 'execute', 'run it', 'apply', 'save', 'save it',
    'ok', 'okay', 'تمام', 'تم', 'ماشي', 'حاضر', 'اوك', 'اوكي',
    'تمام نفذ', 'تم نفذ', 'نفذ', 'نفذها', 'نفذ التغييرات',
    'اكد', 'اكدها', 'تاكيد', 'موافق', 'اعتمد', 'قم بالتنفيذ',
    'احفظ', 'احفظها', 'طبق', 'طبقها'
  ];
  var CANCEL_COMMANDS = [
    'cancel', 'cancel it', 'stop', 'do not', "don't",
    'الغاء', 'لا تنفذ', 'الغ التغييرات', 'الغاء التغييرات', 'لا'
  ];

  function normaliseCommand(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[أإآ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/[^\w\u0600-\u06FF\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function planCommand(value) {
    var text = normaliseCommand(value);
    if (!text) return '';
    if (CONFIRM_COMMANDS.indexOf(text) >= 0) return 'confirm';
    if (CANCEL_COMMANDS.indexOf(text) >= 0) return 'cancel';
    return '';
  }

  /* A typed confirm/cancel awaits the API like any other send. It must not
     take state.busy itself - the plan card sets and clears that flag with its
     own guards - so it refuses a second run with a flag of its own. */
  var planCommandRunning = false;

  async function sendMessage(text, options) {
    /* Resolves true only once the request was actually dispatched: the cards
       wait for that answer before retiring themselves, so a refused click
       leaves the card live instead of dying as a dead card. */
    if (state.busy) return false;
    var retry = !!(options && options.retry);
    /* A card click travels as an answer object: the ids of the question and
       the option, never wording the model has to interpret again. */
    var answer = options && options.answer && typeof options.answer === 'object'
      ? options.answer : null;
    if (answer && (!answer.clarificationId || typeof answer.clarificationId !== 'string')) {
      answer = null;
    }
    if (!state.enabled) {
      setStatus(t('lang_ai_disabled', 'Turn the assistant on first.'), true);
      return false;
    }
    if (!chatConfiguredForSelection()) {
      setStatus(t('lang_ai_provider_key_required', 'Enter the provider token.'), true);
      return false;
    }

    var message = typeof text === 'string'
      ? text.trim()
      : String((el.prompt && el.prompt.value) || '').trim();
    if (!message && state.attachments.length) {
      message = t('lang_ai_use_image', 'Use the attached image.');
    }
    if (!message) return false;
    if (message.length > MAX_MESSAGE_CHARS) {
      setStatus(t('lang_ai_message_too_long', 'That message is too long. Keep it under 4,000 characters.'), true);
      return false;
    }
    /* Typing instead of attaching abandons the choice the card offered, so a
       later attachment cannot answer a question the operator walked away
       from. */
    if (!answer) state.pendingChoice = null;

    var pendingPlan = latestPendingPlan();
    /* An answer is a decision for the card, never a plan command: an option
       labelled "confirm" must not run the plan instead of answering. */
    var pendingCommand = !answer && pendingPlan ? planCommand(message) : '';
    if (pendingCommand) {
      /* A second Enter or click while that await is in flight must not run
         the same command twice; the plan card's own busy/planBusy guards take
         over as soon as it is called. */
      if (planCommandRunning) return false;
      planCommandRunning = true;
      try {
        state.messages.push({ role: 'user', text: message, attachments: [] });
        if (state.messages.length === 1 && el.empty) el.empty.remove();
        appendBubble('user', message, true, []);
        if (el.prompt) el.prompt.value = '';
        if (pendingCommand === 'confirm') await confirmPlanCard(pendingPlan);
        else await cancelPlanCard(pendingPlan);
      } finally {
        planCommandRunning = false;
      }
      return true;
    }

    var attachmentNames = state.attachments.map(function (attachment) {
      return attachment.name;
    });
    var history = historyForRequest();
    if (!retry) {
      state.messages.push({ role: 'user', text: message, attachments: attachmentNames });
      if (state.messages.length === 1 && el.empty) el.empty.remove();
      appendBubble('user', message, true, attachmentNames);
      if (el.prompt) el.prompt.value = '';
    }

    var generation = state.chatGeneration;
    state.busy = true;
    updateControls();
    setStatus(t('lang_ai_thinking', 'Thinking...'));

    /* Snapshot the queue before the request leaves: a file attached while this
       turn is in flight must survive the reply, so only what this message
       actually carried is dropped from the queue afterwards. */
    var sentIds = state.pendingAttachmentIds.slice();
    try {
      var result = await api().chat({
        message: message,
        history: history,
        conversationId: state.conversationId,
        answer: answer || undefined,
        attachedIds: sentIds,
        authToken: sessionToken(),
        branchId: activeBranch(),
        username: currentUsername()
      });
      if (generation !== state.chatGeneration) return true;
      if (!result || !result.success) {
        setStatus(messageFor(result, 'chat'), true);
        showRetry();
        return true;
      }
      if (result.provider) state.chat.provider = result.provider;
      if (result.model) state.chat.model = result.model;
      var reply = String(result.text || '').trim();
      var toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
      if (!reply && !toolCalls.length) {
        setStatus(t('lang_ai_empty_reply', 'The assistant returned an empty reply. Try again.'), true);
        showRetry();
        return true;
      }
      /* These ids travelled with this message, so they belong to it now. Ids
         queued while the turn was in flight are kept for the next message. */
      state.pendingAttachmentIds = state.pendingAttachmentIds.filter(function (id) {
        return sentIds.indexOf(id) === -1;
      });
      addMessage('assistant', reply, toolCalls);
      setStatus('');
    } catch (error) {
      if (generation !== state.chatGeneration) return true;
      console.error('[AI] chat request failed in the desktop bridge.', error);
      setStatus(t('lang_ai_failed', 'The assistant could not answer. Try again.'), true);
      showRetry();
    } finally {
      /* A generation change means the view was reset; leave its state alone
         without swallowing the answer the caller is waiting for. */
      if (generation === state.chatGeneration) {
        state.busy = false;
        updateControls();
        renderMessages();
      }
    }
    return true;
  }

  function lastUserMessage() {
    for (var index = state.messages.length - 1; index >= 0; index -= 1) {
      var message = state.messages[index];
      if (message && message.role === 'user' && message.text) return message.text;
    }
    return '';
  }

  async function retryLastMessage() {
    if (state.busy) return;
    var message = lastUserMessage();
    if (!message) return;
    hideRetry();
    await sendMessage(message, { retry: true });
  }

  function sessionToken() {
    try {
      return String(localStorage.getItem('posnic_jwt_token') || '');
    } catch (error) {
      return '';
    }
  }

  function activeBranch() {
    try {
      return String((global.PosnicPro && PosnicPro.local && PosnicPro.local.get('branch_id_set')) || '');
    } catch (error) {
      return '';
    }
  }

  function currentUsername() {
    try {
      return String((global.PosnicPro && PosnicPro.local && PosnicPro.local.get('username')) || '');
    } catch (error) {
      return '';
    }
  }

  function historyForRequest() {
    return state.messages.slice(-16).map(function (message) {
      return { role: message.role, content: message.text };
    });
  }

  function renderMessages() {
    if (!el.messages) return;
    el.messages.textContent = '';
    if (!state.messages.length) {
      if (el.empty) el.messages.append(el.empty);
      return;
    }
    state.messages.forEach(function (message) {
      if (message.text) appendBubble(message.role, message.text, false, message.attachments);
      if (message.toolCalls && message.toolCalls.length) appendToolCards(message.toolCalls, false);
    });
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function appendBubble(role, text, scroll, attachments) {
    if (!el.messages) return;
    var row = document.createElement('div');
    row.className = 'posnic-ai-message posnic-ai-message--' + (role === 'user' ? 'user' : 'assistant');
    var bubble = document.createElement('div');
    bubble.className = 'posnic-ai-bubble';
    bubble.textContent = String(text || '');
    if (Array.isArray(attachments) && attachments.length) {
      var files = document.createElement('div');
      files.className = 'posnic-ai-bubble-files';
      files.textContent = t('lang_ai_images_label', 'Images') + ': ' + attachments.join(', ');
      bubble.append(files);
    }
    row.append(bubble);
    el.messages.append(row);
    if (scroll !== false) el.messages.scrollTop = el.messages.scrollHeight;
  }

  /* Objects that cross Electron's contextBridge arrive frozen. Keep the
     conversation's own mutable copy so progress and confirmation can update a
     plan card without touching the bridge object. */
  function cloneValue(value) {
    if (typeof global.structuredClone === 'function') {
      try {
        return global.structuredClone(value);
      } catch (error) {
        /* Fall through for plain JSON data. */
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function addMessage(role, text, toolCalls) {
    var message = {
      role: role,
      text: String(text || '').trim(),
      toolCalls: Array.isArray(toolCalls) ? cloneValue(toolCalls) : []
    };
    if (!message.text && !message.toolCalls.length) return;
    state.messages.push(message);
    if (state.messages.length === 1 && el.empty) el.empty.remove();
    if (message.text) appendBubble(message.role, message.text);
    if (message.toolCalls.length) appendToolCards(message.toolCalls);
  }

  function appendToolCards(toolCalls, scroll) {
    if (!el.messages || !toolCalls || !toolCalls.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'posnic-ai-tools';
    toolCalls.forEach(function (call) {
      var card = buildToolCard(call);
      if (card) wrap.append(card);
    });
    if (!wrap.children.length) return;
    el.messages.append(wrap);
    if (scroll !== false) el.messages.scrollTop = el.messages.scrollHeight;
  }

  function toolPayload(call) {
    if (!call || !call.metadata || typeof call.metadata !== 'object') return null;
    return call.metadata.posnic || null;
  }

  function buildToolCard(call) {
    var payload = toolPayload(call);
    /* An internal correction is for the model, not the user. The assistant
       retries immediately, so showing its error would be noise. */
    if (payload && payload.internal === true) return null;
    if (!payload || payload.kind === 'error' || call.status === 'error') {
      return buildErrorCard(payload, call);
    }
    if (payload.kind === 'clarify') return buildClarifyCard(payload);
    if (payload.kind === 'write_plan') return buildPlanCard(payload);
    if (payload.kind === 'product_search' || payload.kind === 'product_list') return buildProductCard(payload);
    if (payload.kind === 'category_list') return buildCategoryCard(payload);
    if (payload.kind === 'help') return buildHelpCard(payload);
    /* Local notes are loaded and saved silently. They are the assistant's
       working context, not a shop record or a chat result to show. */
    if (payload.kind === 'user_profile' || payload.kind === 'profile_saved') return null;
    return buildGenericCard(call);
  }

  function cardShell(title, meta) {
    var card = document.createElement('div');
    card.className = 'posnic-ai-card';
    var head = document.createElement('div');
    head.className = 'posnic-ai-card-head';
    var name = document.createElement('span');
    name.className = 'posnic-ai-card-title';
    name.textContent = title;
    head.append(name);
    if (meta) {
      var note = document.createElement('span');
      note.className = 'posnic-ai-card-meta';
      note.textContent = meta;
      head.append(note);
    }
    card.append(head);
    return card;
  }

  function openRoute(route) {
    var value = String(route || '');
    if (value.indexOf('#/') === 0) {
      global.location.hash = value;
      return;
    }
    if (/^[a-z0-9_-]+\.html(?:[?#].*)?$/i.test(value)) {
      global.open(value, '_blank', 'noopener');
    }
  }

  function routeButton(label, route) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-link p-0';
    button.textContent = label;
    button.addEventListener('click', function () { openRoute(route); });
    return button;
  }

  /* The page and the server read numbers with the same rule (the file loaded
     before this one), so the value echoed in the bubble is the value stored. */
  function parseNumber(raw) {
    var lib = window.PosnicNumeric;
    if (lib && typeof lib.parseNumberInput === 'function') return lib.parseNumberInput(raw);
    return { ok: true, value: String(raw == null ? '' : raw) };
  }

  /* A click on this card is a decision the system takes, not a sentence for
     the model to re-read. An option that means "enter something" opens the
     entry - the picker, a number field - instead of describing it in chat;
     everything else sends the ids of the question and the option alongside
     the label, and only text that really is an answer goes back as text. */
  function buildClarifyCard(payload) {
    var card = cardShell(t('lang_ai_need_detail', 'Need one detail'), '');
    var body = document.createElement('div');
    body.className = 'posnic-ai-card-body';
    var question = document.createElement('div');
    question.className = 'posnic-ai-card-note posnic-ai-clarify-question';
    question.textContent = payload.question || '';
    body.append(question);
    var answerFor = function (option) {
      return {
        clarificationId: String(payload.id || ''),
        optionId: String((option && option.id) || '')
      };
    };
    /* One send at a time per card: the flag is raised the moment a click is
       handed to sendMessage and drops again only when the send was refused,
       so a second click cannot race the first while the answer is in flight. */
    var sending = false;
    var settle = function () {
      payload.answered = true;
      body.querySelectorAll('button, input').forEach(function (item) {
        item.disabled = true;
      });
    };
    var options = Array.isArray(payload.options) ? payload.options : [];
    if (options.length) {
      var list = document.createElement('div');
      list.className = 'posnic-ai-options';
      options.forEach(function (option) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-outline-primary btn-sm posnic-ai-option';
        button.textContent = option.label || option.value || '';
        button.disabled = payload.answered === true || state.busy;
        button.addEventListener('click', function () {
          if (payload.answered || state.busy || sending) return;
          var answer = answerFor(option);
          if (option.action === 'attach') {
            /* Open the picker. The card stays live until a file is chosen,
               so cancelling the dialog costs nothing and asks nothing. */
            startAttachment(answer, option.label, payload);
            return;
          }
          /* The card settles only once the send was accepted: a click that
             returns early (busy, disabled, too long) leaves it live to press
             again instead of dying as a dead card. */
          sending = true;
          sendMessage(option.value || option.label || '', { answer: answer })
            .then(function (accepted) {
              if (accepted) settle();
              else sending = false;
            });
        });
        list.append(button);
      });
      body.append(list);
    } else if (payload.action === 'attach') {
      var attach = document.createElement('button');
      attach.type = 'button';
      attach.className = 'btn btn-outline-primary btn-sm posnic-ai-option';
      attach.textContent = t('lang_ai_attach_image', 'Attach image');
      attach.disabled = payload.answered === true || state.busy;
      attach.addEventListener('click', function () {
        if (payload.answered || state.busy) return;
        startAttachment(answerFor(null), '', payload);
      });
      body.append(attach);
    } else if (payload.action === 'number') {
      var row = document.createElement('div');
      row.className = 'posnic-ai-number';
      var input = document.createElement('input');
      /* Arabic-Indic digits cannot be typed into type="number": ask for the
         decimal keyboard and let the shared normaliser read whatever the
         operator's layout produced. */
      input.type = 'text';
      input.inputMode = 'decimal';
      input.className = 'form-control';
      input.setAttribute('aria-label', payload.question || '');
      var use = document.createElement('button');
      use.type = 'button';
      use.className = 'btn btn-primary btn-sm';
      use.textContent = t('lang_ai_use_value', 'Use this value');
      use.disabled = payload.answered === true || state.busy;
      var error = document.createElement('div');
      error.className = 'posnic-ai-card-note posnic-ai-number-error';
      error.hidden = true;
      var submitNumber = function () {
        if (payload.answered || state.busy || sending) return;
        var raw = String(input.value || '').trim();
        if (!raw) return;
        var parsed = parseNumber(raw);
        if (!parsed.ok) {
          /* The card stays live: an invalid value never settles the question,
             so the operator corrects it in place. */
          error.textContent = t('lang_ai_invalid_number', 'Enter a valid number.');
          error.hidden = false;
          input.focus();
          return;
        }
        error.hidden = true;
        /* Echo the canonical value and send exactly that, so the bubble, the
             plan preview and the stored answer all agree on the number. */
        input.value = parsed.value;
        sending = true;
        sendMessage(parsed.value, {
          answer: {
            clarificationId: String(payload.id || ''),
            optionId: '',
            slot: String(payload.slot || ''),
            value: parsed.value
          }
        }).then(function (accepted) {
          if (accepted) settle();
          else sending = false;
        });
      };
      use.addEventListener('click', submitNumber);
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitNumber();
        }
      });
      row.append(input, use);
      body.append(row, error);
    } else {
      var hint = document.createElement('div');
      hint.className = 'posnic-ai-card-note';
      hint.textContent = t('lang_ai_type_answer', 'Type your answer below.');
      body.append(hint);
    }
    card.append(body);
    return card;
  }

  /* The picker is opened for a card that asked for an image. Nothing is sent
     yet: the file is the answer, and it only becomes one once it is actually
     attached. */
  function startAttachment(answer, label, payload) {
    if (!el.attach || el.attach.disabled || !el.attachInput || !canAttach()) {
      setStatus(t('lang_ai_attach_failed', 'That image could not be attached.'), true);
      return;
    }
    state.pendingChoice = {
      answer: {
        clarificationId: String(answer.clarificationId || ''),
        optionId: String(answer.optionId || '')
      },
      label: String(label || ''),
      payload: payload || null
    };
    el.attachInput.click();
  }

  function planActionLabel(action) {
    var map = {
      create_category: t('lang_ai_plan_create_category', 'Create category'),
      update_category: t('lang_ai_plan_update_category', 'Update category'),
      create_product: t('lang_ai_plan_create_product', 'Create product'),
      update_product: t('lang_ai_plan_update_product', 'Update product'),
      adjust_stock: t('lang_ai_plan_adjust_stock', 'Adjust stock')
    };
    return map[action] || action || '';
  }

  function planStatusLabel(status) {
    var map = {
      pending: t('lang_ai_plan_pending', 'Waiting for confirmation'),
      running: t('lang_ai_plan_running_status', 'Running...'),
      completed: t('lang_ai_plan_completed', 'Completed'),
      partial: t('lang_ai_plan_partial', 'Partly completed'),
      failed: t('lang_ai_plan_failed', 'Could not complete'),
      cancelled: t('lang_ai_plan_cancelled', 'Cancelled')
    };
    return map[status] || status || '';
  }

  function planStepStatusLabel(status) {
    var map = {
      pending: t('lang_ai_plan_step_pending', 'Pending'),
      running: t('lang_ai_plan_step_running', 'Working...'),
      success: t('lang_ai_plan_step_success', 'Done'),
      failed: t('lang_ai_plan_step_failed', 'Failed'),
      skipped: t('lang_ai_plan_step_skipped', 'Skipped')
    };
    return map[status] || status || '';
  }

  function planStepName(step) {
    var fields = step && step.fields ? step.fields : {};
    if (fields.name && typeof fields.name === 'string') return fields.name;
    if (step && step.before && step.before.name) return step.before.name;
    return '';
  }

  function planStepMeta(step) {
    var fields = step && step.fields ? step.fields : {};
    var parts = [];
    if (step.action === 'create_product' || step.action === 'update_product') {
      if (fields.selling_price !== undefined) {
        parts.push(t('lang_price_title', 'Price') + ': ' + String(fields.selling_price));
      }
      if (fields.cost_price !== undefined) {
        parts.push(t('lang_cost_price', 'Cost price') + ': ' + String(fields.cost_price));
      }
      if (fields.mrp_price !== undefined && Number(fields.mrp_price) !== Number(fields.selling_price)) {
        parts.push(t('lang_mrp_title', 'Retail price') + ': ' + String(fields.mrp_price));
      }
      if (fields.opening_stock !== undefined) {
        parts.push(t('lang_stock', 'Stock') + ': ' + String(fields.opening_stock));
      }
      if (fields.category_name && typeof fields.category_name === 'string') parts.push(fields.category_name);
    }
    if (step.action === 'adjust_stock') {
      var mode = fields.stock_mode === 'add'
        ? t('lang_ai_plan_add', 'add')
        : fields.stock_mode === 'subtract'
          ? t('lang_ai_plan_subtract', 'subtract')
          : t('lang_ai_plan_set', 'set to');
      parts.push(t('lang_stock', 'Stock') + ': ' + mode + ' ' +
        String(fields.stock_quantity == null ? '' : fields.stock_quantity));
    }
    if (Array.isArray(step.images) && step.images.length) {
      parts.push(String(step.images.length) + ' ' + t('lang_ai_plan_images', 'images'));
    }
    return parts.filter(Boolean).join(' · ');
  }

  function findPlanPayload(planId) {
    for (var index = 0; index < state.messages.length; index += 1) {
      var calls = state.messages[index].toolCalls || [];
      for (var callIndex = 0; callIndex < calls.length; callIndex += 1) {
        var payload = toolPayload(calls[callIndex]);
        if (payload && payload.kind === 'write_plan' && payload.plan && payload.plan.id === planId) {
          return payload;
        }
      }
    }
    return null;
  }

  function latestPendingPlan() {
    for (var index = state.messages.length - 1; index >= 0; index -= 1) {
      var calls = state.messages[index].toolCalls || [];
      for (var callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
        var payload = toolPayload(calls[callIndex]);
        if (payload && payload.kind === 'write_plan' && payload.plan && payload.plan.status === 'pending') {
          return payload;
        }
      }
    }
    return null;
  }

  function updatePlanProgress(progress) {
    if (!progress || !progress.planId) return;
    var payload = findPlanPayload(progress.planId);
    if (!payload || !payload.plan) return;
    if (['completed', 'partial', 'failed', 'cancelled'].indexOf(payload.plan.status) >= 0) return;
    payload.plan.status = 'running';
    var steps = payload.plan.steps || [];
    for (var index = 0; index < steps.length; index += 1) {
      if (steps[index].id === progress.stepId) {
        steps[index].status = progress.status;
        steps[index].message = progress.message || '';
        if (progress.result) {
          steps[index].result = progress.result;
          steps[index].resultId = progress.result.id;
          steps[index].resultName = progress.result.name;
          steps[index].verified = progress.result.verified;
          if (progress.result.warning) steps[index].warning = progress.result.warning;
        }
        break;
      }
    }
    renderMessages();
  }

  async function confirmPlanCard(payload) {
    if (state.busy || state.planBusy || !payload || !payload.plan) return;
    if (!hasBridge() || typeof api().confirmPlan !== 'function') {
      setStatus(t('lang_ai_failed', 'The assistant could not be loaded. Try again.'), true);
      return;
    }
    var generation = state.chatGeneration;
    state.planBusy = true;
    state.busy = true;
    payload.plan.status = 'running';
    renderMessages();
    updateControls();
    setStatus(t('lang_ai_plan_running', 'Running...'));
    try {
      var result = await api().confirmPlan({
        planId: payload.plan.id,
        conversationId: state.conversationId,
        authToken: sessionToken(),
        branchId: activeBranch()
      });
      if (generation !== state.chatGeneration) return;
      if (result && result.plan) payload.plan = cloneValue(result.plan);
      if (!result || !result.success) {
        setStatus(messageFor(result, 'chat'), true);
      } else {
        setStatus('');
      }
      renderMessages();
    } catch (error) {
      if (generation !== state.chatGeneration) return;
      console.error('[AI] plan confirmation failed in the desktop bridge.', error);
      setStatus(t('lang_ai_failed', 'The assistant could not answer. Try again.'), true);
      renderMessages();
    } finally {
      if (generation !== state.chatGeneration) return;
      state.planBusy = false;
      state.busy = false;
      updateControls();
      renderMessages();
    }
  }

  async function cancelPlanCard(payload) {
    if (state.busy || state.planBusy || !payload || !payload.plan) return;
    if (!hasBridge() || typeof api().cancelPlan !== 'function') return;
    var generation = state.chatGeneration;
    state.planBusy = true;
    updateControls();
    try {
      var result = await api().cancelPlan({
        planId: payload.plan.id,
        conversationId: state.conversationId
      });
      if (generation !== state.chatGeneration) return;
      if (!result || !result.success) {
        setStatus(messageFor(result, 'chat'), true);
        return;
      }
      payload.plan.status = 'cancelled';
      setStatus('');
      renderMessages();
    } catch (error) {
      if (generation !== state.chatGeneration) return;
      setStatus(t('lang_ai_failed', 'The assistant could not be loaded. Try again.'), true);
    } finally {
      if (generation !== state.chatGeneration) return;
      state.planBusy = false;
      updateControls();
      renderMessages();
    }
  }

  function buildPlanCard(payload) {
    var plan = payload.plan || {};
    var card = cardShell(
      plan.title || t('lang_ai_plan_title', 'Review changes'),
      planStatusLabel(plan.status)
    );
    var body = document.createElement('div');
    body.className = 'posnic-ai-card-body';
    if (plan.summary) {
      var summary = document.createElement('div');
      summary.className = 'posnic-ai-card-note posnic-ai-plan-summary';
      summary.textContent = plan.summary;
      body.append(summary);
    }
    var warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
    if (warnings.length) {
      var warning = document.createElement('div');
      warning.className = 'posnic-ai-plan-warning';
      warning.textContent = warnings.join(' ');
      body.append(warning);
    }
    (plan.steps || []).forEach(function (step, index) {
      var row = document.createElement('div');
      row.className = 'posnic-ai-plan-step';
      var main = document.createElement('div');
      main.className = 'posnic-ai-plan-step-main';
      var title = document.createElement('div');
      title.className = 'posnic-ai-plan-step-title';
      var name = planStepName(step);
      title.textContent = (index + 1) + '. ' + planActionLabel(step.action) + (name ? ': ' + name : '');
      main.append(title);
      var meta = planStepMeta(step);
      if (meta) {
        var metaLine = document.createElement('div');
        metaLine.className = 'posnic-ai-plan-step-meta';
        metaLine.textContent = meta;
        main.append(metaLine);
      }
      if (step.message) {
        var message = document.createElement('div');
        message.className = 'posnic-ai-plan-step-meta';
        message.textContent = step.message;
        main.append(message);
      }
      if (step.warning) {
        var stepWarning = document.createElement('div');
        stepWarning.className = 'posnic-ai-plan-step-warning';
        stepWarning.textContent = step.warning;
        main.append(stepWarning);
      }
      row.append(main);
      var status = document.createElement('span');
      status.className = 'posnic-ai-plan-step-status posnic-ai-plan-step-status--' + (step.status || 'pending');
      status.textContent = planStepStatusLabel(step.status || 'pending');
      row.append(status);
      if (step.result && step.result.route && step.status === 'success') {
        var open = routeButton(t('lang_ai_plan_open', 'Open'), step.result.route);
        open.className = 'btn btn-link p-0 posnic-ai-plan-open';
        row.append(open);
      }
      body.append(row);
    });
    card.append(body);

    var foot = document.createElement('div');
    foot.className = 'posnic-ai-card-foot posnic-ai-plan-foot';
    if (plan.status === 'pending') {
      var note = document.createElement('span');
      note.className = 'posnic-ai-plan-note';
      note.textContent = t('lang_ai_plan_confirm_note', 'Nothing is saved until you confirm.');
      foot.append(note);
      var confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'btn btn-primary btn-sm';
      confirm.textContent = t('lang_ai_plan_confirm', 'Confirm');
      confirm.disabled = state.busy || state.planBusy;
      confirm.addEventListener('click', function () { confirmPlanCard(payload); });
      foot.append(confirm);
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-link p-0';
      cancel.textContent = t('lang_ai_plan_cancel', 'Cancel');
      cancel.disabled = state.busy || state.planBusy;
      cancel.addEventListener('click', function () { cancelPlanCard(payload); });
      foot.append(cancel);
    } else if (plan.status === 'running') {
      var running = document.createElement('span');
      running.className = 'posnic-ai-plan-note';
      running.textContent = t('lang_ai_plan_running', 'Running...');
      foot.append(running);
    } else if (plan.status === 'partial' || plan.status === 'failed') {
      /* A plan that could not fully undo itself must be reviewed, not
         replayed: retrying it could apply the surviving half twice. */
      if (plan.retryable !== false) {
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn-outline-primary btn-sm';
        retry.textContent = t('lang_ai_plan_retry', 'Retry remaining');
        retry.disabled = state.busy || state.planBusy;
        retry.addEventListener('click', function () { confirmPlanCard(payload); });
        foot.append(retry);
      }
      var cancelRetry = document.createElement('button');
      cancelRetry.type = 'button';
      cancelRetry.className = 'btn btn-link p-0';
      cancelRetry.textContent = t('lang_ai_plan_cancel', 'Cancel');
      cancelRetry.disabled = state.busy || state.planBusy;
      cancelRetry.addEventListener('click', function () { cancelPlanCard(payload); });
      foot.append(cancelRetry);
    }
    if (foot.childNodes.length) card.append(foot);
    return card;
  }

  function buildProductCard(payload) {
    var count = Number(payload.count) || 0;
    var total = Number(payload.total);
    var meta = count === 1
      ? t('lang_ai_one_match', '1 match')
      : String(count) + ' ' + t('lang_ai_matches', 'matches');
    if (Number.isFinite(total) && total > count) {
      meta = String(count) + ' ' + t('lang_ai_of_total', 'of') + ' ' + String(total);
    }
    var card = cardShell(t('lang_ai_products_title', 'Products'), meta);
    var body = document.createElement('div');
    body.className = 'posnic-ai-card-body';
    if (!count) {
      var empty = document.createElement('div');
      empty.className = 'posnic-ai-card-note';
      empty.textContent = t('lang_ai_no_products', 'No products matched in this branch.');
      body.append(empty);
    } else {
      (payload.results || []).forEach(function (item) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'posnic-ai-product';
        row.addEventListener('click', function () {
          if (item.id) openRoute('#/items/' + encodeURIComponent(item.id));
        });
        var main = document.createElement('span');
        main.className = 'posnic-ai-product-main';
        var name = document.createElement('span');
        name.className = 'posnic-ai-product-name';
        name.textContent = item.name || '';
        main.append(name);
        if (item.category) {
          var category = document.createElement('span');
          category.className = 'posnic-ai-product-sub';
          category.textContent = item.category;
          main.append(category);
        }
        var side = document.createElement('span');
        side.className = 'posnic-ai-product-side';
        var price = document.createElement('span');
        price.className = 'posnic-ai-product-price';
        price.textContent = t('lang_price_title', 'Price') + ': ' +
          String(item.sellingPrice == null ? '' : item.sellingPrice);
        side.append(price);
        if (item.trackInventory !== false) {
          var stock = document.createElement('span');
          stock.className = 'posnic-ai-product-stock';
          stock.textContent = t('lang_stock', 'Stock') + ': ' +
            String(item.stock == null ? '' : item.stock);
          side.append(stock);
        }
        row.append(main, side);
        body.append(row);
      });
    }
    card.append(body);
    var foot = document.createElement('div');
    foot.className = 'posnic-ai-card-foot';
    foot.append(routeButton(t('lang_ai_open_items', 'Open Items'), '#/items'));
    card.append(foot);
    return card;
  }

  function buildCategoryCard(payload) {
    var count = Number(payload.count) || 0;
    var card = cardShell(
      t('lang_ai_categories_title', 'Categories'),
      count === 1
        ? '1 ' + t('lang_category', 'category')
        : String(count) + ' ' + t('lang_categories', 'categories')
    );
    var body = document.createElement('div');
    body.className = 'posnic-ai-card-body';
    if (!count) {
      var empty = document.createElement('div');
      empty.className = 'posnic-ai-card-note';
      empty.textContent = t('lang_ai_no_categories', 'No categories in this branch.');
      body.append(empty);
    } else {
      (payload.categories || []).forEach(function (category) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'posnic-ai-product';
        row.addEventListener('click', function () {
          if (category.id) openRoute('#/categories/' + encodeURIComponent(category.id));
        });
        var main = document.createElement('span');
        main.className = 'posnic-ai-product-main';
        var name = document.createElement('span');
        name.className = 'posnic-ai-product-name';
        name.textContent = category.name || '';
        main.append(name);
        if (category.description) {
          var description = document.createElement('span');
          description.className = 'posnic-ai-product-sub';
          description.textContent = category.description;
          main.append(description);
        }
        var side = document.createElement('span');
        side.className = 'posnic-ai-product-side';
        if (category.itemCount != null) {
          var items = document.createElement('span');
          items.className = 'posnic-ai-product-stock';
          items.textContent = String(category.itemCount) + ' ' +
            t('lang_ai_items_count', 'items');
          side.append(items);
        }
        row.append(main, side);
        body.append(row);
      });
    }
    card.append(body);
    var foot = document.createElement('div');
    foot.className = 'posnic-ai-card-foot';
    foot.append(routeButton(t('lang_ai_open_categories', 'Open Categories'), '#/categories'));
    card.append(foot);
    return card;
  }

  function buildHelpCard(payload) {
    var destination = payload.destinations && payload.destinations[0];
    var section = payload.sections && payload.sections[0];
    var card = cardShell(
      t('lang_ai_how_to_title', 'How to'),
      section ? section.title : ''
    );
    var body = document.createElement('div');
    body.className = 'posnic-ai-card-body';
    if (destination) {
      var path = document.createElement('div');
      path.className = 'posnic-ai-help-path';
      path.textContent = (destination.menu || []).join(' → ');
      body.append(path);
      var action = destination.actions && destination.actions[0];
      if (action) {
        var actionLine = document.createElement('div');
        actionLine.className = 'posnic-ai-help-action';
        actionLine.textContent = action.label;
        body.append(actionLine);
      }
    } else if (section) {
      var excerpt = document.createElement('div');
      excerpt.className = 'posnic-ai-card-note';
      excerpt.textContent = String(section.body || '').split('\n')[0].slice(0, 180);
      body.append(excerpt);
    } else {
      var none = document.createElement('div');
      none.className = 'posnic-ai-card-note';
      none.textContent = t('lang_ai_no_help', 'No matching Posnic help page.');
      body.append(none);
    }
    card.append(body);
    if (destination && destination.route) {
      var foot = document.createElement('div');
      foot.className = 'posnic-ai-card-foot';
      foot.append(routeButton(t('lang_ai_open_page', 'Open page'), destination.route));
      card.append(foot);
    }
    return card;
  }

  function profileSectionLabel(section) {
    if (section === 'recurring') return t('lang_ai_memory_recurring', 'Recurring requests');
    if (section === 'language') return t('lang_ai_memory_language', 'Language and wording');
    return t('lang_ai_memory_preferences', 'Preferences');
  }

  function buildProfileCard(payload) {
    var card = cardShell(
      t('lang_ai_memory_title', 'Local notes'),
      t('lang_ai_memory_meta', 'On this computer')
    );
    var body = document.createElement('div');
    body.className = 'posnic-ai-card-body';
    var note = document.createElement('div');
    note.className = 'posnic-ai-card-note';
    if (!payload.exists) {
      note.textContent = t('lang_ai_memory_empty', 'No notes saved yet.');
    } else {
      var counts = payload.counts || {};
      var parts = [];
      if (counts.preferences) parts.push(String(counts.preferences) + ' ' + profileSectionLabel('preferences'));
      if (counts.recurring) parts.push(String(counts.recurring) + ' ' + profileSectionLabel('recurring'));
      if (counts.language) parts.push(String(counts.language) + ' ' + profileSectionLabel('language'));
      note.textContent = parts.length
        ? parts.join(' · ')
        : t('lang_ai_memory_empty', 'No notes saved yet.');
    }
    body.append(note);
    var hint = document.createElement('div');
    hint.className = 'posnic-ai-card-note';
    hint.textContent = t('lang_ai_memory_note', 'The assistant uses these notes to match how you work. They are not shop records.');
    body.append(hint);
    card.append(body);
    return card;
  }

  function buildProfileSavedCard(payload) {
    var card = cardShell(
      payload.duplicate
        ? t('lang_ai_memory_duplicate', 'Already saved')
        : t('lang_ai_memory_saved', 'Saved to local notes'),
      profileSectionLabel(payload.section)
    );
    var body = document.createElement('div');
    body.className = 'posnic-ai-card-body';
    var note = document.createElement('div');
    note.className = 'posnic-ai-card-note';
    note.textContent = payload.note || '';
    body.append(note);
    if (!payload.duplicate) {
      var hint = document.createElement('div');
      hint.className = 'posnic-ai-card-note';
      hint.textContent = t('lang_ai_memory_saved_note', 'The assistant will use this in later conversations on this computer.');
      body.append(hint);
    }
    card.append(body);
    return card;
  }

  function buildErrorCard(payload, call) {
    var card = cardShell(t('lang_ai_tool_error_title', 'Could not complete'), '');
    card.classList.add('posnic-ai-card--error');
    var body = document.createElement('div');
    body.className = 'posnic-ai-card-body';
    var note = document.createElement('div');
    note.className = 'posnic-ai-card-note';
    note.textContent = (payload && payload.message) ||
      (call && call.error && call.error.message) ||
      t('lang_ai_tool_error', 'The assistant could not complete that request.');
    body.append(note);
    card.append(body);
    return card;
  }

  function buildGenericCard(call) {
    var card = cardShell(
      t('lang_ai_tool_title', 'Shop data'),
      call && call.status === 'running' ? t('lang_ai_tool_running', 'Working...') : ''
    );
    var body = document.createElement('div');
    body.className = 'posnic-ai-card-body';
    var note = document.createElement('div');
    note.className = 'posnic-ai-card-note';
    note.textContent = t('lang_ai_tool_done', 'The assistant finished that lookup.');
    body.append(note);
    card.append(body);
    return card;
  }

  function updateControls() {
    if (!el.mic || !el.send) return;
    var recording = state.recording;
    el.mic.disabled = (state.busy && !recording) ||
      !state.enabled || !state.transcription.configured;
    el.mic.classList.toggle('is-recording', recording);
    el.mic.setAttribute('aria-pressed', recording ? 'true' : 'false');
    var icon = el.mic.querySelector('i');
    if (icon) {
      icon.classList.toggle('icon-mic', !recording);
      icon.classList.toggle('icon-square', recording);
    }
    var label = el.mic.querySelector('span');
    if (label) {
      label.textContent = recording
        ? t('lang_ai_stop', 'Stop and transcribe')
        : t('lang_ai_record', 'Record');
    }
    el.send.disabled = state.busy || !state.enabled || !chatConfiguredForSelection();
    if (el.retry) el.retry.disabled = state.busy;
    if (el.reasoning) {
      el.reasoning.disabled = !state.enabled || state.busy || state.reasoningBusy;
    }
    if (el.attach) {
      el.attach.disabled = state.busy || state.attachmentBusy || !state.enabled || !canAttach();
    }
    if (el.recordTime) {
      el.recordTime.textContent = recording
        ? formatTime((Date.now() - state.startedAt) / 1000) + ' / ' + formatTime(MAX_SECONDS)
        : '';
    }
  }

  function pickMime() {
    if (!global.MediaRecorder || typeof global.MediaRecorder.isTypeSupported !== 'function') return '';
    var types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (var i = 0; i < types.length; i += 1) {
      if (global.MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
    return '';
  }

  function releaseStream() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (track) {
        try { track.stop(); } catch (error) { /* already stopped */ }
      });
      state.stream = null;
    }
  }

  function clearRecordingTimers() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (state.autoStop) {
      clearTimeout(state.autoStop);
      state.autoStop = null;
    }
  }

  function stopRecording() {
    if (!state.recording || !state.recorder) return;
    state.recording = false;
    clearRecordingTimers();
    updateControls();
    try {
      state.recorder.stop();
    } catch (error) {
      releaseStream();
      state.busy = false;
      updateControls();
      setStatus(t('lang_ai_recorder_failed', 'The recording stopped unexpectedly. Try again.'), true);
    }
  }

  async function finishRecording() {
    var recorder = state.recorder;
    var chunks = state.chunks;
    var cancelled = state.cancelled;
    state.recorder = null;
    state.chunks = [];
    state.cancelled = false;
    clearRecordingTimers();
    releaseStream();
    updateControls();

    if (cancelled) return;
    var blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
    await transcribeBlob(blob);
  }

  /* One path for a clip from MediaRecorder, so the page sends the same
     base64 payload on desktop and phone. */
  async function transcribeBlob(blob) {
    if (!blob || !blob.size) {
      setStatus(t('lang_ai_empty_transcript', 'No speech was recognised. Try again a little closer to the microphone.'), true);
      return;
    }
    if (blob.size > MAX_AUDIO_BYTES) {
      setStatus(t('lang_ai_too_large', 'That recording is too large. Keep it under 30 seconds.'), true);
      return;
    }
    if (state.busy) return;

    state.busy = true;
    updateControls();
    setStatus(t('lang_ai_transcribing', 'Transcribing...'));

    try {
      var buffer = await blob.arrayBuffer();
      var result = await api().transcribe({ audio: buffer, mimeType: blob.type, language: 'ar' });
      state.busy = false;
      updateControls();
      if (!result || !result.success) {
        setStatus(messageFor(result, 'transcription'), true);
        return;
      }
      var text = String(result.text || '').trim();
      if (!text) {
        setStatus(t('lang_ai_empty_transcript', 'No speech was recognised. Try again a little closer to the microphone.'), true);
        return;
      }
      sendMessage(text);
    } catch (error) {
      state.busy = false;
      updateControls();
      console.error('[AI] transcription request failed.', error);
      setStatus(t('lang_ai_audio_failed', 'That recording could not be read. Try again.'), true);
    }
  }

  async function startRecording() {
    if (state.recording) {
      stopRecording();
      return;
    }
    if (state.busy) return;
    if (!state.enabled) {
      setStatus(t('lang_ai_disabled', 'Turn the assistant on first.'), true);
      return;
    }
    if (!state.transcription.configured) {
      setStatus(t('lang_ai_key_missing', 'Add your Groq Whisper key first.'), true);
      return;
    }
    if (global.isSecureContext === false ||
        !global.navigator || !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function' ||
        !global.MediaRecorder) {
      /* Browsers only expose in-page recording on a secure origin. A phone on
         plain HTTP cannot use the microphone, and opening the system recorder
         is not a substitute. Send it to the local HTTPS front door instead. */
      var secureUrl = secureVoiceUrl();
      if (secureUrl) {
        setStatus(
          t('lang_ai_voice_https_required', 'Voice recording needs the secure Posnic address. Open {url} and log in again.')
            .replace(/\{url\}/g, secureUrl),
          true,
        );
        return;
      }
      setStatus(t('lang_ai_recorder_failed', 'Recording is not available here. Type your question instead.'), true);
      return;
    }

    setStatus('');
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setStatus(micError(error), true);
      return;
    }

    var mime = pickMime();
    try {
      state.recorder = mime
        ? new global.MediaRecorder(state.stream, { mimeType: mime })
        : new global.MediaRecorder(state.stream);
    } catch (error) {
      releaseStream();
      setStatus(t('lang_ai_recorder_failed', 'The recording could not start. Try again.'), true);
      return;
    }

    state.chunks = [];
    state.cancelled = false;
    state.recorder.ondataavailable = function (event) {
      if (event.data && event.data.size) state.chunks.push(event.data);
    };
    state.recorder.onerror = function () {
      setStatus(t('lang_ai_recorder_failed', 'The recording stopped unexpectedly. Try again.'), true);
    };
    state.recorder.onstop = finishRecording;

    try {
      state.recorder.start();
    } catch (error) {
      state.recorder = null;
      releaseStream();
      setStatus(t('lang_ai_recorder_failed', 'The recording could not start. Try again.'), true);
      return;
    }

    state.startedAt = Date.now();
    state.recording = true;
    updateControls();
    setStatus('');
    state.timer = setInterval(function () {
      if (!state.recording) return;
      if (el.recordTime) {
        el.recordTime.textContent = formatTime((Date.now() - state.startedAt) / 1000) +
          ' / ' + formatTime(MAX_SECONDS);
      }
    }, 250);
    state.autoStop = setTimeout(stopRecording, MAX_SECONDS * 1000);
  }

  function cacheElements() {
    el.setupCard = byId('ai_setup_card');
    el.chatCard = byId('ai_chat_card');
    el.settingsColumn = byId('ai_settings_column');
    el.settingsCard = byId('ai_settings_card');
    el.enable = byId('ai_enable');
    el.setupForm = byId('ai_setup_form');
    el.setupError = byId('ai_setup_error');
    el.setupStatus = byId('ai_setup_status');
    el.transcriptionKey = byId('ai_transcription_key');
    el.transcriptionSave = byId('ai_transcription_save');
    el.transcriptionState = byId('ai_transcription_state');
    el.provider = byId('ai_provider');
    el.model = byId('ai_model');
    el.settingsTokens = byId('ai_settings_tokens');
    el.settingsTokenKey = byId('ai_settings_token_key');
    el.settingsTokenSave = byId('ai_settings_token_save');
    el.settingsTokenState = byId('ai_settings_token_state');
    el.settingsAddGroup = byId('ai_settings_add_group');
    el.turnOn = byId('ai_turn_on');
    el.reasoning = byId('ai_reasoning');
    el.reasoningValue = byId('ai_reasoning_value');
    el.reasoningState = byId('ai_reasoning_state');
    el.connectionStatus = byId('ai_connection_status');
    el.disable = byId('ai_disable');
    el.removeKey = byId('ai_remove_key');
    el.messages = byId('ai_messages');
    el.empty = byId('ai_empty');
    el.status = byId('ai_status');
    el.retry = byId('ai_retry');
    el.prompt = byId('ai_prompt');
    el.send = byId('ai_send');
    el.mic = byId('ai_mic');
    el.recordTime = byId('ai_record_time');
    el.newChat = byId('ai_new_chat');
    el.attach = byId('ai_attach');
    el.attachInput = byId('ai_attach_input');
    el.attachments = byId('ai_attachments');
  }

  function bind() {
    el.enable.addEventListener('click', revealSetup);
    el.transcriptionSave.addEventListener('click', saveTranscriptionKey);
    el.transcriptionKey.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveTranscriptionKey();
      }
    });
    el.provider.addEventListener('change', onProviderChange);
    el.model.addEventListener('change', onModelChange);
    if (el.settingsTokenSave) el.settingsTokenSave.addEventListener('click', saveProviderKey);
    if (el.settingsTokenKey) {
      el.settingsTokenKey.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          saveProviderKey();
        }
      });
    }
    el.turnOn.addEventListener('click', turnOn);
    if (el.reasoning) {
      el.reasoning.addEventListener('input', onReasoningInput);
      el.reasoning.addEventListener('change', function () { saveReasoning(); });
    }
    el.disable.addEventListener('click', disableFeature);
    el.removeKey.addEventListener('click', removeTranscription);
    el.newChat.addEventListener('click', function () { newChat(); });
    el.send.addEventListener('click', function () { sendMessage(); });
    if (el.retry) el.retry.addEventListener('click', retryLastMessage);
    el.mic.addEventListener('click', startRecording);
    if (el.attach && el.attachInput) {
      el.attach.addEventListener('click', function () {
        if (el.attach.disabled) return;
        el.attachInput.click();
      });
      el.attachInput.addEventListener('change', function () {
        var files = el.attachInput.files;
        attachFiles(files);
        el.attachInput.value = '';
      });
      /* Cancelling the dialog answers nothing: the card stays live and the
         operator can still type an answer or attach later. */
      el.attachInput.addEventListener('cancel', function () {
        state.pendingChoice = null;
      });
    }
    el.prompt.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });

    global.addEventListener('hashchange', function () {
      if (state.recording) {
        state.cancelled = true;
        stopRecording();
      }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && state.recording) {
        state.cancelled = true;
        stopRecording();
      }
    });
  }

  function init() {
    if (!state.initialized) {
      cacheElements();
      loadSettings();
      bind();
      state.conversationId = newConversationId();
      if (hasIpc() && typeof api().onPlanProgress === 'function') {
        state.offPlanProgress = api().onPlanProgress(updatePlanProgress);
      }
      if (hasIpc() && typeof api().onChatProgress === 'function') {
        state.offChatProgress = api().onChatProgress(showChatProgress);
      }
      state.initialized = true;
    }
    renderAttachments();
    refresh();
  }

  PosnicPro.ai = {
    showDataTablePage: function () {
      if (!PosnicPro.userACL || !PosnicPro.userACL.branch ||
          PosnicPro.userACL.branch.write !== true) {
        hasher.setHash('dashboard');
        return;
      }
      PosnicPro.HideSideBarModal();
      $('.nav-link-active,.tab-pane-active,.dropdown-item').removeClass('active');
      $('.vertical-layout').removeClass('toggle-menu');
      $('.vertical-menu li a').removeClass('active');
      $('.page_loader,#osk-container').hide();
      $('.page-title-box,#ai').show();
      $('#v-pills-manage-tab,#view_ai_page').addClass('active');
      $('#v-pills-manage').addClass('show active');
      $('.dashboard_img_menu').hide();
      PosnicPro.ai.init();
    },
    init: init,
    refresh: refresh,
  };
})(window);
