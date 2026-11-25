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
  getModel,
  getProvider,
  runtimeConfig,
} = require('./provider-registry');
const { createContextStore } = require('./tools/context');
const { createPosnicToolPlugin } = require('./tools/plugin');
const { createUserProfileStore } = require('./user-profile');
const { attachmentNotice, createAttachmentStore } = require('./attachments');
const { createPlanStore } = require('./actions/plan-store');
const { executePlan } = require('./actions/plan-executor');
const { createApiClient } = require('./tools/api-client');
const { createConversationMemoryStore } = require('./conversation-memory');
const { currencyInstruction, normalizeCurrencyText } = require('./currency');

const START_TIMEOUT_MS = 25000;
const CHAT_TIMEOUT_MS = 120000;
const COMPACT_TIMEOUT_MS = 60000;
/* OpenCode reports the real prompt and completion tokens for every step. Use
   them instead of a character guess so a session can fill the model's actual
   context window before it is compacted. */
const DEFAULT_CONTEXT_LIMIT = 131072;
const COMPACT_AT_CONTEXT_RATIO = 0.8;
const HARD_CONTEXT_RATIO = 0.95;
const CHARS_PER_TOKEN = 4;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
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

function createOpenCodeRuntime({ baseDir, keyStore, logger, fetchImpl, apiBaseUrl, profileStore } = {}) {
  let client = null;
  let starting = null;
  let sessionID = null;
  let sessionTurns = 0;
  let sessionTokens = 0;
  let workspace = '';
  let location = null;
  let envBackup = new Map();
  let settings = keyStore ? keyStore.getSettings() : { provider: 'groq', model: 'openai/gpt-oss-120b' };
  let log = typeof logger === 'function' ? logger : () => {};
  const toolContext = createContextStore();
  const attachmentStore = createAttachmentStore();
  const planStore = createPlanStore();
  const memory = createConversationMemoryStore();

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
    });
    log(`[AI config] provider=${settings.provider} model=${settings.model}`);
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

  function applyEnvironment() {
    for (const provider of require('./provider-registry').PROVIDERS) {
      if (!envBackup.has(provider.env)) {
        envBackup.set(provider.env, {
          had: Object.prototype.hasOwnProperty.call(process.env, provider.env),
          value: process.env[provider.env],
        });
      }
      const loaded = keyStore.read(`provider:${provider.id}`);
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
      const loaded = keyStore.read(`provider:${provider.id}`);
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
    if (keyStore) settings = keyStore.getSettings();
    await stop({ preserveConversation: true });
    return start();
  }

  async function resetChat({ conversationId } = {}) {
    await removeCurrentSession();
    if (conversationId) {
      attachmentStore.clear(conversationId);
      planStore.clearConversation(conversationId);
      memory.clear(conversationId);
    } else {
      attachmentStore.clearAll();
      planStore.clearAll();
      memory.clearAll();
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
      model: { providerID: provider.id, id: model.id },
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
    return String((error && error.message) || error || 'The model provider returned an error.').slice(0, 300);
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
      error: failed ? String(
        failed.error.message || failed.error.code || 'The model provider returned an error.',
      ).slice(0, 300) : '',
    };
  }

  async function requestReply(id, promptText) {
    const startedAt = Date.now();
    let prompt;
    try {
      prompt = await client.session.prompt({ sessionID: id, text: promptText });
    } catch (error) {
      return {
        ok: false,
        code: 'provider_error',
        message: providerErrorMessage(error),
        retryable: true,
      };
    }

    const promptDoneAt = Date.now();
    try {
      await withTimeout(
        client.session.wait({ sessionID: id }),
        CHAT_TIMEOUT_MS,
        'chat_timeout',
        'The assistant took too long to reply.',
      );
    } catch (error) {
      try { await client.session.interrupt({ sessionID: id }); } catch (interruptError) { /* already stopped */ }
      if (error && error.code === 'chat_timeout') {
        return {
          ok: false,
          code: 'chat_timeout',
          message: 'The assistant took too long to reply.',
          retryable: false,
        };
      }
      return {
        ok: false,
        code: 'provider_error',
        message: providerErrorMessage(error),
        retryable: true,
      };
    }

    const waitDoneAt = Date.now();
    const cutoff = (prompt && prompt.time && prompt.time.created) || 0;
    let collected;
    try {
      collected = await collectReply(id, cutoff);
    } catch (error) {
      log(`[AI timing] session=${id} prompt=${promptDoneAt - startedAt}ms wait=${waitDoneAt - promptDoneAt}ms collect=failed promptChars=${promptText.length}`);
      return {
        ok: false,
        code: 'provider_error',
        message: providerErrorMessage(error),
        retryable: true,
      };
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
      return {
        ok: false,
        code: 'provider_error',
        message: collected.error,
        retryable: true,
      };
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

  function buildPrompt(conversation, message, attached, { full = false, currencySign = '' } = {}) {
    /* A continuing OpenCode session already holds the conversation. Only a
       fresh session (new topic, compaction, recovery) needs the memory block;
       repeating it every turn duplicates context and makes the model work
       against two copies of the same conversation. */
    const block = full ? memory.contextFor(conversation, { full, message }) : '';
    const notice = attachmentNotice(attached);
    return [
      block,
      currencyInstruction(currencySign),
      `${String(message || '').trim()}${notice}`,
    ].filter(Boolean).join('\n\n');
  }

  function correctionPrompt(correction, currencySign = '') {
    return [currencyInstruction(currencySign), correction].filter(Boolean).join('\n\n');
  }

  const READ_TOOL_RE = /^(posnic_search_products|posnic_list_products|posnic_list_categories|posnic_recall|posnic_help)$/;

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
    return [
      '[Correction from Posnic]',
      'The user just answered your pending question. Continue that unfinished request; do not search, list products or change topic.',
      pending.text ? `Original request: ${pending.text}` : '',
      pending.note ? `Recorded draft: ${pending.note}` : '',
      pending.question ? `You asked: ${pending.question}` : '',
      pending.missing && pending.missing.length ? `Still missing: ${pending.missing.join(', ')}` : '',
      `The user answered: ${String(message || '').trim()}`,
      'If every required value is known, call posnic_propose_plan now. If a required value is still missing, call posnic_ask_user once for all missing values. Never use 0 for a price or cost the user did not give.',
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
    return [
      '[Correction from Posnic]',
      'The user asked you to add or change a shop record. Do not stop at search results, do not ask the user to repeat the request, and do not change topic. Continue that request now.',
      pending.text ? `Request: ${pending.text}` : '',
      `The user just wrote: ${String(message || '').trim()}`,
      'Use the search results you already have. Do not search again.',
      'If the user already named a category, use the closest active category; never create a near-duplicate and never ask which category to use.',
      'If every required value is known, call posnic_propose_plan now. If a required value is missing, call posnic_ask_user once for all missing values. Never use 0 for a price or cost the user did not give.',
    ].filter(Boolean).join('\n');
  }

  function contextLimit() {
    const model = selectedModel();
    const limit = model && model.limit && Number(model.limit.context);
    return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_CONTEXT_LIMIT;
  }

  async function workingSession(turn) {
    const limit = contextLimit();
    /* Compact before the window is full, but only from real usage. A fixed
       turn or character limit would throw away most of a 131k-token window. */
    const overBudget = sessionTokens >= limit * HARD_CONTEXT_RATIO;
    let fresh = !sessionID || turn.switched || overBudget;
    if (!fresh && sessionTokens >= limit * COMPACT_AT_CONTEXT_RATIO) {
      const compacted = await compactSession();
      if (!compacted) fresh = true;
    }
    if (fresh) {
      await removeCurrentSession();
      const id = await ensureSession();
      return { id, full: true };
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
  } = {}) {
    if (reset) await resetChat({ conversationId });
    await start();
    const provider = selectedProvider();
    const model = selectedModel();
    const conversation = conversationKey(conversationId) || 'default';

    if (Array.isArray(history) && history.length && !memory.has(conversation)) {
      memory.seed(conversation, history);
    }

    const turn = memory.beginTurn(conversation, message);
    if (!turn) {
      throw runtimeError('conversation_missing', 'The chat session is missing. Reload the page and try again.');
    }

    const attached = attachmentStore.list(conversation);
    const session = await workingSession(turn);
    let activeSessionId = session.id;

    /* The renderer owns the user's JWT, active branch and account name. Keep
       them for this session only; the tools read them on demand. */
    toolContext.set(session.id, {
      apiBaseUrl: resolveApiBaseUrl(),
      token: typeof authToken === 'string' ? authToken : '',
      branchId: typeof branchId === 'string' ? branchId : '',
      username: typeof username === 'string' ? username : '',
      conversationId: conversation,
    });

    let promptText = buildPrompt(conversation, message, attached, {
      full: session.full,
      currencySign,
    });
    let reply = await requestReply(session.id, promptText);
    let usedRecovery = false;

    if (!reply.ok && reply.retryable && sessionTurns > 0) {
      usedRecovery = true;
      log(`[AI memory] retrying in a fresh session after ${reply.code}`);
      await removeCurrentSession();
      const freshId = await ensureSession();
      activeSessionId = freshId;
      toolContext.set(freshId, {
        apiBaseUrl: resolveApiBaseUrl(),
        token: typeof authToken === 'string' ? authToken : '',
        branchId: typeof branchId === 'string' ? branchId : '',
        username: typeof username === 'string' ? username : '',
        conversationId: conversation,
      });
      promptText = buildPrompt(conversation, message, attached, {
        full: true,
        currencySign,
      });
      reply = await requestReply(freshId, promptText);
    }

    if (!reply.ok) {
      throw runtimeError(reply.code, reply.message);
    }

    /* If an explicit add/create request, or an answer to a pending question,
       made the model wander into a read or stop without a plan, give it one
       corrective turn inside the same session. The failed read is discarded
       from memory; only this final answer is recorded. */
    const pending = memory.pendingRequest(conversation);
    const needsPending = turn.pendingAnswer && shouldContinuePending(reply);
    const needsWrite = turn.writeRequest && shouldContinueWrite(reply);
    let correctionText = '';
    if (pending && (needsPending || needsWrite)) {
      const correction = needsPending
        ? pendingCorrection(pending, message)
        : writeCorrection(pending, message);
      correctionText = correctionPrompt(correction, currencySign);
      log(`[AI memory] continuing ${needsPending ? 'an answered request' : 'a write request'} after an incomplete reply`);
      const corrected = await requestReply(activeSessionId, correctionText);
      if (corrected.ok) {
        reply = corrected;
      } else {
        /* Showing the discarded search result would look like a completed
           read and hide the unfinished write. Fail so the page offers Retry. */
        log(`[AI memory] continuation failed: ${corrected.code}`);
        throw runtimeError(
          corrected.code || 'provider_error',
          corrected.message || 'The assistant could not finish the request. Try again.',
        );
      }
    }

    reply.text = normalizeCurrencyText(reply.text);
    /* A self-correction returned by a tool is for the model. It must not
       appear as a failed shop action in the chat while the model retries. */
    const visibleToolCalls = (Array.isArray(reply.toolCalls) ? reply.toolCalls : [])
      .filter((call) => {
        const posnic = call && call.metadata && call.metadata.posnic;
        return !(posnic && posnic.internal === true);
      });
    const completed = memory.completeTurn(conversation, reply.text, visibleToolCalls);
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

    return {
      success: true,
      text: reply.text,
      toolCalls: visibleToolCalls,
      attachments: attached,
      provider: provider.id,
      providerLabel: provider.label,
      model: model.id,
      modelLabel: model.label,
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
      return { success: true, plan };
    } catch (error) {
      plan.status = 'failed';
      plan.finishedAt = Date.now();
      planStore.finish(planId, 'failed');
      memory.notePlan(conversationKey(conversationId), plan, 'failed');
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
    return { success: true };
  }

  function updateSettings(next) {
    settings = keyStore.setSettings(next);
    return settings;
  }

  function status() {
    return {
      running: !!client,
      provider: settings.provider,
      model: settings.model,
    };
  }

  return {
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
  };
}

module.exports = {
  CHAT_TIMEOUT_MS,
  START_TIMEOUT_MS,
  createOpenCodeRuntime,
  messageText,
  messageTools,
};
