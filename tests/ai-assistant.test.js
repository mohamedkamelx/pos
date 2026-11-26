'use strict';

/*
 * THE AI ASSISTANT'S THREE BOUNDARIES.
 *
 * The assistant is the first optional feature that sends a recording and a
 * typed message off the till. Its edges are worth pinning:
 *
 *   - the Groq Whisper key and the model-provider token are checked, kept by
 *     the main process and never returned to a page;
 *   - the microphone and chat stay off until the shop opts in and both
 *     credentials exist;
 *   - speech goes to Groq, replies go through the embedded OpenCode agent,
 *     and the agent has read-only shop tools plus two local-note tools; shop
 *     writes stay in the main process and are not exposed to the model.
 *
 * The tests use a fake safeStorage, a fake fetch and a fake runtime. No real
 * key, provider, network request or microphone is involved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const KEY = 'gsk_test_1234567890abcdef';
const PROVIDER_KEY = 'gsk_provider_test_1234567890';

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      assert.ok(!handlers.has(channel), `${channel} was registered twice`);
      handlers.set(channel, handler);
    },
  };
}

function secureStorage(overrides = {}) {
  return Object.assign({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (value) => {
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('wrong key');
      return text.slice('sealed:'.length);
    },
  }, overrides);
}

function insecureStorage() {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('not available'); },
    decryptString: () => { throw new Error('not available'); },
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function freshAiIpc() {
  const file = require.resolve(path.join(ROOT, 'src/ai-ipc.js'));
  delete require.cache[file];
  return require(file);
}

function fakeRuntime() {
  const calls = [];
  let running = false;
  return {
    calls,
    async start() { running = true; calls.push({ type: 'start' }); return this; },
    async stop() { running = false; calls.push({ type: 'stop' }); },
    async restart() { running = true; calls.push({ type: 'restart' }); return this; },
    updateSettings(next) { calls.push({ type: 'updateSettings', next }); return next; },
    isRunning: () => running,
    async chat(payload) {
      calls.push({ type: 'chat', payload });
      return {
        success: true,
        text: 'Embedded agent reply.',
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
      };
    },
    async resetChat() { calls.push({ type: 'reset' }); return { success: true }; },
  };
}

function fakeOpenCodeSdk({ promptHook, tokenHook, waitHook } = {}) {
  const state = {
    sessions: new Map(),
    sessionCount: 0,
    prompts: [],
    compactCalls: 0,
    removeCalls: 0,
    clock: 1000,
  };
  const client = {
    provider: { list: async () => ({ data: [{ id: 'groq' }] }) },
    model: {
      list: async () => ({
        data: [
          { providerID: 'groq', id: 'openai/gpt-oss-120b', modelID: 'openai/gpt-oss-120b' },
          { providerID: 'groq', id: 'openai/gpt-oss-20b', modelID: 'openai/gpt-oss-20b' },
        ],
      }),
    },
    agent: { list: async () => ({ data: [{ id: 'posnic-assistant' }] }) },
    session: {
      create: async () => {
        const id = `ses_${++state.sessionCount}`;
        state.sessions.set(id, []);
        return { id };
      },
      prompt: async ({ sessionID, text }) => {
        const index = state.prompts.length;
        state.prompts.push({ sessionID, text });
        const hook = promptHook && promptHook({ sessionID, text, index });
        if (hook && hook.throw) throw new Error(hook.throw);
        if (hook && hook.error) {
          state.clock += 10;
          const created = state.clock;
          state.sessions.get(sessionID).push({
            type: 'assistant',
            time: { created: created + 1 },
            content: [],
            error: hook.error,
          });
          return { time: { created } };
        }
        const reply = (hook && hook.reply) || `Reply ${index + 1}`;
        const parts = [{ type: 'text', text: reply }];
        if (hook && Array.isArray(hook.tools)) {
          hook.tools.forEach((tool, toolIndex) => {
            parts.push({
              id: tool.id || `tool_${index}_${toolIndex}`,
              type: 'tool',
              name: tool.name,
              state: {
                status: tool.status || 'completed',
                input: tool.input || {},
                metadata: tool.metadata || {},
              },
            });
          });
        }
        state.clock += 10;
        const created = state.clock;
        const usage = (hook && hook.tokens) || (tokenHook
          ? tokenHook({ sessionID, text, index, reply, state })
          : null);
        const message = {
          type: 'assistant',
          time: { created: created + 1 },
          content: parts,
        };
        if (usage) message.tokens = usage;
        state.sessions.get(sessionID).push(message);
        return { time: { created } };
      },
      wait: async (args) => {
        if (waitHook) await waitHook(args);
      },
      compact: async () => {
        state.compactCalls += 1;
        return {};
      },
      remove: async ({ sessionID }) => {
        state.removeCalls += 1;
        state.sessions.delete(sessionID);
      },
      interrupt: async () => {},
    },
    message: {
      list: async ({ sessionID }) => ({ data: state.sessions.get(sessionID) || [] }),
    },
    close: async () => {},
  };
  return { client, state };
}

async function createRuntimeHarness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-runtime-'));
  const logs = [];
  let settings = { provider: 'groq', model: 'openai/gpt-oss-120b' };
  const { client, state } = fakeOpenCodeSdk(options);
  const sdkLoaderPath = require.resolve(path.join(ROOT, 'src/ai/sdk-loader'));
  const runtimePath = require.resolve(path.join(ROOT, 'src/ai/opencode-runtime'));
  const previousLoader = require.cache[sdkLoaderPath];
  const previousRuntime = require.cache[runtimePath];
  require.cache[sdkLoaderPath] = {
    id: sdkLoaderPath,
    filename: sdkLoaderPath,
    loaded: true,
    exports: async () => ({ OpenCode: { create: async () => client } }),
  };
  delete require.cache[runtimePath];
  const { createOpenCodeRuntime } = require(runtimePath);
  const providerKeys = options.providerKeys || { 'provider:groq': 'test-provider-key' };
  const runtime = createOpenCodeRuntime({
    baseDir: dir,
    keyStore: {
      getSettings: () => settings,
      read: (slot) => ({ key: providerKeys[slot] || '' }),
      setSettings: (next) => { settings = next; return settings; },
    },
    logger: (line) => logs.push(line),
    fetchImpl: async () => response(200, { data: [] }),
    apiBaseUrl: 'http://127.0.0.1:5555',
    chatTimeoutMs: options.chatTimeoutMs,
  });
  t.after(async () => {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (previousLoader) require.cache[sdkLoaderPath] = previousLoader;
    else delete require.cache[sdkLoaderPath];
    if (previousRuntime) require.cache[runtimePath] = previousRuntime;
    else delete require.cache[runtimePath];
  });
  return { runtime, state, dir, logs };
}

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-ai-'));
  const ipc = fakeIpc();
  const calls = [];
  const aiIpc = freshAiIpc();
  const runtime = options.runtime || fakeRuntime();
  const fetchImpl = options.fetchImpl || (async () => response(200, { data: [] }));
  aiIpc.setupAiIPC({
    ipcMain: ipc,
    app: { getPath: () => dir, once: () => {} },
    safeStorage: options.safeStorage || secureStorage(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    },
    fallbackFetchImpl: options.fallbackFetchImpl,
    runtimeFactory: () => runtime,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    keyPath: path.join(dir, 'ai-groq-key.json'),
    providerKeyPath: path.join(dir, 'ai-provider-groq.json'),
    handlers: ipc.handlers,
    calls,
    runtime,
    state: aiIpc.aiInputState,
  };
}

test('a category question offers create or leave uncategorized', () => {
  const { askUser } = require(path.join(ROOT, 'src/ai/tools/ask-user'));
  const arabic = askUser({
    question: 'ما هو سعر البيع، سعر التكلفة، الكمية المبدئية، وهل تريد إضافة صورة أو فئة؟',
    pending: 'Add product "تلاجة بنسونيك 16 قدم" - missing selling price, cost price, opening stock, optional image, optional category',
    missing: ['selling price', 'cost price', 'opening stock'],
  }, { pendingText: 'أريد أن أضيف تلاجة بنسونيك 16 قدم' });
  assert.equal(arabic.kind, 'clarify');
  assert.match(arabic.question, /أنشئ تصنيفًا مناسبًا/);
  assert.match(arabic.question, /بدون تصنيف/);
  assert.match(arabic.pending, /أنشئ تصنيفًا مناسبًا/);
  assert.doesNotMatch(arabic.question, /أرفق صورة/);
  assert.ok(arabic.question.length <= 300);

  const noImage = askUser({
    question: 'ما هو سعر البيع وسعر التكلفة والكمية المتوفرة؟ هل تريد إنشاء فئة «تلاجات» أم تركها غير مصنفة؟',
    pending: 'New product: تلاجة بنسونيك 16 قدم. Missing: selling price, cost price, opening stock.',
    missing: ['selling_price', 'cost_price', 'opening_stock'],
  }, { pendingText: 'أريد أن أضيف تلاجة بنسونيك 16 قدم' });
  assert.equal(noImage.kind, 'clarify');
  assert.match(noImage.question, /أرفق صورة إن وجدت/);
  assert.match(noImage.pending, /صورة اختيارية/);
  assert.equal(noImage.question.match(/أرفق صورة/g).length, 1);

  const firstImageAsk = askUser({
    question: 'ما هو سعر البيع؟',
    missing: ['selling_price', 'opening_stock'],
  }, { pendingText: 'أريد أن أضيف تلاجة بنسونيك 16 قدم' });
  assert.match(firstImageAsk.question, /أرفق صورة إن وجدت/);
  assert.match(firstImageAsk.pending, /صورة اختيارية/);

  const secondImageAsk = askUser({
    question: 'ما هو سعر البيع؟',
    missing: ['selling_price', 'opening_stock'],
  }, {
    pendingText: 'أريد أن أضيف تلاجة بنسونيك 16 قدم',
    pendingNote: firstImageAsk.pending,
  });
  assert.doesNotMatch(secondImageAsk.question, /أرفق صورة/);

  const named = askUser({
    question: 'أي فئة تريد للمنتج؟',
    options: [{ label: 'إنشاء فئة جديدة', value: 'new' }],
    missing: ['category'],
  }, { pendingText: 'ضيف برودكت جزمة' });
  assert.equal(named.kind, 'clarify');
  assert.match(named.question, /^أي فئة تريد للمنتج؟/);
  assert.doesNotMatch(named.question, /وبالنسبة للفئة/);
  assert.match(named.question, /أرفق صورة إن وجدت/);

  const english = askUser({
    question: 'What are the price, cost and stock, and do you want an image or category?',
    missing: ['selling price', 'cost price', 'opening stock'],
  }, { pendingText: 'Add product fridge' });
  assert.match(english.question, /create a suitable category/);
  assert.match(english.question, /uncategorized/);

  const localized = askUser({
    question: 'ما هو سعر البيع؟ وهل تريد إنشاء فئة "تلاجات" أم تركها غير مصنفة؟',
    options: [
      { label: 'Create category "تلاجات"', value: 'create_category' },
      { label: 'Leave uncategorized', value: 'no_category' },
    ],
    missing: ['selling_price'],
  }, { pendingText: 'أضف منتج تلاجة' });
  assert.equal(localized.options[0].label, 'إنشاء فئة "تلاجات"');
  assert.equal(localized.options[0].value, 'إنشاء فئة "تلاجات"');
  assert.equal(localized.options[1].label, 'ترك غير مصنفة');
  assert.equal(localized.options[1].value, 'ترك غير مصنفة');
});

test('both credentials are validated, encrypted and kept out of the page', async (t) => {
  const h = setup(t, {
    fetchImpl: async (url, init) => {
      assert.match(url, /\/models$/);
      assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
      return response(200, { data: [] });
    },
  });

  assert.deepEqual(
    [...h.handlers.keys()].sort(),
    [
      'ai:attach',
      'ai:cancel-plan',
      'ai:chat',
      'ai:clear-key',
      'ai:clear-provider-key',
      'ai:confirm-plan',
      'ai:key-status',
      'ai:remove-attachment',
      'ai:reset-chat',
      'ai:save-key',
      'ai:save-provider-key',
      'ai:set-enabled',
      'ai:set-provider-model',
      'ai:transcribe',
      'ai:validate-key',
      'ai:validate-provider-key',
    ],
  );

  const saved = await h.handlers.get('ai:save-key')({}, KEY);
  assert.deepEqual(saved, { success: true, configured: true, secure: true, session: false });
  assert.equal(fs.existsSync(h.keyPath), true);

  const raw = fs.readFileSync(h.keyPath, 'utf8');
  assert.ok(!raw.includes(KEY), 'the key was written in clear text');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(h.keyPath).mode & 0o777, 0o600);
    fs.chmodSync(h.keyPath, 0o644);
    assert.equal((await h.handlers.get('ai:save-key')({}, KEY)).success, true);
    assert.equal(fs.statSync(h.keyPath).mode & 0o777, 0o600);
  }

  const status = await h.handlers.get('ai:key-status')({});
  assert.equal(status.success, true);
  assert.equal(status.transcription.configured, true);
  assert.equal(status.transcription.secure, true);
  assert.equal(status.transcription.session, false);
  assert.equal(status.chat.configured, false);
  assert.equal(status.chat.provider, 'groq');
  assert.deepEqual(
    status.providers.map((provider) => provider.id),
    ['groq', 'nvidia'],
  );
  assert.ok(status.providers[0].models.some((model) => model.id === 'openai/gpt-oss-120b'));
  assert.ok(status.providers[0].models.some((model) => model.id === 'openai/gpt-oss-20b'));
  assert.ok(status.providers[0].models.some((model) => model.id === 'qwen/qwen3.8-27b'));

  /* An empty field means check the saved key; it must use the stored copy. */
  assert.equal((await h.handlers.get('ai:validate-key')({}, '')).success, true);

  const cleared = await h.handlers.get('ai:clear-key')({});
  assert.deepEqual(cleared, { success: true, configured: false });
  assert.equal(fs.existsSync(h.keyPath), false);
  assert.equal((await h.handlers.get('ai:key-status')({})).transcription.configured, false);
});

test('the provider token and model selection are separate from transcription', async (t) => {
  const h = setup(t, {
    fetchImpl: async (url, init) => {
      assert.match(url, /\/models$/);
      assert.equal(init.headers.Authorization, `Bearer ${PROVIDER_KEY}`);
      return response(200, { data: [] });
    },
  });

  assert.equal((await h.handlers.get('ai:validate-provider-key')({}, {
    provider: 'nvidia', key: PROVIDER_KEY,
  })).success, true);
  assert.equal((await h.handlers.get('ai:set-provider-model')({}, {
    provider: 'nvidia', model: 'moonshotai/kimi-k3.1-pro',
  })).success, true);
  assert.ok(h.runtime.calls.some((call) =>
    call.type === 'updateSettings' &&
    call.next.provider === 'nvidia' &&
    call.next.model === 'moonshotai/kimi-k3.1-pro'));
  assert.equal((await h.handlers.get('ai:save-provider-key')({}, {
    provider: 'nvidia', key: PROVIDER_KEY,
  })).success, true);

  const nvidiaPath = path.join(h.dir, 'ai-provider-nvidia.json');
  assert.equal(fs.existsSync(nvidiaPath), true);
  assert.ok(!fs.readFileSync(nvidiaPath, 'utf8').includes(PROVIDER_KEY));
  assert.equal(fs.existsSync(h.providerKeyPath), false, 'the Groq token was written instead');

  const status = await h.handlers.get('ai:key-status')({});
  assert.equal(status.chat.configured, true);
  assert.equal(status.chat.provider, 'nvidia');
  assert.equal(status.chat.model, 'moonshotai/kimi-k3.1-pro');

  assert.equal((await h.handlers.get('ai:set-provider-model')({}, {
    provider: 'nvidia', model: 'not-a-real-model',
  })).code, 'model_unavailable');

  assert.equal((await h.handlers.get('ai:clear-provider-key')({}, {
    provider: 'nvidia',
  })).success, true);
  assert.equal(fs.existsSync(nvidiaPath), false);
  assert.equal((await h.handlers.get('ai:key-status')({})).chat.configured, false);
});

test('a backup provider token is stored separately from the primary token', async (t) => {
  const h = setup(t, {
    fetchImpl: async () => response(200, { data: [] }),
  });

  assert.equal((await h.handlers.get('ai:save-provider-key')({}, {
    provider: 'groq', key: PROVIDER_KEY,
  })).success, true);
  const backupKey = 'gsk_backup_test_0987654321';
  const backup = await h.handlers.get('ai:save-provider-key')({}, {
    provider: 'groq', key: backupKey, backup: true,
  });
  assert.equal(backup.success, true);
  assert.equal(backup.backup, true);
  assert.equal(backup.backupConfigured, true);

  const backupPath = path.join(h.dir, 'ai-provider-groq2.json');
  assert.equal(fs.existsSync(h.providerKeyPath), true);
  assert.equal(fs.existsSync(backupPath), true);
  assert.ok(!fs.readFileSync(backupPath, 'utf8').includes(backupKey));

  const status = await h.handlers.get('ai:key-status')({});
  assert.equal(status.chat.configured, true);
  assert.equal(status.chat.backupConfigured, true);
  assert.equal(status.chat.activeToken, 'primary');

  const removed = await h.handlers.get('ai:clear-provider-key')({}, {
    provider: 'groq', backup: true,
  });
  assert.equal(removed.success, true);
  assert.equal(removed.backupConfigured, false);
  assert.equal(fs.existsSync(backupPath), false);
  assert.equal(fs.existsSync(h.providerKeyPath), true);
});

