const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'codemeta.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('CodeMeta preserves the product identity without an upstream URL', () => {
  assert.equal(metadata['@context'], 'https://w3id.org/codemeta/3.0');
  assert.equal(metadata['@type'], 'SoftwareSourceCode');
  assert.equal(metadata.name, 'Posnic POS');
  assert.equal(metadata['@id'], undefined);
  assert.equal(metadata.codeRepository, undefined);
  assert.equal(metadata.issueTracker, undefined);
  assert.equal(metadata.url, undefined);
});

test('CodeMeta states a version, and it cannot drift from package.json', () => {
  assert.equal(metadata.version, packageJson.version);
  assert.match(metadata.version, /^\d+\.\d+\.\d+/);

  const citation = fs.readFileSync(path.join(root, 'CITATION.cff'), 'utf8');
  const cffVersion = /^version:\s*(.+)$/m.exec(citation);
  assert.ok(cffVersion, 'CITATION.cff states no version');
  assert.equal(cffVersion[1].trim().replace(/^['"]|['"]$/g, ''), packageJson.version);

  const cffReleaseDate = /^date-released:\s*(.+)$/m.exec(citation);
  assert.ok(cffReleaseDate, 'CITATION.cff states no release date');
  const appstream = fs.readFileSync(
    path.join(root, 'builds/linux/com.posnic.app.metainfo.xml'), 'utf8',
  );
  const latestRelease = /<release version="([^"]+)" date="([^"]+)"/.exec(appstream);
  assert.ok(latestRelease, 'AppStream states no release');
  assert.equal(latestRelease[1], packageJson.version);
  assert.equal(cffReleaseDate[1].trim(), latestRelease[2]);
  assert.equal(metadata.releaseNotes, undefined);

  const cffLicense = /^license:\s*(.+)$/m.exec(citation);
  assert.equal(cffLicense[1].trim(), packageJson.license);
});

test('CodeMeta preserves the source licence and package-component boundary', () => {
  assert.equal(packageJson.license, 'AGPL-3.0-only');
  assert.equal(metadata.license, 'https://spdx.org/licenses/AGPL-3.0-only.html');
  assert.equal(metadata.isAccessibleForFree, true);
  assert.match(metadata.description, /separately licensed components/i);
  assert.match(metadata.description, /MongoDB Community Server under SSPL-1\.0/i);
});

test('CodeMeta publishes the verified publisher and supported platforms', () => {
  assert.equal(metadata.author.name, packageJson.author);
  assert.equal(metadata.publisher.name, packageJson.author);
  assert.deepEqual(metadata.operatingSystem, ['Windows', 'macOS', 'Linux']);
  assert.equal(metadata.maintainer.url, undefined);
});

test('project metadata uses only the standard schema and licence URLs', () => {
  const links = JSON.stringify(metadata).match(/https:\/\/[^"\\]+/g) || [];
  for (const link of links) {
    assert.ok(
      link.startsWith('https://w3id.org/codemeta/') || link.startsWith('https://spdx.org/licenses/'),
      `unexpected external metadata URL: ${link}`,
    );
  }
  assert.doesNotMatch(JSON.stringify(metadata), /posnic\.com|github\.com|githubusercontent\.com/i);
  assert.doesNotMatch(JSON.stringify(packageJson), /posnic\.com|github\.com|githubusercontent\.com/i);
});

test('README carries no upstream website or repository links', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /posnic\.com|github\.com|githubusercontent\.com|posnic\.github\.io/i);
});

test('CLA workflow keeps the agreement local and names no public host', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'cla.yml'), 'utf8');
  assert.ok(fs.existsSync(path.join(root, '.github', 'CLA.md')));
  assert.doesNotMatch(workflow, /github\.com|posnic\.com|path-to-document/i);
  assert.match(workflow, /branch:\s*cla-signatures/);
});
