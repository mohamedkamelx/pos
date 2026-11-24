'use strict';

/*
 * VOICE DICTATION'S THREE BOUNDARIES.
 *
 * Voice input is the first optional feature that asks for the microphone and
 * the first one that may send customer audio off the till. That makes its
 * edges worth pinning:
 *
 *   - the Groq key is validated, kept by the main process and never written
 *     in clear text or returned to a page;
 *   - the microphone/IPC path stays off until the shop opts in, and a system
 *     with no real keystore keeps the key in memory rather than pretending
 *     basic_text is encryption;
 *   - the settings page, shortcut, palette microphone and universal search
 *     all reach the feature, and none of them bypasses the branch permission
 *     or the translation pack.
 *
 * The tests use a fake safeStorage and a fake fetch. No real key, network
 * request or microphone is involved.
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

function freshVoiceIpc() {
  const file = require.resolve(path.join(ROOT, 'src/voice-ipc.js'));
  delete require.cache[file];
  return require(file);
}

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-voice-'));
  const ipc = fakeIpc();
  const calls = [];
  const voiceIpc = freshVoiceIpc();
  const fetchImpl = options.fetchImpl || (async () => response(200, { data: [] }));
  voiceIpc.setupVoiceIPC({
    ipcMain: ipc,
    app: { getPath: () => dir },
    safeStorage: options.safeStorage || secureStorage(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    keyPath: path.join(dir, 'voice-groq-key.json'),
    handlers: ipc.handlers,
    calls,
    state: voiceIpc.voiceInputState,
  };
}

test('a Groq key is validated, encrypted and kept out of the page', async (t) => {
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
      'voice:clear-key',
      'voice:key-status',
      'voice:save-key',
      'voice:set-enabled',
      'voice:transcribe',
      'voice:validate-key',
    ],
  );

  const saved = await h.handlers.get('voice:save-key')({}, KEY);
  assert.deepEqual(saved, { success: true, configured: true, secure: true, session: false });
  assert.equal(fs.existsSync(h.keyPath), true);

  const raw = fs.readFileSync(h.keyPath, 'utf8');
  assert.ok(!raw.includes(KEY), 'the key was written in clear text');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(h.keyPath).mode & 0o777, 0o600);
    /* Rewriting an existing file must keep the private mode too. */
    fs.chmodSync(h.keyPath, 0o644);
    const again = await h.handlers.get('voice:save-key')({}, KEY);
    assert.equal(again.success, true);
    assert.equal(fs.statSync(h.keyPath).mode & 0o777, 0o600);
  }

  const status = await h.handlers.get('voice:key-status')({});
  assert.equal(status.configured, true);
  assert.equal(status.secure, true);
  assert.equal(status.session, false);
  assert.equal(status.reason, '');

  /* An empty field means check the saved key; it must use the stored copy. */
  assert.equal((await h.handlers.get('voice:validate-key')({}, '')).success, true);

  const cleared = await h.handlers.get('voice:clear-key')({});
  assert.deepEqual(cleared, { success: true, configured: false });
  assert.equal(fs.existsSync(h.keyPath), false);
  assert.equal((await h.handlers.get('voice:key-status')({})).configured, false);
});

