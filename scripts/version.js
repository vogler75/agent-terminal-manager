'use strict';
// The release number lives in VERSION. This script copies it into package.json / package-lock.json,
// which electron-builder uses for the app version, the exe file version and the artifact names.
//
//   node scripts/version.js           sync package.json from VERSION (runs before every build)
//   node scripts/version.js 0.2.0     set a new version (VERSION + package.json + package-lock.json)
//   node scripts/version.js --check v0.2.0   exit 1 unless the tag matches VERSION (release workflow)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const versionFile = path.join(root, 'VERSION');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function read() {
  const v = fs.readFileSync(versionFile, 'utf8').trim();
  if (!SEMVER.test(v)) throw new Error(`VERSION must look like 1.2.3 (found "${v}")`);
  return v;
}

// Rewrites only the "version" field so the file's formatting stays as it is.
function setJsonVersion(file, v, { lockRoot = false } = {}) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return false;
  let text = fs.readFileSync(p, 'utf8');
  const before = text;
  text = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${v}$2`); // first occurrence = the package itself
  if (lockRoot) text = text.replace(/("packages"\s*:\s*\{\s*""\s*:\s*\{[^}]*?"version"\s*:\s*")[^"]*(")/, `$1${v}$2`);
  if (text !== before) fs.writeFileSync(p, text);
  return text !== before;
}

function sync(v) {
  const changed = [setJsonVersion('package.json', v), setJsonVersion('package-lock.json', v, { lockRoot: true })];
  if (changed.some(Boolean)) console.log(`version ${v} written to package.json${changed[1] ? ' and package-lock.json' : ''}`);
}

const [arg, tag] = process.argv.slice(2);
try {
  if (arg === '--check') {
    const v = read();
    const t = String(tag || '').replace(/^refs\/tags\//, '').replace(/^v/, '');
    if (t !== v) { console.error(`Tag ${tag} does not match VERSION ${v}. Set the version with "node scripts/version.js ${t}", commit, then tag.`); process.exit(1); }
    console.log(`tag matches VERSION ${v}`);
  } else if (arg) {
    if (!SEMVER.test(arg)) throw new Error(`Not a version: ${arg} (use 1.2.3)`);
    fs.writeFileSync(versionFile, arg + '\n');
    sync(arg);
    console.log(`VERSION = ${arg}. Commit, then: git tag v${arg} && git push origin v${arg}`);
  } else {
    sync(read());
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
