// Structured chat view for OpenCode agent sessions (and reused by the orchestrator view).
import { h, clear, toast, modal } from './ui.js';

export function renderMessages(container, messages, live, { compact = false } = {}) {
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  // Expanded tool calls stay expanded across live re-renders.
  const open = container._openTools || (container._openTools = new Set());
  clear(container);
  const list = (messages || []).filter((m) => m.role !== 'idle');
  const shown = compact ? list.slice(-6) : list;
  let toolGroup = null; // consecutive tool-only assistant messages share one box
  for (const m of shown) {
    const tools = m.tools || [];
    const isEvent = m.role === 'user' && (m.text || '').startsWith('[TermClaw event]');
    if (m.role === 'assistant' && !m.text && tools.length && !m.error) {
      if (!toolGroup) {
        toolGroup = h('div', { class: 'msg assistant tools-only' }, m.time && !compact ? h('div', { class: 'meta' }, new Date(m.time).toLocaleTimeString()) : null);
        container.appendChild(toolGroup);
      }
      tools.forEach((t, i) => toolGroup.appendChild(toolLine(t, `${m.id}:${t.id || i}`, open, compact)));
      continue;
    }
    toolGroup = null;
    const thinking = m.role === 'assistant' && !m.text && !tools.length && !m.done;
    const el = h('div', { class: 'msg ' + (isEvent ? 'event' : m.role) },
      m.time && !compact ? h('div', { class: 'meta' }, new Date(m.time).toLocaleTimeString() + (isEvent ? ' · event' : '')) : null,
      thinking ? h('span', { class: 'thinking' }, 'thinking…')
        : m.role === 'assistant' && !compact ? markdown(m.text || '') : (m.text || ''),
      m.error ? h('div', { class: 'bad' }, m.error) : null,
      tools.length ? h('div', { class: 'tool-list' }, tools.map((t, i) => toolLine(t, `${m.id}:${t.id || i}`, open, compact))) : null);
    container.appendChild(el);
  }
  if (live) container.appendChild(h('div', { class: 'msg assistant live' }, compact ? live : markdown(live)));
  if (!shown.length && !live) container.appendChild(h('div', { class: 'muted' }, 'No messages yet.'));
  if (atBottom || compact) container.scrollTop = container.scrollHeight;
}

const TOOL_ICON = { completed: '✓', error: '✗', failed: '✗', running: '◌', pending: '◌', in_progress: '◌', streaming: '◌' };

// The most telling argument of a tool call (path, pattern, command, ...), shortened.
function toolSubject(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['path', 'filePath', 'file_path', 'fileName', 'pattern', 'command', 'cmd', 'url', 'query', 'description', 'prompt']) {
    if (typeof input[k] === 'string' && input[k]) return input[k];
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v);
  return first || '';
}

