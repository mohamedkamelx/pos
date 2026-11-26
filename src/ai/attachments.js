/*
 * Chat image attachments for the assistant.
 *
 * The renderer reads the file, sends the bytes to the main process, and gets a
 * short attachment id back. The model only sees the id and the file name, never
 * the bytes. A confirmed plan resolves those ids here and uploads the images
 * through the normal item image endpoint.
 *
 * Attachments live in memory for the life of the runtime session. They are
 * never written to disk, never synced and never returned to the renderer.
 */

'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_ATTACHMENTS = 8;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const ALLOWED = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/bmp',
]);
const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};
const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

function cleanText(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? text.slice(0, max) : text;
}

function normaliseMime(value) {
  const mime = cleanText(value, 80).toLowerCase();
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function normaliseData(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const comma = text.indexOf(',');
  const base64 = /^data:[^;]+;base64,/i.test(text) && comma > -1
    ? text.slice(comma + 1)
    : text;
  if (!base64 || !/^[a-z0-9+/=\s]+$/i.test(base64)) return '';
  return base64.replace(/\s+/g, '');
}

function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return match ? match[1].toLowerCase() : '';
}

function normaliseName(name, mime) {
  const base = cleanText(name, 180) || 'image';
  const extension = extensionOf(base);
  if (extension && MIME_BY_EXTENSION[extension]) {
    return { name: base, mime: mime || MIME_BY_EXTENSION[extension] };
  }
  const wanted = mime && EXTENSIONS[mime] ? EXTENSIONS[mime] : 'png';
  const stem = extension ? base.slice(0, -(extension.length + 1)) : base;
  return { name: `${stem || 'image'}.${wanted}`, mime: mime || MIME_BY_EXTENSION[wanted] };
}

function createAttachmentStore({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const sessions = new Map();
  const lifetime = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;

  function session(sessionID, create) {
    const key = String(sessionID || '');
    if (!key) return null;
    let entry = sessions.get(key);
    if (!entry && create) {
      entry = { items: new Map(), createdAt: now() };
      sessions.set(key, entry);
    }
    if (entry) sweep(entry);
    return entry || null;
  }

  function sweep(entry) {
    const cutoff = now() - lifetime;
    for (const [id, item] of entry.items.entries()) {
      if (item.createdAt < cutoff) entry.items.delete(id);
    }
  }

  /* A user can attach a photo, then answer several questions before asking
     for the plan. Touching on every read keeps an attachment that is still
     part of the live conversation from expiring between those turns. */
  function touch(item) {
    if (item) item.createdAt = now();
  }

  function addMany(sessionID, rawList) {
    const entry = session(sessionID, true);
    if (!entry) return { ok: false, code: 'session_required', message: 'The chat session is missing.' };
    if (!Array.isArray(rawList) || !rawList.length) {
      return { ok: true, attachments: [] };
    }
    if (rawList.length > MAX_ATTACHMENTS) {
      return {
        ok: false,
        code: 'too_many_attachments',
        message: `Attach up to ${MAX_ATTACHMENTS} images at a time.`,
      };
    }

    const accepted = [];
    let total = 0;
    for (const item of entry.items.values()) total += item.size;
    for (const raw of rawList) {
      const rawName = cleanText(raw && raw.name, 180) || 'image';
      const rawMime = normaliseMime(raw && raw.mime);
      const normalised = normaliseName(rawName, rawMime);
      const name = normalised.name;
      const mime = normalised.mime;
      const data = normaliseData(raw && raw.data);
      if (!data) {
        return { ok: false, code: 'attachment_invalid', message: `The image "${rawName}" could not be read.` };
      }
      const size = Buffer.byteLength(data, 'base64');
      if (!size) {
        return { ok: false, code: 'attachment_invalid', message: `The image "${rawName}" is empty.` };
      }
      if (size > MAX_BYTES) {
        return { ok: false, code: 'attachment_too_large', message: `The image "${rawName}" is larger than 5 MB.` };
      }
      if (total + size > MAX_TOTAL_BYTES) {
        return { ok: false, code: 'attachments_too_large', message: 'The attached images are larger than 20 MB in total.' };
      }
      if (!ALLOWED.has(mime)) {
        return { ok: false, code: 'attachment_type', message: `The image "${rawName}" must be a PNG, JPEG, GIF or BMP file.` };
      }
      total += size;
      const id = 'img_' + crypto.randomBytes(8).toString('hex');
      const saved = {
        id,
        name,
        mime,
        size,
        data,
        createdAt: now(),
      };
      entry.items.set(id, saved);
      accepted.push({ id, name: saved.name, mime: saved.mime, size: saved.size });
    }
    return { ok: true, attachments: accepted };
  }

  function list(sessionID) {
    const entry = session(sessionID, false);
    if (!entry) return [];
    return Array.from(entry.items.values()).map((item) => {
      touch(item);
      return {
        id: item.id,
        name: item.name,
        mime: item.mime,
        size: item.size,
      };
    });
  }

  function get(sessionID, id) {
    const entry = session(sessionID, false);
    if (!entry) return null;
    const item = entry.items.get(String(id || '')) || null;
    touch(item);
    return item;
  }

  function describe(sessionID, ids) {
    if (!Array.isArray(ids) || !ids.length) return { ok: true, attachments: [] };
    const attachments = [];
    for (const id of ids) {
      const item = get(sessionID, id);
      if (!item) {
        return {
          ok: false,
          code: 'attachment_missing',
          message: 'An attached image is no longer available. Attach it again and ask me to use it.',
        };
      }
      attachments.push(item);
    }
    return { ok: true, attachments };
  }

  function remove(sessionID, id) {
    const entry = session(sessionID, false);
    if (!entry) return { ok: false, code: 'attachment_missing' };
    const removed = entry.items.delete(String(id || ''));
    return removed ? { ok: true } : { ok: false, code: 'attachment_missing' };
  }

  function clear(sessionID) {
    sessions.delete(String(sessionID || ''));
  }

  function clearAll() {
    sessions.clear();
  }

  return { addMany, clear, clearAll, describe, get, list, remove };
}

function attachmentNotice(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  return [
    '',
    '',
    '[Attached images for this message. Use one of these attachment ids in posnic_propose_plan when the user wants an image added to a product. Do not reuse an id from an earlier message; it may have expired.]',
    ...attachments.map((item) => `- ${item.id}: ${item.name}`),
  ].join('\n');
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_ATTACHMENTS,
  MAX_BYTES,
  attachmentNotice,
  createAttachmentStore,
};