test('transcription waits for opt-in, a key and a supported recording', async (t) => {
  let posts = 0;
  const h = setup(t, {
    fetchImpl: async (url, init) => {
      if (url.endsWith('/models')) return response(200, { data: [] });
      if (url.endsWith('/audio/transcriptions')) {
        posts += 1;
        assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
        const file = init.body.get('file');
        assert.equal(file.name, 'dictation.webm');
        assert.equal(init.body.get('model'), 'whisper-large-v3-turbo');
        assert.equal(init.body.get('language'), 'ar');
        assert.equal(init.body.get('temperature'), '0');
        return response(200, { text: 'مرحبا بكم' });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });
  const transcribe = h.handlers.get('voice:transcribe');

  let result = await transcribe({}, { audio: new Uint8Array([1, 2]), mimeType: 'audio/webm' });
  assert.equal(result.code, 'disabled');

  await h.handlers.get('voice:set-enabled')({}, true);
  result = await transcribe({}, { audio: new Uint8Array([1, 2]), mimeType: 'audio/webm' });
  assert.equal(result.code, 'key_missing');
  assert.equal((await h.handlers.get('voice:validate-key')({}, '')).code, 'key_missing');

  assert.equal((await h.handlers.get('voice:save-key')({}, KEY)).success, true);

  result = await transcribe({}, { audio: new Uint8Array([1, 2]), mimeType: 'text/plain' });
  assert.equal(result.code, 'audio_unsupported');
  assert.equal(posts, 0);

  result = await transcribe({}, {
    audio: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/webm;codecs=opus',
  });
  assert.equal(result.success, true);
  assert.equal(result.text, 'مرحبا بكم');
  assert.equal(posts, 1);
  assert.equal(h.state.enabled, true);
});

test('Groq failures keep their meaning instead of becoming a generic error', async (t) => {
  const h = setup(t, {
    fetchImpl: async (url) => {
      if (url.endsWith('/models')) return response(200, { data: [] });
      return response(429, { error: { message: 'slow down' } });
    },
  });
  await h.handlers.get('voice:save-key')({}, KEY);
  await h.handlers.get('voice:set-enabled')({}, true);
  const result = await h.handlers.get('voice:transcribe')({}, {
    audio: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/webm',
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'rate_limited');
  assert.equal(result.status, 429);
});

test('an offline key check stores nothing', async (t) => {
  const h = setup(t, {
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const result = await h.handlers.get('voice:save-key')({}, KEY);
  assert.equal(result.success, false);
  assert.equal(result.code, 'network_error');
  assert.equal(fs.existsSync(h.keyPath), false);
  assert.equal((await h.handlers.get('voice:key-status')({})).configured, false);
});

test('a keystore write failure is reported as a save failure', async (t) => {
  const h = setup(t, {
    safeStorage: secureStorage({ encryptString: () => { throw new Error('read-only keyring'); } }),
    fetchImpl: async () => response(200, { data: [] }),
  });
  const result = await h.handlers.get('voice:save-key')({}, KEY);
  assert.equal(result.success, false);
  assert.equal(result.code, 'key_save_failed');
  assert.equal(fs.existsSync(h.keyPath), false);
  assert.equal((await h.handlers.get('voice:key-status')({})).configured, false);
});

test('a system without a secure keystore keeps the key only in main memory', async (t) => {
  const h = setup(t, {
    safeStorage: insecureStorage(),
    fetchImpl: async () => response(200, { data: [] }),
  });
  const saved = await h.handlers.get('voice:save-key')({}, KEY);
  assert.deepEqual(saved, { success: true, configured: true, secure: false, session: true });
  assert.equal(fs.existsSync(h.keyPath), false, 'the key was written without a keystore');

  const status = await h.handlers.get('voice:key-status')({});
  assert.equal(status.configured, true);
  assert.equal(status.secure, false);
  assert.equal(status.session, true);

  await h.handlers.get('voice:clear-key')({});
  const after = await h.handlers.get('voice:key-status')({});
  assert.equal(after.configured, false);
  assert.equal(after.session, false);
});

test('the microphone, key and settings are wired through every door', () => {
  const main = read('src', 'main.js');
  assert.match(main, /setupVoiceIPC\(\{\s*app,\s*safeStorage,\s*systemPreferences\s*\}\)/);
  assert.match(main, /fromMainWindow\s*&&\s*permission === 'media'\s*&&\s*voiceInputState\.enabled\s*&&\s*audioOnly/);
  assert.match(main, /permission !== 'media'\s*\|\|\s*!voiceInputState\.enabled/);

  const voiceIpc = read('src', 'voice-ipc.js');
  assert.match(voiceIpc, /require\('\.\/ipc-guard'\)\.guard/);
  assert.match(voiceIpc, /safeStorage\.encryptString/);
  assert.match(voiceIpc, /askForMediaAccess\('microphone'\)/);
  assert.match(voiceIpc, /form\.append\('language', 'ar'\)/);
  assert.match(voiceIpc, /mode: 0o600/);

  const preload = read('src', 'preload.js');
  for (const method of ['setEnabled', 'keyStatus', 'validateKey', 'saveKey', 'clearKey', 'transcribe']) {
    assert.match(preload, new RegExp(`${method}: \\(`), `preload.voice.${method} is missing`);
  }

  const settings = read('frontend', 'modules', 'settings_write.html');
  for (const id of [
    'v-pills-voice-tab', 'v-pills-voice', 'voice_enabled', 'voice_provider',
    'voice_local_model', 'voice_groq_key', 'voice_test_record', 'voice_local_load',
  ]) {
    assert.match(settings, new RegExp(`id="${id}"`), `${id} is missing from settings`);
  }
  assert.match(settings, /<option value="local"/);
  assert.match(settings, /<option value="groq"/);

  const sidebar = read('frontend', 'layouts', 'sidebar.html');
  assert.match(sidebar, /id="manage_sec_voice"/);
  assert.match(sidebar, /href="#\/settings\/voice"/);

  const palette = read('frontend', 'static', 'script', 'js', 'core', 'command-palette.js');
  assert.match(palette, /id="cmdk-voice"/);
  assert.match(palette, /PosnicPro\.voice\.togglePalette/);

  const map = JSON.parse(read('frontend', 'pages_css_js_map.json'));
  assert.ok(map.dashboard.js.includes('static/voice/voice-engine.js'));
  assert.ok(map.dashboard.js.includes('static/script/js/core/voice-input.js'));

  const packageJson = JSON.parse(read('package.json'));
  assert.match(packageJson.build.mac.extendInfo.NSMicrophoneUsageDescription, /microphone/i);
  assert.match(read('builds', 'entitlements.mac.plist'), /com\.apple\.security\.device\.audio-input/);

  for (const file of ['voice-engine.js', 'voice-worker.js', 'sample-ar.wav']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'frontend', 'static', 'voice', file)), `${file} is missing`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'frontend', 'static', 'voice-lab.html')));
  for (const file of [
    'transformers.min.js',
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
    'LICENSE',
    'LICENSE-ONNXRUNTIME',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, 'frontend', 'static', 'script', 'vendor', 'transformers', file)),
      `${file} is missing`);
  }
});

