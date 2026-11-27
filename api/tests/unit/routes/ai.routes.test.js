'use strict';

jest.mock('../../../src/middleware/auth', () => ({
  protect: jest.fn((req, res, next) => next()),
}));

const router = require('../../../src/routes/ai.routes');

function transcribeHandler() {
  const layer = router.stack.find(
    (entry) => entry.route && entry.route.path === '/transcribe'
  );
  if (!layer) throw new Error('transcribe route is missing');
  return layer.route.stack[0].handle;
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe('ai.routes transcribe payload', () => {
  afterEach(() => {
    delete global.__posnicAiBridge;
  });

  test('decodes base64 audio before invoking the desktop bridge', async () => {
    const invoke = jest.fn(async () => ({ success: true }));
    global.__posnicAiBridge = { invoke };

    const req = {
      body: {
        audio: Buffer.from([1, 2, 3, 4]).toString('base64'),
        audioEncoding: 'base64',
        mimeType: 'audio/webm',
        language: 'ar',
      },
    };
    const res = fakeResponse();
    await transcribeHandler()(req, res);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [channel, payload] = invoke.mock.calls[0];
    expect(channel).toBe('ai:transcribe');
    expect(Buffer.isBuffer(payload.audio)).toBe(true);
    expect([...payload.audio]).toEqual([1, 2, 3, 4]);
    expect(payload.audioEncoding).toBeUndefined();
    expect(payload.mimeType).toBe('audio/webm');
    expect(res.body).toEqual({ success: true });
  });

  test('decodes an audio data URL', async () => {
    const invoke = jest.fn(async () => ({ success: true }));
    global.__posnicAiBridge = { invoke };

    const req = { body: { audio: 'data:audio/webm;base64,AQIDBA==' } };
    const res = fakeResponse();
    await transcribeHandler()(req, res);

    const payload = invoke.mock.calls[0][1];
    expect(Buffer.isBuffer(payload.audio)).toBe(true);
    expect([...payload.audio]).toEqual([1, 2, 3, 4]);
  });

  test('leaves a body without audio untouched', async () => {
    const invoke = jest.fn(async () => ({ success: false }));
    global.__posnicAiBridge = { invoke };

    const req = { body: { language: 'ar' } };
    const res = fakeResponse();
    await transcribeHandler()(req, res);

    expect(invoke.mock.calls[0][1]).toEqual({ language: 'ar' });
  });
});
