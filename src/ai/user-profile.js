/*
 * Per-user assistant notes.
 *
 * These notes are local to one Posnic user on one computer. They record how
 * that person likes to work and what they ask for repeatedly, so the assistant
 * can adapt its wording and workflow in later conversations. They are not shop
 * records, are never sent to the API as shop data and are never synced.
 *
 * The model can only append one short, validated note through the
 * posnic_update_user_profile tool. It cannot choose a path or rewrite the file.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_NOTE_CHARS = 240;
const MAX_NOTES_PER_SECTION = 20;
const MAX_PROFILE_BYTES = 16 * 1024;

const SECTIONS = [
  { id: 'preferences', title: 'Preferences' },
  { id: 'recurring', title: 'Recurring requests' },
  { id: 'language', title: 'Language and wording' },
];

const HEADER = [
  '# Posnic assistant notes',
  '',
  'These notes are kept on this computer for this user. They describe how the',
  'user likes to work and what they ask for repeatedly. They are not shop',
  'records and are never synced.',
  '',
].join('\n');

function template() {
  return HEADER + SECTIONS.map((section) => `## ${section.title}\n`).join('\n') + '\n';
}

function userKey(username) {
  const value = String(username || '').trim();
  if (!value) return 'default';
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function profilePath(dir, username) {
  return path.join(dir, `user-profile-${userKey(username)}.md`);
}

function cleanNote(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*[-*]\s*/, '')
    .trim()
    .slice(0, MAX_NOTE_CHARS)
    .trim();
}

function sensitiveReason(note) {
  const value = String(note || '');
  if (/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(value)) return 'email';
  if (/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/.test(value)) return 'key';
  if (/\bbearer\s+[A-Za-z0-9._-]{8,}\b/i.test(value)) return 'token';
  if (/\b(?:password|passwd|pwd)\b/i.test(value)) return 'password';
  if (/\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\b/i.test(value)) return 'token';
  if (/\d{9,}/.test(value)) return 'number';
  return '';
}

function sectionRange(lines, title) {
  const heading = `## ${title}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function sectionNotes(lines, range) {
  if (!range) return [];
  return lines
    .slice(range.start + 1, range.end)
    .filter((line) => /^\s*-\s+/.test(line))
    .map((line) => line.replace(/^\s*-\s+/, '').trim())
    .filter(Boolean);
}

function countNotes(text) {
  const lines = String(text || '').split(/\r?\n/);
  const counts = {};
  for (const section of SECTIONS) {
    counts[section.id] = sectionNotes(lines, sectionRange(lines, section.title)).length;
  }
  return counts;
}

function truncateUtf8(text, max) {
  const buffer = Buffer.from(String(text || ''), 'utf8');
  if (buffer.length <= max) return String(text || '');
  return buffer.subarray(0, max).toString('utf8');
}

function readProfile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      return { text: template(), exists: false, bytes: 0, counts: countNotes(template()) };
    }
    let text = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_PROFILE_BYTES) {
      text = truncateUtf8(text, MAX_PROFILE_BYTES);
    }
    return {
      text,
      exists: true,
      bytes: Buffer.byteLength(text, 'utf8'),
      counts: countNotes(text),
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { text: template(), exists: false, bytes: 0, counts: countNotes(template()) };
    }
    throw error;
  }
}

function writeProfile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(file, { force: true });
      fs.renameSync(temp, file);
    } catch (renameError) {
      try { fs.rmSync(temp, { force: true }); } catch (cleanupError) { /* best effort */ }
      throw renameError;
    }
  }
  try { fs.chmodSync(file, 0o600); } catch (error) { /* Windows has no POSIX mode */ }
}

function createProfile(dir, username) {
  const file = profilePath(dir, username);

  function read() {
    return { ...readProfile(file), path: file };
  }

  function append(input) {
    const section = SECTIONS.find((entry) => entry.id === (input && input.section));
    if (!section) {
      return {
        ok: false,
        code: 'invalid_section',
        message: 'Choose preferences, recurring or language.',
      };
    }

    const note = cleanNote(input && input.note);
    if (!note) {
      return { ok: false, code: 'invalid_note', message: 'The note is empty.' };
    }
    const sensitive = sensitiveReason(note);
    if (sensitive) {
      return {
        ok: false,
        code: 'sensitive_note',
        message: 'The note contains personal or secret information and was not saved.',
      };
    }

    const current = readProfile(file);
    const lines = (current.exists ? current.text : template()).split(/\r?\n/);

    let range = sectionRange(lines, section.title);
    if (!range) {
      lines.push(`## ${section.title}`, '');
      range = sectionRange(lines, section.title);
    }

    const existing = sectionNotes(lines, range);
    if (existing.some((entry) => entry.toLowerCase() === note.toLowerCase())) {
      return {
        ok: true,
        added: false,
        duplicate: true,
        section: section.id,
        note,
        counts: current.counts,
        text: current.text,
      };
    }

    /* Remove trailing blank lines inside the section, then add the bullet. */
    let insertAt = range.end;
    while (insertAt > range.start + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
    lines.splice(insertAt, 0, `- ${note}`, '');

    range = sectionRange(lines, section.title);
    const notes = sectionNotes(lines, range);
    if (notes.length > MAX_NOTES_PER_SECTION) {
      const removeCount = notes.length - MAX_NOTES_PER_SECTION;
      let removed = 0;
      for (let index = range.start + 1; index < range.end && removed < removeCount; index += 1) {
        if (/^\s*-\s+/.test(lines[index])) {
          lines.splice(index, 1);
          index -= 1;
          removed += 1;
          range = sectionRange(lines, section.title);
        }
      }
    }

    let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    if (Buffer.byteLength(text, 'utf8') > MAX_PROFILE_BYTES) {
      text = truncateUtf8(text, MAX_PROFILE_BYTES);
    }
    writeProfile(file, text);

    return {
      ok: true,
      added: true,
      duplicate: false,
      section: section.id,
      note,
      counts: countNotes(text),
      text,
    };
  }

  function clear() {
    writeProfile(file, template());
    return { ok: true, text: template(), counts: countNotes(template()) };
  }

  return { append, clear, path: file, read };
}

function createUserProfileStore({ dir } = {}) {
  const base = path.resolve(String(dir || path.join(process.cwd(), 'ai', 'profiles')));
  return {
    dir: base,
    forUser(username) {
      return createProfile(base, username);
    },
  };
}

module.exports = {
  HEADER,
  MAX_NOTE_CHARS,
  MAX_NOTES_PER_SECTION,
  MAX_PROFILE_BYTES,
  SECTIONS,
  cleanNote,
  countNotes,
  createUserProfileStore,
  profilePath,
  sensitiveReason,
  template,
  userKey,
};