test('the content policy opens only the voice destinations and WebAssembly', () => {
  const app = read('api', 'app.js');
  const section = (name) => {
    const start = app.indexOf(`'${name}'`);
    assert.ok(start > -1, `${name} is missing`);
    return app.slice(start, app.indexOf('],', start));
  };

  const connect = section('connect-src');
  assert.match(connect, /https:\/\/api\.groq\.com/);
  assert.match(connect, /https:\/\/huggingface\.co/);
  assert.match(connect, /https:\/\/\*\.huggingface\.co/);
  assert.match(section('media-src'), /'blob:'/);
  assert.match(section('script-src'), /'wasm-unsafe-eval'/);
});

test('voice labels exist in both languages with the same placeholders', () => {
  const english = JSON.parse(read('languages', '_english.json'));
  const arabic = JSON.parse(read('languages', 'ar.json'));
  const keys = Object.keys(english).filter((key) => key.startsWith('lang_voice_'));
  assert.ok(keys.length > 40);
  assert.deepEqual(
    Object.keys(arabic).filter((key) => key.startsWith('lang_voice_')).sort(),
    keys.slice().sort(),
  );
  const tokens = (text) => (String(text).match(/\{[A-Za-z0-9_]+\}/g) || []).sort();
  for (const key of keys) {
    assert.ok(String(arabic[key] || '').trim(), `${key} has no Arabic text`);
    assert.deepEqual(tokens(arabic[key]), tokens(english[key]), `${key} placeholders changed`);
  }
});

test('universal search finds Voice for an authorized shop and hides it from a restricted one', async () => {
  const frontend = (...parts) => read('frontend', ...parts);
  const dom = new JSDOM(
    frontend('layouts', 'header.html') +
      frontend('layouts', 'sidebar.html') +
      frontend('modules', 'settings_write.html'),
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

  const voice = matches('voice').find((row) => /Voice input/.test(row.textContent));
  assert.ok(voice, 'Voice input is absent from universal search');
  voice.click();
  assert.equal(routes.at(-1), 'settings/voice');

  assert.ok(matches('Groq').length > 0, 'the engine setting is not searchable');
  assert.ok(matches('Arabic model').length > 0, 'the model setting is not searchable');
  assert.equal(
    matches('Groq API key').filter((row) => /Groq API key/.test(row.textContent)).length,
    0,
    'the password control is exposed by search',
  );

  /* The last two query checks left the palette open. Close it before changing
     the ACL, otherwise the next open reuses the catalogue built as a manager. */
  d.getElementById('cmdk-close').click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  w.PosnicPro.userACL.branch.write = false;
  assert.equal(
    matches('voice').filter((row) => /Voice input/.test(row.textContent)).length,
    0,
    'a restricted user can still see Voice input',
  );
});
