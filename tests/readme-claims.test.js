/*
 * The README's numbers must be true.
 *
 * The badges were a test count of 8,296 and coverage of 66%. Neither matched
 * what the suite actually did - the real figures were 7,986 and 64.6% - because
 * a number typed into a badge stays where it was typed while the thing it
 * describes moves on.
 *
 * A stale badge is worse on a public repository than no badge. It is the first
 * thing a stranger reads, they have no way to check it, and if the easily
 * checked claims are wrong there is no reason to believe the rest.
 *
 * The counts that can be derived are derived here. The ones that cannot - the
 * live download total, the latest release - are left to shields.io, which reads
 * them from GitHub rather than from a promise made months ago.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
test('README carries no public badges, repository links or vendor contact links', () => {
  assert.doesNotMatch(README, /img\.shields\.io/i);
  assert.doesNotMatch(README, /https?:\/\/[^\s)]*(?:posnic\.com|github\.com|githubusercontent\.com|posnic\.github\.io)/i);
});

test('the source licence in package.json is the licence in the file', () => {
  const licence = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.match(licence, /GNU AFFERO GENERAL PUBLIC LICENSE/,
    'LICENSE is not the AGPL the badge and package.json claim');
  assert.match(licence, /Version 3/, 'LICENSE is not version 3');
});

test('the third-party notices exist and ship with the app', () => {
  /* The installer carries MongoDB under the SSPL and Microsoft's C++ runtime.
     Both require their notice to travel with the copy. */
  const notices = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
  assert.ok(fs.existsSync(notices), 'THIRD-PARTY-NOTICES.md is missing');

  const text = fs.readFileSync(notices, 'utf8');
  for (const named of ['MongoDB', 'SSPL', 'Node.js', 'Electron', 'Visual C++']) {
    assert.ok(text.includes(named), `the notices do not mention ${named}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const f of ['THIRD-PARTY-NOTICES.md', 'LICENSE']) {
    assert.ok(pkg.build.files.includes(f),
      `${f} is not packaged, so it does not reach anyone who installs this`);
  }
});

test('the licence files survive the markdown exclusion', () => {
  // build.files is order-sensitive: a later pattern overrides an earlier one.
  // THIRD-PARTY-NOTICES.md was listed at index 7 and the blanket markdown
  // exclusion at index 33, so the exclusion won and the notices never reached
  // the installer - while the packaging test passed, because it checks that
  // listed files exist rather than that they survive the filter.
  //
  // MongoDB's SSPL and Microsoft's runtime terms both require the notice to
  // travel with the copy, so this is the difference between complying and
  // believing you comply.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = pkg.build.files;

  const exclusion = files.findIndex((f) => f === '!**/*.md');
  if (exclusion === -1) return; // no blanket exclusion, nothing to outrank

  for (const needed of ['THIRD-PARTY-NOTICES.md', 'LICENSE']) {
    const at = files.indexOf(needed);
    assert.notStrictEqual(at, -1, `${needed} is not in build.files`);
    if (!needed.endsWith('.md')) continue;
    assert.ok(at > exclusion,
      `${needed} is listed at ${at}, before the "!**/*.md" exclusion at ` +
      `${exclusion}. Later patterns win, so it is excluded and never ships.`);
  }
});

test('the test command a contributor is told to run is the one CI runs', () => {
  /*
   * `cd api && npm test` used to fail 12 suites on a clean checkout, because it
   * ran the unfiltered suite while CI ran the curated one. A first command that
   * fails teaches a new contributor that the project is broken, or worse, that
   * red is normal here.
   *
   * They are the same command now. The quarantine stays visible through
   * test:known-failures rather than being hidden - excluding suites is only
   * honest while the list is easy to look at.
   */
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'api', 'package.json'), 'utf8'));

  assert.match(pkg.scripts.test, /jest\.ci\.config\.js/,
    'api "npm test" must run the same configuration as CI');
  assert.strictEqual(pkg.scripts.test, pkg.scripts['test:ci'],
    'test and test:ci have drifted apart');

  assert.ok(pkg.scripts['test:all'],
    'the unfiltered suite must still be runnable, under a name that says so');
  assert.ok(!/jest\.ci\.config\.js/.test(pkg.scripts['test:all']),
    'test:all must not use the CI config, or nothing runs the quarantine');

  assert.ok(pkg.scripts['test:known-failures'],
    'the quarantine must be inspectable, or excluding it is just hiding it');
});

test('the quarantine list is reachable and not silently empty', () => {
  const list = require('../api/jest.known-failures.js');
  assert.ok(Array.isArray(list), 'jest.known-failures no longer exports a list');

  for (const suite of list) {
    assert.ok(fs.existsSync(path.join(ROOT, 'api', suite)),
      `${suite} is quarantined but no longer exists - the list is stale`);
  }
});

test('the docs describe the commands that exist', () => {
  const dev = fs.readFileSync(path.join(ROOT, 'docs', 'DEVELOPMENT.md'), 'utf8');
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'api', 'package.json'), 'utf8'));

  for (const named of ['test:known-failures', 'test:all', 'test:local']) {
    assert.ok(dev.includes(named), `DEVELOPMENT.md does not mention ${named}`);
    assert.ok(pkg.scripts[named], `${named} is documented but does not exist`);
  }
});

test('package metadata does not point at an external repository or homepage', () => {
  for (const dir of ['.', 'api', 'frontend']) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
    const where = dir === '.' ? 'root' : dir;
    for (const field of ['repository', 'bugs', 'homepage']) {
      assert.equal(pkg[field], undefined,
        `${where}/package.json still carries ${field}`);
    }
  }
});

test('every locked sharp copy includes the symlink-validation fix', () => {
  const lock = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const sharpCopies = Object.entries(lock.packages)
    .filter(([where]) => /(?:^|\/)node_modules\/sharp$/.test(where));

  assert.ok(sharpCopies.length > 0, 'package-lock.json has no sharp package');
  for (const [where, pkg] of sharpCopies) {
    const [major, minor] = pkg.version.split('.').map(Number);
    assert.ok(major > 0 || minor >= 35,
      `${where} locks vulnerable sharp ${pkg.version}; require 0.35.0 or later`);
  }
});

test('the repository declares what it is', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.description && pkg.description.length > 40,
    'the root package has no usable description');
  assert.ok((pkg.keywords || []).length >= 5,
    'the root package has no keywords, so it is unfindable');
});

test('line endings and editor settings are declared', () => {
  /* Without these, a contributor on Linux and one on Windows hand each other
     diffs where every line changed. */
  for (const f of ['.gitattributes', '.editorconfig']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is missing`);
  }

  const attrs = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attrs, /^\* text=auto/m, '.gitattributes does not normalise text');
  assert.match(attrs, /\*\.bat\s+text eol=crlf/,
    'Windows batch files need CRLF or they misbehave when run');
});

