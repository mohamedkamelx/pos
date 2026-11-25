'use strict';

/*
 * The assistant's local user notes are a small per-user Markdown file. These
 * tests keep the file local, bounded, deduplicated and free of obvious
 * personal or secret data. No shop database, provider or network is involved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  MAX_NOTE_CHARS,
  MAX_NOTES_PER_SECTION,
  SECTIONS,
  cleanNote,
  createUserProfileStore,
  profilePath,
  sensitiveReason,
  template,
  userKey,
} = require(path.join(ROOT, 'src/ai/user-profile'));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-user-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the profile template has the three fixed sections', () => {
  const text = template();
  for (const section of SECTIONS) {
    assert.match(text, new RegExp(`^## ${section.title}$`, 'm'));
  }
  assert.match(text, /never synced/);
});

test('profile paths are per user and never contain the username', () => {
  const dir = '/tmp/profiles';
  const first = profilePath(dir, 'admin');
  const second = profilePath(dir, 'cashier');
  assert.notEqual(first, second);
  assert.equal(first.includes('admin'), false);
  assert.equal(path.dirname(first), dir);
  assert.equal(profilePath(dir, '../evil').startsWith(dir + path.sep), true);
  assert.equal(userKey(''), 'default');
});

test('notes are cleaned, bounded and checked for secrets', () => {
  assert.equal(cleanNote('  - Prefers short replies.\n'), 'Prefers short replies.');
  assert.equal(cleanNote('a\n\nb\tc'), 'a b c');
  assert.equal(cleanNote('x'.repeat(MAX_NOTE_CHARS + 50)).length, MAX_NOTE_CHARS);

  assert.equal(sensitiveReason('Prefers short replies.'), '');
  assert.equal(sensitiveReason('Email me at owner@example.com'), 'email');
  assert.equal(sensitiveReason('Use sk-1234567890abcdef'), 'key');
  assert.equal(sensitiveReason('Bearer abcdef1234567890'), 'token');
  assert.equal(sensitiveReason('The password is secret'), 'password');
  assert.equal(sensitiveReason('Call 01012345678'), 'number');
});

test('a note is appended under its section, deduplicated and persisted', (t) => {
  const dir = tempDir(t);
  const profile = createUserProfileStore({ dir }).forUser('admin');

  const empty = profile.read();
  assert.equal(empty.exists, false);
  assert.deepEqual(empty.counts, { preferences: 0, recurring: 0, language: 0 });

  const saved = profile.append({
    section: 'language',
    note: 'Uses Egyptian Arabic and keeps product names in Latin script.',
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.added, true);
  assert.equal(saved.counts.language, 1);

  const duplicate = profile.append({
    section: 'language',
    note: 'Uses Egyptian Arabic and keeps product names in Latin script.',
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.duplicate, true);

  const reread = profile.read();
  assert.equal(reread.exists, true);
  assert.equal(reread.counts.language, 1);
  assert.match(reread.text, /^## Language and wording$/m);
  assert.match(reread.text, /Uses Egyptian Arabic/);
  assert.equal(fs.statSync(profile.path).isFile(), true);
});

test('a full section keeps the newest notes', (t) => {
  const dir = tempDir(t);
  const profile = createUserProfileStore({ dir }).forUser('admin');

  for (let index = 1; index <= MAX_NOTES_PER_SECTION + 3; index += 1) {
    const saved = profile.append({
      section: 'recurring',
      note: `Recurring note ${index}`,
    });
    assert.equal(saved.ok, true);
  }

  const text = profile.read().text;
  assert.equal((text.match(/^- Recurring note /gm) || []).length, MAX_NOTES_PER_SECTION);
  assert.equal(text.includes('Recurring note 1\n'), false);
  assert.match(text, /Recurring note 23/);
});

test('a note with personal data is rejected and clear resets the file', (t) => {
  const dir = tempDir(t);
  const profile = createUserProfileStore({ dir }).forUser('admin');

  const rejected = profile.append({
    section: 'preferences',
    note: 'Call 01012345678 before ordering.',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'sensitive_note');
  assert.equal(profile.read().exists, false);

  profile.append({ section: 'preferences', note: 'Prefers short replies.' });
  assert.equal(profile.read().counts.preferences, 1);

  const cleared = profile.clear();
  assert.equal(cleared.ok, true);
  assert.equal(profile.read().counts.preferences, 0);
});
