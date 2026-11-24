const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, 'codemeta.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

test('CodeMeta declares a current SoftwareSourceCode identity', () => {
  assert.equal(metadata['@context'], 'https://w3id.org/codemeta/3.0');
  assert.equal(metadata['@type'], 'SoftwareSourceCode');
  assert.equal(metadata.name, 'Posnic POS');
  assert.match(metadata.description, /point-of-sale software/i);
  assert.match(metadata.description, /AGPL-3\.0-only/i);
  assert.match(metadata.description, /separately licensed components/i);
  assert.equal(metadata.version, pkg.version);
  assert.equal(metadata.softwareVersion, pkg.version);
  assert.deepEqual(metadata.keywords, pkg.keywords);
});

test('CodeMeta keeps the source licence and package-component boundary', () => {
  assert.equal(metadata.license, 'https://spdx.org/licenses/AGPL-3.0-only.html');
  assert.equal(metadata.isAccessibleForFree, true);
  assert.match(metadata.description, /separately licensed components/i);
  assert.match(metadata.description, /MongoDB Community Server under SSPL-1\.0/i);
});

test('CodeMeta identifies point-of-sale scope without promoting development as released', () => {
  assert.equal(metadata.applicationSubCategory, 'Point of sale software');
  assert.deepEqual(metadata.operatingSystem, ['Windows', 'macOS', 'Linux']);
  assert.deepEqual(metadata.runtimePlatform, ['Electron', 'Node.js', 'MongoDB']);
  assert.equal(metadata.isSourceCodeOf?.['@type'], 'SoftwareApplication');
  assert.equal(metadata.isSourceCodeOf?.name, 'Posnic POS');
  assert.equal(metadata.developmentStatus, 'active');
  assert.doesNotMatch(metadata.developmentStatus, /not a tagged release/i);
  assert.doesNotMatch(JSON.stringify(metadata), /aggregateRating|reviewRating|customer count/i);
});

test('CodeMeta and package metadata carry no former upstream links', () => {
  const code = JSON.stringify(metadata);
  assert.doesNotMatch(code, /posnic\.com|github\.com|githubusercontent\.com/i);
  for (const key of ['@id', 'codeRepository', 'issueTracker', 'continuousIntegration', 'url', 'downloadUrl', 'readme', 'releaseNotes', 'citation', 'softwareHelp', 'relatedLink']) {
    assert.equal(metadata[key], undefined, `codemeta.json still has ${key}`);
  }
  for (const dir of ['.', 'api', 'frontend']) {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
    for (const field of ['repository', 'bugs', 'homepage']) {
      assert.equal(p[field], undefined, `${dir}/package.json still has ${field}`);
    }
  }
});

test('README links to the local metadata files', () => {
  assert.match(readme, /\[Citation metadata\]\(CITATION\.cff\)/);
  assert.match(readme, /\[CodeMeta\]\(codemeta\.json\)/);
  assert.doesNotMatch(readme, /posnic\.com|github\.com|githubusercontent\.com/i);
});