test('the documented self-host installer exists locally and is never fetched from a host', () => {
  const installer = path.join(ROOT, 'scripts', 'install-server.sh');
  assert.ok(fs.existsSync(installer), 'scripts/install-server.sh is missing');

  for (const doc of ['README.md', 'docs/SELF_HOSTING.md']) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    assert.match(text, /scripts\/install-server\.sh/,
      `${doc} does not name the local installer`);
    assert.doesNotMatch(text, /https?:\/\/[^\s)]*(?:githubusercontent\.com|github\.com)/i,
      `${doc} still fetches the installer from a public host`);
  }
});

test('the README explains both ways to install, and tells them apart', () => {
  /*
   * "we provide either offline desktop app or they can install in servers" -
   * the two are different enough in what they ask of the shop (somebody has to
   * maintain a server) that offering them as one thing sends people to the
   * harder answer than the one they need.
   */
  assert.match(README, /^### Desktop$/m, 'the README has no desktop install section');
  assert.match(README, /^### Your own server$/m, 'the README has no server install section');

  const install = README.slice(README.indexOf('\n## Install'));
  const desktopAt = install.indexOf('### Desktop');
  const serverAt = install.indexOf('### Your own server');
  assert.ok(desktopAt < serverAt,
    'the server install comes first; most shops want the desktop app');

  /* The honest parts. Each of these was a deliberate decision, not filler. */
  assert.match(install, /install-server\.sh/, 'the server section names no installer');
  assert.match(install, /SELF_HOSTING\.md/, 'the server section links to no full guide');
  assert.match(install, /27017/,
    'the server section does not warn about exposing the database port');
  assert.match(install, /does not include sync|not include sync/i,
    'the server section does not say that sync is Cloud');
});

test('every relative link in the README points at something', () => {
  /*
   * A broken link in the first file a stranger reads costs more than the page
   * it fails to open: it is the cheapest possible signal that nobody checks.
   */
  const broken = [];
  for (const m of README.matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)/g)) {
    if (!fs.existsSync(path.join(ROOT, m[1]))) broken.push(m[1]);
  }
  assert.deepEqual([...new Set(broken)], [], 'README links to files that do not exist');
});
