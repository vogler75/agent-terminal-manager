'use strict';
// "Test connection" for PowerShell remoting (WinRM) projects: is the port open, does the WinRM service answer,
// is the host trusted by this machine's WinRM client. The result carries hints for what to enable.
const { tcpCheck, runCapture } = require('./hosts');
const { psPort, psq } = require('./connect');

const IS_WIN = process.platform === 'win32';

// TrustedHosts is a comma separated list; * and wildcard patterns match.
function trustedMatches(list, host) {
  const h = String(host).toLowerCase();
  return String(list || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).some((p) => {
    if (p === '*' || p === h) return true;
    if (!p.includes('*')) return false;
    return new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(h);
  });
}

// What to do next, from the step results ({ tcp, wsman, trusted }).
function hintsFor(c, r) {
  const hints = [];
  const port = psPort(c.project);
  const ssl = !!(c.project.psremote && c.project.psremote.ssl);
  if (!r.tcp.ok) {
    hints.push(`Port ${port} on ${c.project.host} is not reachable (${r.tcp.error || 'no answer'}). Check the host name or IP address.`);
    hints.push('On the remote machine, in PowerShell as administrator: Enable-PSRemoting -Force' + (ssl ? ' (plus an HTTPS listener, see Setup help)' : ''));
    hints.push(`If the network of the remote machine is “Public”, Enable-PSRemoting refuses to open the firewall: run Enable-PSRemoting -Force -SkipNetworkProfileCheck, then Set-NetFirewallRule -Name 'WINRM-HTTP-In-TCP' -RemoteAddress Any (or set the network to Private).`);
    hints.push(`Windows Firewall must allow TCP ${port} (rule “Windows Remote Management (HTTP-In)”); a firewall in between must as well.`);
  } else if (!r.wsman.ok) {
    hints.push('The port is open but the WinRM service does not answer: on the remote machine run Enable-PSRemoting -Force (as administrator) and check Get-Service WinRM.');
    if (ssl) hints.push('For HTTPS the remote machine needs a listener with a certificate: winrm enumerate winrm/config/listener (see Setup help).');
  }
  if (r.trusted && r.trusted.known && !r.trusted.match && !ssl) {
    hints.push(`If ${c.project.host} is not in your Active Directory domain, this computer must trust it (as administrator): Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value ${c.project.host} -Concatenate -Force. Or use HTTPS, which does not need TrustedHosts.`);
  }
  if (c.project.user && /^[^\\@]+$/.test(c.project.user)) {
    hints.push('A local account on the remote machine must be a member of Administrators or “Remote Management Users”. For a local account use the form MACHINE\\user.');
  }
  return hints;
}

// c: { project } with the form values (host, user, psremote options); nothing needs to be saved.
async function testConnection(project) {
  if (!IS_WIN) return { ok: false, steps: [{ name: 'Client', ok: false, detail: 'PowerShell remoting (WinRM) needs the Windows version of TermClaw. Use an SSH project with OpenSSH on the Windows machine from here.' }], hints: [] };
  if (!project.host) return { ok: false, steps: [{ name: 'Host', ok: false, detail: 'Enter a host name or IP address first.' }], hints: [] };
  const port = psPort(project);
  const ssl = !!(project.psremote && project.psremote.ssl);
  const steps = [];
  const r = {};

  r.tcp = await tcpCheck(project.host, port, 4000);
  steps.push({ name: `TCP ${port}`, ok: r.tcp.ok, detail: r.tcp.ok ? `reachable (${r.tcp.ms} ms)` : `not reachable (${r.tcp.error || 'no answer'})` });

  r.wsman = { ok: false, detail: 'skipped' };
  r.trusted = { known: false };
  if (r.tcp.ok) {
    const script = [
      "$ProgressPreference = 'SilentlyContinue'",
      `$h = ${psq(project.host)}`,
      '$r = @{}',
      `try { $null = Test-WSMan -ComputerName $h -Port ${port}${ssl ? ' -UseSSL' : ''} -ErrorAction Stop; $r.wsman = 'ok' } catch { $r.wsman = $_.Exception.Message }`,
      'try { $r.trusted = [string](Get-Item WSMan:\\localhost\\Client\\TrustedHosts -ErrorAction Stop).Value; $r.trustedKnown = $true } catch { $r.trustedKnown = $false }',
      '$r | ConvertTo-Json -Compress',
    ].join('\n');
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const out = await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], 30000);
    let j = null;
    try { j = JSON.parse(out.out.split(/\r?\n/).filter((l) => l.startsWith('{')).pop()); } catch {}
    if (!j) {
      r.wsman = { ok: false, detail: out.out.replace(/<Objs[\s\S]*?<\/Objs>/g, '').trim().split(/\r?\n/).pop() || 'no answer from powershell.exe' };
    } else {
      r.wsman = { ok: j.wsman === 'ok', detail: j.wsman === 'ok' ? 'WinRM answers' : String(j.wsman).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) };
      if (j.trustedKnown) r.trusted = { known: true, match: trustedMatches(j.trusted, project.host), list: j.trusted || '' };
    }
    steps.push({ name: 'WinRM service', ok: r.wsman.ok, detail: r.wsman.detail });
    if (r.wsman.ok && !ssl) {
      steps.push(r.trusted.known
        ? { name: 'TrustedHosts', ok: r.trusted.match, detail: r.trusted.match ? 'host is trusted by this computer' : 'host is not in TrustedHosts (fine inside an Active Directory domain)', warn: !r.trusted.match }
        : { name: 'TrustedHosts', ok: true, detail: 'could not be read (needs administrator rights)', warn: true });
    }
  }
  const hints = hintsFor({ project }, r);
  return { ok: r.tcp.ok && r.wsman.ok, steps, hints };
}

module.exports = { testConnection, hintsFor, trustedMatches };
