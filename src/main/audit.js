'use strict';
// Audit log for MCP and orchestrator actions: kept in memory for the UI and appended to a file.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class AuditLog extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'audit.log');
    this.entries = [];
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-500);
      this.entries = lines.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {}
  }

  add(entry) {
    const e = { time: Date.now(), ...entry };
    this.entries.push(e);
    if (this.entries.length > 2000) this.entries.splice(0, this.entries.length - 2000);
    fs.appendFile(this.file, JSON.stringify(e) + '\n', () => {});
    this.emit('entry', e);
    return e;
  }

  list(limit = 500) { return this.entries.slice(-limit); }
}

module.exports = { AuditLog };
