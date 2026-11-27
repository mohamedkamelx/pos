'use strict';

/*
 * The AI assistant for a phone on the shop Wi-Fi.
 *
 * The assistant itself lives in the desktop main process: it owns the keys,
 * the provider calls and the embedded runtime. This router is a thin,
 * authenticated door to the same handlers the desktop renderer uses over IPC.
 * It deliberately does not read, store or return a provider token, and it
 * refuses every key-management action so a secret is never sent over the
 * shop's HTTP connection. A shop configures the assistant on the till.
 *
 * The bridge is present only when the API is running inside Posnic desktop.
 * The standalone API answers 503, and the page keeps its desktop-only note.
 */

const express = require('express');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

/* The AI page is a branch-write destination on the desktop; the same rule
 * applies to the same page on a phone. */
router.use((req, res, next) => {
  const user = req.user;
  if (user && user.access && user.access.branch && user.access.branch.write === true) {
    return next();
  }
  return res.status(403).json({
    success: false,
    code: 'forbidden',
    error: 'You do not have permission to use the AI assistant.',
  });
});

function bridge() {
  return typeof global !== 'undefined' ? global.__posnicAiBridge : null;
}

async function invoke(req, res, channel, payload) {
  const available = bridge();
  if (!available) {
    return res.status(503).json({
      success: false,
      code: 'bridge_unavailable',
      error: 'The AI assistant is available in the Posnic desktop app.',
    });
  }

  res.set('Cache-Control', 'no-store');
  try {
    const result = await available.invoke(channel, payload, null);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: 'bridge_failed',
      error: 'The assistant could not complete that request.',
    });
  }
}

/* The signed-in request is the authority for shop-data tools. The page sends
 * the token it already holds; if a caller leaves it out, use the request's
 * own bearer token rather than letting the runtime run unauthenticated. */
function withRequestAuth(req, body) {
  const payload = Object.assign({}, body || {});
  if (!payload.authToken) {
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Bearer ')) payload.authToken = header.slice(7);
    /* A browser keeps the login in an HTTP-only cookie, so the page cannot
       read it. The route runs in the API process and can hand the runtime the
       same credential without ever sending it back to the page. */
    else if (req.cookies && req.cookies.jwt) payload.authToken = req.cookies.jwt;
  }
  /* tenantContext is the branch the request was actually validated against.
     Prefer it over a client header so the assistant cannot be pointed at a
     different branch than the rest of the request. */
  if (req.tenantContext && req.tenantContext.branchId) {
    payload.branchId = String(req.tenantContext.branchId);
  } else if (!payload.branchId && req.headers['x-branch-id']) {
    payload.branchId = String(req.headers['x-branch-id']);
  }
  return payload;
}

/* A browser on the shop Wi-Fi sends the clip as base64 because JSON cannot
 * carry an ArrayBuffer. The desktop bridge and the transcriber still expect
 * bytes, so decode it here before the IPC handler sees it. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function audioPayload(req) {
  const body = Object.assign({}, req.body || {});
  const audio = body.audio;
  const dataUrl = typeof audio === 'string' && /^data:audio\/[^;]+;base64,/i.test(audio);
  const flagged = body.audioEncoding === 'base64' && typeof audio === 'string';
  if (!dataUrl && !flagged) return body;

  const encoded = String(audio)
    .replace(/^data:[^;]+;base64,/i, '')
    .replace(/\s+/g, '');
  if (!encoded || !BASE64_RE.test(encoded)) return body;

  body.audio = Buffer.from(encoded, 'base64');
  delete body.audioEncoding;
  return body;
}

router.get('/status', (req, res) => invoke(req, res, 'ai:key-status', {}));

router.post('/enabled', (req, res) =>
  invoke(req, res, 'ai:set-enabled', !!(req.body && req.body.enabled === true))
);

router.post('/chat', (req, res) => invoke(req, res, 'ai:chat', withRequestAuth(req, req.body)));

router.post('/transcribe', (req, res) =>
  invoke(req, res, 'ai:transcribe', audioPayload(req))
);

router.post('/attach', (req, res) => invoke(req, res, 'ai:attach', req.body || {}));

router.post('/remove-attachment', (req, res) =>
  invoke(req, res, 'ai:remove-attachment', req.body || {})
);

router.post('/reset-chat', (req, res) => invoke(req, res, 'ai:reset-chat', req.body || {}));

router.post('/confirm-plan', (req, res) =>
  invoke(req, res, 'ai:confirm-plan', withRequestAuth(req, req.body))
);

router.post('/cancel-plan', (req, res) => invoke(req, res, 'ai:cancel-plan', req.body || {}));

router.post('/reasoning', (req, res) =>
  invoke(req, res, 'ai:set-reasoning', { reasoning: req.body && req.body.reasoning })
);

router.post('/provider-model', (req, res) =>
  invoke(req, res, 'ai:set-provider-model', {
    provider: req.body && req.body.provider,
    model: req.body && req.body.model,
  })
);

/*
 * Key management stays on the till. Returning the same shape as the other
 * refusals lets the page explain it without a special case for HTTP errors.
 */
function desktopOnly(_req, res) {
  return res.status(403).json({
    success: false,
    code: 'desktop_only',
    error: 'Configure the AI assistant in the Posnic desktop app.',
  });
}

router.post('/validate-key', desktopOnly);
router.post('/save-key', desktopOnly);
router.post('/clear-key', desktopOnly);
router.post('/validate-provider-key', desktopOnly);
router.post('/save-provider-key', desktopOnly);
router.post('/clear-provider-key', desktopOnly);

module.exports = router;