// First meaningful line of a tool result, e.g. "Found 8 matches" or "Read file …, lines 1-426".
function toolSummary(result) {
  const line = String(result || '').split('\n').map((l) => l.trim()).find((l) => l && !/^[{[]/.test(l));
  return line ? line.replace(/^→\s*/, '').slice(0, 120) : '';
}

function toolLine(t, key, open, compact) {
  const icon = TOOL_ICON[t.status] || '•';
  const cls = t.status === 'completed' ? 'ok' : (t.status === 'error' || t.status === 'failed') ? 'bad' : 'warn';
  const head = h('summary', { class: 'tool-head' },
    h('span', { class: 'tool-icon ' + cls }, icon),
    h('span', { class: 'tool-name' }, t.name || 'tool'),
    h('span', { class: 'tool-subject mono' }, toolSubject(t.input)),
    !compact ? h('span', { class: 'tool-summary' }, toolSummary(t.result)) : null);
  if (compact) return h('div', { class: 'tool-call' }, head);
  const det = h('details', { class: 'tool-call', open: open.has(key) },
    head,
    h('div', { class: 'tool-body' },
      t.input ? h('div', { class: 'tool-label' }, 'Input') : null,
      t.input ? h('pre', { class: 'tool-pre' }, JSON.stringify(t.input, null, 2)) : null,
      t.result ? h('div', { class: 'tool-label' }, 'Output') : null,
      t.result ? h('pre', { class: 'tool-pre' }, t.result) : null));
  det.addEventListener('toggle', () => { if (det.open) open.add(key); else open.delete(key); });
  return det;
}

// Small Markdown renderer for agent answers (code blocks, inline code, bold, headings, lists).
// Builds DOM nodes, never HTML strings, so agent output cannot inject markup.
function markdown(text) {
  const root = h('div', { class: 'md' });
  const parts = String(text).split(/^```[^\n]*\n?/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { root.appendChild(h('pre', { class: 'md-code' }, part.replace(/\n$/, ''))); return; }
    let listEl = null;
    for (const raw of part.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      const head = /^(#{1,4})\s+(.*)$/.exec(line);
      const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      if (item) {
        if (!listEl) { listEl = h(/^\s*\d/.test(line) ? 'ol' : 'ul'); root.appendChild(listEl); }
        listEl.appendChild(h('li', null, inline(item[1])));
        continue;
      }
      listEl = null;
      if (head) root.appendChild(h('div', { class: 'md-h md-h' + head[1].length }, inline(head[2])));
      else if (line.trim()) root.appendChild(h('p', null, inline(line)));
    }
  });
  return root;
}

function inline(text) {
  const out = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[0].startsWith('`') ? h('code', { class: 'md-inline' }, m[0].slice(1, -1)) : h('b', null, m[0].slice(2, -2)));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderChat(ctx, box, s, { compact = false } = {}) {
  const { S, call, STATUS_LABEL } = ctx;
  const log = h('div', { class: 'chat-log', 'data-sid': s.id, 'data-compact': compact ? '1' : '' });
  const status = h('div', { class: 'chat-status', 'data-chat-status': s.id });
  const perm = h('div', { class: 'perm-box', 'data-perm': s.id });
  const chat = h('div', { class: 'chat' }, compact ? null : status, log, compact ? null : perm);
  box.appendChild(chat);
  fillStatus(ctx, status, s);
  if (!compact) {
    const ta = h('textarea', { placeholder: s.kind === 'acp'
      ? 'Prompt for the agent… (Enter to send, Shift+Enter for a new line, / for commands)'
      : 'Prompt for the agent… (Enter to send, Shift+Enter for a new line, / for commands, !cmd for shell)' });
    // The chat view is redrawn on status changes: keep the draft and the focus across redraws.
    const drafts = S.chatDrafts || (S.chatDrafts = new Map());
    ta.value = drafts.get(s.id) || '';
    ta.addEventListener('input', () => drafts.set(s.id, ta.value));
    ta.addEventListener('focus', () => { S.chatFocus = s.id; });
    ta.addEventListener('blur', () => { setTimeout(() => { if (S.chatFocus === s.id && !document.activeElement?.closest?.('.chat-input')) S.chatFocus = null; }, 0); });
    // A microtask runs right after this redraw, before the next key event, so no keystroke is lost.
    if (S.chatFocus === s.id) queueMicrotask(() => { if (ta.isConnected) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; } });
    const slash = slashMenu(ctx, s.id, ta);
    // After a redraw, reopen the command menu for a restored "/..." draft.
    if (S.chatFocus === s.id && /^\/\S*$/.test(ta.value)) queueMicrotask(() => { if (ta.isConnected) ta.dispatchEvent(new Event('input')); });
    const sendIt = async () => {
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      drafts.delete(s.id);
      slash.close();
      try {
        if (/^[/!]/.test(text)) await runSlash(ctx, s.id, text);
        else await call('agentSend', s.id, text);
      } catch (e) { toast(e.message, { error: true }); ta.value = text; }
    };
    ta.addEventListener('keydown', (e) => {
      if (slash.onKey(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt(); }
    });
    chat.appendChild(h('div', { class: 'chat-input', style: { position: 'relative' } }, slash.el, ta,
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('button', { class: 'primary', onclick: sendIt }, 'Send'),
        h('button', { onclick: () => call('agentInterrupt', s.id), title: 'Interrupt the current run' }, 'Stop'))));
  }
  renderMessages(log, S.agentMessages.get(s.id), S.agentLive.get(s.id), { compact });
  if (!compact) renderPermission(ctx, s.id);
}

export function fillStatus(ctx, el, s) {
  // Live usage updates redraw this bar; do not close a dropdown the user has open.
  if (document.activeElement && document.activeElement.tagName === 'SELECT' && el.contains(document.activeElement)) return;
  clear(el);
  const info = ctx.S.sessions.get(s.id) || s;
  // Element.append() would print null as text, so drop empty parts first.
  el.append(...[
    ctx.dot(info.status), h('span', null, ctx.STATUS_LABEL[info.status] || info.status),
    h('span', { title: info.agentSessionId ? `${info.kind === 'acp' ? 'ACP' : 'OpenCode'} session ${info.agentSessionId}${info.url ? ' at ' + info.url : ''}` : '' }, info.kind === 'acp' ? `${info.agentName || 'Agent'} · ACP` : 'OpenCode'),
    info.model ? h('button', { class: 'model-btn', title: 'Change the model of this session', onclick: () => pickModel(ctx, s.id) }, info.model + ' ▾')
      : info.status !== 'starting' && info.status !== 'error' ? h('span', { class: 'warn' }, '· no model — log in to a provider') : null,
    // Agent settings published over ACP, e.g. Copilot's Mode (agent / plan / autopilot).
    ...(info.agentOptions || []).map((o) => h('label', { class: 'status-select', title: o.description || o.name }, o.name,
      h('select', { onchange: (e) => ctx.call('agentSetOption', s.id, o.id, e.target.value).catch((err) => toast(err.message, { error: true })) },
        o.options.map((x) => h('option', { value: x.value, selected: x.value === o.current }, x.name))))),
    info.kind === 'acp' ? h('label', { class: 'status-select', title: 'How permission requests of the agent are answered' }, 'Approvals',
      h('select', { onchange: (e) => ctx.call('agentSetApproval', s.id, e.target.value) },
        [['ask', 'Ask'], ['reads', 'Auto-approve reads'], ['all', 'Auto-approve all']].map(([v, l]) => h('option', { value: v, selected: (info.approval || 'ask') === v }, l)))) : null,
    usageLabel(info.usage),
    h('span', { class: 'spacer' }),
    h('button', { title: info.kind === 'acp' ? `Open a terminal to log in to ${info.agentName || 'the agent'}` : 'Open a terminal with “opencode auth login” to connect a provider (API key or OAuth)', onclick: () => providerLogin(ctx, s.id) }, info.kind === 'acp' ? 'Login' : 'Provider login'),
    h('button', { class: 'icon', title: 'Refresh the model after logging in', onclick: () => ctx.call('agentRefreshModel', s.id) }, '↻'),
    info.status === 'error' ? h('button', { onclick: () => ctx.call('reconnect', s.id) }, 'Reconnect') : null,
    // Full-width block: start errors can span several lines (server log excerpt).
    info.error ? h('div', { class: 'bad mono', style: { flexBasis: '100%', whiteSpace: 'pre-wrap', fontSize: '12px', maxHeight: '220px', overflow: 'auto' } }, info.error) : null,
  ].filter(Boolean));
}

// Token usage: context window use (live while the agent works) and the session total.
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
function usageLabel(u) {
  if (!u || (!u.used && !u.totalTokens)) return null;
  const parts = [];
  if (u.used) parts.push(`context ${fmtTokens(u.used)}${u.size ? ' / ' + fmtTokens(u.size) + ` (${Math.round((u.used / u.size) * 100)}%)` : ''}`);
  if (u.totalTokens) parts.push(`${fmtTokens(u.totalTokens)} tokens`);
  if (u.cost && typeof u.cost.amount === 'number') parts.push(`${u.cost.currency === 'USD' ? '$' : (u.cost.currency || '') + ' '}${u.cost.amount.toFixed(u.cost.amount < 1 ? 3 : 2)}`);
  const title = `Context window: ${u.used || 0} of ${u.size || '?'} tokens\nThis session: ${u.inputTokens || 0} input + ${u.outputTokens || 0} output = ${u.totalTokens || 0} tokens in ${u.turns || 0} turn(s)`;
  return h('span', { class: 'usage', title }, '· ' + parts.join(' · '));
}

async function providerLogin(ctx, sessionId) {
  try { const t = await ctx.call('agentLogin', sessionId); ctx.selectSession(t.id); } catch (e) { toast(e.message, { error: true }); }
}

// Runs a slash command; commands that need UI (model picker, login, help) are handled here.
async function runSlash(ctx, sessionId, text) {
  const r = await ctx.call('agentRunSlash', sessionId, text);
  if (!r || r.handled !== 'ui') return;
  if (r.name === 'model') return pickModel(ctx, sessionId);
  if (r.name === 'login') return providerLogin(ctx, sessionId);
  if (r.name === 'help') {
    const c = await ctx.call('agentSlashCommands', sessionId);
    const row = (name, desc, tag) => h('tr', null, h('td', { class: 'mono' }, '/' + name), h('td', null, desc || ''), h('td', { class: 'muted' }, tag));
    modal({
      title: 'Commands', okText: null, cancelText: 'Close',
      body: h('table', { class: 'list' },
        c.builtin.map((x) => row(x.name + (x.args ? ' ' + x.args : ''), x.description, 'app')),
        c.commands.map((x) => row(x.name, x.description, 'command')),
        c.skills.map((x) => row(x.id, x.description.slice(0, 140), 'skill')),
        h('tr', null, h('td', { class: 'mono' }, '!<command>'), h('td', null, 'Run a shell command in the project'), h('td', { class: 'muted' }, 'app'))),
    });
  }
}

// Autocomplete list shown above the input while typing "/name".
function slashMenu(ctx, sessionId, ta) {
  const el = h('div', { class: 'slash-menu', style: { display: 'none' } });
  let items = [];
  let shown = [];
  let index = 0;
  let loaded = null;
  const load = () => loaded || (loaded = ctx.call('agentSlashCommands', sessionId).then((c) => {
    items = [
      ...c.builtin.map((x) => ({ name: x.name, desc: x.description, tag: 'app', args: x.args })),
      ...c.commands.map((x) => ({ name: x.name, desc: x.description, tag: 'command' })),
      ...c.skills.map((x) => ({ name: x.id, desc: x.description, tag: 'skill' })),
    ];
  }).catch(() => { loaded = null; }));
  const close = () => { el.style.display = 'none'; shown = []; };
  const render = () => {
    clear(el);
    shown.forEach((it, i) => el.appendChild(h('div', {
      class: 'slash-item' + (i === index ? ' active' : ''),
      onmousedown: (e) => { e.preventDefault(); index = i; complete(); },
    }, h('span', { class: 'mono' }, '/' + it.name + (it.args ? ' ' + it.args : '')), h('span', { class: 'muted' }, it.desc.slice(0, 90)), h('span', { class: 'tag' }, it.tag))));
    el.style.display = shown.length ? '' : 'none';
  };
  const update = async () => {
    const m = /^\/(\S*)$/.exec(ta.value);
    if (!m) return close();
    await load();
    const q = m[1].toLowerCase();
    shown = items.filter((it) => it.name.toLowerCase().startsWith(q)).concat(items.filter((it) => !it.name.toLowerCase().startsWith(q) && it.name.toLowerCase().includes(q))).slice(0, 12);
    index = Math.min(index, Math.max(0, shown.length - 1));
    render();
  };
  const complete = () => {
    const it = shown[index];
    if (!it) return;
    ta.value = '/' + it.name + ' ';
    close();
    ta.focus();
  };
  ta.addEventListener('input', () => { index = 0; update(); });
  ta.addEventListener('blur', () => setTimeout(close, 150));
  return {
    el,
    close,
    // Returns true when the key was used by the menu.
    onKey(e) {
      if (!shown.length) return false;
      if (e.key === 'ArrowDown') { index = (index + 1) % shown.length; render(); e.preventDefault(); return true; }
      if (e.key === 'ArrowUp') { index = (index - 1 + shown.length) % shown.length; render(); e.preventDefault(); return true; }
      if (e.key === 'Escape') { close(); e.preventDefault(); return true; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const it = shown[index];
        // Enter on an exact match without arguments runs it directly.
        if (e.key === 'Enter' && it && ta.value.trim() === '/' + it.name && !it.args) { close(); return false; }
        complete(); e.preventDefault(); return true;
      }
      return false;
    },
  };
}

// Model picker: models of all logged-in providers, grouped by provider, with search and effort (variant).
async function pickModel(ctx, sessionId) {
  let data;
  try { data = await ctx.call('agentModels', sessionId); } catch (e) { toast(e.message, { error: true }); return; }
  const { current, models } = data;
  let selected = current ? models.find((m) => m.providerID === current.providerID && m.id === current.id) : null;
  const search = h('input', { placeholder: `Search ${models.length} models…` });
  const list = h('div', { class: 'model-list' });
  const variant = h('select', { style: { width: 'auto' } });
  const fillVariants = () => {
    clear(variant);
    const vs = (selected && selected.variants) || [];
    variant.appendChild(h('option', { value: '' }, 'default'));
    for (const v of vs) variant.appendChild(h('option', { value: v, selected: current && current.variant === v && selected.id === current.id }, v));
    variant.disabled = !vs.length;
  };
  // Sorted by provider, then name, so each provider gets one header.
  const sorted = [...models].sort((a, b) => a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name));
  const isCurrent = (m) => current && m.providerID === current.providerID && m.id === current.id;
  const renderList = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const shown = sorted.filter((m) => !q || `${m.providerID}/${m.id} ${m.name}`.toLowerCase().includes(q));
    let provider = null;
    for (const m of shown) {
      if (m.providerID !== provider) {
        provider = m.providerID;
        list.appendChild(h('div', { class: 'model-group' }, provider));
      }
      list.appendChild(h('label', { class: 'model-row' + (selected === m ? ' selected' : '') },
        h('input', { type: 'radio', name: 'model', checked: selected === m, onchange: () => { selected = m; fillVariants(); renderList(); } }),
        h('span', { class: 'model-name' }, m.name, isCurrent(m) ? h('span', { class: 'tag', style: { marginLeft: '6px' } }, 'current') : null),
        h('span', { class: 'model-id mono' }, m.id)));
    }
    if (!shown.length) list.appendChild(h('div', { class: 'muted', style: { padding: '8px' } }, 'No model matches.'));
  };
  search.addEventListener('input', renderList);
  renderList();
  fillVariants();
  modal({
    title: 'Model for this agent session',
    body: h('div', null,
      search, h('div', { style: { height: '8px' } }), list,
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('span', { class: 'muted' }, 'Effort / variant:'), variant),
      h('p', { class: 'muted' }, 'Only models of logged-in providers are listed. Use “Provider login” to add more (e.g. Anthropic, OpenAI, GitHub Copilot).')),
    okText: 'Use model',
    onOk: async () => {
      if (!selected) throw new Error('Choose a model');
      await ctx.call('agentSetModel', sessionId, selected.providerID, selected.id, variant.value);
      toast(`Model: ${selected.providerID}/${selected.id}${variant.value ? ' (' + variant.value + ')' : ''}`);
    },
  });
}

// Permission request of an ACP agent (before a tool call): one button per option.
export function renderPermission(ctx, id) {
  const s = ctx.S.sessions.get(id);
  document.querySelectorAll(`.perm-box[data-perm="${id}"]`).forEach((el) => {
    clear(el);
    const p = s && s.permission;
    if (!p) return;
    const answer = async (optionId) => {
      try { await ctx.call('agentPermission', id, optionId); } catch (e) { toast(e.message, { error: true }); }
    };
    el.append(
      h('div', { class: 'perm-title' }, '⚠ The agent asks for permission: ', h('b', null, p.title)),
      p.input ? h('div', { class: 'tool' }, JSON.stringify(p.input).slice(0, 600)) : null,
      h('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap' } },
        ...(p.options || []).map((o) => h('button', { class: /allow/.test(o.kind) ? 'primary' : '', onclick: () => answer(o.id) }, o.name)),
        h('button', { onclick: () => answer(null) }, 'Cancel')));
  });
}

export function renderChatLog(ctx, id) {
  document.querySelectorAll(`.chat-log[data-sid="${id}"]`).forEach((el) => {
    renderMessages(el, ctx.S.agentMessages.get(id), ctx.S.agentLive.get(id), { compact: el.dataset.compact === '1' });
  });
}
