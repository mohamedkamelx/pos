const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const PUBLIC = path.join(FRONTEND, 'public');
const ROOT_FILES = ['robots.txt', 'llms.txt', '_headers'];
const POSNIC_SEO_TITLE = 'Posnic POS - Offline POS & Billing Software';
const POSNIC_SEO_DESCRIPTION =
  'Posnic POS is offline-first open source POS and billing software for retail stores and small businesses.';
const POSNIC_SEO_KEYWORDS = ['POS', 'Billing Software', 'Offline POS', 'Online/Offline POS', 'open source POS'];

function read(...parts) {
  return fs.readFileSync(path.join(...parts), 'utf8');
}

test('frontend source carries local discovery files', () => {
  for (const file of ROOT_FILES) {
    assert.ok(fs.existsSync(path.join(FRONTEND, file)), `${file} is missing from frontend/`);
  }

  const robots = read(FRONTEND, 'robots.txt');
  assert.match(robots, /^User-agent: \*/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.doesNotMatch(robots, /https?:\/\//);

  const llms = read(FRONTEND, 'llms.txt');
  assert.match(llms, /^# Posnic POS$/m);
  assert.match(llms, /POS; Billing Software; Offline POS; Online\/Offline POS; open source POS/);
  assert.doesNotMatch(llms, /https?:\/\//);

  const headers = read(FRONTEND, '_headers');
  assert.match(headers, /\/robots\.txt[\s\S]*Content-Type: text\/plain; charset=utf-8/);
  assert.match(headers, /\/llms\.txt[\s\S]*Content-Type: text\/plain; charset=utf-8/);
  assert.match(
    headers,
    /\/static\/manifest\.webmanifest[\s\S]*Content-Type: application\/manifest\+json; charset=utf-8/,
  );
});

test('public app entry pages expose local metadata without external hosts', () => {
  const index = read(FRONTEND, 'index.html');
  const login = read(FRONTEND, 'login.html');

  for (const html of [index, login]) {
    assert.match(html, new RegExp(`<title>${POSNIC_SEO_TITLE}</title>`));
    assert.match(html, new RegExp(`<meta name="description" content="${POSNIC_SEO_DESCRIPTION}">`));
    assert.match(html, /<meta name="robots" content="index, follow">/);
    assert.doesNotMatch(html, /rel="canonical"/);
    assert.doesNotMatch(html, /og:url/);
    assert.doesNotMatch(html, /application\/ld\+json/);
    assert.doesNotMatch(html, /https?:\/\/(?:www\.)?(?:posnic\.com|github\.com|posnic\.io)(?:\/|["'])/i);
  }

  assert.match(login, /<meta property="og:title" content="Posnic POS - Offline POS & Billing Software">/);
  assert.match(login, /<meta name="twitter:card" content="summary">/);
  assert.match(login, /<meta name="twitter:title" content="Posnic POS - Offline POS & Billing Software">/);
});

test('gulp publishes discovery files into frontend/public', () => {
  const gulpIndex = read(FRONTEND, 'gulpfile.js', 'index.js');
  assert.match(gulpIndex, /function copyRootPublicFiles\(\)/);
  for (const file of ROOT_FILES) {
    assert.match(gulpIndex, new RegExp(`['"]${file.replace('.', '\\.')}['"]`));
  }
  assert.match(gulpIndex, /exports\.rootPublicFiles = copyRootPublicFiles/);
  assert.match(gulpIndex, /parallel\(copyRootPublicFiles,/);

  if (!fs.existsSync(PUBLIC)) return;
  for (const file of ROOT_FILES) {
    const built = path.join(PUBLIC, file);
    assert.ok(fs.existsSync(built), `${file} is missing from frontend/public after build`);
    assert.equal(read(FRONTEND, file), read(PUBLIC, file), `${file} changed during copy`);
  }
});
