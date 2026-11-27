/*
 * Embedded OpenCode runtime for the AI assistant.
 *
 * OpenCode is hosted inside the Electron main process. The renderer never sees
 * an OpenCode port, address or token; it asks this module for a reply through
 * IPC. The runtime uses a dedicated chat-only agent: every tool permission is
 * denied and only the selected model provider may be used.
 *
 * The model catalogue is bundled and fetched never, so starting the assistant
 * does not make a second network request just to list models.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const loadOpenCodeSdk = require('./sdk-loader');
const {
  AGENT_ID,
  PROVIDERS,
  getModel,
  getProvider,
  normaliseReasoning,
  normaliseSettings,
  runtimeConfig,
  systemPrompt,
} = require('./provider-registry');
const { MAX_PROVIDER_TOKENS, providerTokenSlot } = require('./key-store');
const { createContextStore } = require('./tools/context');
const { presentClarification } = require('./ask-slots');
const { createPosnicToolPlugin, toolPayloadChars } = require('./tools/plugin');
const { createUserProfileStore } = require('./user-profile');
const { attachmentNotice, createAttachmentStore } = require('./attachments');
const { createPlanStore } = require('./actions/plan-store');
const { executePlan } = require('./actions/plan-executor');
const { createApiClient } = require('./tools/api-client');
const { createConversationMemoryStore } = require('./conversation-memory');
const { runLocalProductFlow } = require('./local/product-flow');
const { runCompiler } = require('./agent/compiler');
const { extractIntent } = require('./agent/intent');
const { runLiveRead } = require('./agent/live-read');
const { createTaskKernel } = require('./agent/task-kernel');
const { currencyInstruction, normalizeCurrencyText } = require('./currency');
const {
  CHARS_PER_TOKEN,
  fitReferenceLayers,
  outputReserveTokens,
  referenceBudgetChars,
} = require('./context-budget');
const { normalizeName } = require('./text-match');

const START_TIMEOUT_MS = 25000;
const CHAT_TIMEOUT_MS = 120000;
const COMPACT_TIMEOUT_MS = 60000;
/* When the model has not answered by this point, the page says so instead of
   leaving the user with a silent spinner. */
const SLOW_NOTICE_MS = 8000;
/* How often the wait looks at the session to see whether the model is still
   doing anything. Long enough not to spam the status line, short enough that
   the user sees movement within a couple of seconds. */
const ACTIVITY_POLL_MS = 2000;
/* A task with several tool steps is allowed to run as long as it keeps
   producing them. This is the ceiling that stops a genuinely wedged session
   from holding the turn open for ever. */
const MAX_WAIT_MULTIPLIER = 4;
/* One user turn should never spend more than this many model requests:
   the first answer, one correction, one recovery and one quota retry. */
const MAX_MODEL_REQUESTS = 4;
/* Groq's free tier rejects any single request larger than 8,000 tokens with
   413, even though the model's context window is 131,072. Providers at or
   below this budget get a fresh session and compact memory before the next
   turn, so the transcript cannot grow past the per-request limit. */
const LOW_REQUEST_BUDGET = 16000;
const LOW_REQUEST_PRESSURE = 0.5;
const COMPACT_TASK_CARD_CHARS = 900;
const COMPACT_LOCAL_CONTEXT_CHARS = 1200;
/* OpenCode reports the real prompt and completion tokens for every step. Use
   them instead of a character guess so a session can fill the model's actual
   context window before it is compacted. */
const DEFAULT_CONTEXT_LIMIT = 131072;
const COMPACT_AT_CONTEXT_RATIO = 0.6;
const HARD_CONTEXT_RATIO = 0.85;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return error;
}

function timeoutError(code, message) {
  return runtimeError(code, message);
}

function withTimeout(promise, ms, code, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(code, message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function messageTools(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content
    .filter((part) => part && part.type === 'tool')
    .map((part) => {
      const state = part.state || {};
      return {
        id: part.id,
        name: part.name,
        status: state.status || 'unknown',
        input: state.input,
        metadata: state.metadata,
        ...(Array.isArray(state.content) ? { content: state.content } : {}),
        ...(state.error ? {
          error: {
            message: String((state.error && state.error.message) || state.error).slice(0, 300),
          },
        } : {}),
      };
    });
}

/* Tool results are part of the model context even when they are not text.
   Count them in the session budget so a long product list compacts the
   session instead of quietly growing it. */
function serializedSize(value) {
  try {
    return JSON.stringify(value || []).length;
  } catch (error) {
    return 0;
  }
}

function messageTokens(message) {
  const usage = message && message.tokens;
  if (!usage || typeof usage !== 'object') return null;
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const cache = usage.cache && typeof usage.cache === 'object' ? usage.cache : {};
  return {
    input: number(usage.input),
    output: number(usage.output),
    reasoning: number(usage.reasoning),
    cache: { read: number(cache.read), write: number(cache.write) },
  };
}

/* Mirrors @opencode/schema TokenUsage.total. The provider may report cached
   prompt tokens separately, so count every bucket. */
function tokenTotal(tokens) {
  if (!tokens) return 0;
  return tokens.input + tokens.output + tokens.reasoning +
    tokens.cache.read + tokens.cache.write;
}

function estimatedTokens(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) / CHARS_PER_TOKEN);
}

/* One line for every request sent to a model.
 *
 * The token counts come from the provider, so this is measured rather than
 * guessed: how large the prompt was, what the reply spent, and whether the
 * request fits the per-request cap the provider enforces. A turn that skips
 * the budget counter is marked, because "budget untouched, tokens spent" is
 * exactly the combination that used to hide a rejected request. */
function formatLlmRequest({
  index = 0,
  id = '',
  prompt = '',
  reply = null,
  ms = 0,
  counted = true,
  cap = 0,
} = {}) {
  const digits = (value) => Number(value) || 0;
  const tokens = (reply && reply.tokens) || null;
  const input = tokens ? digits(tokens.input) : 0;
  const output = tokens ? digits(tokens.output) : 0;
  const reasoning = tokens ? digits(tokens.reasoning) : 0;
  const cache = tokens
    ? digits(tokens.cache && tokens.cache.read) + digits(tokens.cache && tokens.cache.write)
    : 0;
  const outcome = reply && reply.ok
    ? ((reply.toolCalls && reply.toolCalls.length) ? 'tools' : 'reply')
    : ((reply && (reply.code || reply.message)) || 'no-reply');
  const usage = input + output + reasoning + cache;

  return (
    `[AI llm] #${index} session=${id} outcome=${outcome} ` +
    `prompt=${String(prompt || '').length}ch ` +
    `in=${input} out=${output} think=${reasoning} cache=${cache} total=${usage} ` +
    `ms=${ms} counted=${counted}` +
    (cap > 0 ? ` cap=${cap} fits=${input <= cap}` : '')
  );
}

