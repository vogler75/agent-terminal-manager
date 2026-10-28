// Structured chat view for OpenCode agent sessions (and reused by the orchestrator view).
import { h, clear, toast } from './ui.js';

export function renderMessages(container, messages, live, { compact = false } = {}) {
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  clear(container);
  const list = (messages || []).filter((m) => m.role !== 'idle');
  const shown = compact ? list.slice(-6) : list;
  for (const m of shown) {
    const isEvent = m.role === 'user' && m.text.startsWith('[ATM event]');
    const el = h('div', { class: 'msg ' + (isEvent ? 'event' : m.role) },
      m.time && !compact ? h('div', { class: 'meta' }, new Date(m.time).toLocaleTimeString() + (isEvent ? ' · Ereignis' : '')) : null,
      m.text || (m.role === 'assistant' && !(m.tools || []).length ? (m.done ? '' : '…') : ''),
      m.error ? h('div', { class: 'bad' }, m.error) : null,
      (m.tools || []).map((t) => h('div', { class: 'tool' }, `⚙ ${t.name} · ${t.status || ''}` + (t.input && !compact ? '\n' + JSON.stringify(t.input).slice(0, 400) : '') + (t.result && !compact ? '\n→ ' + t.result.slice(0, 800) : ''))));
    container.appendChild(el);
  }
  if (live) container.appendChild(h('div', { class: 'msg assistant live' }, live));
  if (!shown.length && !live) container.appendChild(h('div', { class: 'muted' }, 'Noch keine Nachrichten.'));
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
    const ta = h('textarea', { placeholder: 'Prompt an den Agent… (Enter senden, Shift+Enter neue Zeile)' });
    const sendIt = async () => {
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      try { await call('agentSend', s.id, text); } catch (e) { toast(e.message, { error: true }); ta.value = text; }
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt(); } });
    chat.appendChild(h('div', { class: 'chat-input' }, ta,
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('button', { class: 'primary', onclick: sendIt }, 'Senden'),
        h('button', { onclick: () => call('agentInterrupt', s.id), title: 'Aktuelle Ausführung abbrechen' }, 'Stopp'))));
  }
  renderMessages(log, S.agentMessages.get(s.id), S.agentLive.get(s.id), { compact });
}

export function fillStatus(ctx, el, s) {
  clear(el);
  const info = ctx.S.sessions.get(s.id) || s;
  el.append(ctx.dot(info.status), h('span', null, ctx.STATUS_LABEL[info.status] || info.status),
    h('span', { class: 'muted' }, 'OpenCode' + (info.url ? ' · ' + info.url : '') + (info.agentSessionId ? ' · ' + info.agentSessionId : '')),
    info.error ? h('span', { class: 'bad' }, info.error) : null,
    h('span', { class: 'spacer' }),
    info.status === 'error' ? h('button', { onclick: () => ctx.call('reconnect', s.id) }, 'Neu verbinden') : null);
}

export function renderChatLog(ctx, id) {
  document.querySelectorAll(`.chat-log[data-sid="${id}"]`).forEach((el) => {
    renderMessages(el, ctx.S.agentMessages.get(id), ctx.S.agentLive.get(id), { compact: el.dataset.compact === '1' });
  });
}
