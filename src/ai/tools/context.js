/*
 * Per-session tool context.
 *
 * The renderer owns the signed-in JWT and the active branch. It passes both
 * with a chat message; the runtime keeps them in memory, keyed by the OpenCode
 * session, and hands them to the read-only tools. Nothing here is written to
 * disk or logged.
 */

'use strict';

function createContextStore() {
  const sessions = new Map();

  function key(sessionID) {
    return String(sessionID || '').trim();
  }

  function set(sessionID, context) {
    const id = key(sessionID);
    if (!id) return null;
    const next = {
      apiBaseUrl: String((context && context.apiBaseUrl) || '').replace(/\/+$/, ''),
      token: String((context && context.token) || ''),
      branchId: String((context && context.branchId) || ''),
      username: String((context && context.username) || ''),
      conversationId: String((context && context.conversationId) || '').trim().slice(0, 100),
      updatedAt: Date.now(),
    };
    sessions.set(id, next);
    return next;
  }

  function get(sessionID) {
    return sessions.get(key(sessionID)) || null;
  }

  function clear(sessionID) {
    sessions.delete(key(sessionID));
  }

  function clearAll() {
    sessions.clear();
  }

  return { clear, clearAll, get, set };
}

module.exports = { createContextStore };
