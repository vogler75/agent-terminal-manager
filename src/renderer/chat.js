// Structured chat view for OpenCode agent sessions (and reused by the orchestrator view).
import { h, clear, toast, modal } from './ui.js';

export function renderMessages(container, messages, live, { compact = false } = {}) {
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  clear(container);
  const list = (messages || []).filter((m) => m.role !== 'idle');
  const shown = compact ? list.slice(-6) : list;
  for (const m of shown) {
    const isEvent = m.role === 'user' && m.text.startsWith('[ATM event]');
    const el = h('div', { class: 'msg ' + (isEvent ? 'event' : m.role) },
      m.time && !compact ? h('div', { class: 'meta' }, new Date(m.time).toLocaleTimeString() + (isEvent ? ' · event' : '')) : null,
      m.text || (m.role === 'assistant' && !(m.tools || []).length ? (m.done ? '' : '…') : ''),
      m.error ? h('div', { class: 'bad' }, m.error) : null,
      (m.tools || []).map((t) => h('div', { class: 'tool' }, `⚙ ${t.name} · ${t.status || ''}` + (t.input && !compact ? '\n' + JSON.stringify(t.input).slice(0, 400) : '') + (t.result && !compact ? '\n→ ' + t.result.slice(0, 800) : ''))));
    container.appendChild(el);
  }
  if (live) container.appendChild(h('div', { class: 'msg assistant live' }, live));
  if (!shown.length && !live) container.appendChild(h('div', { class: 'muted' }, 'No messages yet.'));
  if (atBottom || compact) container.scrollTop = container.scrollHeight;
}

export function renderChat(ctx, box, s, { compact = false } = {}) {
  const { S, call, STATUS_LABEL } = ctx;
  const log = h('div', { class: 'chat-log', 'data-sid': s.id, 'data-compact': compact ? '1' : '' });
  const status = h('div', { class: 'chat-status', 'data-chat-status': s.id });
  const chat = h('div', { class: 'chat' }, compact ? null : status, log);
  box.appendChild(chat);
  fillStatus(ctx, status, s);
  if (!compact) {
    const ta = h('textarea', { placeholder: 'Prompt for the agent… (Enter to send, Shift+Enter for a new line, / for commands, !cmd for shell)' });
    const slash = slashMenu(ctx, s.id, ta);
    const sendIt = async () => {
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
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
}

export function fillStatus(ctx, el, s) {
  clear(el);
  const info = ctx.S.sessions.get(s.id) || s;
  // Element.append() would print null as text, so drop empty parts first.
  el.append(...[
    ctx.dot(info.status), h('span', null, ctx.STATUS_LABEL[info.status] || info.status),
    h('span', { title: info.agentSessionId ? `OpenCode session ${info.agentSessionId} at ${info.url}` : '' }, 'OpenCode'),
    info.model ? h('button', { class: 'model-btn', title: 'Change the model of this session', onclick: () => pickModel(ctx, s.id) }, info.model + ' ▾')
      : info.status !== 'starting' && info.status !== 'error' ? h('span', { class: 'warn' }, '· no model — log in to a provider') : null,
    h('span', { class: 'spacer' }),
    h('button', { title: 'Open a terminal with “opencode auth login” to connect a provider (API key or OAuth)', onclick: () => providerLogin(ctx, s.id) }, 'Provider login'),
    h('button', { class: 'icon', title: 'Refresh the model after logging in', onclick: () => ctx.call('agentRefreshModel', s.id) }, '↻'),
    info.status === 'error' ? h('button', { onclick: () => ctx.call('reconnect', s.id) }, 'Reconnect') : null,
    // Full-width block: start errors can span several lines (server log excerpt).
    info.error ? h('div', { class: 'bad mono', style: { flexBasis: '100%', whiteSpace: 'pre-wrap', fontSize: '12px', maxHeight: '220px', overflow: 'auto' } }, info.error) : null,
  ].filter(Boolean));
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

export function renderChatLog(ctx, id) {
  document.querySelectorAll(`.chat-log[data-sid="${id}"]`).forEach((el) => {
    renderMessages(el, ctx.S.agentMessages.get(id), ctx.S.agentLive.get(id), { compact: el.dataset.compact === '1' });
  });
}
