'use strict';

/*
 * A local, durable record of the errors that take the till down.
 *
 * app.log is enough while the process can still append to it, but it is
 * rotated on the first write of a new day and it is written from the same
 * handlers that can be the thing that throws. This file is appended to before
 * any application handler runs and never leaves the machine. It exists so the
 * next idle crash produces a full stack instead of the last two frames
 * somebody managed to paste from a terminal.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 5 * 1024 * 1024;
const REDACTIONS = [
  [/(mongodb(?:\+srv)?:\/\/[^:\s/]+:)[^@\s/]+@/gi, '$1[REDACTED]@'],
  [/((?:Bearer|Basic)\s+)[^\s"',}]+/gi, '$1[REDACTED]'],
  [/((?:password|passwd|token|secret|authorization|cookie|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]'],
];

function redact(value) {
  let text;
  try {
    text = String(value == null ? '' : value);
  } catch (_) {
    text = '';
  }
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text;
}

function safeString(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch (_) {
    return Object.prototype.toString.call(value);
  }
}

function serializeError(value, depth = 0, seen = new Set()) {
  if (value == null) return null;
  if (depth > 4) return { name: 'Error', message: '[cause depth limit]' };
  if (!(value instanceof Error)) {
    return { name: typeof value, message: safeString(value) };
  }
  if (seen.has(value)) return { name: value.name, message: '[circular cause]' };
  seen.add(value);

  const out = { name: value.name, message: value.message, stack: value.stack };
  for (const key of ['code', 'errno', 'syscall', 'path', 'url']) {
    if (value[key] !== undefined) out[key] = safeString(value[key]);
  }
  if (value.cause !== undefined) out.cause = serializeError(value.cause, depth + 1, seen);
  seen.delete(value);
  return out;
}

function serializeContext(context) {
  if (!context || typeof context !== 'object') return {};
  const seen = new Set();
  try {
    return JSON.parse(JSON.stringify(context, (key, value) => {
      if (typeof value === 'bigint') return String(value);
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
      }
      return value;
    }));
  } catch (_) {
    return { note: 'context could not be serialized' };
  }
}

function createCrashLog({ file, maxBytes = MAX_BYTES, now = () => new Date() } = {}) {
  if (!file) throw new Error('createCrashLog needs a file');

  function rotateIfNeeded(incomingBytes) {
    try {
      const size = fs.statSync(file).size;
      if (size + incomingBytes <= maxBytes) return;
      fs.rmSync(`${file}.old`, { force: true });
      fs.renameSync(file, `${file}.old`);
    } catch (_) {
      /* No existing file, or a filesystem that refuses the rename. Appending
         below still succeeds in the common case. */
    }
  }

  function append(kind, error, context = {}) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const entry = {
        at: now().toISOString(),
        kind,
        pid: process.pid,
        process: {
          electron: process.versions.electron || null,
          node: process.versions.node,
          chrome: process.versions.chrome || null,
          v8: process.versions.v8,
        },
        uptimeSeconds: Math.round(process.uptime()),
        context: serializeContext(context),
        error: serializeError(error),
      };
      const line = `${redact(JSON.stringify(entry))}\n`;
      rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
      fs.appendFileSync(file, line, 'utf8');
      return true;
    } catch (_) {
      /* A crash log must never be the reason a till stops. */
      return false;
    }
  }

  return { file, append };
}

module.exports = { createCrashLog, redact, serializeError };
