const fs = require('fs');
const path = require('path');

const templateRoot = path.join(
  __dirname,
  '..',
  'node_modules',
  'app-builder-lib',
  'templates',
  'nsis'
);
const templatePath = path.join(templateRoot, 'installSection.nsh');

/*
 * The NSIS installer is built with unicode: false, so every template it reads
 * has to be ASCII. electron-builder's templates have contained non-ASCII
 * characters in comments and messages before, which makes the ANSI compiler
 * reject a build that is otherwise fine. Normalise them at install/build time
 * rather than patching files inside node_modules by hand.
 */
const ASCII_REPLACEMENTS = new Map([
  ['С', 'S'],
  ['с', 'c'],
  ['—', '-'],
  ['–', '-'],
  ['’', "'"],
  ['‘', "'"],
  ['“', '"'],
  ['”', '"'],
  ['…', '...'],
  ['\u00a0', ' '],
]);

function toAscii(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x00-\x7F]/g, (char) => ASCII_REPLACEMENTS.get(char) ?? '?');
}

function nshFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return nshFiles(full);
    return entry.name.endsWith('.nsh') ? [full] : [];
  });
}

function normalizeNsisTemplates() {
  for (const file of nshFiles(templateRoot)) {
    const original = fs.readFileSync(file, 'utf8');
    const ascii = toAscii(original);
    if (ascii !== original) fs.writeFileSync(file, ascii, 'utf8');
  }
}

if (!fs.existsSync(templatePath)) {
  console.error(`electron-builder NSIS template not found: ${templatePath}`);
  process.exit(1);
}

normalizeNsisTemplates();

const hiddenDetails = 'SetDetailsPrint none';
const visibleDetails = 'SetDetailsPrint both';
const template = fs.readFileSync(templatePath, 'utf8');

if (template.includes(visibleDetails)) {
  console.log('Installer extraction details are already enabled.');
  process.exit(0);
}

if (!template.includes(hiddenDetails)) {
  console.error('Unsupported electron-builder NSIS template: details setting was not found.');
  process.exit(1);
}

fs.writeFileSync(templatePath, template.replace(hiddenDetails, visibleDetails), 'utf8');
console.log('Enabled file extraction details on the installer progress page.');