function createOpenCodeRuntime({
  baseDir,
  keyStore,
  logger,
  fetchImpl,
  apiBaseUrl,
  profileStore,
  chatTimeoutMs,
  slowNoticeMs,
} = {}) {
  let client = null;
  let starting = null;
  let sessionID = null;
  let sessionTurns = 0;
  let sessionTokens = 0;
  let workspace = '';
  let location = null;
  let envBackup = new Map();
  /* Which token slot each provider is using. The key store persists the choice;
     this map is the fallback for a key store without the multi-token methods. */
  const activeTokenSlots = new Map();
  let settings = normaliseSettings(
    keyStore ? keyStore.getSettings() : { provider: 'groq', model: 'openai/gpt-oss-120b' },
  );
  let log = typeof logger === 'function' ? logger : () => {};
  const chatTimeout = Number(chatTimeoutMs) > 0 ? Number(chatTimeoutMs) : CHAT_TIMEOUT_MS;
  const slowNotice = Number(slowNoticeMs) > 0 ? Number(slowNoticeMs) : SLOW_NOTICE_MS;
  const toolContext = createContextStore();
  const attachmentStore = createAttachmentStore();
  const planStore = createPlanStore();
  const memory = createConversationMemoryStore();
  const taskKernel = createTaskKernel();

  function resolveApiBaseUrl() {
    return String(typeof apiBaseUrl === 'function' ? apiBaseUrl() : (apiBaseUrl || '')).replace(/\/+$/, '');
  }

  const runtimeDir = path.join(baseDir || process.cwd(), 'opencode');
  const configDir = path.join(runtimeDir, 'config');
  const workspaceDir = path.join(runtimeDir, 'workspace');
  const databasePath = path.join(runtimeDir, 'sessions.db');
  const localProfiles = profileStore || createUserProfileStore({ dir: path.join(runtimeDir, 'profiles') });
  const toolPlugin = createPosnicToolPlugin({
    store: toolContext,
    profileStore: localProfiles,
    planStore,
    attachments: attachmentStore,
    memory,
    fetchImpl,
    logger: log,
  });

  function writeConfig() {
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    const config = runtimeConfig({
      providerID: settings.provider,
      modelID: settings.model,
      reasoning: settings.reasoning,
    });
    log(
      `[AI config] provider=${settings.provider} model=${settings.model} ` +
      `reasoning=${settings.reasoning}`,
    );
    fs.writeFileSync(
      path.join(configDir, 'opencode.json'),
      JSON.stringify(config, null, 2),
      { mode: 0o600 },
    );
  }

  function selectedProvider() {
    return getProvider(settings.provider);
  }

  function selectedModel() {
    const provider = selectedProvider();
    return provider ? getModel(provider.id, settings.model) : null;
  }

  function requestTokenLimit() {
    const selected = selectedModel();
    return Number(selected && selected.requestTokens) || 0;
  }

  function lowRequestBudget() {
    const budget = requestTokenLimit();
    /* An unknown cap fails closed.
 *
       A model with no declared requestTokens used to return false here. That
       switched on the full-size memory and local blocks and, worse, disabled
       requestPressure altogether, so the transcript grew towards the whole
       131k context window while the provider was still refusing anything
       over its real per-request limit. Not knowing the limit is not evidence
       that the limit is generous: the compact sizes are the safe default,
       and the provider's own reported tokens still say what was sent. */
    return budget <= 0 || budget <= LOW_REQUEST_BUDGET;
  }

  /* Characters the reference layers may occupy in one request: the cap in
     characters, minus the fixed payload and the reserve for the reply. The
     fixed payload is measured once from the prompt and the tool schemas the
     runtime actually registers, so the number cannot drift away from the
     request it is meant to describe. */
  let fixedPayloadChars = 0;

  async function budgetForRequest() {
    const cap = requestTokenLimit();
    if (cap <= 0) return Number.POSITIVE_INFINITY;
    if (!fixedPayloadChars) {
      try {
        fixedPayloadChars = systemPrompt().length + await toolPayloadChars();
      } catch (error) {
        /* Cannot happen in practice: this measures the same definitions the
           plugin registers. Refuse to trim rather than guess at a payload
           and starve the memory block on a bad number. */
        log(`[AI budget] fixed payload could not be measured: ${error.message}`);
        return Number.POSITIVE_INFINITY;
      }
    }
    const budget = referenceBudgetChars({
      requestTokens: cap,
      fixedChars: fixedPayloadChars,
      reserveTokens: outputReserveTokens(settings.reasoning),
    });
    log(
      `[AI budget] cap=${cap} fixed=${fixedPayloadChars} ` +
      `reserve=${outputReserveTokens(settings.reasoning)} reference=${budget}`,
    );
    return budget;
  }

  function tokenSlots(providerID) {
    if (keyStore && typeof keyStore.providerTokenSlots === 'function') {
      return keyStore.providerTokenSlots(providerID);
    }
    const slots = [];
    for (let index = 0; index < MAX_PROVIDER_TOKENS; index += 1) {
      const loaded = keyStore ? keyStore.read(providerTokenSlot(providerID, index)) : null;
      if (loaded && loaded.key) slots.push(index);
    }
    return slots;
  }

  function activeTokenIndex(providerID) {
    const slots = tokenSlots(providerID);
    if (!slots.length) return 0;
    if (keyStore && typeof keyStore.getActiveProviderToken === 'function') {
      const stored = Number(keyStore.getActiveProviderToken(providerID));
      if (slots.includes(stored)) return stored;
    }
    const remembered = activeTokenSlots.get(providerID);
    if (slots.includes(remembered)) return remembered;
    return slots[0];
  }

  function useProviderToken(providerID, index) {
    if (!Number.isInteger(index) || !tokenSlots(providerID).includes(index)) return false;
    activeTokenSlots.set(providerID, index);
    if (keyStore && typeof keyStore.setActiveProviderToken === 'function') {
      keyStore.setActiveProviderToken(providerID, index);
    }
    return true;
  }

  function usePrimaryToken(providerID) {
    if (providerID) {
      const first = tokenSlots(providerID)[0];
      if (first !== undefined) useProviderToken(providerID, first);
    } else {
      activeTokenSlots.clear();
    }
  }

  function readProviderToken(providerID) {
    if (!keyStore) {
      return {
        key: '',
        error: 'provider_key_missing',
        slot: providerTokenSlot(providerID, 0),
        index: 0,
        backup: false,
      };
    }
    const index = activeTokenIndex(providerID);
    const loaded = keyStore.read(providerTokenSlot(providerID, index));
    return {
      ...loaded,
      slot: providerTokenSlot(providerID, index),
      index,
      backup: index > 0,
    };
  }

  function rotateProviderToken(providerID, attempted) {
    if (!keyStore || !providerID) return false;
    const slots = tokenSlots(providerID);
    if (slots.length < 2) return false;
    const current = activeTokenIndex(providerID);
    const start = Math.max(0, slots.indexOf(current));
    for (let step = 1; step <= slots.length; step += 1) {
      const candidate = slots[(start + step) % slots.length];
      if (attempted && attempted.has(candidate)) continue;
      const loaded = keyStore.read(providerTokenSlot(providerID, candidate));
      if (!loaded.key) continue;
      if (useProviderToken(providerID, candidate)) return true;
    }
    return false;
  }

  function activeToken(providerID) {
    return activeTokenIndex(providerID);
  }

  function applyEnvironment() {
    const selected = selectedProvider();
    for (const provider of PROVIDERS) {
      if (!envBackup.has(provider.env)) {
        envBackup.set(provider.env, {
          had: Object.prototype.hasOwnProperty.call(process.env, provider.env),
          value: process.env[provider.env],
        });
      }
      const loaded = selected && provider.id === selected.id
        ? readProviderToken(provider.id)
        : keyStore.read(providerTokenSlot(provider.id, 0));
      if (loaded.key) process.env[provider.env] = loaded.key;
      else delete process.env[provider.env];
    }
  }

  function restoreEnvironment() {
    for (const [name, previous] of envBackup.entries()) {
      if (previous.had) process.env[name] = previous.value;
      else delete process.env[name];
    }
    envBackup = new Map();
  }

  async function waitForReady() {
    const provider = selectedProvider();
    const model = selectedModel();
    if (!provider || !model) {
      throw runtimeError('model_unavailable', 'The selected model is not available.');
    }

    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        /* The first provider.list call starts the lazy model-provider load.
           Empty answers while it warms up are expected, so poll. */
        const providers = await client.provider.list(location);
        const available = !!(providers && (providers.data || []).some((p) => p.id === provider.id));
        if (available) {
          const models = await client.model.list(location);
          const hasModel = !!(models && (models.data || []).some(
            (m) => m.providerID === provider.id && (m.id === model.id || m.modelID === model.id),
          ));
          if (hasModel) {
            const agents = await client.agent.list(location);
            if (agents && (agents.data || []).some((agent) => agent.id === AGENT_ID)) {
              return;
            }
          }
        }
      } catch (error) {
        lastError = error;
      }
      await delay(250);
    }

    throw runtimeError(
      'runtime_failed',
      lastError ? `The embedded assistant did not become ready: ${String(lastError.message || lastError).slice(0, 200)}`
        : 'The embedded assistant did not become ready.',
    );
  }

  async function start() {
    if (client) return client;
    if (starting) return starting;
    /* The page can change provider or model while the runtime is stopped.
       Read the saved choice again so a later start does not reuse a stale
       selection. */
    if (keyStore) settings = keyStore.getSettings();
    starting = (async () => {
      const provider = selectedProvider();
      const model = selectedModel();
      if (!provider || !model) {
        throw runtimeError('model_unavailable', 'The selected model is not available.');
      }
      const loaded = readProviderToken(provider.id);
      if (!loaded.key) {
        throw runtimeError(
          loaded.error === 'unreadable' ? 'provider_key_unreadable' : 'provider_key_missing',
          loaded.error === 'unreadable'
            ? 'The saved provider token could not be read. Enter it again.'
            : 'Save a provider token before turning on chat.',
        );
      }

      writeConfig();
      applyEnvironment();

      let sdk;
      try {
        sdk = await loadOpenCodeSdk();
      } catch (error) {
        throw runtimeError('runtime_failed', `The embedded assistant could not load: ${String(error.message || error).slice(0, 200)}`);
      }
      if (!sdk || typeof sdk.OpenCode?.create !== 'function') {
        throw runtimeError('runtime_failed', 'The embedded assistant SDK is not available.');
      }

      const created = await sdk.OpenCode.create({
        database: { path: databasePath },
        models: { fetch: false, snapshot: true },
        fs: { filewatcher: false },
        config: { directory: configDir, project: false, claude: false },
        plugins: [toolPlugin],
        log: {
          level: 'error',
          emit: (entry) => {
            if (entry && entry.level === 'error') {
              log(`[AI runtime] ${String(entry.message || entry).slice(0, 300)}`);
            }
          },
        },
      });
      client = created;
      workspace = workspaceDir;
      location = { location: { directory: workspace } };
      await waitForReady();
      return client;
    })().catch(async (error) => {
      if (client && typeof client.close === 'function') {
        try { await client.close(); } catch (closeError) { /* already closing */ }
      }
      client = null;
      sessionID = null;
      sessionTurns = 0;
      sessionTokens = 0;
      starting = null;
      restoreEnvironment();
      throw error;
    });
    return starting;
  }

  async function removeCurrentSession() {
    const id = sessionID;
    sessionID = null;
    sessionTurns = 0;
    sessionTokens = 0;
    if (!id) return;
    if (client) {
      try { await client.session.remove({ sessionID: id }); } catch (error) { /* already gone */ }
    }
    toolContext.clear(id);
  }

  async function closeClient({ preserveConversation = false } = {}) {
    if (client && typeof client.close === 'function') {
      try { await client.close(); } catch (error) { /* already closing */ }
    }
    client = null;
    sessionID = null;
    sessionTurns = 0;
    sessionTokens = 0;
    starting = null;
    toolContext.clearAll();
    if (!preserveConversation) {
      attachmentStore.clearAll();
      planStore.clearAll();
      memory.clearAll();
    }
    restoreEnvironment();
  }

  async function stop(options) {
    const pending = starting;
    starting = null;
    if (pending) {
      try { await pending; } catch (error) { /* start already failed */ }
    }
    await closeClient(options);
  }

  async function restart() {
    /* Restart is also used after a provider or model change. Re-read the
       saved selection so the new session is created with it. The draft,
       attachments and pending plans belong to the conversation, not to the
       old session, so keep them across the restart. */
    if (keyStore) settings = normaliseSettings(keyStore.getSettings());
    await stop({ preserveConversation: true });
    return start();
  }

  async function resetChat({ conversationId } = {}) {
    await removeCurrentSession();
    if (conversationId) {
      attachmentStore.clear(conversationId);
      planStore.clearConversation(conversationId);
      memory.clear(conversationId);
      taskKernel.reset(conversationId);
    } else {
      attachmentStore.clearAll();
      planStore.clearAll();
      memory.clearAll();
      taskKernel.reset();
    }
    return { success: true };
  }

  async function ensureSession() {
    await start();
    if (sessionID) return sessionID;
    const provider = selectedProvider();
    const model = selectedModel();
    if (!provider || !model) {
      throw runtimeError('model_unavailable', 'The selected model is not available.');
    }
    const session = await client.session.create({
      ...location,
      agent: AGENT_ID,
      model: {
        providerID: provider.id,
        id: model.id,
        variant: normaliseReasoning(settings.reasoning),
      },
      title: 'Posnic assistant',
      /* Belt and braces: the agent already denies every tool except the shop
         and local-note tools. Repeating the policy on the session keeps the
         rest of the catalogue out of the request, including the skill loader. */
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'provider.use', resource: provider.id, effect: 'allow' },
        { action: 'skill', resource: '*', effect: 'deny' },
        { action: 'posnic_search_products', resource: '*', effect: 'allow' },
        { action: 'posnic_list_products', resource: '*', effect: 'allow' },
        { action: 'posnic_list_categories', resource: '*', effect: 'allow' },
        { action: 'posnic_help', resource: '*', effect: 'allow' },
        { action: 'posnic_recall', resource: '*', effect: 'allow' },
        { action: 'posnic_user_profile', resource: '*', effect: 'allow' },
        { action: 'posnic_update_user_profile', resource: '*', effect: 'allow' },
        { action: 'posnic_ask_user', resource: '*', effect: 'allow' },
        { action: 'posnic_propose_plan', resource: '*', effect: 'allow' },
      ],
    });
    sessionID = session.id;
    sessionTurns = 0;
    sessionTokens = 0;
    return sessionID;
  }

  function providerErrorMessage(error) {
    const text = error && typeof error === 'object'
      ? (error.message || error.type || error.code)
      : error;
    return String(text || 'The model provider returned an error.').slice(0, 300);
  }

  function requestTooLargeMessage(original) {
    const provider = selectedProvider();
    const label = provider && provider.label ? provider.label : 'The provider';
    const budget = requestTokenLimit();
    const limit = budget
      ? `${label} limits one request to about ${budget.toLocaleString('en-US')} tokens on the free tier.`
      : `${label} rejected the request as too large.`;
    return `Request too large. ${limit} Start a new chat, lower the thinking level, or choose a provider with a larger request limit. (${original})`;
  }

  function retryAfterMsFromError(error) {
    if (!error || typeof error !== 'object') return 0;
    const direct = Number(error.retryAfterMs || error.retry_after_ms);
    if (Number.isFinite(direct) && direct > 0) return Math.round(direct);
    const retryAfter = Number(error.retryAfter || error.retry_after);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.round(retryAfter * 1000);

    let message = String(error.message || '');
    if (error.response && typeof error.response.body === 'string') {
      message += ` ${error.response.body}`;
    }
    const seconds = message.match(
      /(?:try again|retry)(?:\s+again)?\s+(?:in|after)\s+(?:(\d+)\s*m(?:in(?:ute)?s?)?\s*)?(\d+(?:\.\d+)?)\s*s\b/i,
    );
    if (seconds) {
      const minutes = Number(seconds[1] || 0);
      const rest = Number(seconds[2] || 0);
      if (minutes || rest) return Math.round((minutes * 60 + rest) * 1000);
    }
    const minutes = message.match(
      /(?:try again|retry)(?:\s+again)?\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\b/i,
    );
    if (minutes) return Math.round(Number(minutes[1]) * 60000);
    return 0;
  }

  function isRateLimitError(error) {
    if (!error) return false;
    if (typeof error === 'string') {
      return /rate limit|quota|tokens per day|too many requests/i.test(error);
    }
    const type = String(error.type || error.code || '').toLowerCase();
    const status = Number(
      error.status || error.statusCode || (error.response && error.response.status),
    );
    const message = String(error.message || '');
    return status === 429 ||
      type === 'rate_limited' ||
      type.includes('rate-limit') ||
      type.includes('rate_limit') ||
      /rate limit|quota|tokens per day|too many requests/i.test(message);
  }

  function providerFailure(error) {
    const rateLimited = isRateLimitError(error);
    const status = Number(
      (error && (error.status || error.statusCode ||
        (error.response && error.response.status))) || 0,
    );
    const type = String((error && (error.type || error.code)) || '').toLowerCase();
    const original = providerErrorMessage(error);
    const requestTooLarge = status === 413 ||
      /request too large|reduce your message size|payload too large/i.test(original);
    const failure = {
      ok: false,
      code: requestTooLarge
        ? 'request_too_large'
        : (rateLimited ? 'rate_limited' : 'provider_error'),
      message: requestTooLarge ? requestTooLargeMessage(original) : original,
      retryable: !requestTooLarge,
    };
    if (requestTooLarge) failure.requestTooLarge = true;
    if (rateLimited) {
      const retryAfterMs = retryAfterMsFromError(error);
      if (retryAfterMs > 0) failure.retryAfterMs = retryAfterMs;
    }
    failure.authFailed = status === 401 || status === 403 ||
      type === 'provider_key_invalid' ||
      /unauthorized|invalid.*(?:api.?key|token)|authentication failed/i.test(failure.message);
    log(
      `[AI provider] ${failure.code}${status ? ` status=${status}` : ''}` +
      `${failure.retryAfterMs ? ` retryAfterMs=${failure.retryAfterMs}` : ''}`,
    );
    const limit = original.match(/Limit\s+(\d+)\s*,\s*Requested\s+(\d+)/i);
    if (limit) {
      log(`[AI provider] request limit=${limit[1]} requested=${limit[2]}`);
    }
    return failure;
  }

  function isTokenFailure(reply) {
    return !!reply && (reply.code === 'rate_limited' ||
      reply.code === 'provider_key_invalid' ||
      reply.authFailed === true);
  }

  async function collectReply(id, cutoff) {
    const messages = await client.message.list({ sessionID: id });
    const list = (messages && messages.data) || [];
    const assistants = list
      .filter((item) => {
        if (!item || item.type !== 'assistant') return false;
        if (cutoff && item.time && item.time.created < cutoff) return false;
        return true;
      })
      .sort((left, right) => {
        const a = (left.time && left.time.created) || 0;
        const b = (right.time && right.time.created) || 0;
        return a - b;
      });

    const text = assistants.map(messageText).filter(Boolean).join('\n').trim();
    const toolCalls = assistants.flatMap(messageTools);
    const failed = assistants.find((item) => item.error);
    /* The last step sent the whole session, so its usage is the current
       context size. Earlier steps only describe a smaller intermediate
       prompt. */
    let tokens = null;
    for (let index = assistants.length - 1; index >= 0; index -= 1) {
      tokens = messageTokens(assistants[index]);
      if (tokens) break;
    }
    return {
      text,
      toolCalls,
      tokens,
      error: failed ? failed.error : null,
    };
  }

  /* Waiting is not the same as being stuck. A large request spends most of
     its time running tool steps, and one fixed deadline would cut it down in
     the middle of working. So the wait keeps looking at the session: a new
     assistant message is proof it is still alive, which earns it more time
     and gives the status line something to say. It only gives up after
     chatTimeout with nothing at all happening, which is a stall rather than
     a slow thought, or after a ceiling that stops a wedged session holding
     the turn open for ever. */
  async function waitForReply(id, cutoff, onProgress) {
    const startedAt = Date.now();
    const ceiling = chatTimeout * MAX_WAIT_MULTIPLIER;
    /* Never poll more slowly than the stall it is watching for. A short
       timeout must still be noticed on time, or a tight configuration would
       wait out the poll interval instead of the timeout. */
    const pollMs = Math.max(1, Math.min(ACTIVITY_POLL_MS, Math.floor(chatTimeout / 4) || 1));
    let lastActivityAt = Date.now();
    let lastCount = 0;
    let waitError = null;

    /* One wait for the whole turn. The loop races a timer against it rather
       than starting a new wait each poll, so the session is never awaited
       twice and a rejected wait is not lost between polls. */
    const waiting = Promise.resolve().then(() => client.session.wait({ sessionID: id }));
    waiting.catch((error) => { waitError = error; });

    for (;;) {
      const winner = await Promise.race([
        waiting.then(() => 'done', () => 'failed'),
        new Promise((resolve) => setTimeout(() => resolve('tick'), pollMs)),
      ]);
      if (winner === 'failed') return { error: waitError || new Error('wait failed') };
      if (winner === 'done') return { ok: true };

      let count = lastCount;
      try {
        const messages = await client.message.list({ sessionID: id });
        const list = (messages && messages.data) || [];
        count = list.filter((item) => item && item.type === 'assistant' &&
          (!cutoff || !item.time || item.time.created >= cutoff)).length;
      } catch (error) {
        /* Could not read the session. That says nothing either way, so it
           neither extends the life of this turn nor ends it. */
      }

      if (count > lastCount) {
        lastActivityAt = Date.now();
        lastCount = count;
        if (count > 0) reportProgress(onProgress, 'working');
      }

      const silentMs = Date.now() - lastActivityAt;
      const totalMs = Date.now() - startedAt;
      if (silentMs >= chatTimeout) return { stalled: true, silentMs, totalMs };
      if (totalMs >= ceiling) return { overrun: true, silentMs, totalMs };
    }
  }

  async function requestReply(id, promptText, options = {}) {
    const startedAt = Date.now();
    let prompt;
    try {
      prompt = await client.session.prompt({ sessionID: id, text: promptText });
    } catch (error) {
      return providerFailure(error);
    }

    const promptDoneAt = Date.now();
    const cutoff = (prompt && prompt.time && prompt.time.created) || 0;
    const waited = await waitForReply(id, cutoff, options.onProgress);
    if (waited.stalled || waited.overrun) {
      try { await client.session.interrupt({ sessionID: id }); } catch (interruptError) { /* already stopped */ }
      {
        /* A slow model may have finished the plan and then kept the session
           busy. Do not throw that completed work away: collect the steps it
           already produced and return a plan or question if one is there. */
        let collected = null;
        try {
          collected = await collectReply(id, cutoff);
        } catch (collectError) { /* the timeout result still stands */ }
        if (collected &&
            (collected.text || collected.toolCalls.length) &&
            planOrQuestionSucceeded(collected.toolCalls)) {
          log(
            `[AI timing] session=${id} ${waited.overrun ? 'hit the wait ceiling' : 'stalled'}; ` +
            `returning the completed work wait=${Date.now() - promptDoneAt}ms ` +
            `steps=${collected.toolCalls.length}`,
          );
          return {
            ok: true,
            text: collected.text,
            toolCalls: collected.toolCalls,
            tokens: collected.tokens,
          };
        }
        log(
          `[AI timing] session=${id} ` +
          `${waited.overrun ? 'wait ceiling' : 'idle timeout'} ` +
          `silent=${waited.silentMs}ms total=${waited.totalMs}ms`,
        );
        return {
          ok: false,
          code: 'chat_timeout',
          message: waited.overrun
            ? 'The assistant took too long to reply.'
            : 'The assistant stopped responding. Try again.',
          retryable: false,
        };
      }
    }
    if (waited.error) return providerFailure(waited.error);

    const waitDoneAt = Date.now();
    let collected;
    try {
      collected = await collectReply(id, cutoff);
    } catch (error) {
      log(`[AI timing] session=${id} prompt=${promptDoneAt - startedAt}ms wait=${waitDoneAt - promptDoneAt}ms collect=failed promptChars=${promptText.length}`);
      return providerFailure(error);
    }
    log(
      `[AI timing] session=${id} prompt=${promptDoneAt - startedAt}ms ` +
      `wait=${waitDoneAt - promptDoneAt}ms collect=${Date.now() - waitDoneAt}ms ` +
      `promptChars=${promptText.length} replyChars=${collected.text.length} ` +
      `tools=${collected.toolCalls.length} tokens=${tokenTotal(collected.tokens)}`,
    );
    if (collected.text || collected.toolCalls.length) {
      return {
        ok: true,
        text: collected.text,
        toolCalls: collected.toolCalls,
        tokens: collected.tokens,
      };
    }
    if (collected.error) {
      return providerFailure(collected.error);
    }
    return {
      ok: false,
      code: 'empty_reply',
      message: 'The assistant returned an empty reply. Try again.',
      retryable: true,
    };
  }

  async function compactSession() {
    if (!sessionID || !client) return false;
    if (!client.session || typeof client.session.compact !== 'function') return false;
    try {
      await client.session.compact({ sessionID });
      if (typeof client.session.wait === 'function') {
        await withTimeout(
          client.session.wait({ sessionID }),
          COMPACT_TIMEOUT_MS,
          'compact_timeout',
          'The assistant context could not be compacted.',
        );
      }
      sessionTurns = 0;
      sessionTokens = 0;
      return true;
    } catch (error) {
      log(`[AI memory] compaction failed: ${String((error && error.message) || error).slice(0, 200)}`);
      return false;
    }
  }

  /* Progress is a UI courtesy. A broken listener must never break the turn. */
  function reportProgress(onProgress, stage, extra) {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ stage, at: Date.now(), ...(extra || {}) });
    } catch (error) {
      log(`[AI progress] ${error.message}`);
    }
  }

  function requestKernelState(conversation, intent, pending, turn) {
    try {
      taskKernel.observe(conversation, { intent, pending, memory, turn });
    } catch (error) {
      log(`[AI task] state update failed: ${error.message}`);
    }
  }

  function localContextBlock(context) {
    if (!context || typeof context !== 'object') return '';
    try {
      /* The local check is compact by construction. Keep a hard cap anyway:
         this is reference data, not a place to paste the category table. The
         resolution plan sits near the front so it survives any truncation. */
      const limit = lowRequestBudget() ? COMPACT_LOCAL_CONTEXT_CHARS : 3000;
      return `[Local pre-check]\n${JSON.stringify(context).slice(0, limit)}`;
    } catch (error) {
      return '';
    }
  }

  function compactTaskCard(card) {
    const text = String(card || '').trim();
    if (!text || !lowRequestBudget() || text.length <= COMPACT_TASK_CARD_CHARS) return text;
    return `${text.slice(0, COMPACT_TASK_CARD_CHARS - 20).trim()}\n[End task card]`;
  }

  function buildPrompt(conversation, message, attached, {
    full = false,
    currencySign = '',
    localContext = null,
    taskCard = '',
    budget = Number.POSITIVE_INFINITY,
  } = {}) {
    /* The live session is the model's transcript, but it is not a reliable
       place to keep a decision: a compaction, a topic switch or a retry can
       drop the message that carried the user's last answer. The compact
       memory block is reference data, not a second transcript, and is cheap
       enough to send on every turn. It is what keeps the current category and
       settled answers from being asked for again. */
    const block = memory.contextFor(conversation, { full, message });
    const notice = attachmentNotice(attached);
    /* These three are the only part of the request the runtime can give up,
       so they are the only part the budget is allowed to cut. They are fitted
       in REFERENCE_PRIORITY order: a tight cap costs the task card and the
       local pre-check long before it costs a settled answer, and only then
       trims a layer from its tail. The currency line and the message itself
       are not reference data and are never dropped. */
    const fitted = fitReferenceLayers([
      { name: 'memory', text: block },
      { name: 'card', text: compactTaskCard(taskCard) },
      { name: 'local', text: localContextBlock(localContext) },
    ], budget);
    if (fitted.dropped.length || fitted.trimmed.length) {
      log(
        `[AI budget] reference did not fit budget=${budget} ` +
        `dropped=${fitted.dropped.join(',') || '-'} ` +
        `trimmed=${fitted.trimmed.join(',') || '-'}`,
      );
    }
    return [
      fitted.text,
      currencyInstruction(currencySign),
      `${String(message || '').trim()}${notice}`,
    ].filter(Boolean).join('\n\n');
  }

  function correctionPrompt(correction, currencySign = '') {
    return [currencyInstruction(currencySign), correction].filter(Boolean).join('\n\n');
  }

  const READ_TOOL_RE = /^(posnic_search_products|posnic_list_products|posnic_list_categories|posnic_recall|posnic_help)$/;
  const CREATE_REQUEST_RE = /(?:أضيف|اضيف|أضف|اضف|ضيف|إضافة|اضافة|إنشاء|انشاء|new product|add product|create product)/i;

  function isCreateRequest(value) {
    return CREATE_REQUEST_RE.test(String(value || ''));
  }

  function exactDuplicate(toolCalls, message) {
    const wanted = normalizeName(message);
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
      if (!call) continue;
      const result = call.metadata && call.metadata.posnic;
      if (!result || (result.kind !== 'product_search' && result.kind !== 'product_list')) continue;
      const query = normalizeName(call.input && call.input.query) || wanted;
      for (const item of Array.isArray(result.results) ? result.results : []) {
        const name = normalizeName(item && item.name);
        if (!name) continue;
        if (name === query || (Array.from(name).length >= 4 && wanted.includes(name))) {
          return item;
        }
      }
    }
    return null;
  }

  const PRODUCT_READ_KINDS = new Set(['product_search', 'product_list']);

  function isProductReadCall(call) {
    const result = call && call.metadata && call.metadata.posnic;
    return !!result && PRODUCT_READ_KINDS.has(result.kind);
  }

  function clarifyQuestions(toolCalls) {
    const questions = [];
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
      if (!call || call.name !== 'posnic_ask_user') continue;
      const result = call.metadata && call.metadata.posnic;
      if (!result || result.kind !== 'clarify' || !result.question) continue;
      questions.push(String(result.question));
    }
    return questions;
  }

  /* Prose that asks the user for something when a clarify card is present. */
  const QUESTION_PROSE_RE = /(?:[?؟]|(?:^|\s)(?:please|kindly|provide|tell|send|give|share|enter|specify|need|want|which|what|how many|confirm)\b|أرجو|ارجو|من\s+فضلك|زودني|زودنى|اذكر|أحتاج|احتاج|محتاج|حدد|أدخل|ادخل|قولي|قولى|ما\s+هو|ما\s+هي|هل\s)/i;

  /* The clarify card already asks the question. A prose bubble that repeats it
     makes the same turn look like two questions, so drop the duplicate. Models
     often rephrase the card's question, so compare the content words too, not
     just the exact sentence. */
  function suppressRepeatedQuestion(text, toolCalls) {
    const value = String(text || '').trim();
    if (!value) return value;
    const questions = clarifyQuestions(toolCalls);
    if (!questions.length) return value;
    const normalized = normalizeName(value);
    if (!normalized) return value;
    const words = new Set(normalized.split(' ').filter((word) => word.length >= 3));
    for (const question of questions) {
      const asked = normalizeName(question);
      if (!asked) continue;
      if (normalized === asked || normalized.includes(asked) || asked.includes(normalized)) {
        return '';
      }
      const askedWords = new Set(asked.split(' ').filter((word) => word.length >= 3));
      let shared = 0;
      for (const word of words) {
        if (askedWords.has(word)) shared += 1;
      }
      if (shared >= 2 && shared >= Math.ceil(words.size * 0.5)) return '';
    }
    if (QUESTION_PROSE_RE.test(value)) return '';
    return value;
  }

  function arabicDigits(value) {
    return String(value == null ? '' : value).replace(/[0-9]/g, (digit) => '٠١٢٣٤٥٦٧٨٩'[digit]);
  }

  function duplicateQuestion(item, message) {
    const arabic = /[\u0600-\u06FF]/.test(String(message || ''));
    const name = String((item && item.name) || '').trim().slice(0, 120);
    const values = [];
    if (Number.isFinite(Number(item && item.sellingPrice))) {
      values.push(`${arabic ? 'السعر' : 'price'} ${arabic ? arabicDigits(item.sellingPrice) : item.sellingPrice}`);
    }
    if (Number.isFinite(Number(item && item.costPrice))) {
      values.push(`${arabic ? 'التكلفة' : 'cost'} ${arabic ? arabicDigits(item.costPrice) : item.costPrice}`);
    }
    if (Number.isFinite(Number(item && item.stock))) {
      values.push(`${arabic ? 'المخزون' : 'stock'} ${arabic ? arabicDigits(item.stock) : item.stock}`);
    }
    const detail = values.length ? ` (${values.join(arabic ? '، ' : ', ')})` : '';
    if (arabic) {
      return {
        question: `المنتج «${name}» موجود بالفعل${detail}. هل تريد تعديل السعر أو التكلفة أو المخزون، أم إلغاء؟`,
        options: [
          { label: 'تعديل السعر', value: 'تعديل السعر' },
          { label: 'تعديل التكلفة', value: 'تعديل التكلفة' },
          { label: 'تعديل المخزون', value: 'تعديل المخزون' },
          { label: 'إلغاء', value: 'إلغاء' },
        ],
        pending: `المنتج الموجود: ${name}${detail}`,
      };
    }
    return {
      question: `The product "${name}" already exists${detail}. Do you want to edit the price, cost or stock, or cancel?`,
      options: [
        { label: 'Edit price', value: 'Edit price' },
        { label: 'Edit cost', value: 'Edit cost' },
        { label: 'Edit stock', value: 'Edit stock' },
        { label: 'Cancel', value: 'Cancel' },
      ],
      pending: `Existing product: ${name}${detail}`,
    };
  }

  function duplicateClarify(item, message) {
    const copy = duplicateQuestion(item, message);
    return {
      id: `posnic_duplicate_${Date.now().toString(36)}`,
      name: 'posnic_ask_user',
      status: 'completed',
      input: { question: copy.question, options: copy.options.map((option) => option.value), missing: [] },
      metadata: { posnic: presentClarification({
        kind: 'clarify',
        question: copy.question,
        options: copy.options,
        pending: copy.pending,
        missing: [],
      }) },
    };
  }

  function localClarifyCall(result) {
    return {
      id: `posnic_local_question_${Date.now().toString(36)}`,
      name: 'posnic_ask_user',
      status: 'completed',
      input: {
        question: result.question,
        options: (result.options || []).map((option) => option.value),
        pending: result.pending,
        missing: result.missing || [],
      },
      metadata: { posnic: presentClarification({
        kind: 'clarify',
        question: result.question,
        options: result.options || [],
        pending: result.pending,
        missing: result.missing || [],
        draft: result.draft || null,
      }) },
    };
  }

  function localPlanCall(plan) {
    return {
      id: `posnic_local_plan_${Date.now().toString(36)}`,
      name: 'posnic_propose_plan',
      status: 'completed',
      input: {
        title: plan.title,
        summary: plan.summary,
        steps: plan.steps,
        /* The corrections the local checker applied ride with the proposal
           so the confirmation card can show what changed before commit. */
        ...(Array.isArray(plan.corrections) && plan.corrections.length
          ? { corrections: plan.corrections }
          : {}),
      },
      metadata: { posnic: { kind: 'write_plan', plan } },
    };
  }

  function planOrQuestionSucceeded(toolCalls) {
    return (Array.isArray(toolCalls) ? toolCalls : []).some((call) => {
      const name = call && call.name;
      const result = call && call.metadata && call.metadata.posnic;
      if (name === 'posnic_propose_plan') return !!result && result.kind === 'write_plan';
      if (name === 'posnic_ask_user') return !!result && result.kind === 'clarify';
      return false;
    });
  }

  function shouldContinuePending(reply) {
    if (!reply || !reply.ok) return false;
    const calls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
    if (!calls.length || planOrQuestionSucceeded(calls)) return false;
    return calls.some((call) => READ_TOOL_RE.test(String((call && call.name) || '')));
  }

  function pendingCorrection(pending, message) {
    const answered = Array.isArray(pending.answers) ? pending.answers : [];
    const latest = answered.length ? answered[answered.length - 1] : null;
    const category = pending.category && pending.category.name;
    const stage = pending.stage || '';
    return [
      '[Correction from Posnic]',
      'The user just answered your pending question. Continue that unfinished request; do not search, list products or change topic.',
      stage ? `Stage: ${stage}${stage === 'collecting' ? ' — ask for the missing values themselves, never for permission to continue.' : ''}` : '',
      pending.text ? `Original request: ${pending.text}` : '',
      pending.note ? `Recorded draft: ${pending.note}` : '',
      pending.question ? `You asked: ${pending.question}` : '',
      pending.missing && pending.missing.length ? `Still missing: ${pending.missing.join(', ')}` : '',
      answered.length
        ? `Already answered for this request (settled; do not ask again): ${answered
          .map((item) => memory.settledAnswer(item))
          .join('; ')}`
        : '',
      category
        ? `Current category: ${category}${pending.category.id ? ` | id ${pending.category.id}` : ''}. Use it unless the user named another category; never ask for it again or create a near-duplicate.`
        : '',
      /* A choice the user clicked is already decided, so the wording of the
         button is not handed over to be read as prose again. That re-reading
         is what turned "no category, without a photo" into a category name
         and got the whole plan rejected. */
      latest && latest.decision
        ? `The user chose one of the options you offered: ${memory.settledAnswer(latest)}. Apply it exactly as it stands: "none" means leave that field empty, and it is never a name or a value to look up.`
        : `The user answered: ${String(message || '').trim()}`,
      /* One option set decides one value, so "bundle everything" and
         ask_missing_split can never both be right. The gate wins: a free-text
         question may still cover the remaining values together, but a question
         with buttons asks for the single value its buttons decide. */
      'If every required value is known and the image and category questions were answered, call posnic_propose_plan now. If something is still missing, call posnic_ask_user: a free-text question may cover the remaining values together, but one option set decides exactly one value, so with options ask for that one value only. Never ask again for what was answered. Never use 0 for a price or cost the user did not give.',
    ].filter(Boolean).join('\n');
  }

  function shouldContinueWrite(reply) {
    if (!reply || !reply.ok) return false;
    const calls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
    /* A plan or a real clarification finishes the turn. Any other answer to
       an explicit add/create request is incomplete, even if it is only text. */
    return !planOrQuestionSucceeded(calls);
  }

  function writeCorrection(pending, message) {
    const category = pending && pending.category && pending.category.name;
    const stage = pending && pending.stage ? pending.stage : '';
    return [
      '[Correction from Posnic]',
      'The user asked you to add or change a shop record. Do not stop at search results, do not ask the user to repeat the request, and do not change topic. Continue that request now.',
      stage ? `Stage: ${stage}${stage === 'collecting' ? ' — ask for the missing values themselves, never for permission to continue.' : ''}` : '',
      pending.text ? `Request: ${pending.text}` : '',
      category ? `Current category: ${category}. Use it unless the user named another category.` : '',
      `The user just wrote: ${String(message || '').trim()}`,
      'Use the search results you already have. Do not search again.',
      'If the user already named a category, use the closest active category; never create a near-duplicate and never ask which category to use.',
      'If every required value is known, call posnic_propose_plan now. If a required value is missing, call posnic_ask_user for it: a free-text question may cover the remaining values together, but one option set decides exactly one value. Never use 0 for a price or cost the user did not give.',
    ].filter(Boolean).join('\n');
  }

  function contextLimit() {
    const model = selectedModel();
    const limit = model && model.limit && Number(model.limit.context);
    return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_CONTEXT_LIMIT;
  }

  async function workingSession(turn) {
    const limit = contextLimit();
    const budget = requestTokenLimit();
    const lowBudget = budget > 0 && budget <= LOW_REQUEST_BUDGET;
    /* Compact before the window is full, but only from real usage. A fixed
       turn or character limit would throw away most of a 131k-token window. */
    const overBudget = sessionTokens >= limit * HARD_CONTEXT_RATIO;
    /* A low per-request limit is a different budget from the context window.
       After the first real turn, start a fresh session so the old transcript
       cannot push the next request over the provider's limit. The compact
       memory block carries the pending request and settled answers. */
    const requestPressure = lowBudget && sessionTokens > 0 &&
      sessionTokens >= budget * LOW_REQUEST_PRESSURE;
    let fresh = !sessionID || turn.switched || overBudget || requestPressure;
    if (!fresh && sessionTokens >= limit * COMPACT_AT_CONTEXT_RATIO) {
      const compacted = await compactSession();
      if (!compacted) fresh = true;
    }
    if (fresh) {
      await removeCurrentSession();
      const id = await ensureSession();
      return { id, full: !lowBudget };
    }
    return { id: sessionID, full: false };
  }

  async function chat({
    message,
    reset,
    history,
    authToken,
    branchId,
    username,
    conversationId,
    currencySign,
    onProgress,
    answer,
    attachedIds,
  } = {}) {
    if (reset) await resetChat({ conversationId });
    let provider = selectedProvider();
    let model = selectedModel();
    const conversation = conversationKey(conversationId) || 'default';

    if (Array.isArray(history) && history.length && !memory.has(conversation)) {
      memory.seed(conversation, history);
    }

    /* The card's attachment ids only count if this conversation actually holds
       them: a forged or foreign id must never become the draft's image, so the
       list is checked against the store before it is resolved. */
    const stored = attachmentStore.list(conversation);
    const storedIds = stored.map((item) => item && item.id).filter(Boolean);
    const safeAnswer = answer && typeof answer === 'object'
      ? (Array.isArray(answer.attachmentIds)
        ? Object.assign({}, answer, {
          attachmentIds: answer.attachmentIds.filter((id) => storedIds.indexOf(id) !== -1),
        })
        : answer)
      : null;
    const turn = memory.beginTurn(conversation, message, {
      answer: safeAnswer,
    });
    if (!turn) {
      throw runtimeError('conversation_missing', 'The chat session is missing. Reload the page and try again.');
    }

    const sentImages = (Array.isArray(attachedIds) ? attachedIds : [])
      .map((id) => (typeof id === 'string' ? id.trim().slice(0, 80) : ''))
      .filter((id) => storedIds.indexOf(id) !== -1)
      .slice(0, 8);
    if (sentImages.length) {
      memory.noteImage(conversation, 'attached', sentImages, { onlyIfUnset: true });
    }
    const pending = memory.pendingRequest(conversation);
    /* What the model may write into a plan is decided by the draft, not by
       the queue. A recorded picture is the only one offered; a decline
       advertises nothing - unless this very message carried a fresh upload,
       which overrides it; and only an undecided slot falls back to this
       message's uploads, so a chip left over from an earlier turn is never
       offered for a product whose picture the operator already refused. */
    const imageState = pending && pending.draft && pending.draft.image;
    const imageStatus = imageState && imageState.status;
    const answerIds = safeAnswer && Array.isArray(safeAnswer.attachmentIds)
      ? safeAnswer.attachmentIds
      : [];
    const allowedImages = imageStatus === 'attached' && Array.isArray(imageState.attachmentIds) &&
      imageState.attachmentIds.length
      ? imageState.attachmentIds
      : (imageStatus === 'none' && !answerIds.length ? [] : sentImages);
    /* The model is offered exactly those ids - never the session's whole
       list, so an image used for one product cannot be written into the plan
       of the next one. */
    const attached = stored.filter((item) => allowedImages.indexOf(item && item.id) !== -1);
    const token = typeof authToken === 'string' ? authToken : '';
    const activeBranchId = typeof branchId === 'string' ? branchId : '';

    reportProgress(onProgress, 'understanding');
    let intent = null;
    try {
      intent = extractIntent(message, { pending });
    } catch (error) {
      log(`[AI intent] extraction failed: ${error.message}`);
    }
    requestKernelState(conversation, intent, pending, turn);

    /* A standard single-product create is handled locally, before OpenCode is
       started. Anything with a second meaning goes to the model. */
    let localApi = null;
    if (token && resolveApiBaseUrl()) {
      try {
        localApi = createApiClient({
          baseUrl: resolveApiBaseUrl(),
          token,
          branchId: activeBranchId,
          fetchImpl,
        });
      } catch (error) {
        localApi = null;
      }
    }
    /* The local check is an optimization, never a gate: a bug in it must not
       stop the assistant from answering. On failure the model gets the turn. */
    const pendingProduct = !!(pending && pending.draft &&
      pending.draft.kind === 'create_product');
    const localCreate = !!(intent && intent.confidence === 'high' &&
      intent.action === 'create_product');
    let local = null;
    if (localCreate || (turn.pendingAnswer && pendingProduct)) {
      reportProgress(onProgress, 'reading_shop');
      try {
        local = await runLocalProductFlow({
          message,
          pending,
          api: localApi,
          branchId: activeBranchId,
          conversationId: conversation,
          memory,
          attachments: attachmentStore,
          turn,
          userText: memory.userTextFor(conversation),
          log,
        });
      } catch (error) {
        log(`[AI local] product check failed: ${error.message}`);
      }
    }

    /* Live reads answer from authorized item rows only. The intent parser has
       already refused a sentence with a second question or instruction. */
    const readActions = [
      'read_stock', 'read_price', 'read_count', 'read_profit', 'list_products',
    ];
    let live = null;
    /* An answer to a pending question can mention a price or a quantity
       without being a lookup. Let the model interpret it in context instead
       of answering it as a live read for a product that does not exist yet. */
    if (!(local && local.handled) && localApi && intent &&
        !turn.pendingAnswer &&
        intent.confidence === 'high' && readActions.includes(intent.action)) {
      reportProgress(onProgress, 'reading_shop');
      try {
        live = await runLiveRead({
          intent,
          message,
          api: localApi,
          currencySign,
        });
      } catch (error) {
        log(`[AI local] live read failed: ${error.message}`);
      }
    }

    /* A fully known update, stock change or multi-action sentence becomes the
       same validated plan the model would propose. */
    const planActions = [
      'update_product', 'adjust_stock', 'multi', 'create_category', 'bulk_create',
    ];
    let compiled = null;
    /* The same applies to a compiler plan: an answer to a pending question is
       part of that request, not a new standalone edit to resolve. */
    if (!(local && local.handled) && !(live && live.handled) && localApi &&
        !turn.pendingAnswer &&
        intent && intent.confidence === 'high' &&
        planActions.includes(intent.action)) {
      reportProgress(onProgress, 'preparing_plan');
      try {
        compiled = await runCompiler({
          intent,
          message,
          api: localApi,
          conversationId: conversation,
          memory,
          attachments: attachmentStore,
          pending,
          kernel: taskKernel,
          currencySign,
        });
      } catch (error) {
        log(`[AI local] compiler failed: ${error.message}`);
      }
    }

    let promptText = '';
    let correctionText = '';
    let usedRecovery = false;
    let localHandled = false;
    let activeSessionId = sessionID || '';
    let reply;

    if (local && local.handled) {
      localHandled = true;
      if (local.kind === 'plan') {
        local.plan.conversationId = conversation;
        planStore.add(local.plan);
        reply = {
          ok: true,
          text: '',
          toolCalls: [localPlanCall(local.plan)],
          tokens: null,
        };
      } else if (local.kind === 'clarify') {
        reply = {
          ok: true,
          text: '',
          toolCalls: [localClarifyCall(local.result)],
          tokens: null,
        };
      } else {
        reply = { ok: true, text: local.text || '', toolCalls: [], tokens: null };
      }
      log('[AI local] product request handled without a model request');
    } else if (live && live.handled) {
      localHandled = true;
      reply = {
        ok: true,
        text: live.text || '',
        toolCalls: Array.isArray(live.toolCalls) ? live.toolCalls : [],
        tokens: null,
      };
      log('[AI local] live shop read answered without a model request');
    } else if (compiled && compiled.handled) {
      localHandled = true;
      if (compiled.kind === 'plan') {
        compiled.plan.conversationId = conversation;
        planStore.add(compiled.plan);
        reply = {
          ok: true,
          text: '',
          toolCalls: [localPlanCall(compiled.plan)],
          tokens: null,
        };
      } else if (compiled.kind === 'clarify') {
        reply = {
          ok: true,
          text: '',
          toolCalls: [localClarifyCall(compiled.result)],
          tokens: null,
        };
      } else {
        reply = { ok: true, text: compiled.text || '', toolCalls: [], tokens: null };
      }
      log('[AI local] plan compiled without a model request');
    } else {
      await start();
      provider = selectedProvider();
      model = selectedModel();
      const session = await workingSession(turn);
      activeSessionId = session.id;

      /* The renderer owns the user's JWT, active branch and account name. Keep
         them for this session only; the tools read them on demand. */
      toolContext.set(session.id, {
        apiBaseUrl: resolveApiBaseUrl(),
        token,
        branchId: activeBranchId,
        username: typeof username === 'string' ? username : '',
        conversationId: conversation,
      });

      let modelRequests = 0;
      const requestModel = async (id, prompt, options) => {
        const countsBudget = !options || options.budget !== false;
        if (countsBudget) {
          if (modelRequests >= MAX_MODEL_REQUESTS) {
            return {
              ok: false,
              code: 'request_budget_exhausted',
              message: 'The assistant used its request budget for this turn. Try again.',
              retryable: false,
            };
          }
          modelRequests += 1;
        }
        reportProgress(onProgress, 'waiting_model');
        const slow = setTimeout(
          () => reportProgress(onProgress, 'slow'),
          slowNotice,
        );
        const requestAt = Date.now();
        try {
          const reply = await requestReply(id, prompt, { onProgress });
          /* One line for this request. It is the only place that can tell a
             slow-but-working turn apart from one the provider refused, which
             is what the old single-character-count log could never do. */
          log(formatLlmRequest({
            index: modelRequests,
            id,
            prompt,
            reply,
            ms: Date.now() - requestAt,
            counted: countsBudget,
            cap: requestTokenLimit(),
          }));
          return reply;
        } finally {
          clearTimeout(slow);
        }
      };

      /* One budget for the whole turn. The cap, the fixed payload and the
         thinking level do not change while it runs, and every retry below
         rebuilds the same request against the same room. */
      const requestBudget = await budgetForRequest();
      promptText = buildPrompt(conversation, message, attached, {
        full: session.full,
        currencySign,
        localContext: (local && local.context) || (compiled && compiled.context),
        taskCard: taskKernel.cardFor(conversation),
        budget: requestBudget,
      });
      if (lowRequestBudget()) {
        log(`[AI prompt] chars=${promptText.length} request_limit=${requestTokenLimit()}`);
      }
      reply = await requestModel(session.id, promptText);

      /* A quota or an invalid token is tied to the token. Walk the saved tokens
         in order, retrying the same turn in a fresh session with the
         conversation memory. Each token is tried at most once, and the last
         usable token stays active for the next turn. */
      const attemptedTokens = new Set([activeTokenIndex(provider.id)]);
      while (!reply.ok && isTokenFailure(reply) &&
             rotateProviderToken(provider.id, attemptedTokens)) {
        attemptedTokens.add(activeTokenIndex(provider.id));
        log(`[AI auth] ${reply.code}; retrying with provider token ${activeTokenIndex(provider.id) + 1}`);
        await removeCurrentSession();
        await restart();
        const freshId = await ensureSession();
        activeSessionId = freshId;
        toolContext.set(freshId, {
          apiBaseUrl: resolveApiBaseUrl(),
          token,
          branchId: activeBranchId,
          username: typeof username === 'string' ? username : '',
          conversationId: conversation,
        });
        promptText = buildPrompt(conversation, message, attached, {
          full: !lowRequestBudget(),
          currencySign,
          localContext: (local && local.context) || (compiled && compiled.context),
          taskCard: taskKernel.cardFor(conversation),
          budget: requestBudget,
        });
        reply = await requestModel(freshId, promptText, { budget: false });
      }

      /* A create request for a product that already exists must not become a
         generic "enter price, cost, stock..." question. The search result is
         enough to ask the real choice, without another model round trip. */
      if (reply.ok && turn.writeRequest && isCreateRequest(message) &&
          !planOrQuestionSucceeded(reply.toolCalls)) {
        const duplicate = exactDuplicate(reply.toolCalls, message);
        if (duplicate) {
          log(`[AI memory] exact duplicate found; asking whether to update ${duplicate.id || duplicate.name}`);
          reply = {
            ...reply,
            text: '',
            toolCalls: [...reply.toolCalls, duplicateClarify(duplicate, message)],
          };
        }
      }

      /* A 413 is a size error, not a transient provider failure. Retrying the
         same full transcript only produces the same 413. Drop the transcript,
         keep the compact memory and try once; if it is still too large the
         page shows a clear request-limit message. */
      if (!reply.ok && reply.requestTooLarge && sessionTurns > 0) {
        usedRecovery = true;
        log('[AI memory] retrying in a fresh session with compact memory after request_too_large');
        await removeCurrentSession();
        const freshId = await ensureSession();
        activeSessionId = freshId;
        toolContext.set(freshId, {
          apiBaseUrl: resolveApiBaseUrl(),
          token,
          branchId: activeBranchId,
          username: typeof username === 'string' ? username : '',
          conversationId: conversation,
        });
        promptText = buildPrompt(conversation, message, attached, {
          full: false,
          currencySign,
          localContext: (local && local.context) || (compiled && compiled.context),
          taskCard: taskKernel.cardFor(conversation),
          budget: requestBudget,
        });
        reply = await requestModel(freshId, promptText);
      }

      if (!reply.ok && reply.retryable && reply.code !== 'rate_limited' && sessionTurns > 0) {
        usedRecovery = true;
        log(`[AI memory] retrying in a fresh session after ${reply.code}`);
        await removeCurrentSession();
        const freshId = await ensureSession();
        activeSessionId = freshId;
        toolContext.set(freshId, {
          apiBaseUrl: resolveApiBaseUrl(),
          token,
          branchId: activeBranchId,
          username: typeof username === 'string' ? username : '',
          conversationId: conversation,
        });
        promptText = buildPrompt(conversation, message, attached, {
          full: !lowRequestBudget(),
          currencySign,
          localContext: (local && local.context) || (compiled && compiled.context),
          taskCard: taskKernel.cardFor(conversation),
          budget: requestBudget,
        });
        reply = await requestModel(freshId, promptText);
      }

      if (!reply.ok) {
        throw runtimeError(
          reply.code,
          reply.message,
          reply.retryAfterMs ? { retryAfterMs: reply.retryAfterMs } : undefined,
        );
      }

      /* If an explicit add/create request, or an answer to a pending question,
         made the model wander into a read or stop without a plan, give it one
         corrective turn inside the same session. The failed read is discarded
         from memory; only this final answer is recorded. */
      const currentPending = memory.pendingRequest(conversation) || pending;
      const needsPending = turn.pendingAnswer && shouldContinuePending(reply);
      const needsWrite = turn.writeRequest && shouldContinueWrite(reply);
      if (currentPending && (needsPending || needsWrite)) {
        const correction = needsPending
          ? pendingCorrection(currentPending, message)
          : writeCorrection(currentPending, message);
        correctionText = correctionPrompt(correction, currencySign);
        log(`[AI memory] continuing ${needsPending ? 'an answered request' : 'a write request'} after an incomplete reply`);
        const corrected = await requestModel(activeSessionId, correctionText);
        if (corrected.ok) {
          reply = corrected;
        } else {
          /* Showing the discarded search result would look like a completed
             read and hide the unfinished write. Fail so the page offers Retry. */
          log(`[AI memory] continuation failed: ${corrected.code}`);
          throw runtimeError(
            corrected.code || 'provider_error',
            corrected.message || 'The assistant could not finish the request. Try again.',
            corrected.retryAfterMs ? { retryAfterMs: corrected.retryAfterMs } : undefined,
          );
        }
      }
    }

    reply.text = normalizeCurrencyText(reply.text);
    reply.text = suppressRepeatedQuestion(reply.text, reply.toolCalls);
    /* An explicit create request should not turn into a browse of similar
       products. Keep the duplicate check internal: only an exact match keeps
       its result card so the shop can see what was found. */
    const createText = turn.writeRequest
      ? message
      : (turn.pendingAnswer && pending ? pending.text : '');
    const hideProductReads = !!createText &&
      isCreateRequest(createText) &&
      !exactDuplicate(reply.toolCalls, createText);
    try {
      taskKernel.noteToolCalls(
        conversation,
        Array.isArray(reply.toolCalls) ? reply.toolCalls : [],
      );
    } catch (error) {
      log(`[AI task] tool state update failed: ${error.message}`);
    }
    /* A self-correction returned by a tool is for the model. It must not
       appear as a failed shop action in the chat while the model retries. */
    const visibleToolCalls = (Array.isArray(reply.toolCalls) ? reply.toolCalls : [])
      .filter((call) => {
        const posnic = call && call.metadata && call.metadata.posnic;
        return !(posnic && posnic.internal === true);
      })
      .filter((call) => !hideProductReads || !isProductReadCall(call));
    const completed = memory.completeTurn(conversation, reply.text, visibleToolCalls);
    if (!localHandled) {
      sessionTurns += correctionText ? 2 : 1;
      /* The provider reports the whole prompt plus the reply, so it is the
         authoritative context size. Only estimate when usage is missing. */
      const reportedTokens = tokenTotal(reply.tokens);
      if (reportedTokens > 0) {
        sessionTokens = reportedTokens;
      } else {
        const turnChars = promptText.length +
          (correctionText ? correctionText.length : 0) +
          reply.text.length +
          serializedSize(visibleToolCalls);
        sessionTokens += estimatedTokens(turnChars);
      }
      log(
        `[AI memory] session=${activeSessionId} turns=${sessionTurns} ` +
        `contextTokens=${sessionTokens}/${contextLimit()} ` +
        `source=${reportedTokens > 0 ? 'provider' : 'estimate'}`,
      );
    } else {
      log(`[AI local] session=${activeSessionId || 'local'} handled without a model request`);
    }

    reportProgress(onProgress, 'done');

    return {
      success: true,
      text: reply.text,
      toolCalls: visibleToolCalls,
      attachments: attached,
      provider: provider ? provider.id : '',
      providerLabel: provider ? provider.label : '',
      model: model ? model.id : '',
      modelLabel: model ? model.label : '',
      memory: completed ? {
        topicId: completed.topicId,
        title: completed.title,
        switched: turn.switched,
        resumed: turn.resumed,
        recovered: usedRecovery,
      } : undefined,
    };
  }

  function conversationKey(value) {
    return typeof value === 'string' ? value.trim().slice(0, 100) : '';
  }

  function attach({ conversationId, files } = {}) {
    const conversation = conversationKey(conversationId);
    if (!conversation) {
      return { success: false, code: 'conversation_missing', error: 'The chat session is missing. Reload the page and try again.' };
    }
    const result = attachmentStore.addMany(conversation, files);
    if (!result.ok) {
      return { success: false, code: result.code, error: result.message };
    }
    return { success: true, attachments: result.attachments };
  }

  function removeAttachment({ conversationId, id } = {}) {
    const conversation = conversationKey(conversationId);
    if (!conversation) {
      return { success: false, code: 'conversation_missing', error: 'The chat session is missing.' };
    }
    const result = attachmentStore.remove(conversation, id);
    if (!result.ok) {
      return { success: false, code: result.code, error: 'That image is no longer attached.' };
    }
    return { success: true };
  }

  function planFor(planId, conversationId) {
    const found = planStore.get(planId);
    if (!found.ok) return found;
    const conversation = conversationKey(conversationId);
    if (found.plan.conversationId && found.plan.conversationId !== conversation) {
      return { ok: false, code: 'plan_not_found', message: 'That change is no longer available. Ask me to prepare it again.' };
    }
    return found;
  }

  async function confirmPlan({ planId, conversationId, authToken, branchId, onProgress } = {}) {
    const found = planFor(planId, conversationId);
    if (!found.ok) {
      return { success: false, code: found.code, error: found.message };
    }
    if (found.plan.status === 'completed') {
      return { success: true, plan: found.plan, already: true };
    }
    const begun = planStore.begin(planId);
    if (!begun.ok) {
      return { success: false, code: begun.code, error: begun.message };
    }
    if (begun.already) {
      return { success: true, plan: begun.plan, already: true };
    }

    const token = typeof authToken === 'string' ? authToken.trim() : '';
    const branch = typeof branchId === 'string' ? branchId.trim() : '';
    if (!token || !branch) {
      planStore.finish(planId, 'pending');
      return { success: false, code: 'auth_required', error: 'Sign in again and choose a branch before confirming.' };
    }

    let api;
    try {
      api = createApiClient({
        baseUrl: resolveApiBaseUrl(),
        token,
        branchId: branch,
        fetchImpl,
      });
    } catch (error) {
      planStore.finish(planId, 'pending');
      return { success: false, code: error.code || 'configuration_error', error: error.message };
    }

    let plan = begun.plan;
    try {
      plan = await executePlan(plan, {
        api,
        attachments: attachmentStore,
        sessionID: conversationKey(conversationId),
        onProgress,
        logger: log,
      });
      planStore.finish(planId, plan.status);
      memory.notePlan(conversationKey(conversationId), plan, plan.status);
      taskKernel.notePlan(conversationKey(conversationId), plan, plan.status);
      /* The plan changed shop rows. A price or stock answer from the previous
         cache would now be wrong. */
      taskKernel.invalidateLive(conversationKey(conversationId));
      return { success: true, plan };
    } catch (error) {
      plan.status = 'failed';
      plan.finishedAt = Date.now();
      planStore.finish(planId, 'failed');
      memory.notePlan(conversationKey(conversationId), plan, 'failed');
      taskKernel.notePlan(conversationKey(conversationId), plan, 'failed');
      taskKernel.invalidateLive(conversationKey(conversationId));
      log(`[AI plan] execution failed: ${error && error.code ? error.code : 'plan_failed'}`);
      return {
        success: false,
        code: (error && error.code) || 'plan_failed',
        error: (error && error.message) || 'The change could not be completed.',
        plan,
      };
    }
  }

  function cancelPlan({ planId, conversationId } = {}) {
    const found = planFor(planId, conversationId);
    if (!found.ok) {
      return { success: false, code: found.code, error: found.message };
    }
    const result = planStore.cancel(planId);
    if (!result.ok) {
      return { success: false, code: result.code, error: result.message };
    }
    memory.notePlan(conversationKey(conversationId), found.plan, 'cancelled');
    taskKernel.notePlan(conversationKey(conversationId), found.plan, 'cancelled');
    return { success: true };
  }

  function updateSettings(next) {
    settings = normaliseSettings(keyStore.setSettings(next));
    return settings;
  }

  function status() {
    return {
      running: !!client,
      provider: settings.provider,
      model: settings.model,
      reasoning: normaliseReasoning(settings.reasoning),
    };
  }

  return {
    activeToken,
    activeTokenIndex,
    attach,
    cancelPlan,
    chat,
    close: stop,
    confirmPlan,
    isRunning: () => !!client,
    removeAttachment,
    resetChat,
    restart,
    retry: restart,
    start,
    status,
    stop,
    updateSettings,
    usePrimaryToken,
    useProviderToken,
  };
}

module.exports = {
  CHAT_TIMEOUT_MS,
  START_TIMEOUT_MS,
  createOpenCodeRuntime,
  messageText,
  messageTools,
};
