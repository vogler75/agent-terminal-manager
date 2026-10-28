'use strict';
// Encrypts secret values (MCP env vars, headers) with the OS keychain via Electron safeStorage,
// so config.json never holds them in clear text.
let safeStorage = null;
try { ({ safeStorage } = require('electron')); } catch {}

const PREFIX = 'enc:';

function available() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
}

function encrypt(obj) {
  const text = JSON.stringify(obj || {});
  if (!available()) return 'plain:' + Buffer.from(text).toString('base64');
  return PREFIX + safeStorage.encryptString(text).toString('base64');
}

function decrypt(blob) {
  if (!blob) return {};
  try {
    if (blob.startsWith(PREFIX)) return JSON.parse(safeStorage.decryptString(Buffer.from(blob.slice(PREFIX.length), 'base64')));
    if (blob.startsWith('plain:')) return JSON.parse(Buffer.from(blob.slice(6), 'base64').toString('utf8'));
  } catch {}
  return {};
}

module.exports = { encrypt, decrypt, available };
