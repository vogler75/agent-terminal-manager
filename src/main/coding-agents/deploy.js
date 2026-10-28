'use strict';
// Deploys the project's selected MCP servers and skills to all coding agents found on the project's machine.
// Two round trips: (1) detect agents + read config files and our manifest, (2) write merged files.
const { Target, parseSections } = require('./target');
const { registry } = require('./registry');
const secrets = require('../secrets');

// Manifest of what this app deployed, stored next to the configs it manages.
const MANIFEST = {
  project: { base: 'project', rel: '.agent-terminal-manager/deployed.json' },
  user: { base: 'home', rel: '.config/agent-terminal-manager/deployed.json' },
};

const sanitizeName = (n) => String(n || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

class AgentSetup {
  constructor({ store, skills, audit }) {
    this.store = store;
    this.skills = skills;
    this.audit = audit;
  }

  agents() {
    return registry.map((a) => ({
      id: a.id, name: a.name, bin: a.bin, homepage: a.homepage, notes: a.notes,
      install: a.install, mcpScopes: a.mcpScopes, skillScopes: a.skillScopes,
    }));
  }

  // MCP library entries with decrypted env/headers, ready for adapters.
  resolveServers(ids) {
    const lib = this.store.data.mcpLibrary || [];
    return (ids || []).map((id) => lib.find((x) => x.id === id)).filter(Boolean).map((e) => {
      const sec = secrets.decrypt(e.secrets);
      return {
        name: sanitizeName(e.name),
        type: e.type === 'http' ? 'http' : 'stdio',
        command: e.command || '',
        args: e.args || [],
        env: sec.env || {},
        url: e.url || '',
        headers: sec.headers || {},
      };
    });
  }

  _target(project) {
    const host = project.hostId ? this.store.getHost(project.hostId) : null;
    return new Target(project, host);
  }

  _selectedAgents(setup) {
    const ids = setup.agents && setup.agents !== 'auto' && setup.agents.length ? setup.agents : null;
    return registry.filter((a) => !ids || ids.includes(a.id));
  }

  async detect(project) {
    const t = this._target(project);
    const script = [t.preamble(), ...registry.map((a) => t.detectSnippet(a.id, a.bin, a.versionArgs))].join('\n');
    const r = await t.run(script, { timeout: 60000 });
    const parsed = parseSections(r.out);
    if (!Object.keys(parsed.detect).length) throw new Error(`Could not run on the target: ${(r.err || r.out).trim().slice(0, 400)}`);
    return registry.map((a) => ({ id: a.id, name: a.name, ...(parsed.detect[a.id] || { installed: false }) }));
  }

  installCommand(project, agentId) {
    const a = registry.find((x) => x.id === agentId);
    if (!a) throw new Error('unknown agent ' + agentId);
    const t = this._target(project);
    const cmd = a.installCommand(t.kind);
    if (!cmd) throw new Error(`${a.name} has no install command for ${t.kind === 'powershell' ? 'Windows PowerShell' : 'Linux/macOS'}`);
    return { command: cmd, kind: t.kind };
  }

  async deploy(project) {
    const setup = { scope: 'project', agents: 'auto', mcp: [], skills: [], ...(project.agentSetup || {}) };
    const scope = setup.scope === 'user' ? 'user' : 'project';
    const t = this._target(project);
    const agents = this._selectedAgents(setup);
    const servers = this.resolveServers(setup.mcp);
    const skillNames = (setup.skills || []).filter(Boolean);
    const skillFiles = new Map(skillNames.map((n) => [n, this.skills.load(n)]));
    const report = { project: project.name, scope, target: t.kind, dir: t.dir, agents: [], errors: [] };

    // ---- 1. read ----
    const fileKeys = new Map(); // key -> loc
    const keyOf = (loc) => `${loc.base}:${loc.rel}`;
    fileKeys.set('manifest', MANIFEST[scope]);
    for (const a of agents) {
      const f = a.supportsMcp(scope) && a.mcpFile(scope, t.kind);
      if (f) fileKeys.set(keyOf(f), f);
    }
    const keyIds = new Map([...fileKeys.keys()].map((k, i) => [k, 'f' + i]));
    const readScript = [
      t.preamble(),
      ...agents.map((a) => t.detectSnippet(a.id, a.bin, a.versionArgs)),
      ...[...fileKeys.entries()].map(([k, loc]) => t.readSnippet(keyIds.get(k), loc)),
    ].join('\n');
    const r1 = await t.run(readScript, { timeout: 90000 });
    const read = parseSections(r1.out);
    if (!Object.keys(read.detect).length) throw new Error(`Could not run on the target: ${(r1.err || r1.out).trim().slice(0, 400)}`);

    let manifest = {};
    try { manifest = JSON.parse(read.file[keyIds.get('manifest')] || '{}'); } catch { manifest = {}; }
    const files = new Map(); // key -> current content (string|null)
    for (const [k] of fileKeys) if (k !== 'manifest') files.set(k, read.file[keyIds.get(k)] ?? null);
    const changedFiles = new Set();
    const writes = [];
    const commands = [];
    const nextManifest = {};

    // ---- 2. plan per agent ----
    const skillDirsDone = new Map(); // dir key -> agent name that already handles it
    for (const a of agents) {
      const det = read.detect[a.id] || { installed: false };
      const prev = manifest[a.id] || { mcp: [], skills: [] };
      const entry = { id: a.id, name: a.name, installed: det.installed, working: det.working !== false, version: det.version || '', mcp: null, skills: null, warnings: [] };
      if (det.installed && det.working === false) entry.warnings.push(`Found but not working: ${det.problem}`);
      report.agents.push(entry);
      if (!det.installed) {
        // Keep the previous manifest entry so a later deploy can still clean up.
        if (manifest[a.id]) nextManifest[a.id] = prev;
        continue;
      }
      const record = { mcp: [], skills: [] };

      // MCP
      if (a.supportsMcp(scope)) {
        const f = a.mcpFile(scope, t.kind);
        const k = keyOf(f);
        try {
          const res = a.applyMcp(files.get(k), servers, prev.mcp || [], t.kind, det);
          if (res.commands) commands.push(...res.commands.map((c, i) => ({ key: `${a.id}-${i}`, agent: a.id, cmd: c })));
          if (res.content !== undefined && res.content !== files.get(k)) { files.set(k, res.content); changedFiles.add(k); }
          entry.mcp = { file: t.displayPath(f), added: res.added, removed: res.removed, skipped: res.skipped };
          record.mcp = res.added;
        } catch (e) {
          entry.mcp = { file: t.displayPath(f), error: e.message };
          record.mcp = prev.mcp || [];
        }
      } else if (servers.length) {
        entry.warnings.push(`MCP is not supported for ${a.name} in ${scope} scope`);
      }

      // Skills
      const dir = a.supportsSkills(scope) && a.skillsDir(scope, t.kind);
      if (dir) {
        const dk = keyOf(dir);
        const shared = skillDirsDone.get(dk);
        const removedSkills = (prev.skills || []).filter((n) => !skillNames.includes(n));
        if (!shared) {
          skillDirsDone.set(dk, a.name);
          for (const n of removedSkills) writes.push({ remove: { base: dir.base, rel: `${dir.rel}/${n}` } });
          for (const n of skillNames) {
            writes.push({ remove: { base: dir.base, rel: `${dir.rel}/${n}` } });
            for (const f of skillFiles.get(n)) writes.push({ loc: { base: dir.base, rel: `${dir.rel}/${n}/${f.rel}` }, content: { base64: f.content } });
          }
        }
        entry.skills = { dir: t.displayPath(dir), written: skillNames, removed: removedSkills, sharedWith: shared || null };
        record.skills = skillNames;
      } else if (skillNames.length) {
        entry.warnings.push(`Skills are not supported for ${a.name} in ${scope} scope`);
      }
      nextManifest[a.id] = record;
    }

    // ---- 3. write ----
    for (const k of changedFiles) writes.push({ loc: fileKeys.get(k), content: files.get(k) });
    writes.push({ loc: MANIFEST[scope], content: JSON.stringify({ ...nextManifest, _updated: new Date().toISOString() }, null, 2) + '\n' });
    const writeScript = [
      t.preamble(),
      t.strict(true),
      ...writes.map((w) => (w.remove ? t.removeDirSnippet(w.remove) : t.writeSnippet(w.loc, w.content))),
      t.strict(false),
      ...commands.map((c) => t.commandSnippet(c.key, c.cmd)),
      t.echo('@@ATM_DONE'),
    ].join('\n');
    const r2 = await t.run(writeScript, { timeout: 120000 });
    const done = r2.out.includes('@@ATM_DONE');
    if (!done || (r2.code !== 0 && t.kind === 'posix')) report.errors.push(`Writing failed: ${(r2.err || r2.out).trim().slice(-600)}`);
    const cmdRes = parseSections(r2.out).cmd;
    for (const c of commands) {
      const res = cmdRes[c.key];
      const entry = report.agents.find((x) => x.id === c.agent);
      if (!res || !res.ok) entry.warnings.push(`Command failed: ${c.cmd}\n${res ? res.output.slice(-400) : 'no output'}`);
    }
    report.ok = !report.errors.length && report.agents.every((a) => !(a.mcp && a.mcp.error));
    report.time = Date.now();
    this.audit.add({ source: 'app', action: 'agents.deploy', detail: `${project.name}: ${report.agents.filter((a) => a.installed).map((a) => a.name).join(', ') || 'no agents found'}`, error: report.ok ? undefined : 'see report' });
    return report;
  }
}

module.exports = { AgentSetup, sanitizeName, MANIFEST };