test('the assistant needs both credentials, then transcribes and chats', async (t) => {
  let posts = 0;
  const h = setup(t, {
    fetchImpl: async (url, init) => {
      if (url.endsWith('/models')) return response(200, { data: [] });
      if (url.endsWith('/audio/transcriptions')) {
        posts += 1;
        assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
        const file = init.body.get('file');
        assert.equal(file.name, 'recording.webm');
        assert.equal(init.body.get('model'), 'whisper-large-v3');
        assert.equal(init.body.get('language'), 'ar');
        assert.equal(init.body.get('temperature'), '0');
        const prompt = String(init.body.get('prompt') || '');
        assert.match(prompt, /شرب/);
        assert.match(prompt, /اتنين 2/);
        assert.ok(prompt.split(/\s+/).length < 224, 'Whisper prompt stays inside its token budget');
        assert.ok(prompt.length < 900, 'Whisper prompt stays short');
        return response(200, { text: 'مرحبا بكم' });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  let enabled = await h.handlers.get('ai:set-enabled')({}, true);
  assert.equal(enabled.code, 'key_missing');
  assert.equal(h.state.enabled, false);

  await h.handlers.get('ai:save-key')({}, KEY);
  enabled = await h.handlers.get('ai:set-enabled')({}, true);
  assert.equal(enabled.code, 'provider_key_missing');
  assert.equal(h.state.enabled, false);

  await h.handlers.get('ai:save-provider-key')({}, { provider: 'groq', key: PROVIDER_KEY });
  enabled = await h.handlers.get('ai:set-enabled')({}, true);
  assert.deepEqual(enabled, { success: true, enabled: true });
  assert.equal(h.state.enabled, true);
  assert.ok(h.runtime.calls.some((call) => call.type === 'start'));

  let result = await h.handlers.get('ai:transcribe')({}, {
    audio: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/webm;codecs=opus',
  });
  assert.equal(result.success, true);
  assert.equal(result.text, 'مرحبا بكم');
  assert.equal(result.model, 'whisper-large-v3');
  assert.equal(posts, 1);

  result = await h.handlers.get('ai:transcribe')({}, {
    audio: new Uint8Array([1, 2, 3]),
    mimeType: 'text/plain',
  });
  assert.equal(result.code, 'audio_unsupported');
  assert.equal(posts, 1);

  result = await h.handlers.get('ai:chat')({}, {
    message: 'How do I add a customer?',
    history: [{ role: 'user', content: 'earlier' }],
  });
  assert.equal(result.success, true);
  assert.equal(result.text, 'Embedded agent reply.');
  const chatCall = h.runtime.calls.find((call) => call.type === 'chat');
  assert.equal(chatCall.payload.message, 'How do I add a customer?');

  assert.equal((await h.handlers.get('ai:reset-chat')({})).success, true);
  assert.ok(h.runtime.calls.some((call) => call.type === 'reset'));

  const off = await h.handlers.get('ai:set-enabled')({}, false);
  assert.deepEqual(off, { success: true, enabled: false });
  assert.equal(h.state.enabled, false);
  assert.ok(h.runtime.calls.some((call) => call.type === 'stop'));
  assert.equal((await h.handlers.get('ai:transcribe')({}, {
    audio: new Uint8Array([1]), mimeType: 'audio/webm',
  })).code, 'disabled');
});

test('provider and transcription failures keep their meaning', async (t) => {
  const h = setup(t, {
    fetchImpl: async (url) => {
      if (url.endsWith('/models')) return response(200, { data: [] });
      return response(429, { error: { message: 'slow down' } });
    },
  });
  await h.handlers.get('ai:save-key')({}, KEY);
  await h.handlers.get('ai:save-provider-key')({}, { provider: 'groq', key: PROVIDER_KEY });
  await h.handlers.get('ai:set-enabled')({}, true);
  const result = await h.handlers.get('ai:transcribe')({}, {
    audio: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/webm',
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'rate_limited');
  assert.equal(result.status, 429);
});

test('a transient transcription reset is retried on the fallback transport', async (t) => {
  let primaryAttempts = 0;
  let fallbackAttempts = 0;
  const h = setup(t, {
    fetchImpl: async (url) => {
      if (url.endsWith('/models')) return response(200, { data: [] });
      primaryAttempts += 1;
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNRESET', message: 'read ECONNRESET' };
      throw error;
    },
    fallbackFetchImpl: async (url) => {
      if (!url.endsWith('/audio/transcriptions')) throw new Error('unexpected fallback URL ' + url);
      fallbackAttempts += 1;
      return response(200, { text: 'مرحبا' });
    },
  });
  await h.handlers.get('ai:save-key')({}, KEY);
  await h.handlers.get('ai:save-provider-key')({}, { provider: 'groq', key: PROVIDER_KEY });
  await h.handlers.get('ai:set-enabled')({}, true);
  const result = await h.handlers.get('ai:transcribe')({}, {
    audio: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/webm',
  });
  assert.equal(result.success, true);
  assert.equal(result.text, 'مرحبا');
  assert.equal(result.usedFallback, true);
  assert.equal(primaryAttempts, 1);
  assert.equal(fallbackAttempts, 1);
});

test('a transcription timeout is reported, not retried on the fallback', async (t) => {
  let fallbackAttempts = 0;
  const h = setup(t, {
    fetchImpl: async (url) => {
      if (url.endsWith('/models')) return response(200, { data: [] });
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    },
    fallbackFetchImpl: async () => {
      fallbackAttempts += 1;
      return response(200, { text: 'unexpected' });
    },
  });
  await h.handlers.get('ai:save-key')({}, KEY);
  await h.handlers.get('ai:save-provider-key')({}, { provider: 'groq', key: PROVIDER_KEY });
  await h.handlers.get('ai:set-enabled')({}, true);
  const result = await h.handlers.get('ai:transcribe')({}, {
    audio: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/webm',
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'network_error');
  assert.equal(result.retryable, false);
  assert.equal(result.error, 'Groq took too long to answer.');
  assert.equal(fallbackAttempts, 0);
});

test('a chat rate limit keeps its retry time for the page', () => {
  const { runtimeFailure } = freshAiIpc();
  const error = new Error('Rate limit reached. Please try again in 11m53s.');
  error.code = 'rate_limited';
  error.retryAfterMs = 713000;
  const result = runtimeFailure(error);
  assert.equal(result.success, false);
  assert.equal(result.code, 'rate_limited');
  assert.equal(result.retryAfterMs, 713000);
  assert.match(result.error, /Rate limit reached/);
});

test('an offline check stores nothing', async (t) => {
  const h = setup(t, {
    fetchImpl: async () => { throw new Error('offline'); },
  });
  let result = await h.handlers.get('ai:save-key')({}, KEY);
  assert.equal(result.success, false);
  assert.equal(result.code, 'network_error');
  assert.equal(fs.existsSync(h.keyPath), false);

  result = await h.handlers.get('ai:save-provider-key')({}, {
    provider: 'groq', key: PROVIDER_KEY,
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'network_error');
  assert.equal(fs.existsSync(h.providerKeyPath), false);
  assert.equal((await h.handlers.get('ai:key-status')({})).chat.configured, false);
});

test('a keystore write failure is reported as a save failure', async (t) => {
  const h = setup(t, {
    safeStorage: secureStorage({ encryptString: () => { throw new Error('read-only keyring'); } }),
    fetchImpl: async () => response(200, { data: [] }),
  });
  const result = await h.handlers.get('ai:save-key')({}, KEY);
  assert.equal(result.success, false);
  assert.equal(result.code, 'key_save_failed');
  assert.equal(fs.existsSync(h.keyPath), false);
});

test('a system without a secure keystore keeps credentials only in main memory', async (t) => {
  const h = setup(t, {
    safeStorage: insecureStorage(),
    fetchImpl: async () => response(200, { data: [] }),
  });
  const saved = await h.handlers.get('ai:save-key')({}, KEY);
  assert.deepEqual(saved, { success: true, configured: true, secure: false, session: true });
  assert.equal(fs.existsSync(h.keyPath), false, 'the key was written without a keystore');

  const provider = await h.handlers.get('ai:save-provider-key')({}, {
    provider: 'groq', key: PROVIDER_KEY,
  });
  assert.equal(provider.success, true);
  assert.equal(provider.secure, false);
  assert.equal(provider.session, true);
  assert.equal(fs.existsSync(h.providerKeyPath), false);

  const status = await h.handlers.get('ai:key-status')({});
  assert.equal(status.transcription.configured, true);
  assert.equal(status.transcription.secure, false);
  assert.equal(status.transcription.session, true);
  assert.equal(status.chat.configured, true);
  assert.equal(status.chat.session, true);

  await h.handlers.get('ai:clear-key')({});
  await h.handlers.get('ai:clear-provider-key')({}, { provider: 'groq' });
  const after = await h.handlers.get('ai:key-status')({});
  assert.equal(after.transcription.configured, false);
  assert.equal(after.chat.configured, false);
});

test('the microphone, bridge, page, search and package are wired to AI, not Voice', () => {
  const main = read('src', 'main.js');
  assert.match(main, /setupAiIPC\(\{[\s\S]*?apiBaseUrl:\s*\(\)\s*=>\s*`http:\/\/127\.0\.0\.1:\$\{apiPort\(\)\}`/);
  assert.match(main, /permission === 'media'\s*&&\s*aiInputState\.enabled\s*&&\s*audioOnly/);
  assert.match(main, /permission !== 'media'\s*\|\|\s*!aiInputState\.enabled/);

  const aiIpc = read('src', 'ai-ipc.js');
  assert.match(aiIpc, /require\('\.\/ipc-guard'\)\.guard/);

  const keyStore = read('src', 'ai', 'key-store.js');
  assert.match(keyStore, /safeStorage\.encryptString/);
  assert.match(keyStore, /mode: 0o600/);

  const transcriber = read('src', 'ai', 'transcriber.js');
  assert.match(transcriber, /const TRANSCRIBE_MODEL = 'whisper-large-v3';/);
  assert.match(transcriber, /language.*ar/);

  const registry = read('src', 'ai', 'provider-registry.js');
  for (const model of [
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
    'moonshotai/kimi-k3.1-pro',
    'mistralai/mistral-large-4-1t-a52b',
  ]) {
    assert.match(registry, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(registry, /action: '\*', resource: '\*', effect: 'deny'/);
  assert.match(registry, /action: 'provider\.use', resource: selected\.id, effect: 'allow'/);
  assert.match(registry, /action: 'posnic_search_products', resource: '\*', effect: 'allow'/);
  assert.match(registry, /action: 'posnic_help', resource: '\*', effect: 'allow'/);
  assert.match(registry, /capabilities: \{ tools: true,/);

  const preload = read('src', 'preload.js');
  for (const method of [
    'setEnabled', 'keyStatus', 'validateKey', 'saveKey', 'clearKey',
    'validateProviderKey', 'saveProviderKey', 'clearProviderKey',
    'setProviderModel', 'transcribe', 'chat', 'resetChat',
    'attach', 'removeAttachment', 'confirmPlan', 'cancelPlan',
    'onPlanProgress',
  ]) {
    assert.match(preload, new RegExp(`${method}: \\(`), `preload.ai.${method} is missing`);
  }

  const sidebar = read('frontend', 'layouts', 'sidebar.html');
  assert.match(sidebar, /href="#\/ai"/);
  assert.match(sidebar, /data-module="branch"\s+data-access="write"\s+href="#\/ai"/);
  assert.match(sidebar, /id="aiModule"/);
  assert.match(sidebar, /id="view_ai_page"/);
  assert.match(sidebar, /lang_ai_title/);

  const map = JSON.parse(read('frontend', 'pages_css_js_map.json'));
  assert.ok(map.dashboard.js.includes('static/script/js/core/ai.js'));
  assert.ok(!map.dashboard.js.some((entry) => /voice/.test(entry)));
  const htmlMap = JSON.parse(read('frontend', 'pages_html_map.json'));
  assert.ok(htmlMap.files.includes('modules/ai.html'));

  const settings = read('frontend', 'modules', 'settings_write.html');
  assert.ok(!/v-pills-voice|voice_enabled|voice-groq-key/.test(settings));

  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.dependencies['@opencode/sdk'], '2.4.1');
  for (const file of [
    'src/ai-ipc.js',
    'src/ai/provider-registry.js',
    'src/ai/key-store.js',
    'src/ai/transcriber.js',
    'src/ai/provider-client.js',
    'src/ai/opencode-runtime.js',
    'src/ai/sdk-loader.js',
    'src/ai/user-profile.js',
    'src/ai/attachments.js',
    'src/ai/conversation-memory.js',
    'src/ai/currency.js',
    'src/ai/text-match.js',
    'src/ai/reference/*.js',
    'src/ai/reference/*.md',
    'src/ai/tools/*.js',
    'src/ai/actions/*.js',
  ]) {
    assert.ok(packageJson.build.files.includes(file), `${file} is not packaged`);
  }
  assert.match(packageJson.build.mac.extendInfo.NSMicrophoneUsageDescription, /microphone/i);
  assert.match(read('builds', 'entitlements.mac.plist'), /com\.apple\.security\.device\.audio-input/);

  for (const stale of [
    'frontend/static/voice-lab.html',
    'frontend/static/voice/voice-engine.js',
    'frontend/static/voice/voice-worker.js',
    'frontend/static/script/js/core/voice-input.js',
    'src/voice-ipc.js',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, stale)), false, `${stale} still exists`);
  }
});

test('the content policy keeps provider calls in the main process', () => {
  const app = read('api', 'app.js');
  const section = (name) => {
    const start = app.indexOf(`'${name}'`);
    assert.ok(start > -1, `${name} is missing`);
    return app.slice(start, app.indexOf('],', start));
  };

  const connect = section('connect-src');
  assert.doesNotMatch(connect, /api\.groq\.com/);
  assert.doesNotMatch(connect, /huggingface/);
  assert.doesNotMatch(section('script-src'), /wasm-unsafe-eval/);
  assert.match(section('media-src'), /'blob:'/);
});

test('AI labels exist in both languages and the old voice keys are gone', () => {
  const english = JSON.parse(read('languages', '_english.json'));
  const arabic = JSON.parse(read('languages', 'ar.json'));
  const englishKeys = Object.keys(english).filter((key) => key.startsWith('lang_ai_')).sort();
  const arabicKeys = Object.keys(arabic).filter((key) => key.startsWith('lang_ai_')).sort();
  assert.ok(englishKeys.length >= 60, `only ${englishKeys.length} AI labels are present`);
  assert.deepEqual(arabicKeys, englishKeys);
  assert.ok(englishKeys.includes('lang_ai_key_remove'));

  assert.deepEqual(
    Object.keys(english).filter((key) => key.startsWith('lang_voice_')),
    [],
    'stale voice labels remain in English',
  );
  assert.deepEqual(
    Object.keys(arabic).filter((key) => key.startsWith('lang_voice_')),
    [],
    'stale voice labels remain in Arabic',
  );

  const tokens = (text) => (String(text).match(/\{[A-Za-z0-9_]+\}/g) || []).sort();
  for (const key of englishKeys) {
    assert.ok(String(english[key] || '').trim(), `${key} has no English text`);
    assert.ok(String(arabic[key] || '').trim(), `${key} has no Arabic text`);
    assert.deepEqual(tokens(arabic[key]), tokens(english[key]), `${key} placeholders changed`);
  }
});

test('universal search finds the assistant for an authorized shop and hides it from a restricted one', async () => {
  const frontend = (...parts) => read('frontend', ...parts);
  const dom = new JSDOM(
    frontend('layouts', 'header.html') +
      frontend('layouts', 'sidebar.html') +
      frontend('modules', 'ai.html'),
    { runScripts: 'outside-only', url: 'http://localhost/dashboard.html' },
  );
  const w = dom.window;
  const d = w.document;
  const routes = [];
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  w.hasher = { setHash: (hash) => routes.push(hash) };
  w.PosnicPro = {
    local: { get: () => null },
    userACL: {
      sales: { write: true },
      customer: { write: true },
      receiving: { write: true },
      branch: { write: true },
      report: { read: true },
    },
    i18n: { t: (_, fallback) => fallback },
    get: (params, done) => {
      if (params.url === 'extensions/v1') done({ extensions: [] });
      else done({ data: { events: [], records: [], generation: 0 } });
    },
    post: () => {},
  };
  w.eval(frontend('static', 'script', 'js', 'core', 'command-palette.js'));

  function matches(query) {
    d.getElementById('posnic-header-search').click();
    const input = d.getElementById('cmdk-input');
    input.value = query;
    input.dispatchEvent(new w.Event('input'));
    return [...d.querySelectorAll('#cmdk-list [role=option]')];
  }

  const assistant = matches('assistant').find((row) => /AI Assistant/.test(row.textContent));
  assert.ok(assistant, 'AI Assistant is absent from universal search');
  assistant.click();
  assert.equal(routes.at(-1), 'ai');

  assert.ok(matches('Groq').length > 0, 'the Groq alias is not searchable');
  assert.ok(matches('provider').length > 0, 'the provider alias is not searchable');
  assert.equal(
    matches('assistant').filter((row) => /Voice input/.test(row.textContent)).length,
    0,
    'the removed Voice page is still searchable',
  );

  d.getElementById('cmdk-close').click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  w.PosnicPro.userACL.branch.write = false;
  assert.equal(
    matches('assistant').filter((row) => /AI Assistant/.test(row.textContent)).length,
    0,
    'a user without branch write can still see the assistant',
  );
});

test('the assistant page renders clickable clarification, product list and plan cards', async () => {
  const frontend = (...parts) => read('frontend', ...parts);
  const dom = new JSDOM(
    '<!doctype html><html><body>' + frontend('modules', 'ai.html') + '</body></html>',
    { runScripts: 'outside-only', url: 'http://localhost/dashboard.html' },
  );
  const w = dom.window;
  const d = w.document;
  const chatCalls = [];
  const confirmCalls = [];
  const progressListeners = [];

  w.PosnicPro = {
    local: {
      get: (key) => {
        if (key === 'ai_assistant_settings') return JSON.stringify({ enabled: true });
        if (key === 'branch_id_set') return 'branch-1';
        if (key === 'username') return 'admin';
        return null;
      },
      set: () => {},
    },
    i18n: { t: (_, fallback) => fallback },
    userACL: { branch: { write: true } },
    HideSideBarModal: () => {},
  };
  w.hasher = { setHash: () => {} };
  w.$ = () => ({
    removeClass() { return this; },
    addClass() { return this; },
    hide() { return this; },
    show() { return this; },
  });
  w.localStorage.setItem('posnic_jwt_token', 'jwt-session');

  const plan = {
    id: 'plan_1',
    title: 'Add Pepsi',
    summary: 'Create Pepsi 1L',
    status: 'pending',
    warnings: ['Creates the product "Pepsi 1L".'],
    steps: [{
      id: 'p1',
      action: 'create_product',
      fields: { name: 'Pepsi 1L', selling_price: 25 },
      images: [],
      status: 'pending',
    }],
  };
  const toolCalls = [
    {
      name: 'posnic_list_products',
      status: 'completed',
      metadata: {
        posnic: {
          kind: 'product_list',
          count: 1,
          total: 1,
          results: [{
            id: 'item-1',
            name: 'Pepsi 1L',
            sellingPrice: 25,
            stock: 12,
            trackInventory: true,
            unit: 'bottle',
            category: 'Drinks',
          }],
        },
      },
    },
    {
      name: 'posnic_ask_user',
      status: 'completed',
      metadata: {
        posnic: {
          kind: 'clarify',
          question: 'Which unit?',
          options: [{ label: 'Piece', value: 'piece' }],
        },
      },
    },
    {
      name: 'posnic_propose_plan',
      status: 'completed',
      metadata: { posnic: { kind: 'write_plan', plan } },
    },
    {
      name: 'posnic_user_profile',
      status: 'completed',
      metadata: {
        posnic: {
          kind: 'user_profile',
          exists: true,
          counts: { preferences: 1, recurring: 0, language: 0 },
          text: 'Prefers short replies',
        },
      },
    },
    {
      name: 'posnic_update_user_profile',
      status: 'completed',
      metadata: {
        posnic: {
          kind: 'profile_saved',
          section: 'preferences',
          note: 'Prefers short replies',
          added: true,
          duplicate: false,
          counts: { preferences: 1, recurring: 0, language: 0 },
        },
      },
    },
  ];

  w.electronAPI = {
    ai: {
      keyStatus: async () => ({
        success: true,
        enabled: true,
        transcription: { configured: true },
        chat: {
          configured: true,
          provider: 'groq',
          model: 'openai/gpt-oss-120b',
        },
        providers: [],
      }),
      setEnabled: async () => ({ success: true, enabled: true }),
      chat: async (payload) => {
        chatCalls.push(payload);
        return chatCalls.length === 1
          ? { success: true, text: 'Here is what I found.', toolCalls }
          : { success: true, text: 'Okay.', toolCalls: [] };
      },
      onPlanProgress: (listener) => {
        progressListeners.push(listener);
        return () => {};
      },
      attach: async () => ({ success: true, attachments: [] }),
      removeAttachment: async () => ({ success: true }),
      resetChat: async () => ({ success: true }),
      transcribe: async () => ({ success: true, text: '' }),
      confirmPlan: async (payload) => {
        confirmCalls.push(payload);
        return {
          success: true,
          plan: {
            ...plan,
            status: 'completed',
            steps: [{ ...plan.steps[0], status: 'success' }],
          },
        };
      },
      cancelPlan: async () => ({ success: true }),
    },
  };

  w.eval(frontend('static', 'script', 'js', 'core', 'ai.js'));
  w.PosnicPro.ai.init();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(d.getElementById('ai_chat_card').hidden, false);

  d.getElementById('ai_prompt').value = 'show me';
  d.getElementById('ai_send').click();
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(progressListeners.length, 1);
  assert.equal(d.querySelectorAll('.posnic-ai-option').length, 1);
  assert.match(d.body.textContent, /Pepsi 1L/);
  assert.match(d.body.textContent, /Add Pepsi/);
  assert.doesNotMatch(d.body.textContent, /Local notes/);
  assert.equal(d.querySelectorAll('.posnic-ai-plan-foot .btn-primary').length, 1);

  d.querySelector('.posnic-ai-option').click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(chatCalls.length, 2);
  assert.equal(chatCalls[1].message, 'piece');

  const confirm = d.querySelector('.posnic-ai-plan-foot .btn-primary');
  assert.ok(confirm, 'the plan confirmation button was not rendered');
  confirm.click();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(confirmCalls.length, 1);
  assert.equal(confirmCalls[0].planId, 'plan_1');
  assert.equal(confirmCalls[0].authToken, 'jwt-session');
  assert.equal(confirmCalls[0].branchId, 'branch-1');
  assert.match(d.body.textContent, /Completed/);
});

test('a rate-limited chat tells the user when to retry', async () => {
  const frontend = (...parts) => read('frontend', ...parts);
  const dom = new JSDOM(
    '<!doctype html><html><body>' + frontend('modules', 'ai.html') + '</body></html>',
    { runScripts: 'outside-only', url: 'http://localhost/dashboard.html' },
  );
  const w = dom.window;
  const d = w.document;

  w.PosnicPro = {
    local: {
      get: (key) => {
        if (key === 'ai_assistant_settings') return JSON.stringify({ enabled: true });
        if (key === 'branch_id_set') return 'branch-1';
        if (key === 'username') return 'admin';
        return null;
      },
      set: () => {},
    },
    i18n: { t: (_, fallback) => fallback },
    userACL: { branch: { write: true } },
    HideSideBarModal: () => {},
  };
  w.hasher = { setHash: () => {} };
  w.$ = () => ({
    removeClass() { return this; },
    addClass() { return this; },
    hide() { return this; },
    show() { return this; },
  });
  w.localStorage.setItem('posnic_jwt_token', 'jwt-session');
  w.electronAPI = {
    ai: {
      keyStatus: async () => ({
        success: true,
        enabled: true,
        transcription: { configured: true },
        chat: { configured: true, provider: 'groq', model: 'openai/gpt-oss-120b' },
        providers: [],
      }),
      setEnabled: async () => ({ success: true, enabled: true }),
      chat: async () => ({
        success: false,
        code: 'rate_limited',
        error: 'Rate limit reached. Please try again in 11m53s.',
        retryAfterMs: 713000,
      }),
      onPlanProgress: () => () => {},
      attach: async () => ({ success: true, attachments: [] }),
      removeAttachment: async () => ({ success: true }),
      resetChat: async () => ({ success: true }),
      transcribe: async () => ({ success: true, text: '' }),
      confirmPlan: async () => ({ success: true }),
      cancelPlan: async () => ({ success: true }),
    },
  };

  w.eval(frontend('static', 'script', 'js', 'core', 'ai.js'));
  w.PosnicPro.ai.init();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(d.getElementById('ai_chat_card').hidden, false);
  assert.deepEqual(
    [...d.querySelectorAll('#ai_model option')].map((option) => option.value),
    ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
  );

  d.getElementById('ai_prompt').value = 'أريد أن أضيف تلاجة';
  d.getElementById('ai_send').click();
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.match(d.getElementById('ai_status').textContent, /12 minutes/);
  assert.equal(d.getElementById('ai_retry').hidden, false);
});

test('a typed confirmation confirms the pending plan without asking the model again', async () => {
  const frontend = (...parts) => read('frontend', ...parts);
  const dom = new JSDOM(
    '<!doctype html><html><body>' + frontend('modules', 'ai.html') + '</body></html>',
    { runScripts: 'outside-only', url: 'http://localhost/dashboard.html' },
  );
  const w = dom.window;
  const d = w.document;
  const chatCalls = [];
  const confirmCalls = [];

  w.PosnicPro = {
    local: {
      get: (key) => {
        if (key === 'ai_assistant_settings') return JSON.stringify({ enabled: true });
        if (key === 'branch_id_set') return 'branch-1';
        if (key === 'username') return 'admin';
        return null;
      },
      set: () => {},
    },
    i18n: { t: (_, fallback) => fallback },
    userACL: { branch: { write: true } },
    HideSideBarModal: () => {},
  };
  w.hasher = { setHash: () => {} };
  w.$ = () => ({
    removeClass() { return this; },
    addClass() { return this; },
    hide() { return this; },
    show() { return this; },
  });
  w.localStorage.setItem('posnic_jwt_token', 'jwt-session');

  const plan = {
    id: 'plan_typed',
    title: 'Add Test',
    summary: 'Create the Test category',
    status: 'pending',
    warnings: [],
    steps: [{
      id: 's1',
      action: 'create_category',
      fields: { name: 'Test' },
      images: [],
      status: 'pending',
    }],
  };
  Object.freeze(plan.steps[0].fields);
  Object.freeze(plan.steps[0]);
  Object.freeze(plan.steps);
  Object.freeze(plan.warnings);
  Object.freeze(plan);
  /* contextBridge freezes objects crossing into the page. The page must copy
     the tool payload before it can run or update a plan. */
  const toolCalls = Object.freeze([Object.freeze({
    name: 'posnic_propose_plan',
    status: 'completed',
    metadata: Object.freeze({ posnic: Object.freeze({ kind: 'write_plan', plan }) }),
  })]);

  w.electronAPI = {
    ai: {
      keyStatus: async () => ({
        success: true,
        enabled: true,
        transcription: { configured: true },
        chat: { configured: true, provider: 'groq', model: 'openai/gpt-oss-120b' },
        providers: [],
      }),
      setEnabled: async () => ({ success: true, enabled: true }),
      chat: async (payload) => {
        chatCalls.push(payload);
        return { success: true, text: 'Review the preview.', toolCalls };
      },
      onPlanProgress: () => () => {},
      attach: async () => ({ success: true, attachments: [] }),
      removeAttachment: async () => ({ success: true }),
      resetChat: async () => ({ success: true }),
      transcribe: async () => ({ success: true, text: '' }),
      confirmPlan: async (payload) => {
        confirmCalls.push(payload);
        return {
          success: true,
          plan: {
            ...plan,
            status: 'completed',
            steps: [{ ...plan.steps[0], status: 'success' }],
          },
        };
      },
      cancelPlan: async () => ({ success: true }),
    },
  };

  w.eval(frontend('static', 'script', 'js', 'core', 'ai.js'));
  w.PosnicPro.ai.init();
  await new Promise((resolve) => setTimeout(resolve, 80));

  d.getElementById('ai_prompt').value = 'add a test category';
  d.getElementById('ai_send').click();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(chatCalls.length, 1);
  assert.equal(d.querySelectorAll('.posnic-ai-plan-foot .btn-primary').length, 1);

  d.getElementById('ai_prompt').value = 'تمام نفذ';
  d.getElementById('ai_send').click();
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(chatCalls.length, 1, 'the typed confirmation went to the model');
  assert.equal(confirmCalls.length, 1, 'the typed confirmation did not execute the plan');
  assert.equal(confirmCalls[0].planId, 'plan_typed');
  assert.equal(d.querySelectorAll('.posnic-ai-message--user').length, 2);
  assert.match(d.body.textContent, /تمام نفذ/);
  assert.match(d.body.textContent, /Completed/);
});

test('a reply from a replaced chat does not repaint the new chat', async () => {
  const frontend = (...parts) => read('frontend', ...parts);
  const dom = new JSDOM(
    '<!doctype html><html><body>' + frontend('modules', 'ai.html') + '</body></html>',
    { runScripts: 'outside-only', url: 'http://localhost/dashboard.html' },
  );
  const w = dom.window;
  const d = w.document;
  let resolveChat;
  const pendingChat = new Promise((resolve) => { resolveChat = resolve; });
  const resetCalls = [];

  w.PosnicPro = {
    local: {
      get: (key) => {
        if (key === 'ai_assistant_settings') return JSON.stringify({ enabled: true });
        if (key === 'branch_id_set') return 'branch-1';
        if (key === 'username') return 'admin';
        return null;
      },
      set: () => {},
    },
    i18n: { t: (_, fallback) => fallback },
    userACL: { branch: { write: true } },
    HideSideBarModal: () => {},
  };
  w.hasher = { setHash: () => {} };
  w.$ = () => ({
    removeClass() { return this; },
    addClass() { return this; },
    hide() { return this; },
    show() { return this; },
  });
  w.localStorage.setItem('posnic_jwt_token', 'jwt-session');

  w.electronAPI = {
    ai: {
      keyStatus: async () => ({
        success: true,
        enabled: true,
        transcription: { configured: true },
        chat: { configured: true, provider: 'groq', model: 'openai/gpt-oss-120b' },
        providers: [],
      }),
      setEnabled: async () => ({ success: true, enabled: true }),
      chat: async () => pendingChat,
      onPlanProgress: () => () => {},
      attach: async () => ({ success: true, attachments: [] }),
      removeAttachment: async () => ({ success: true }),
      resetChat: async (payload) => {
        resetCalls.push(payload);
        return { success: true };
      },
      transcribe: async () => ({ success: true, text: '' }),
      confirmPlan: async () => ({ success: true }),
      cancelPlan: async () => ({ success: true }),
    },
  };

  w.eval(frontend('static', 'script', 'js', 'core', 'ai.js'));
  w.PosnicPro.ai.init();
  await new Promise((resolve) => setTimeout(resolve, 80));

  d.getElementById('ai_prompt').value = 'add a product';
  d.getElementById('ai_send').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(d.querySelectorAll('.posnic-ai-message--user').length, 1);

  d.getElementById('ai_new_chat').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(d.querySelectorAll('.posnic-ai-message--user').length, 0);
  assert.equal(resetCalls.length, 1);

  resolveChat({
    success: true,
    text: 'Which unit?',
    toolCalls: [{
      name: 'posnic_ask_user',
      status: 'completed',
      metadata: {
        posnic: {
          kind: 'clarify',
          question: 'Which unit?',
          options: [{ label: 'Piece', value: 'piece' }],
        },
      },
    }],
  });
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(d.querySelectorAll('.posnic-ai-message--assistant').length, 0);
  assert.doesNotMatch(d.body.textContent, /Which unit\?/);
  assert.equal(d.getElementById('ai_send').disabled, false);
});

test('a provider failure shows Retry and resends without duplicating the message', async () => {
  const frontend = (...parts) => read('frontend', ...parts);
  const dom = new JSDOM(
    '<!doctype html><html><body>' + frontend('modules', 'ai.html') + '</body></html>',
    { runScripts: 'outside-only', url: 'http://localhost/dashboard.html' },
  );
  const w = dom.window;
  const d = w.document;
  let chatCalls = 0;

  w.PosnicPro = {
    local: {
      get: (key) => {
        if (key === 'ai_assistant_settings') return JSON.stringify({ enabled: true });
        if (key === 'branch_id_set') return 'branch-1';
        if (key === 'username') return 'admin';
        return null;
      },
      set: () => {},
    },
    i18n: { t: (_, fallback) => fallback },
    userACL: { branch: { write: true } },
    HideSideBarModal: () => {},
  };
  w.hasher = { setHash: () => {} };
  w.$ = () => ({
    removeClass() { return this; },
    addClass() { return this; },
    hide() { return this; },
    show() { return this; },
  });
  w.localStorage.setItem('posnic_jwt_token', 'jwt-session');

  w.electronAPI = {
    ai: {
      keyStatus: async () => ({
        success: true,
        enabled: true,
        transcription: { configured: true },
        chat: { configured: true, provider: 'groq', model: 'openai/gpt-oss-120b' },
        providers: [],
      }),
      setEnabled: async () => ({ success: true, enabled: true }),
      chat: async () => {
        chatCalls += 1;
        return chatCalls === 1
          ? { success: false, code: 'provider_error' }
          : { success: true, text: 'Done.', toolCalls: [] };
      },
      onPlanProgress: () => () => {},
      attach: async () => ({ success: true, attachments: [] }),
      removeAttachment: async () => ({ success: true }),
      resetChat: async () => ({ success: true }),
      transcribe: async () => ({ success: true, text: '' }),
      confirmPlan: async () => ({ success: true }),
      cancelPlan: async () => ({ success: true }),
    },
  };

  w.eval(frontend('static', 'script', 'js', 'core', 'ai.js'));
  w.PosnicPro.ai.init();
  await new Promise((resolve) => setTimeout(resolve, 80));

  d.getElementById('ai_prompt').value = 'edit ass';
  d.getElementById('ai_send').click();
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.match(d.getElementById('ai_status').textContent, /provider/i);
  assert.equal(d.getElementById('ai_retry').hidden, false);
  assert.equal(d.querySelectorAll('.posnic-ai-message--user').length, 1);

  d.getElementById('ai_retry').click();
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(chatCalls, 2);
  assert.equal(d.querySelectorAll('.posnic-ai-message--user').length, 1);
  assert.match(d.body.textContent, /Done\./);
  assert.equal(d.getElementById('ai_retry').hidden, true);
});

test('the assistant reference resolves real pages and how-to paths', () => {
  const reference = require(path.join(ROOT, 'src/ai/reference'));
  const navigation = reference.navigation;

  assert.ok(reference.index().length >= 20, 'the reference index is too small');
  assert.equal(reference.search('add a product', { limit: 3 })[0].title, 'Add a product');

  const items = navigation.search('add a product', { limit: 3 })[0];
  assert.equal(items.id, 'items');
  assert.equal(items.actions[0].id, 'add-standard-item');
  assert.equal(items.actions[0].route, '#/items/new');

  const categories = navigation.search('add category', { limit: 3 })[0];
  assert.equal(categories.id, 'categories');
  assert.equal(categories.actions[0].id, 'add-category');

  const stock = navigation.search('where is stock counts', { limit: 3 })[0];
  assert.equal(stock.id, 'stock-counts');

  for (const destination of navigation.list()) {
    assert.ok(destination.menu.length > 0, `${destination.id} has no menu path`);
    assert.match(destination.route, /^(#\/|[a-z0-9_-]+\.html)/i, `${destination.id} has no route`);
    for (const action of destination.actions) {
      assert.match(action.route, /^#\//, `${destination.id}/${action.id} has no route`);
      assert.ok(action.location.trim(), `${action.id} has no location`);
    }
  }

  assert.match(read('src', 'ai', 'reference', 'CAPABILITIES.md'), /posnic_search_products/);
  assert.match(read('src', 'ai', 'reference', 'CAPABILITIES.md'), /posnic_list_products/);
  assert.match(read('src', 'ai', 'reference', 'CAPABILITIES.md'), /posnic_list_categories/);
  assert.match(read('src', 'ai', 'reference', 'CAPABILITIES.md'), /posnic_ask_user/);
  assert.match(read('src', 'ai', 'reference', 'CAPABILITIES.md'), /posnic_propose_plan/);
  assert.match(read('src', 'ai', 'reference', 'CAPABILITIES.md'), /posnic_help/);
  assert.match(read('src', 'ai', 'reference', 'BEHAVIOR.md'), /confirm/i);
  assert.match(read('src', 'ai', 'reference', 'BEHAVIOR.md'), /posnic_list_products/);
  assert.match(read('src', 'ai', 'reference', 'BEHAVIOR.md'), /posnic_ask_user/);
  assert.match(read('src', 'ai', 'reference', 'NAVIGATION.md'), /Inventory → Items/);
});

test('the shop API client sends the user session and active branch', async () => {
  const { createApiClient } = require(path.join(ROOT, 'src/ai/tools/api-client'));
  const requests = [];
  const api = createApiClient({
    baseUrl: 'http://127.0.0.1:5555/',
    token: 'jwt-session',
    branchId: 'branch-9',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response(200, { data: { list: [] } });
    },
  });

  const payload = await api.get('items/search', { q: 'pepsi', limit: 5, empty: '' });
  assert.deepEqual(payload, { data: { list: [] } });
  assert.equal(requests[0].url, 'http://127.0.0.1:5555/api/items/search?q=pepsi&limit=5');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer jwt-session');
  assert.equal(requests[0].init.headers['X-Branch-Id'], 'branch-9');

  const forbidden = createApiClient({
    baseUrl: 'http://127.0.0.1:5555',
    token: 'jwt-session',
    fetchImpl: async () => response(403, { message: 'Item access denied' }),
  });
  await assert.rejects(
    () => forbidden.get('items/search', { q: 'pepsi' }),
    (error) => error.code === 'forbidden' && /Item access denied/.test(error.message),
  );

  const invalid = createApiClient({
    baseUrl: 'http://127.0.0.1:5555',
    token: 'jwt-session',
    fetchImpl: async () => response(400, {
      message: 'Validation failed',
      errors: [{ msg: 'Category name contains invalid characters' }],
    }),
  });
  await assert.rejects(
    () => invalid.post('categories', { name: 'احذية' }),
    (error) => error.code === 'request_failed' &&
      error.message === 'Validation failed: Category name contains invalid characters',
  );

  const anonymous = createApiClient({
    baseUrl: 'http://127.0.0.1:5555',
    token: '',
    fetchImpl: async () => response(200, {}),
  });
  await assert.rejects(
    () => anonymous.get('items/search', { q: 'pepsi' }),
    (error) => error.code === 'auth_required',
  );
});

test('the product search reuses the branch-scoped item route and maps its rows', async () => {
  const {
    formatForModel,
    searchProducts,
  } = require(path.join(ROOT, 'src/ai/tools/search-products'));

  const calls = [];
  const api = {
    async get(pathname, query) {
      calls.push({ pathname, query });
      return {
        data: {
          list: [{
            id: 'item-1',
            name: 'Pepsi 1L',
            category_name: 'Drinks',
            selling_price: '25',
            company_price: '20',
            available_quantity: '12',
            unit: 'bottle',
            barcode_id: '6221001',
            sku: 'PEP-1L',
            description: 'Cold drink',
            track_inventory: true,
          }],
        },
      };
    },
  };

  const result = await searchProducts({ query: 'pepsi', limit: 3 }, { api });
  assert.deepEqual(calls[0], { pathname: 'items/search', query: { q: 'pepsi', limit: 3 } });
  assert.equal(result.kind, 'product_search');
  assert.equal(result.count, 1);
  assert.equal(result.results[0].sellingPrice, 25);
  assert.equal(result.results[0].stock, 12);
  assert.equal(result.results[0].trackInventory, true);
  assert.match(formatForModel(result), /Pepsi 1L/);
  assert.match(formatForModel(result), /price: 25/);

  const empty = await searchProducts({ query: '   ' }, { api });
  assert.equal(empty.kind, 'error');
  assert.equal(empty.code, 'invalid_query');

  const denied = await searchProducts({ query: 'pepsi' }, {
    api: {
      async get() {
        const error = new Error('Item access denied');
        error.code = 'forbidden';
        throw error;
      },
    },
  });
  assert.equal(denied.kind, 'error');
  assert.equal(denied.code, 'forbidden');
  assert.match(formatForModel(denied), /Item access denied/);
});

test('the category list reuses the branch-scoped categories route', async () => {
  const {
    formatForModel,
    listCategories,
  } = require(path.join(ROOT, 'src/ai/tools/list-categories'));

  const calls = [];
  const api = {
    async get(pathname, query) {
      calls.push({ pathname, query });
      return {
        data: {
          total: 1,
          list: [{
            _id: 'cat-1',
            name: 'Drinks',
            description: 'Cold drinks',
            items_count: '12',
            is_active: true,
          }],
        },
      };
    },
  };

  const result = await listCategories({}, { api });
  assert.deepEqual(calls[0], { pathname: 'categories', query: { limit: 20, search: '', status: 'active' } });
  assert.equal(result.kind, 'category_list');
  assert.equal(result.count, 1);
  assert.equal(result.total, 1);
  assert.equal(result.categories[0].itemCount, 12);
  assert.match(formatForModel(result), /Drinks/);
  assert.match(formatForModel(result), /12 items/);

  await listCategories({ query: 'drinks', limit: 5 }, { api });
  assert.deepEqual(calls[1], { pathname: 'categories', query: { limit: 5, search: 'drinks', status: 'active' } });

  const denied = await listCategories({}, {
    api: {
      async get() {
        const error = new Error('Category access denied');
        error.code = 'forbidden';
        throw error;
      },
    },
  });
  assert.equal(denied.kind, 'error');
  assert.equal(denied.code, 'forbidden');
  assert.match(formatForModel(denied), /Category access denied/);
});

test('the product list handles all products, categories and paging without a keyword', async () => {
  const {
    formatForModel,
    listProducts,
  } = require(path.join(ROOT, 'src/ai/tools/list-products'));

  const calls = [];
  const row = {
    id: 'item-1',
    name: 'Pepsi 1L',
    category_name: 'Drinks',
    selling_price: '25',
    company_price: '20',
    available_quantity: '12',
    unit: 'bottle',
    barcode_id: '6221001',
    sku: 'PEP-1L',
    description: 'Cold drink',
    track_inventory: true,
  };
  const api = {
    async get(pathname, query) {
      calls.push({ pathname, query });
      if (pathname === 'items') {
        return { data: { list: [row], total: 47, total_pages: 3 } };
      }
      return { data: { list: [row], total: 1 } };
    },
  };

  const all = await listProducts({}, { api });
  assert.deepEqual(calls[0], {
    pathname: 'items',
    query: { limit: 20, page: 1, sort: 'name' },
  });
  assert.equal(all.kind, 'product_list');
  assert.equal(all.count, 1);
  assert.equal(all.total, 47);
  assert.equal(all.totalPages, 3);
  assert.equal(all.hasMore, true);
  assert.match(formatForModel(all), /Showing 1 of 47/);
  assert.match(formatForModel(all), /id: item-1/);

  const filtered = await listProducts({
    categoryId: '66f1c2a4e1b2c3d4e5f60718',
    categoryName: 'Drinks',
    page: 2,
  }, { api });
  assert.equal(calls[1].pathname, 'items');
  assert.equal(calls[1].query.page, 2);
  assert.equal(calls[1].query.filters, '{"category_id":"66f1c2a4e1b2c3d4e5f60718"}');
  assert.equal(filtered.categoryName, 'Drinks');

  const keyword = await listProducts({ query: 'pepsi' }, { api });
  assert.equal(calls[2].pathname, 'items/search');
  assert.equal(calls[2].query.q, 'pepsi');
  assert.equal(keyword.kind, 'product_list');
  assert.equal(keyword.hasMore, false);
  assert.match(formatForModel(keyword), /matching "pepsi"/);
});

test('clarification returns a question and short clickable options', () => {
  const {
    askUser,
    formatForModel,
  } = require(path.join(ROOT, 'src/ai/tools/ask-user'));

  const result = askUser({
    question: 'Which unit?',
    options: [
      { label: 'Piece' },
      { label: 'Kilogram', value: 'kg' },
    ],
  });
  assert.equal(result.kind, 'clarify');
  assert.deepEqual(result.options, [
    { label: 'Piece', value: 'Piece' },
    { label: 'Kilogram', value: 'kg' },
  ]);
  assert.match(formatForModel(result), /already visible/);
  assert.match(formatForModel(result), /do not repeat/i);

  assert.equal(askUser({ question: '   ' }).code, 'missing_question');
  assert.equal(askUser({
    question: 'Too many?',
    options: [1, 2, 3, 4, 5].map((value) => ({ label: String(value) })),
  }).code, 'too_many_options');
});

test('a category the request already named is not asked for again', () => {
  const { askUser } = require(path.join(ROOT, 'src/ai/tools/ask-user'));
  const question = {
    question: 'أي فئة تريد للمنتج جزمة حمرى؟',
    options: [
      { label: 'احذية', value: 'existing' },
      { label: 'الاحزايا (إنشاء فئة جديدة)', value: 'new' },
    ],
    missing: ['category'],
  };
  const named = askUser(question, {
    pendingText: 'ضيف برودكت جزمة حمرى في فئة الاحزايا وخلي الكمية خمسين',
  });
  assert.equal(named.kind, 'error');
  assert.equal(named.code, 'category_already_given');
  assert.equal(named.internal, true);
  assert.match(named.message, /الاحزايا/);
  assert.match(named.message, /already settled/);

  const combined = askUser({
    ...question,
    missing: ['category', 'selling price', 'cost price'],
  }, {
    pendingText: 'ضيف برودكت جزمة حمرى في فئة الاحزايا وخلي الكمية خمسين',
  });
  assert.equal(combined.kind, 'error');
  assert.equal(combined.code, 'category_already_given');
  assert.match(combined.message, /Ask only for: selling price, cost price/);

  const unnamed = askUser(question, {
    pendingText: 'ضيف برودكت جزمة حمرى وخلي الكمية خمسين',
  });
  assert.equal(unnamed.kind, 'clarify');

  const newCategory = askUser(question, {
    pendingText: 'ضيف برودكت جزمة حمرى في فئة جديدة وخلي الكمية خمسين',
  });
  assert.equal(newCategory.kind, 'clarify');

  const priceQuestion = askUser({
    question: 'ما سعر البيع والتكلفة؟',
    missing: ['selling_price', 'cost_price'],
  }, {
    pendingText: 'ضيف برودكت جزمة حمرى في فئة الاحزايا وخلي الكمية خمسين',
  });
  assert.equal(priceQuestion.kind, 'clarify');

  const answeredCategory = askUser(question, {
    pendingText: 'ضيف برودكت جزمة حمرى',
    answered: [{ question: 'أي فئة؟', answer: 'غسالات' }],
    currentCategory: { name: 'غسالات' },
  });
  assert.equal(answeredCategory.kind, 'error');
  assert.equal(answeredCategory.code, 'category_already_given');
  assert.match(answeredCategory.message, /غسالات/);

  const repeated = askUser({
    question: 'ما سعر البيع؟',
    missing: ['selling price'],
  }, {
    answered: [{ question: 'ما سعر البيع؟', answer: '100' }],
  });
  assert.equal(repeated.kind, 'error');
  assert.equal(repeated.code, 'question_already_answered');
  assert.match(repeated.message, /100/);
});

test('a confirmed plan creates the category once, adds the product image and verifies it', async () => {
  const { validatePlan } = require(path.join(ROOT, 'src/ai/actions/plan-schema'));
  const { executePlan } = require(path.join(ROOT, 'src/ai/actions/plan-executor'));

  const requests = [];
  const category = { _id: 'cat-9', name: 'Drinks' };
  const savedProduct = {
    _id: 'item-9',
    name: 'Pepsi 1L',
    selling_price: 25,
    company_price: 18,
    mrp_price: 25,
    available_quantity: 10,
    category_id: 'cat-9',
    category_name: 'Drinks',
    unit: 'bottle',
    track_inventory: true,
  };
  const api = {
    async get(pathname, query) {
      requests.push({ method: 'GET', pathname, query });
      if (pathname === 'categories') return { data: { list: [], total: 0 } };
      if (pathname === 'items/search') return { data: { list: [], total: 0 } };
      if (pathname === 'categories/cat-9') return { data: category };
      if (pathname === 'items/item-9') return { data: savedProduct };
      throw new Error(`unexpected GET ${pathname}`);
    },
    async post(pathname, body) {
      requests.push({ method: 'POST', pathname, body });
      if (pathname === 'categories') return { data: category };
      if (pathname === 'items/uploadItemMultiImage') {
        return {
          data: [{
            name: '/uploads/item_images/pepsi.png',
            size: 12,
            cover: 'yes',
          }],
        };
      }
      if (pathname === 'items') return { data: savedProduct };
      throw new Error(`unexpected POST ${pathname}`);
    },
    async put() {
      throw new Error('unexpected PUT');
    },
  };
  const attachments = {
    describe(sessionID, ids) {
      assert.equal(sessionID, 'conv-1');
      assert.deepEqual(ids, ['img_1']);
      return {
        ok: true,
        attachments: [{
          id: 'img_1',
          name: 'pepsi.png',
          size: 12,
          data: 'aGVsbG8=',
        }],
      };
    },
  };

  const prepared = await validatePlan({
    title: 'Add Pepsi',
    steps: [
      {
        id: 'cat1',
        action: 'create_category',
        fields: { name: 'Drinks' },
      },
      {
        id: 'p1',
        action: 'create_product',
        fields: {
          name: 'Pepsi 1L',
          selling_price: 25,
          cost_price: 18,
          opening_stock: 10,
          category_id: { step: 'cat1', field: 'id' },
          unit: 'bottle',
        },
        images: [{ attachmentId: 'img_1', cover: true }],
      },
    ],
  }, { api, sessionID: 'conv-1', attachments });

  assert.equal(prepared.ok, true);
  const productStep = prepared.plan.steps[1];
  assert.deepEqual(productStep.fields.category_id, { step: 'cat1', field: 'id' });
  assert.deepEqual(productStep.fields.category_name, { step: 'cat1', field: 'name' });
  assert.ok(productStep.dependsOn.includes('cat1'));
  assert.equal(productStep.images[0].name, 'pepsi.png');
  assert.equal(productStep.images[0].cover, true);

  const executed = await executePlan(prepared.plan, {
    api,
    attachments,
    sessionID: 'conv-1',
  });
  assert.equal(executed.status, 'completed');
  assert.equal(executed.steps[0].status, 'success');
  assert.equal(executed.steps[1].status, 'success');
  assert.equal(executed.steps[1].verified, true);

  const createProduct = requests.find(
    (entry) => entry.method === 'POST' && entry.pathname === 'items',
  );
  assert.ok(createProduct);
  assert.equal(createProduct.body.category_id, 'cat-9');
  assert.equal(createProduct.body.category_name, 'Drinks');
  assert.equal(createProduct.body.image[0].name, '/uploads/item_images/pepsi.png');
  assert.equal(createProduct.body.cover_image, '/uploads/item_images/pepsi.png');
});

test('an update without new images keeps the existing product cover', async () => {
  const { validatePlan } = require(path.join(ROOT, 'src/ai/actions/plan-schema'));
  const { executePlan } = require(path.join(ROOT, 'src/ai/actions/plan-executor'));

  const itemId = '66f1c2a4e1b2c3d4e5f60718';
  const current = {
    _id: itemId,
    name: 'Pepsi',
    selling_price: 25,
    company_price: 18,
    mrp_price: 25,
    available_quantity: 10,
    category_id: 'cat-9',
    category_name: 'Drinks',
    unit: 'bottle',
    track_inventory: true,
    multi_image: [
      { name: '/uploads/item_images/a.png', cover: 'yes' },
      { name: '/uploads/item_images/b.png', cover: 'no' },
    ],
    image: '/uploads/item_images/a.png',
  };
  let putBody = null;
  const api = {
    async get(pathname) {
      if (pathname === 'items/' + itemId) return { data: current };
      if (pathname === 'items/search') return { data: { list: [], total: 0 } };
      throw new Error(`unexpected GET ${pathname}`);
    },
    async post() {
      throw new Error('unexpected POST');
    },
    async put(pathname, body) {
      putBody = { pathname, body };
      current.name = body.name;
      current.mrp_price = body.mrp_price;
      return { data: current };
    },
  };

  const prepared = await validatePlan({
    steps: [{
      id: 'p1',
      action: 'update_product',
      target: itemId,
      fields: { name: 'Pepsi Zero' },
    }],
  }, {
    api,
    sessionID: 'conv-2',
    attachments: { describe: () => ({ ok: true, attachments: [] }) },
  });
  assert.equal(prepared.ok, true);

  const executed = await executePlan(prepared.plan, {
    api,
    sessionID: 'conv-2',
    attachments: { describe: () => ({ ok: true, attachments: [] }) },
  });
  assert.equal(executed.status, 'completed');
  assert.equal(putBody.pathname, 'items/' + itemId + '/details');
  assert.deepEqual(putBody.body.image, [
    { name: '/uploads/item_images/a.png', size: 0, cover: 'yes' },
    { name: '/uploads/item_images/b.png', size: 0, cover: 'no' },
  ]);
  assert.equal(putBody.body.cover_image, '/uploads/item_images/a.png');
});

test('a failed later step undoes earlier writes and leaves a retryable plan', async () => {
  const { executePlan } = require(path.join(ROOT, 'src/ai/actions/plan-executor'));

  const calls = [];
  const category = { _id: 'cat-atomic', name: 'Drinks' };
  const api = {
    async get(pathname) {
      calls.push({ method: 'GET', pathname });
      if (pathname === 'categories/cat-atomic') return { data: category };
      throw new Error(`unexpected GET ${pathname}`);
    },
    async post(pathname) {
      calls.push({ method: 'POST', pathname });
      if (pathname === 'categories') return { data: category };
      if (pathname === 'items') throw new Error('The product could not be saved.');
      throw new Error(`unexpected POST ${pathname}`);
    },
    async put() {
      throw new Error('unexpected PUT');
    },
    async delete(pathname, body) {
      calls.push({ method: 'DELETE', pathname, body });
      return { type: 'success' };
    },
  };
  const plan = {
    id: 'plan_atomic',
    status: 'pending',
    warnings: [],
    steps: [
      { id: 'c1', action: 'create_category', fields: { name: 'Drinks' }, dependsOn: [] },
      {
        id: 'p1',
        action: 'create_product',
        fields: { name: 'Pepsi', selling_price: 10, cost_price: 5, opening_stock: 3 },
        dependsOn: [],
      },
    ],
  };

  const executed = await executePlan(plan, {
    api,
    sessionID: 'conv-atomic',
    attachments: { describe: () => ({ ok: true, attachments: [] }) },
  });

  assert.equal(executed.status, 'failed');
  assert.equal(executed.retryable, true);
  assert.equal(executed.steps[0].status, 'pending');
  assert.equal(executed.steps[0].result, undefined);
  assert.equal(executed.steps[1].status, 'failed');
  assert.equal(executed.summaryStatus.success, 0);
  assert.deepEqual(
    calls.filter((call) => call.method === 'DELETE'),
    [{ method: 'DELETE', pathname: 'categories/cat-atomic', body: undefined }]
  );
  assert.ok(executed.warnings.includes('No changes were kept. You can retry this plan.'));
});

test('an incomplete rollback keeps the surviving step visible and blocks retry', async () => {
  const { executePlan } = require(path.join(ROOT, 'src/ai/actions/plan-executor'));
  const { createPlanStore } = require(path.join(ROOT, 'src/ai/actions/plan-store'));

  const category = { _id: 'cat-atomic', name: 'Drinks' };
  const api = {
    async get(pathname) {
      if (pathname === 'categories/cat-atomic') return { data: category };
      throw new Error(`unexpected GET ${pathname}`);
    },
    async post(pathname) {
      if (pathname === 'categories') return { data: category };
      if (pathname === 'items') throw new Error('The product could not be saved.');
      throw new Error(`unexpected POST ${pathname}`);
    },
    async put() {
      throw new Error('unexpected PUT');
    },
    async delete() {
      throw new Error('The category could not be removed.');
    },
  };
  const plan = {
    id: 'plan_atomic_partial',
    status: 'pending',
    warnings: [],
    steps: [
      { id: 'c1', action: 'create_category', fields: { name: 'Drinks' }, dependsOn: [] },
      {
        id: 'p1',
        action: 'create_product',
        fields: { name: 'Pepsi', selling_price: 10, cost_price: 5, opening_stock: 3 },
        dependsOn: [],
      },
    ],
  };

  const executed = await executePlan(plan, {
    api,
    sessionID: 'conv-atomic',
    attachments: { describe: () => ({ ok: true, attachments: [] }) },
  });

  assert.equal(executed.status, 'partial');
  assert.equal(executed.retryable, false);
  assert.equal(executed.steps[0].status, 'success');
  assert.match(executed.steps[0].warning, /could not be undone/);
  assert.equal(executed.steps[1].status, 'failed');
  assert.match(executed.warnings.join(' '), /could not be undone/);

  const store = createPlanStore();
  store.add(executed);
  const begun = store.begin(executed.id);
  assert.equal(begun.ok, false);
  assert.equal(begun.code, 'plan_review_required');
});

test('an update plan finds the product by its exact name instead of asking for an id', async () => {
  const { validatePlan } = require(path.join(ROOT, 'src/ai/actions/plan-schema'));
  const { executePlan } = require(path.join(ROOT, 'src/ai/actions/plan-executor'));

  const itemId = '66f1c2a4e1b2c3d4e5f60718';
  const current = {
    _id: itemId,
    name: 'ass',
    selling_price: 200,
    company_price: 0,
    mrp_price: 0,
    available_quantity: 21,
    category_id: '',
    category_name: '',
    description: '',
    unit: 'qty',
    barcode_id: '',
    sku: '',
    track_inventory: true,
    multi_image: [],
    image: '',
  };
  const requests = [];
  const api = {
    async get(pathname) {
      requests.push({ method: 'GET', pathname });
      if (pathname === 'items/search') return { data: { list: [current], total: 1 } };
      if (pathname === 'items/' + itemId) return { data: current };
      throw new Error(`unexpected GET ${pathname}`);
    },
    async put(pathname, body) {
      requests.push({ method: 'PUT', pathname, body });
      current.name = body.name;
      current.selling_price = body.selling_price;
      current.company_price = body.company_price;
      current.mrp_price = body.mrp_price;
      current.description = body.description;
      return { data: current };
    },
  };
  const attachments = { describe: () => ({ ok: true, attachments: [] }) };

  const prepared = await validatePlan({
    steps: [{
      id: 'upd1',
      action: 'update_product',
      target: 'ass',
      fields: { description: 'very robust product' },
    }],
  }, { api, sessionID: 'conv-name', attachments });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.plan.steps[0].target, itemId);
  assert.equal(prepared.plan.steps[0].before.name, 'ass');

  const executed = await executePlan(prepared.plan, {
    api,
    sessionID: 'conv-name',
    attachments,
  });
  assert.equal(executed.status, 'completed');
  assert.equal(executed.steps[0].verified, true);
  const update = requests.find((entry) => entry.method === 'PUT');
  assert.equal(update.pathname, 'items/' + itemId + '/details');
  assert.equal(update.body.description, 'very robust product');
});

test('Arabic spelling slips reuse the existing category and resolve the intended product', async () => {
  const { validatePlan } = require(path.join(ROOT, 'src/ai/actions/plan-schema'));

  const itemId = '66f1c2a4e1b2c3d4e5f60718';
  const category = { _id: 'cat-shoes', name: 'احذية' };
  const current = {
    _id: itemId,
    name: 'جزمة حمراء',
    selling_price: 500,
    company_price: 300,
    mrp_price: 500,
    available_quantity: 50,
    category_id: 'cat-shoes',
    category_name: 'احذية',
    description: '',
    unit: 'qty',
    barcode_id: '',
    sku: '',
    track_inventory: true,
    multi_image: [],
    image: '',
  };
  const api = {
    async get(pathname, query) {
      if (pathname === 'categories') return { data: { list: [category], total: 1 } };
      if (pathname === 'categories/cat-shoes') return { data: category };
      if (pathname === 'items/search') {
        return {
          data: {
            list: query && query.q === 'جزمة حمرى' ? [current] : [],
            total: query && query.q === 'جزمة حمرى' ? 1 : 0,
          },
        };
      }
      if (pathname === 'items/' + itemId) return { data: current };
      throw new Error(`unexpected GET ${pathname}`);
    },
    async put(pathname, body) {
      current.name = body.name;
      current.selling_price = body.selling_price;
      current.company_price = body.company_price;
      current.mrp_price = body.mrp_price;
      return { data: current };
    },
  };
  const attachments = { describe: () => ({ ok: true, attachments: [] }) };

  const created = await validatePlan({
    steps: [{
      id: 'p1',
      action: 'create_product',
      fields: {
        name: 'جزمة حمراء',
        selling_price: 550,
        cost_price: 320,
        opening_stock: 20,
        category_name: 'الاحزايا',
      },
    }],
  }, { api, sessionID: 'conv-fuzzy', attachments });
  assert.equal(created.ok, true, created.message);
  assert.equal(created.plan.steps[0].fields.category_id, 'cat-shoes');
  assert.equal(created.plan.steps[0].fields.category_name, 'احذية');

  const updated = await validatePlan({
    steps: [{
      id: 'p1',
      action: 'update_product',
      target: 'جزمة حمرى',
      fields: { selling_price: 525 },
    }],
  }, { api, sessionID: 'conv-fuzzy', attachments });
  assert.equal(updated.ok, true, updated.message);
  assert.equal(updated.plan.steps[0].target, itemId);
  assert.equal(updated.plan.steps[0].targetName, 'جزمة حمراء');
});

test('a category typo is not created beside the real category', async () => {
  const { validatePlan } = require(path.join(ROOT, 'src/ai/actions/plan-schema'));
  const api = {
    async get(pathname, query) {
      if (pathname === 'categories') {
        assert.equal(query.status, 'active');
        return { data: { list: [{ _id: 'cat-shoes', name: 'احذية' }], total: 1 } };
      }
      throw new Error(`unexpected GET ${pathname}`);
    },
  };

  const blocked = await validatePlan({
    steps: [{ id: 'c1', action: 'create_category', fields: { name: 'الاحزايا' } }],
  }, { api });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'possible_duplicate');
  assert.equal(blocked.existingId, 'cat-shoes');

  const allowed = await validatePlan({
    steps: [{ id: 'c1', action: 'create_category', fields: { name: 'احذية اطفال' } }],
  }, { api });
  assert.equal(allowed.ok, true, allowed.message);
});

test('a misspelled category is reused when a product uses it', async () => {
  const { validatePlan } = require(path.join(ROOT, 'src/ai/actions/plan-schema'));
  const { executePlan } = require(path.join(ROOT, 'src/ai/actions/plan-executor'));
  const requests = [];
  const category = { _id: 'cat-shoes', name: 'احذية' };
  const savedProduct = {
    _id: 'item-blue',
    name: 'جزمة زرقاء',
    selling_price: 300,
    company_price: 150,
    mrp_price: 300,
    available_quantity: 20,
    category_id: 'cat-shoes',
    category_name: 'احذية',
    unit: 'qty',
    barcode_id: '',
    sku: '',
    track_inventory: true,
  };
  const api = {
    async get(pathname, query) {
      requests.push({ method: 'GET', pathname, query });
      if (pathname === 'categories') {
        assert.equal(query.status, 'active');
        return { data: { list: [category], total: 1 } };
      }
      if (pathname === 'items/search') return { data: { list: [], total: 0 } };
      if (pathname === 'items/item-blue') return { data: savedProduct };
      throw new Error(`unexpected GET ${pathname}`);
    },
    async post(pathname, body) {
      requests.push({ method: 'POST', pathname, body });
      if (pathname === 'items') return { data: savedProduct };
      throw new Error(`unexpected POST ${pathname}`);
    },
    async put() {
      throw new Error('unexpected PUT');
    },
  };
  const attachments = { describe: () => ({ ok: true, attachments: [] }) };

  const prepared = await validatePlan({
    title: 'Add product جزمة زرقاء',
    summary: 'Create product جزمة زرقاء in category الاحزايا with price 300, cost 150, stock 20.',
    steps: [
      {
        id: 'cat1',
        action: 'create_category',
        fields: { name: 'الاحزايا' },
      },
      {
        id: 'p1',
        action: 'create_product',
        dependsOn: ['cat1'],
        fields: {
          name: 'جزمة زرقاء',
          selling_price: 300,
          cost_price: 150,
          opening_stock: 20,
          category_id: { step: 'cat1', field: 'id' },
          category_name: 'الاحزايا',
        },
      },
    ],
  }, {
    api,
    attachments,
    userText: 'ضيف جزمة زرقاء في فئة الاحزايا بسعر 300 وتكلفة 150 وكمية 20',
  });
  assert.equal(prepared.ok, true, prepared.message);
  assert.match(prepared.plan.summary, /احذية/);
  assert.doesNotMatch(prepared.plan.summary, /الاحزايا/);
  const categoryStep = prepared.plan.steps.find((step) => step.id === 'cat1');
  assert.deepEqual(categoryStep.reuse, { id: 'cat-shoes', name: 'احذية' });
  assert.equal(categoryStep.label, 'Use existing category');
  assert.equal(categoryStep.fields.name, 'احذية');
  const productStep = prepared.plan.steps.find((step) => step.id === 'p1');
  assert.deepEqual(productStep.fields.category_name, { step: 'cat1', field: 'name' });

  const executed = await executePlan(prepared.plan, { api, attachments, sessionID: 'conv-blue' });
  assert.equal(executed.status, 'completed');
  assert.equal(requests.some((entry) => entry.method === 'POST' && entry.pathname === 'categories'), false);
  const createProduct = requests.find((entry) => entry.method === 'POST' && entry.pathname === 'items');
  assert.ok(createProduct);
  assert.equal(createProduct.body.category_id, 'cat-shoes');
  assert.equal(createProduct.body.category_name, 'احذية');
});

test('selling price and retail price are one price unless a different retail price is given', async () => {
  const { validatePlan } = require(path.join(ROOT, 'src/ai/actions/plan-schema'));
  const api = {
    async get(pathname) {
      if (pathname === 'items/search') return { data: { list: [], total: 0 } };
      throw new Error(`unexpected GET ${pathname}`);
    },
  };

  const same = await validatePlan({
    steps: [{
      id: 'p1',
      action: 'create_product',
      fields: {
        name: 'Blue shoe',
        selling_price: 100,
        cost_price: 60,
        opening_stock: 5,
      },
    }],
  }, { api, userText: 'add a blue shoe, selling price 100 and cost 60, stock 5' });
  assert.equal(same.ok, true, same.message);
  assert.equal(same.plan.steps[0].fields.mrp_price, 100);

  const different = await validatePlan({
    steps: [{
      id: 'p1',
      action: 'create_product',
      fields: {
        name: 'Blue shoe',
        selling_price: 100,
        mrp_price: 120,
        cost_price: 60,
        opening_stock: 5,
      },
    }],
  }, { api, userText: 'add a blue shoe, selling price 100 and retail price 120, cost 60, stock 5' });
  assert.equal(different.ok, true, different.message);
  assert.equal(different.plan.steps[0].fields.mrp_price, 120);
});

test('currency-decorated amounts are parsed into numbers', async () => {
  const { validatePlan } = require(path.join(ROOT, 'src/ai/actions/plan-schema'));
  const api = {
    async get(pathname) {
      if (pathname === 'items/search') return { data: { list: [], total: 0 } };
      throw new Error(`unexpected GET ${pathname}`);
    },
  };

  const plan = await validatePlan({
    steps: [{
      id: 'p1',
      action: 'create_product',
      fields: {
        name: 'Blue shoe',
        selling_price: '$ 100',
        cost_price: '١٠٠ جنيه',
        opening_stock: '50',
      },
    }],
  }, { api, userText: 'add a blue shoe with selling price 100 and cost 100, stock 50' });
  assert.equal(plan.ok, true, plan.message);
  assert.equal(plan.plan.steps[0].fields.selling_price, 100);
  assert.equal(plan.plan.steps[0].fields.cost_price, 100);
  assert.equal(plan.plan.steps[0].fields.opening_stock, 50);
  assert.equal(plan.plan.steps[0].fields.mrp_price, 100);
});

test('an unstated zero price is rejected but a free price is allowed', async () => {
  const { validatePlan } = require(path.join(ROOT, 'src/ai/actions/plan-schema'));
  const api = {
    async get(pathname) {
      if (pathname === 'items/search') return { data: { list: [], total: 0 } };
      throw new Error(`unexpected GET ${pathname}`);
    },
  };
  const fields = {
    name: 'Blue shoe',
    selling_price: 0,
    cost_price: 0,
    opening_stock: 5,
  };

  const unstated = await validatePlan({
    steps: [{ id: 'p1', action: 'create_product', fields }],
  }, { api, userText: 'add a blue shoe and keep the stock at 5' });
  assert.equal(unstated.ok, false);
  assert.equal(unstated.code, 'missing_selling_price');

  const free = await validatePlan({
    steps: [{ id: 'p1', action: 'create_product', fields }],
  }, { api, userText: 'add a free blue shoe and keep the stock at 5' });
  assert.equal(free.ok, true, free.message);
  assert.equal(free.plan.steps[0].fields.mrp_price, 0);
});

test('common Arabic colour and size spellings are corrected in product names', () => {
  const { correctCommonSpelling } = require(path.join(ROOT, 'src/ai/text-match'));
  assert.equal(correctCommonSpelling('جزمة حمرى'), 'جزمة حمراء');
  assert.equal(correctCommonSpelling('Bag زرقى'), 'Bag زرقاء');
  assert.equal(correctCommonSpelling('حمراء'), 'حمراء');
  assert.equal(correctCommonSpelling('Nike حمرى'), 'Nike حمراء');
  assert.equal(correctCommonSpelling('تلاجة بنسونيك 14 أدم'), 'تلاجة بنسونيك 14 قدم');
  assert.equal(correctCommonSpelling('آدم'), 'آدم');
});

test('the plan title and summary use the corrected product name', async () => {
  const { validatePlan } = require(path.join(ROOT, 'src/ai/actions/plan-schema'));
  const api = {
    async get() {
      return { data: { list: [], total: 0 } };
    },
  };

  const result = await validatePlan({
    title: 'Add product جزمة حمرى',
    summary: 'Create product جزمة حمرى with price 500, cost 100, stock 50.',
    steps: [{
      id: 'p1',
      action: 'create_product',
      fields: {
        name: 'جزمة حمرى',
        description: 'جزمة جلد حمرى',
        selling_price: 500,
        cost_price: 100,
        opening_stock: 50,
      },
    }],
  }, { api, userText: 'ضيف جزمة حمرى بسعر 500 وتكلفة 100 وكمية 50' });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.plan.steps[0].fields.name, 'جزمة حمراء');
  assert.equal(result.plan.steps[0].fields.description, 'جزمة جلد حمراء');
  assert.match(result.plan.title, /جزمة حمراء/);
  assert.match(result.plan.summary, /جزمة حمراء/);
  assert.doesNotMatch(result.plan.title, /حمرى/);
  assert.doesNotMatch(result.plan.summary, /حمرى/);
});

test('a new product needs a name, selling price, cost price and opening stock', async () => {
  const { validatePlan } = require(path.join(ROOT, 'src/ai/actions/plan-schema'));
  const api = {
    async get() {
      return { data: { list: [], total: 0 } };
    },
  };
  const complete = {
    name: 'Shoe',
    selling_price: 100,
    cost_price: 60,
    opening_stock: 5,
  };

  for (const [field, code] of [
    ['selling_price', 'missing_selling_price'],
    ['cost_price', 'missing_cost_price'],
    ['opening_stock', 'missing_opening_stock'],
  ]) {
    const fields = { ...complete };
    delete fields[field];
    const result = await validatePlan({
      steps: [{ id: 'p1', action: 'create_product', fields }],
    }, { api });
    assert.equal(result.ok, false, `${field} should be required`);
    assert.equal(result.code, code);
    assert.match(result.message, /ask the user/i);
  }

  const explicitZero = await validatePlan({
    steps: [{
      id: 'p1',
      action: 'create_product',
      fields: {
        ...complete,
        selling_price: 0,
        cost_price: 0,
        opening_stock: 0,
      },
    }],
  }, { api });
  assert.equal(explicitZero.ok, true, explicitZero.message);
});

test('a frozen tool plan is cloned before execution mutates it', () => {
  const { createPlanStore } = require(path.join(ROOT, 'src/ai/actions/plan-store'));
  const store = createPlanStore();
  const frozen = Object.freeze({
    id: 'plan_frozen',
    status: 'pending',
    warnings: Object.freeze([]),
    steps: Object.freeze([
      Object.freeze({
        id: 'step_1',
        action: 'create_category',
        status: 'pending',
        fields: Object.freeze({ name: 'Test' }),
        warnings: Object.freeze([]),
      }),
    ]),
  });

  const added = store.add(frozen);
  assert.notEqual(added, frozen);
  assert.equal(Object.isFrozen(added), false);
  assert.equal(Object.isFrozen(added.steps), false);
  assert.equal(Object.isFrozen(added.steps[0]), false);

  const begun = store.begin('plan_frozen');
  assert.equal(begun.ok, true);
  assert.equal(begun.plan.status, 'running');
  begun.plan.steps[0].status = 'success';
  assert.equal(begun.plan.steps[0].status, 'success');
});

test('the tool plugin registers the read, clarification and plan tools and executes them', async (t) => {
  const { createContextStore } = require(path.join(ROOT, 'src/ai/tools/context'));
  const { createPosnicToolPlugin } = require(path.join(ROOT, 'src/ai/tools/plugin'));
  const { createUserProfileStore } = require(path.join(ROOT, 'src/ai/user-profile'));
  const { createPlanStore } = require(path.join(ROOT, 'src/ai/actions/plan-store'));
  const { createConversationMemoryStore } = require(path.join(ROOT, 'src/ai/conversation-memory'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-profile-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));

  const store = createContextStore();
  store.set('session-1', {
    apiBaseUrl: 'http://127.0.0.1:5555/',
    token: 'jwt-session',
    branchId: 'branch-9',
    username: 'admin',
    conversationId: 'conv-1',
  });

  const item = {
    id: 'item-1',
    name: 'Pepsi 1L',
    selling_price: 25,
    available_quantity: 12,
    track_inventory: true,
  };
  const category = {
    _id: 'cat-1',
    name: 'Drinks',
    description: 'Cold drinks',
    items_count: 12,
    is_active: true,
  };
  const requests = [];
  const planStore = createPlanStore();
  const memory = createConversationMemoryStore();
  memory.beginTurn('conv-1', 'ضيف برودكت جزمة في فئة الاحزايا وخلي الكمية 50');
  const plugin = createPosnicToolPlugin({
    store,
    profileStore: createUserProfileStore({ dir: profileDir }),
    planStore,
    memory,
    attachments: { describe: () => ({ ok: true, attachments: [] }) },
    logger: () => {},
    fetchImpl: async (urlString, init) => {
      const url = new URL(urlString);
      requests.push({ url: urlString, pathname: url.pathname, search: url.search, init });
      if (url.pathname === '/api/categories') {
        const search = (url.searchParams.get('search') || '').toLowerCase();
        if (search === 'new cat') return response(200, { data: { total: 0, list: [] } });
        return response(200, { data: { total: 1, list: [category] } });
      }
      if (url.pathname === '/api/items') {
        return response(200, { data: { list: [item], total: 1, total_pages: 1 } });
      }
      if (url.pathname === '/api/items/search') {
        return response(200, { data: { total: 1, list: [item] } });
      }
      return response(200, { data: [] });
    },
  });

  const tools = [];
  const context = {
    tool: {
      async transform(callback) {
        callback({ add: (tool) => tools.push(tool), list: () => tools });
        return { dispose: async () => {} };
      },
    },
  };
  const dispose = await plugin.setup(context);
  assert.equal(typeof dispose, 'function');
  assert.deepEqual(tools.map((tool) => tool.name), [
    'posnic_search_products',
    'posnic_list_products',
    'posnic_list_categories',
    'posnic_help',
    'posnic_recall',
    'posnic_ask_user',
    'posnic_user_profile',
    'posnic_update_user_profile',
    'posnic_propose_plan',
  ]);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  const result = await byName.posnic_search_products.execute(
    { query: 'pepsi' },
    { sessionID: 'session-1' },
  );
  assert.equal(requests[0].url, 'http://127.0.0.1:5555/api/items/search?q=pepsi&limit=8');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer jwt-session');
  assert.equal(requests[0].init.headers['X-Branch-Id'], 'branch-9');
  assert.equal(result.metadata.posnic.count, 1);
  assert.equal(result.metadata.posnic.results[0].name, 'Pepsi 1L');
  assert.match(result.content[0].text, /Pepsi 1L/);

  const anonymous = await byName.posnic_search_products.execute(
    { query: 'pepsi' },
    { sessionID: 'missing' },
  );
  assert.equal(anonymous.metadata.posnic.code, 'auth_required');

  const listResult = await byName.posnic_list_products.execute({}, { sessionID: 'session-1' });
  const listRequest = requests.find((entry) => entry.pathname === '/api/items');
  assert.ok(listRequest, 'the all-products list did not use the item list route');
  assert.match(listRequest.search, /limit=20/);
  assert.match(listRequest.search, /page=1/);
  assert.match(listRequest.search, /sort=name/);
  assert.equal(listResult.metadata.posnic.kind, 'product_list');
  assert.equal(listResult.metadata.posnic.count, 1);
  assert.equal(listResult.metadata.posnic.total, 1);
  assert.match(listResult.content[0].text, /Pepsi 1L/);

  const categoryResult = await byName.posnic_list_categories.execute(
    {},
    { sessionID: 'session-1' },
  );
  const categoryRequest = requests.find(
    (entry) => entry.pathname === '/api/categories' && entry.search.includes('limit=20'),
  );
  assert.ok(categoryRequest);
  assert.equal(categoryRequest.init.headers['X-Branch-Id'], 'branch-9');
  assert.equal(categoryResult.metadata.posnic.kind, 'category_list');
  assert.equal(categoryResult.metadata.posnic.categories[0].name, 'Drinks');
  assert.equal(categoryResult.metadata.posnic.categories[0].itemCount, 12);
  assert.match(categoryResult.content[0].text, /Drinks/);

  const helpResult = await byName.posnic_help.execute(
    { query: 'add a product' },
    { sessionID: 'session-1' },
  );
  assert.equal(helpResult.metadata.posnic.kind, 'help');
  assert.match(helpResult.content[0].text, /Inventory → Items/);

  const clarify = await byName.posnic_ask_user.execute({
    question: 'Which unit?',
    options: [
      { label: 'Piece', value: 'piece' },
      { label: 'Kilogram', value: 'kilogram' },
    ],
  }, { sessionID: 'session-1' });
  assert.equal(clarify.metadata.posnic.kind, 'clarify');
  assert.equal(clarify.metadata.posnic.question, 'Which unit?');
  assert.deepEqual(clarify.metadata.posnic.options, [
    { label: 'Piece', value: 'piece' },
    { label: 'Kilogram', value: 'kilogram' },
  ]);
  assert.match(clarify.content[0].text, /already visible/);

  const namedCategory = await byName.posnic_ask_user.execute({
    question: 'أي فئة تريد للمنتج؟',
    options: [
      { label: 'احذية', value: 'existing' },
      { label: 'إنشاء فئة جديدة', value: 'new' },
    ],
    missing: ['category'],
  }, { sessionID: 'session-1' });
  assert.equal(namedCategory.metadata.posnic.kind, 'error');
  assert.equal(namedCategory.metadata.posnic.code, 'category_already_given');
  assert.equal(namedCategory.metadata.posnic.internal, true);
  assert.match(namedCategory.metadata.posnic.message, /الاحزايا/);

  const planResult = await byName.posnic_propose_plan.execute({
    title: 'Add a category',
    steps: [{
      id: 'cat1',
      action: 'create_category',
      fields: { name: 'New Cat', description: 'A new category' },
    }],
  }, { sessionID: 'session-1' });
  assert.equal(planResult.metadata.posnic.kind, 'write_plan');
  assert.equal(planResult.metadata.posnic.plan.status, 'pending');
  assert.equal(planResult.metadata.posnic.plan.conversationId, 'conv-1');
  assert.equal(planResult.metadata.posnic.plan.steps[0].fields.name, 'New Cat');
  const stored = planStore.get(planResult.metadata.posnic.plan.id);
  assert.equal(stored.ok, true);
  assert.match(planResult.content[0].text, /Nothing has been saved/);

  const emptyProfile = await byName.posnic_user_profile.execute(
    {},
    { sessionID: 'session-1' },
  );
  assert.equal(emptyProfile.metadata.posnic.kind, 'user_profile');
  assert.equal(emptyProfile.metadata.posnic.exists, false);

  const saved = await byName.posnic_update_user_profile.execute({
    section: 'preferences',
    note: 'Prefers short answers with price and stock on one line.',
  }, { sessionID: 'session-1' });
  assert.equal(saved.metadata.posnic.kind, 'profile_saved');
  assert.equal(saved.metadata.posnic.added, true);
  assert.equal(saved.metadata.posnic.duplicate, false);

  const duplicate = await byName.posnic_update_user_profile.execute({
    section: 'preferences',
    note: 'Prefers short answers with price and stock on one line.',
  }, { sessionID: 'session-1' });
  assert.equal(duplicate.metadata.posnic.duplicate, true);

  const savedProfile = await byName.posnic_user_profile.execute(
    {},
    { sessionID: 'session-1' },
  );
  assert.equal(savedProfile.metadata.posnic.exists, true);
  assert.match(savedProfile.content[0].text, /Prefers short answers/);

  const rejected = await byName.posnic_update_user_profile.execute({
    section: 'preferences',
    note: 'Call the owner on 01012345678',
  }, { sessionID: 'session-1' });
  assert.equal(rejected.metadata.posnic.code, 'sensitive_note');

  const anonymousProfile = await byName.posnic_user_profile.execute(
    {},
    { sessionID: 'missing' },
  );
  assert.equal(anonymousProfile.metadata.posnic.code, 'auth_required');

  await dispose();
});

test('assistant messages expose completed and failed tool parts', () => {
  const { messageTools } = require(path.join(ROOT, 'src/ai/opencode-runtime'));
  const calls = messageTools({
    content: [
      { type: 'text', text: 'Hello' },
      {
        type: 'tool',
        id: 'tool-1',
        name: 'posnic_help',
        state: {
          status: 'completed',
          input: { query: 'add a product' },
          metadata: { posnic: { kind: 'help' } },
          content: [{ type: 'text', text: 'ok' }],
        },
      },
      {
        type: 'tool',
        id: 'tool-2',
        name: 'posnic_search_products',
        state: { status: 'error', error: { message: 'boom' } },
      },
    ],
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'posnic_help');
  assert.deepEqual(calls[0].input, { query: 'add a product' });
  assert.deepEqual(calls[0].metadata, { posnic: { kind: 'help' } });
  assert.equal(calls[1].error.message, 'boom');
  assert.deepEqual(messageTools(null), []);
});

test('chat forwards the session token and active branch without returning them', async (t) => {
  const h = setup(t);
  await h.handlers.get('ai:save-key')({}, KEY);
  await h.handlers.get('ai:save-provider-key')({}, { provider: 'groq', key: PROVIDER_KEY });
  const enabled = await h.handlers.get('ai:set-enabled')({}, true);
  assert.equal(enabled.success, true);

  const result = await h.handlers.get('ai:chat')({}, {
    message: 'Show me Pepsi',
    authToken: 'jwt-session',
    branchId: 'branch-9',
    username: 'admin',
  });
  assert.equal(result.success, true);
  const chat = h.runtime.calls.find((call) => call.type === 'chat');
  assert.equal(chat.payload.authToken, 'jwt-session');
  assert.equal(chat.payload.branchId, 'branch-9');
  assert.equal(chat.payload.username, 'admin');
  assert.equal(JSON.stringify(result).includes('jwt-session'), false);

  const tooLong = await h.handlers.get('ai:chat')({}, {
    message: 'hi',
    authToken: 'x'.repeat(4097),
  });
  assert.equal(tooLong.code, 'auth_invalid');

  const badBranch = await h.handlers.get('ai:chat')({}, {
    message: 'hi',
    branchId: 'x'.repeat(81),
  });
  assert.equal(badBranch.code, 'branch_invalid');

  const badUser = await h.handlers.get('ai:chat')({}, {
    message: 'hi',
    username: 'x'.repeat(121),
  });
  assert.equal(badUser.code, 'user_invalid');
});

test('the model receives only the shop and local-note tools and the reference index', () => {
  const registry = require(path.join(ROOT, 'src/ai/provider-registry'));
  const config = registry.runtimeConfig({
    providerID: 'groq',
    modelID: 'openai/gpt-oss-120b',
  });
  const agent = config.agents['posnic-assistant'];

  assert.equal(agent.steps, 8);
  assert.match(agent.system, /Built-in reference topics/);
  assert.match(agent.system, /Add a product/);
  assert.match(agent.system, /Never ask the user to type a record id/);
  const allowed = agent.permissions
    .filter((permission) => permission.effect === 'allow')
    .map((permission) => permission.action)
    .sort();
  assert.deepEqual(allowed, [
    'posnic_ask_user',
    'posnic_help',
    'posnic_list_categories',
    'posnic_list_products',
    'posnic_propose_plan',
    'posnic_recall',
    'posnic_search_products',
    'posnic_update_user_profile',
    'posnic_user_profile',
    'provider.use',
  ]);
  assert.equal(
    config.providers.groq.models['openai/gpt-oss-120b'].capabilities.tools,
    true,
  );
});

test('conversation memory keeps topics, deduplicates points and recalls earlier subjects', () => {
  const { createConversationMemoryStore } = require(path.join(ROOT, 'src/ai/conversation-memory'));
  let clock = 1000;
  const memory = createConversationMemoryStore({ now: () => clock });
  const conversation = 'conv-memory';

  const first = memory.beginTurn(conversation, 'Show me the price of Pepsi 1L');
  assert.equal(first.switched, true);
  memory.completeTurn(conversation, 'Pepsi 1L is 25.00 with 12 in stock.', [{
    metadata: {
      posnic: {
        kind: 'product_search',
        results: [{ id: 'item-1', name: 'Pepsi 1L', sellingPrice: 25, stock: 12 }],
      },
    },
  }]);

  const second = memory.beginTurn(conversation, 'change the price to 30');
  assert.equal(second.switched, false);
  assert.equal(second.reason, 'follow-up');

  memory.beginTurn(conversation, 'change the price to 30');
  const snapshot = memory.snapshot(conversation);
  const active = snapshot.topics.find((topic) => topic.id === snapshot.activeTopicId);
  assert.equal(
    active.points.filter((point) => point === 'change the price to 30').length,
    1,
  );

  const switched = memory.beginTurn(conversation, 'new topic: how do I add a product?');
  assert.equal(switched.switched, true);
  assert.notEqual(switched.topicId, second.topicId);

  const recalled = memory.recall(conversation, 'Pepsi price', 4);
  assert.equal(recalled.kind, 'conversation_recall');
  assert.ok(recalled.topics.some((topic) =>
    /Pepsi/.test(topic.title) || topic.products.some((product) => product.name === 'Pepsi 1L')));

  const resumed = memory.beginTurn(conversation, 'back to Pepsi, what was the price?');
  assert.equal(resumed.switched, true);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.topicId, first.topicId);

  const block = memory.contextFor(conversation, {
    full: true,
    message: 'back to Pepsi, what was the price?',
  });
  assert.match(block, /\[Conversation memory\]/);
  assert.match(block, /Pepsi 1L/);
  assert.match(block, /Earlier topics/);
  assert.match(block, /price 25/);
  assert.ok(block.length <= 6000);
});

test('conversation memory keeps an unfinished create request across short answers', () => {
  const { createConversationMemoryStore } = require(path.join(ROOT, 'src/ai/conversation-memory'));
  let clock = 1000;
  const memory = createConversationMemoryStore({ now: () => clock++ });
  const conversation = 'conv-pending-request';

  const first = memory.beginTurn(
    conversation,
    'ضيف برودكت جزمة حمرى في فئة الاحزايا وخلي الكمية بتاعتها خمسين واحدة',
  );
  assert.equal(first.pendingAnswer, false);
  assert.equal(first.writeRequest, true);
  memory.completeTurn(conversation, 'إيه سعر البيع والتكلفة؟', [{
    metadata: {
      posnic: {
        kind: 'clarify',
        question: 'إيه سعر البيع والتكلفة؟',
        options: [],
        pending: 'إنشاء منتج جزمة حمراء في فئة الأحذية; الكمية 50; missing: selling price, cost price',
        missing: ['selling price', 'cost price'],
      },
    },
  }]);

  const pending = memory.pendingRequest(conversation);
  assert.ok(pending);
  assert.equal(pending.asked, true);
  assert.match(pending.note, /selling price/);
  assert.match(pending.question, /سعر البيع/);

  const answered = memory.beginTurn(conversation, 'البيع 100 والتكلفة 60');
  assert.equal(answered.pendingAnswer, true);
  assert.equal(answered.writeRequest, false);
  assert.equal(answered.switched, false);
  const block = memory.contextFor(conversation, {
    full: true,
    message: 'البيع 100 والتكلفة 60',
  });
  assert.match(block, /Unfinished request/);
  assert.match(block, /جزمة حمرى/);
  assert.match(block, /Already answered/);
  assert.match(block, /البيع 100/);

  memory.beginTurn(conversation, 'مش مهم');
  const snapshot = memory.snapshot(conversation);
  const active = snapshot.topics.find((topic) => topic.id === snapshot.activeTopicId);
  assert.equal(active.corrections.some((item) => item.text === 'مش مهم'), false);
  const afterSkip = memory.contextFor(conversation, { full: true, message: 'مش مهم' });
  assert.match(afterSkip, /Unfinished request/);

  memory.completeTurn(conversation, 'تم تجهيز المعاينة.', [{
    metadata: {
      posnic: {
        kind: 'write_plan',
        plan: {
          id: 'plan_blue',
          status: 'pending',
          steps: [{
            id: 'p1',
            action: 'create_product',
            label: 'Create product',
            fields: { name: 'جزمة زرقاء' },
          }],
        },
      },
    },
  }]);
  assert.equal(memory.pendingRequest(conversation), null);
});

test('an answered category is kept for the next product and is never asked again', () => {
  const { createConversationMemoryStore } = require(path.join(ROOT, 'src/ai/conversation-memory'));
  const memory = createConversationMemoryStore({ now: () => 1000 });
  const conversation = 'conv-category-carry';

  memory.beginTurn(conversation, 'ضيف منتج غسالة');
  memory.completeTurn(conversation, 'أي فئة تريد للمنتج؟', [{
    metadata: {
      posnic: {
        kind: 'clarify',
        question: 'أي فئة تريد للمنتج؟',
        options: [],
        pending: 'إنشاء منتج غسالة; missing: category, selling price',
        missing: ['category', 'selling price'],
      },
    },
  }]);
  const before = memory.pendingRequest(conversation);
  assert.match(before.note, /missing: category/);
  assert.equal(before.answers.length, 0);

  const answered = memory.beginTurn(conversation, 'غسالات');
  assert.equal(answered.pendingAnswer, true);
  const after = memory.pendingRequest(conversation);
  assert.equal(after.note, '', 'the stale draft note is dropped after the answer');
  assert.equal(after.category.name, 'غسالات');
  assert.equal(after.answers.at(-1).answer, 'غسالات');

  const block = memory.contextFor(conversation, { full: false, message: 'غسالات' });
  assert.match(block, /Current category: غسالات/);
  assert.match(block, /غسالات/);

  const nextProduct = memory.beginTurn(conversation, 'ضيف منتج تاني');
  assert.equal(nextProduct.switched, false, 'the current category keeps the next product in the same topic');
  assert.equal(nextProduct.writeRequest, true);
  assert.equal(memory.pendingRequest(conversation).category.name, 'غسالات');
});

test('a category created by a plan becomes the current category', () => {
  const { createConversationMemoryStore } = require(path.join(ROOT, 'src/ai/conversation-memory'));
  const memory = createConversationMemoryStore({ now: () => 1000 });
  const conversation = 'conv-plan-category';

  memory.beginTurn(conversation, 'ضيف منتج غسالة في فئة غسالات');
  memory.completeTurn(conversation, 'راجع المعاينة.', [{
    metadata: {
      posnic: {
        kind: 'write_plan',
        plan: {
          id: 'plan-cat',
          status: 'pending',
          steps: [
            {
              id: 'c1',
              action: 'create_category',
              label: 'Create category',
              fields: { name: 'غسالات' },
              resultId: 'cat-1',
              resultName: 'غسالات',
            },
            {
              id: 'p1',
              action: 'create_product',
              label: 'Create product',
              fields: { name: 'غسالة سامسونج', category_id: 'cat-1', category_name: 'غسالات' },
            },
          ],
        },
      },
    },
  }]);

  assert.equal(memory.pendingRequest(conversation), null);
  const block = memory.contextFor(conversation, { full: false, message: 'ضيف منتج تاني' });
  assert.match(block, /Current category: غسالات/);
  assert.match(block, /id cat-1/);
  const nextProduct = memory.beginTurn(conversation, 'ضيف منتج تاني');
  assert.equal(nextProduct.switched, false);
});

test('a new write request replaces the pending draft while a short answer keeps it', () => {
  const { createConversationMemoryStore } = require(path.join(ROOT, 'src/ai/conversation-memory'));
  const memory = createConversationMemoryStore({ now: () => 1000 });
  const conversation = 'conv-two-products';

  const red = 'ضيف برودكت جزمة حمرى في فئة الاحزايا وخلي الكمية خمسين';
  const first = memory.beginTurn(conversation, red);
  assert.equal(first.writeRequest, true);
  assert.equal(memory.pendingRequest(conversation).text, red);
  memory.completeTurn(conversation, '', []);

  const blue = 'ضيف حزمة زرقاء لنفس الفئة';
  const second = memory.beginTurn(conversation, blue);
  assert.equal(second.writeRequest, true);
  assert.equal(second.pendingAnswer, false);
  assert.equal(memory.pendingRequest(conversation).text, blue);
  memory.completeTurn(conversation, '', []);

  const answer = memory.beginTurn(conversation, 'سعر البيع 500 والتكلفة 100');
  assert.equal(answer.writeRequest, false);
  assert.equal(answer.pendingAnswer, true);
  assert.equal(memory.pendingRequest(conversation).text, blue);
});

test('the recall tool searches only this conversation memory', async () => {
  const { createContextStore } = require(path.join(ROOT, 'src/ai/tools/context'));
  const { createPosnicToolPlugin } = require(path.join(ROOT, 'src/ai/tools/plugin'));
  const { createConversationMemoryStore } = require(path.join(ROOT, 'src/ai/conversation-memory'));

  const store = createContextStore();
  store.set('session-recall', {
    apiBaseUrl: 'http://127.0.0.1:5555',
    token: 'jwt-session',
    branchId: 'branch-9',
    username: 'admin',
    conversationId: 'conv-recall',
  });

  const memory = createConversationMemoryStore();
  memory.beginTurn('conv-recall', 'Show me Pepsi');
  memory.completeTurn('conv-recall', 'Pepsi 1L is 25.00.', [{
    metadata: {
      posnic: {
        kind: 'product_search',
        results: [{ id: 'item-1', name: 'Pepsi 1L', sellingPrice: 25, stock: 12 }],
      },
    },
  }]);

  const plugin = createPosnicToolPlugin({
    store,
    memory,
    planStore: { add: () => {} },
    attachments: { describe: () => ({ ok: true, attachments: [] }) },
    logger: () => {},
  });
  const tools = [];
  const context = {
    tool: {
      async transform(callback) {
        callback({ add: (tool) => tools.push(tool), list: () => tools });
        return { dispose: async () => {} };
      },
    },
  };
  await plugin.setup(context);
  const recall = tools.find((tool) => tool.name === 'posnic_recall');
  assert.ok(recall);

  const result = await recall.execute({ query: 'Pepsi' }, { sessionID: 'session-recall' });
  assert.equal(result.metadata.posnic.kind, 'conversation_recall');
  assert.equal(result.metadata.posnic.topics.length, 1);
  assert.match(result.content[0].text, /Pepsi 1L/);
  assert.match(result.content[0].text, /price 25/);

  const otherConversation = await recall.execute(
    { query: 'Pepsi' },
    { sessionID: 'missing-session' },
  );
  assert.equal(otherConversation.metadata.posnic.kind, 'conversation_recall');
  assert.deepEqual(otherConversation.metadata.posnic.topics, []);
});

test('the runtime separates topics, keeps memory and recovers from a provider error', async (t) => {
  let failOnce = false;
  const h = await createRuntimeHarness(t, {
    promptHook: ({ text }) => {
      if (failOnce && /what about Pepsi/.test(text)) {
        failOnce = false;
        return { throw: 'context length exceeded' };
      }
      return { reply: 'Done.' };
    },
  });
  const base = {
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
    conversationId: 'conv-runtime',
  };

  const first = await h.runtime.chat({ ...base, message: 'Show me Pepsi' });
  assert.equal(first.success, true);
  assert.equal(h.state.sessionCount, 1);
  assert.match(h.state.prompts[0].text, /\[Conversation memory\]/);
  assert.match(h.state.prompts[0].text, /Show me Pepsi/);

  failOnce = true;
  const second = await h.runtime.chat({ ...base, message: 'what about Pepsi?' });
  assert.equal(second.success, true);
  assert.equal(second.memory.recovered, true);
  assert.equal(h.state.sessionCount, 2);
  assert.equal(h.state.removeCalls, 1);
  assert.match(h.state.prompts[2].text, /\[Conversation memory\]/);
  assert.match(h.state.prompts[2].text, /Show me Pepsi/);

  const third = await h.runtime.chat({
    ...base,
    message: 'new topic: how do I add a product?',
  });
  assert.equal(third.success, true);
  assert.equal(third.memory.switched, true);
  assert.equal(h.state.sessionCount, 3);
  assert.match(h.state.prompts[3].text, /Earlier topics/);
});

test('a continuing session still receives the compact memory and current category', async (t) => {
  let planCount = 0;
  const h = await createRuntimeHarness(t, {
    promptHook: () => {
      planCount += 1;
      return {
        reply: 'راجع المعاينة.',
        tools: [{
          name: 'posnic_propose_plan',
          metadata: { posnic: {
            kind: 'write_plan',
            plan: {
              id: `plan-${planCount}`,
              status: 'pending',
              title: 'Add product',
              steps: planCount === 1
                ? [{
                  id: 'c1',
                  action: 'create_category',
                  label: 'Create category',
                  fields: { name: 'غسالات' },
                  resultId: 'cat-1',
                  resultName: 'غسالات',
                }]
                : [{
                  id: 'p1',
                  action: 'create_product',
                  label: 'Create product',
                  fields: { name: 'غسالة تانية', selling_price: 100, company_price: 70 },
                }],
            },
          } },
        }],
      };
    },
  });
  const base = {
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
    conversationId: 'conv-context-every-turn',
  };

  const first = await h.runtime.chat({ ...base, message: 'ضيف منتج غسالة في فئة غسالات' });
  assert.equal(first.success, true);
  assert.equal(first.memory.switched, true);

  const second = await h.runtime.chat({ ...base, message: 'ضيف منتج تاني' });
  assert.equal(second.success, true);
  assert.equal(second.memory.switched, false);
  assert.equal(h.state.sessionCount, 1, 'the current category keeps the follow-up in one session');
  assert.equal(h.state.prompts.length, 2);
  assert.match(h.state.prompts[1].text, /\[Conversation memory\]/);
  assert.match(h.state.prompts[1].text, /Current category: غسالات/);
});

test('a provider rate limit keeps its retry time and does not restart the session', async (t) => {
  const h = await createRuntimeHarness(t, {
    promptHook: ({ index }) => ({
      error: {
        type: 'provider.rate-limit',
        message: 'Rate limit reached for model. Please try again in 11m1.392s.',
        status: 429,
        ...(index === 0 ? { retryAfterMs: 662000 } : {}),
      },
    }),
  });
  const base = {
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
  };

  await assert.rejects(
    () => h.runtime.chat({
      ...base,
      conversationId: 'conv-rate-limit',
      message: 'أريد أن أضيف تلاجة',
    }),
    (error) => {
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.retryAfterMs, 662000);
      return true;
    },
  );
  assert.equal(h.state.sessionCount, 1);
  assert.equal(h.state.removeCalls, 0);

  await assert.rejects(
    () => h.runtime.chat({
      ...base,
      conversationId: 'conv-rate-limit',
      message: 'أريد أن أضيف تلاجة',
    }),
    (error) => {
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.retryAfterMs, 661392);
      return true;
    },
  );
  assert.equal(h.state.sessionCount, 1);
  assert.equal(h.state.removeCalls, 0);
  assert.equal(
    h.logs.filter((line) => /\[AI provider\] rate_limited status=429/.test(line)).length,
    2,
  );
});

test('a quota failure retries once with the backup provider token', async (t) => {
  const h = await createRuntimeHarness(t, {
    providerKeys: {
      'provider:groq': 'primary-token',
      'provider:groq:2': 'backup-token',
    },
    promptHook: ({ index }) => {
      if (index === 0) {
        return { error: {
          type: 'provider.rate-limit',
          message: 'Rate limit reached. Please try again in 60s.',
          status: 429,
          retryAfterMs: 60000,
        } };
      }
      return { reply: '', tools: [{
        name: 'posnic_ask_user',
        metadata: { posnic: {
          kind: 'clarify',
          question: 'ما سعر البيع؟',
          options: [],
          pending: 'إنشاء منتج تلاجة بنسونيك 14 قدم; missing: selling price',
          missing: ['selling price'],
        } },
      }] };
    },
  });

  const result = await h.runtime.chat({
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
    conversationId: 'conv-token-rotation',
    message: 'أريد أن أضيف تلاجة بنسونيك 14 أدم',
  });

  assert.equal(result.success, true);
  assert.equal(h.runtime.activeToken('groq'), 'backup');
  assert.equal(h.state.sessionCount, 2);
  assert.equal(h.state.removeCalls, 1);
  assert.equal(h.state.prompts.length, 2);
  assert.match(h.state.prompts[1].text, /\[Conversation memory\]/);
  assert.match(h.state.prompts[1].text, /تلاجة بنسونيك/);
  assert.ok(h.logs.some((line) =>
    /\[AI auth\] rate limited; retrying with the backup provider token/.test(line)));
});

test('a quota failure on the backup token stops instead of looping', async (t) => {
  const h = await createRuntimeHarness(t, {
    providerKeys: {
      'provider:groq': 'primary-token',
      'provider:groq:2': 'backup-token',
    },
    promptHook: ({ index }) => ({
      error: {
        type: 'provider.rate-limit',
        message: 'Rate limit reached. Please try again in 60s.',
        status: 429,
        ...(index === 0 ? { retryAfterMs: 60000 } : {}),
      },
    }),
  });

  await assert.rejects(
    () => h.runtime.chat({
      authToken: 'jwt-session',
      branchId: 'branch-1',
      username: 'admin',
      conversationId: 'conv-token-rotation-fails',
      message: 'أريد أن أضيف تلاجة',
    }),
    (error) => {
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.retryAfterMs, 60000);
      return true;
    },
  );

  assert.equal(h.runtime.activeToken('groq'), 'backup');
  assert.equal(h.state.sessionCount, 2);
  assert.equal(h.state.removeCalls, 1);
  assert.equal(h.state.prompts.length, 2);
});

test('an exact product duplicate becomes an update question without another model call', async (t) => {
  const name = 'تلاجة بنسونيك 14 أدم';
  const h = await createRuntimeHarness(t, {
    promptHook: () => ({
      reply: 'المنتج موجود بالفعل. هل تريد تعديل السعر أو المخزون؟',
      tools: [{
        name: 'posnic_search_products',
        input: { query: name, limit: 8 },
        metadata: { posnic: {
          kind: 'product_search',
          query: name,
          count: 1,
          results: [{
            id: 'item-duplicate',
            name,
            category: '',
            sellingPrice: 22000,
            costPrice: 19000,
            stock: 2,
            trackInventory: true,
            unit: 'pcs',
          }],
        } },
      }],
    }),
  });

  const result = await h.runtime.chat({
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
    conversationId: 'conv-duplicate',
    message: 'أريد أن أضيف تلاجة بنسونيك 14 أدم',
  });

  assert.equal(result.success, true);
  assert.equal(h.state.prompts.length, 1);
  assert.equal(h.state.sessionCount, 1);
  assert.equal(result.text, '');

  const clarify = result.toolCalls.find((call) => call.name === 'posnic_ask_user');
  assert.ok(clarify, 'a clarification card is returned');
  const payload = clarify.metadata.posnic;
  assert.equal(payload.kind, 'clarify');
  assert.match(payload.question, /موجود بالفعل/);
  assert.match(payload.question, /تعديل السعر/);
  assert.match(payload.question, /٢٢٠٠٠/);
  assert.match(payload.pending, /٢٢٠٠٠/);
  assert.deepEqual(
    payload.options.map((option) => option.value),
    ['تعديل السعر', 'تعديل التكلفة', 'تعديل المخزون', 'إلغاء'],
  );
});

test('a provider or model change is applied to the runtime before it restarts', async (t) => {
  const h = await createRuntimeHarness(t);
  await h.runtime.start();

  h.runtime.updateSettings({ provider: 'groq', model: 'openai/gpt-oss-20b' });
  assert.equal(h.runtime.status().model, 'openai/gpt-oss-20b');

  await h.runtime.restart();
  assert.equal(h.runtime.status().model, 'openai/gpt-oss-20b');

  const config = JSON.parse(fs.readFileSync(
    path.join(h.dir, 'opencode', 'config', 'opencode.json'),
    'utf8',
  ));
  assert.equal(config.agents['posnic-assistant'].model, 'groq/openai/gpt-oss-20b');
});

test('the runtime hides an internal correction while the model retries', async (t) => {
  const h = await createRuntimeHarness(t, {
    promptHook: () => ({
      reply: 'أحتاج سعر البيع.',
      tools: [
        {
          name: 'posnic_ask_user',
          metadata: {
            posnic: {
              kind: 'error',
              code: 'category_already_given',
              internal: true,
              message: 'Use the category the request already names.',
            },
          },
        },
        {
          name: 'posnic_ask_user',
          metadata: {
            posnic: {
              kind: 'clarify',
              question: 'ما سعر البيع؟',
              options: [],
              missing: ['selling price'],
            },
          },
        },
      ],
    }),
  });

  const reply = await h.runtime.chat({
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
    conversationId: 'conv-internal',
    message: 'ضيف جزمة حمراء في فئة الاحزايا',
  });
  assert.equal(reply.success, true);
  assert.equal(reply.toolCalls.length, 1);
  assert.equal(reply.toolCalls[0].metadata.posnic.kind, 'clarify');
});

test('the runtime continues a first write request after a search-only reply', async (t) => {
  const h = await createRuntimeHarness(t, {
    promptHook: ({ text }) => {
      if (/\[Correction from Posnic\]/.test(text)) {
        return {
          reply: 'أحتاج سعر البيع والتكلفة.',
          tools: [{
            name: 'posnic_ask_user',
            metadata: {
              posnic: {
                kind: 'clarify',
                question: 'ما سعر البيع وسعر التكلفة؟',
                options: [],
                missing: ['selling price', 'cost price'],
              },
            },
          }],
        };
      }
      return {
        reply: '',
        tools: [{
          name: 'posnic_search_products',
          metadata: { posnic: { kind: 'product_search', count: 0, total: 0 } },
        }],
      };
    },
  });

  const reply = await h.runtime.chat({
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
    conversationId: 'conv-write-correction',
    message: 'ضيف برودكت جزمة حمرى في فئة الاحزايا وخلي الكمية خمسين',
  });

  assert.equal(reply.success, true);
  assert.equal(h.state.prompts.length, 2);
  assert.match(h.state.prompts[1].text, /Correction from Posnic/);
  assert.match(h.state.prompts[1].text, /Do not search again/);
  assert.equal(reply.toolCalls.length, 1);
  assert.equal(reply.toolCalls[0].metadata.posnic.kind, 'clarify');
});

test('a failed write continuation is reported instead of showing the discarded search', async (t) => {
  let corrections = 0;
  const h = await createRuntimeHarness(t, {
    promptHook: ({ text }) => {
      if (/\[Correction from Posnic\]/.test(text)) {
        corrections += 1;
        return { throw: 'provider temporarily unavailable' };
      }
      return {
        reply: '',
        tools: [{
          name: 'posnic_search_products',
          metadata: { posnic: { kind: 'product_search', count: 0, total: 0 } },
        }],
      };
    },
  });

  await assert.rejects(
    () => h.runtime.chat({
      authToken: 'jwt-session',
      branchId: 'branch-1',
      username: 'admin',
      conversationId: 'conv-write-failure',
      message: 'ضيف جزمة حمراء في فئة احذية',
    }),
    (error) => {
      assert.equal(error.code, 'provider_error');
      assert.match(error.message, /provider temporarily unavailable/);
      return true;
    },
  );
  assert.equal(corrections, 1);
});

test('the runtime keeps a pending create request across a restart and a short answer', async (t) => {
  const h = await createRuntimeHarness(t, {
    promptHook: ({ text }) => {
      if (/\[Correction from Posnic\]/.test(text)) {
        return {
          reply: 'راجع المعاينة.',
          tools: [{
            name: 'posnic_propose_plan',
            metadata: {
              posnic: {
                kind: 'write_plan',
                plan: {
                  id: 'plan_blue',
                  status: 'pending',
                  steps: [{
                    id: 'p1',
                    action: 'create_product',
                    label: 'Create product',
                    fields: { name: 'جزمة زرقاء', selling_price: 100, cost_price: 60, opening_stock: 5 },
                  }],
                },
              },
            },
          }],
        };
      }
      if (text.trim().endsWith('مش مهم')) {
        return {
          reply: 'لقيت نتائج.',
          tools: [{
            name: 'posnic_search_products',
            metadata: { posnic: { kind: 'product_search', results: [] } },
          }],
        };
      }
      if (/ضيف برودكت/.test(text)) {
        return {
          reply: 'إيه سعر البيع والتكلفة؟',
          tools: [{
            name: 'posnic_ask_user',
            metadata: {
              posnic: {
                kind: 'clarify',
                question: 'إيه سعر البيع والتكلفة؟',
                options: [],
                pending: 'إنشاء منتج جزمة زرقاء في فئة الأحذية; missing: selling price, cost price',
                missing: ['selling price', 'cost price'],
              },
            },
          }],
        };
      }
      return { reply: 'تم.' };
    },
  });
  const base = {
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
    conversationId: 'conv-pending-runtime',
  };

  const first = await h.runtime.chat({
    ...base,
    message: 'ضيف برودكت جزمة زرقاء في فئة الاحزايا',
  });
  assert.equal(first.success, true);

  /* A provider or model switch restarts the runtime. The unfinished request
     belongs to the conversation, so it must survive the new session. */
  await h.runtime.restart();

  const second = await h.runtime.chat({ ...base, message: 'مش مهم' });
  assert.equal(second.success, true);
  assert.equal(second.text, 'راجع المعاينة.');
  assert.ok(second.toolCalls.some((call) => call.name === 'posnic_propose_plan'));
  assert.equal(h.state.prompts.length, 3);
  assert.match(h.state.prompts[2].text, /\[Correction from Posnic\]/);
  assert.match(h.state.prompts[2].text, /Original request: ضيف برودكت/);
  assert.match(h.state.prompts[2].text, /The user answered: مش مهم/);
  assert.match(h.state.prompts[2].text, /Never use 0 for a price or cost/);
});

test('a slow model still delivers a plan it already prepared', async (t) => {
  const h = await createRuntimeHarness(t, {
    chatTimeoutMs: 60,
    waitHook: () => new Promise(() => {}),
    promptHook: () => ({
      reply: '',
      tools: [{
        name: 'posnic_propose_plan',
        metadata: {
          posnic: {
            kind: 'write_plan',
            plan: {
              id: 'plan_slow',
              status: 'pending',
              steps: [{
                id: 'p1',
                action: 'create_product',
                label: 'Create product',
                fields: {
                  name: 'جزمة حمراء',
                  selling_price: 500,
                  cost_price: 100,
                  opening_stock: 50,
                },
              }],
            },
          },
        },
      }],
    }),
  });

  const started = Date.now();
  const result = await h.runtime.chat({
    message: 'ضيف جزمة حمراء',
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
    conversationId: 'conv-slow-plan',
  });

  assert.equal(result.success, true);
  assert.ok(result.toolCalls.some((call) => call.name === 'posnic_propose_plan'));
  assert.ok(Date.now() - started < 2000);
});

test('assistant replies use the requested currency wording, never the rupee sign', async (t) => {
  const { currencyInstruction, normalizeCurrencyText } = require('../src/ai/currency');

  assert.equal(
    normalizeCurrencyText('السعر ₹ 200 وليس 200 جنيه'),
    'السعر $ 200 وليس 200 جنية',
  );
  assert.equal(currencyInstruction('₹'), currencyInstruction('$'));
  assert.match(currencyInstruction(''), /"\$ 200"/);

  const h = await createRuntimeHarness(t, {
    promptHook: () => ({ reply: 'السعر ₹ 200، والكلمة 200 جنيه.' }),
  });
  const result = await h.runtime.chat({
    message: 'بكام الجزمة؟',
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
    conversationId: 'conv-currency',
  });

  assert.equal(result.success, true);
  assert.match(result.text, /\$ 200/);
  assert.match(result.text, /جنية/);
  assert.doesNotMatch(result.text, /₹|جنيه/);
  assert.match(h.state.prompts[0].text, /The shop currency symbol is "\$"/);
  assert.match(h.state.prompts[0].text, /Never use "₹" or "جنيه"/);
});

test('a new conversation does not carry the previous conversation context', async (t) => {
  const h = await createRuntimeHarness(t);
  const base = {
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
  };

  const first = await h.runtime.chat({
    ...base,
    message: 'Create a category called TestCat1125 and a product TestWidget1125 in it',
    conversationId: 'conv-before-reset',
  });
  assert.equal(first.success, true);
  assert.equal(h.state.sessionCount, 1);

  await h.runtime.resetChat({ conversationId: 'conv-before-reset' });
  assert.equal(h.state.removeCalls, 1);

  const next = await h.runtime.chat({
    ...base,
    message: 'hello',
    conversationId: 'conv-after-reset',
  });
  assert.equal(next.success, true);
  assert.equal(h.state.sessionCount, 2);

  const freshPrompt = h.state.prompts[h.state.prompts.length - 1].text;
  assert.doesNotMatch(freshPrompt, /TestCat1125|TestWidget1125|conv-before-reset/);
});

test('the runtime compacts when real token usage reaches the context window', async (t) => {
  const h = await createRuntimeHarness(t, {
    tokenHook: ({ index, state }) => ({
      input: state.compactCalls > 0 ? 4000 : 30000 + index * 20000,
      output: 500,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
  });
  const base = {
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
    conversationId: 'conv-compact',
  };

  const first = await h.runtime.chat({ ...base, message: 'Show me Pepsi' });
  assert.equal(first.success, true);
  for (let index = 0; index < 8; index += 1) {
    const result = await h.runtime.chat({ ...base, message: 'continue' });
    assert.equal(result.success, true);
  }
  assert.ok(h.state.compactCalls >= 1);
  assert.equal(h.state.sessionCount, 1);
});

test('the runtime keeps one session while real token usage fits the window', async (t) => {
  const h = await createRuntimeHarness(t, {
    tokenHook: () => ({
      input: 12000,
      output: 400,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
  });
  const base = {
    authToken: 'jwt-session',
    branchId: 'branch-1',
    username: 'admin',
    conversationId: 'conv-long',
  };

  const first = await h.runtime.chat({ ...base, message: 'Show me Pepsi' });
  assert.equal(first.success, true);
  for (let index = 0; index < 20; index += 1) {
    const result = await h.runtime.chat({ ...base, message: 'continue' });
    assert.equal(result.success, true);
  }
  assert.equal(h.state.compactCalls, 0);
  assert.equal(h.state.sessionCount, 1);
});
