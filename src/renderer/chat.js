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
    const ta = h('textarea', { placeholder: 'Prompt for the agent… (Enter to send, Shift+Enter for a new line)' });
    const sendIt = async () => {
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      try { await call('agentSend', s.id, text); } catch (e) { toast(e.message, { error: true }); ta.value = text; }
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt(); } });
    chat.appendChild(h('div', { class: 'chat-input' }, ta,
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
    h('button', { title: 'Open a terminal with “opencode auth login” to connect a provider (API key or OAuth)', onclick: async () => {
      try { const t = await ctx.call('agentLogin', s.id); ctx.selectSession(t.id); } catch (e) { toast(e.message, { error: true }); }
    } }, 'Provider login'),
    h('button', { class: 'icon', title: 'Refresh the model after logging in', onclick: () => ctx.call('agentRefreshModel', s.id) }, '↻'),
    info.status === 'error' ? h('button', { onclick: () => ctx.call('reconnect', s.id) }, 'Reconnect') : null,
    // Full-width block: start errors can span several lines (server log excerpt).
    info.error ? h('div', { class: 'bad mono', style: { flexBasis: '100%', whiteSpace: 'pre-wrap', fontSize: '12px', maxHeight: '220px', overflow: 'auto' } }, info.error) : null,
  ].filter(Boolean));
}

// Model picker: models of all logged-in providers, grouped by provider, with search and effort (variant).
async function pickModel(ctx, sessionId) {
  let data;
  try { data = await ctx.call('agentModels', sessionId); } catch (e) { toast(e.message, { error: true }); return; }
  const { current, models } = data;
  let selected = current ? models.find((m) => m.providerID === current.providerID && m.id === current.id) : null;
  const search = h('input', { placeholder: `Search ${models.length} models…` });
  const list = h('div', { class: 'checklist', style: { maxHeight: '340px' } });
  const variant = h('select', { style: { width: 'auto' } });
  const fillVariants = () => {
    clear(variant);
    const vs = (selected && selected.variants) || [];
    variant.appendChild(h('option', { value: '' }, 'default'));
    for (const v of vs) variant.appendChild(h('option', { value: v, selected: current && current.variant === v && selected.id === current.id }, v));
    variant.disabled = !vs.length;
  };
  const renderList = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const shown = models.filter((m) => !q || `${m.providerID}/${m.id} ${m.name}`.toLowerCase().includes(q));
    let provider = null;
    for (const m of shown) {
      if (m.providerID !== provider) { provider = m.providerID; list.appendChild(h('div', { class: 'muted', style: { marginTop: '6px', fontSize: '11px', textTransform: 'uppercase' } }, provider)); }
      list.appendChild(h('label', null,
        h('input', { type: 'radio', name: 'model', checked: selected === m, onchange: () => { selected = m; fillVariants(); } }),
        m.name, h('span', { class: 'muted mono' }, m.id)));
    }
    if (!shown.length) list.appendChild(h('div', { class: 'muted' }, 'No model matches.'));
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
