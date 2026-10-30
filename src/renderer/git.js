// Git tab of a project, in the style of GitHub Desktop: repository and branch pickers, a push / pull / fetch
// button, the changed files with checkboxes, a diff, a commit box and the history. The main process runs git
// on the project machine; this view polls the selected repository while it is visible.
import { h, clear, toast, confirmDialog, prompt, contextMenu, timeAgo } from './ui.js';
import * as files from './files.js';

const call = (m, ...a) => window.termclaw.call(m, ...a);
const POLL_MS = 6000;
const MAX_LINES = 6000;

const projects = new Map(); // projectId -> per-project view state (kept while switching tabs)
let mounted = null; // { ctx, projectId, root, els, timer }

function pstate(projectId) {
  let d = projects.get(projectId);
  if (!d) {
    d = {
      repos: null, roots: [], scanErr: '', scanning: false,
      repo: loadRepo(projectId), state: null, stateErr: '', loading: false,
      tab: 'changes', selFile: null, diff: null, diffErr: '', unchecked: new Map(), // repo -> Set of paths
      selCommit: null, commitInfo: null, commitFile: null, commitDiff: null,
      busy: '',
    };
    projects.set(projectId, d);
  }
  return d;
}

function loadRepo(projectId) { try { return JSON.parse(localStorage.getItem('gitRepo') || '{}')[projectId] || null; } catch { return null; } }
function saveRepo(projectId, repo) {
  try { const all = JSON.parse(localStorage.getItem('gitRepo') || '{}'); all[projectId] = repo; localStorage.setItem('gitRepo', JSON.stringify(all)); } catch {}
}

export function mount(ctx, el, projectId) {
  if (mounted) clearInterval(mounted.timer);
  const root = h('div', { class: 'gitv' });
  el.appendChild(root);
  mounted = { ctx, projectId, root, els: null, timer: setInterval(poll, POLL_MS) };
  build();
  const d = pstate(projectId);
  if (!d.repos) scan(false); else { draw(); refresh({ silent: true }); }
}

export function unmount() {
  if (!mounted) return;
  clearInterval(mounted.timer);
  closePopover();
  mounted = null;
}

const cur = () => (mounted ? pstate(mounted.projectId) : null);
const project = () => mounted && mounted.ctx.project(mounted.projectId);
const unchecked = (d) => { if (!d.unchecked.has(d.repo)) d.unchecked.set(d.repo, new Set()); return d.unchecked.get(d.repo); };
const sep = (repo) => (/^[A-Za-z]:[\\/]/.test(repo || '') ? '\\' : '/');
// Like Element.append, but skips null / false (as h() does).
const add = (el, ...c) => el.append(...c.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
const ago = (t) => (t ? timeAgo(t) + ' ago' : '');

// ---------- loading ----------

async function scan(force) {
  const d = cur();
  if (!d) return;
  const pid = mounted.projectId;
  d.scanning = true;
  d.scanErr = '';
  draw();
  try {
    const r = await call('gitRepos', pid, force);
    d.repos = r.repos;
    d.roots = r.roots;
    if (!d.repo || !r.repos.some((x) => x.path === d.repo)) d.repo = r.repos.length ? (r.repos.find((x) => x.changes) || r.repos[0]).path : null;
  } catch (e) {
    d.scanErr = e.message;
  }
  d.scanning = false;
  draw();
  if (d.repo) refresh();
}

async function refresh({ silent = false } = {}) {
  const d = cur();
  if (!d || !d.repo) return;
  const pid = mounted.projectId;
  const repo = d.repo;
  if (!silent) { d.loading = true; draw(); }
  try {
    const st = await call('gitState', pid, repo);
    if (cur() !== d || d.repo !== repo) return;
    d.state = st;
    d.stateErr = '';
    // keep the summary in the repository list current
    const r = d.repos && d.repos.find((x) => x.path === repo);
    if (r) Object.assign(r, { head: st.branch.head, ahead: st.branch.ahead, behind: st.branch.behind, changes: st.files.length });
    if (d.selFile && !st.files.some((f) => f.path === d.selFile)) { d.selFile = null; d.diff = null; }
    if (!d.selFile && st.files.length) d.selFile = st.files[0].path;
    if (d.tab === 'changes' && d.selFile) loadDiff();
    if (d.tab === 'history' && !d.selCommit && st.log.length) selectCommit(st.log[0].hash);
  } catch (e) {
    if (cur() !== d) return;
    d.stateErr = e.message;
  }
  d.loading = false;
  draw();
}

function poll() {
  const d = cur();
  if (!d || d.busy || d.loading || !document.hasFocus() || popover) return;
  refresh({ silent: true });
}

async function loadDiff() {
  const d = cur();
  const f = d && d.state && d.state.files.find((x) => x.path === d.selFile);
  if (!f) return;
  const key = d.repo + '\n' + f.path;
  try {
    const r = await call('gitDiff', mounted.projectId, d.repo, { ...f, initial: !!d.state.branch.initial });
    if (cur() !== d || d.repo + '\n' + d.selFile !== key) return;
    d.diff = { key, ...r };
    d.diffErr = '';
  } catch (e) {
    if (cur() !== d) return;
    d.diff = null;
    d.diffErr = e.message;
  }
  drawRight();
}

async function selectCommit(hash) {
  const d = cur();
  d.selCommit = hash;
  d.commitInfo = null;
  d.commitFile = null;
  d.commitDiff = null;
  draw();
  try {
    const info = await call('gitCommitInfo', mounted.projectId, d.repo, hash);
    if (cur() !== d || d.selCommit !== hash) return;
    d.commitInfo = info;
    if (info.files.length) return selectCommitFile(info.files[0]);
  } catch (e) {
    if (cur() === d) toast(e.message, { error: true });
  }
  drawRight();
}

async function selectCommitFile(f) {
  const d = cur();
  d.commitFile = f;
  d.commitDiff = null;
  drawRight();
  try {
    const r = await call('gitCommitDiff', mounted.projectId, d.repo, d.selCommit, f);
    if (cur() !== d || d.commitFile !== f) return;
    d.commitDiff = r;
  } catch (e) {
    if (cur() === d) d.commitDiff = { error: e.message };
  }
  drawRight();
}

// Runs an action, then reloads the repository; returns true on success.
async function act(action, args, label) {
  const d = cur();
  if (!d || !d.repo || d.busy) return false;
  d.busy = label;
  draw();
  try {
    const r = await call('gitAction', mounted.projectId, d.repo, action, args || {});
    toast(r && r.output && action !== 'commit' ? r.output.split('\n').slice(-2).join(' · ') : `${label}: done`);
    return true;
  } catch (e) {
    toast(e.message, { error: true, ms: 9000 });
    return false;
  } finally {
    if (cur() === d) {
      d.busy = '';
      await refresh({ silent: true });
      draw();
    }
  }
}

// ---------- popover (repository and branch pickers) ----------

let popover = null;
function closePopover() {
  if (!popover) return;
  popover.el.remove();
  document.removeEventListener('mousedown', popover.off, true);
  document.removeEventListener('keydown', popover.key, true);
  popover = null;
}
function openPopover(anchor, content, width = 360) {
  closePopover();
  const r = anchor.getBoundingClientRect();
  const el = h('div', { class: 'git-pop', style: { left: Math.min(r.left, window.innerWidth - width - 8) + 'px', top: r.bottom + 4 + 'px', width: width + 'px' } }, content);
  document.body.appendChild(el);
  const off = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  setTimeout(() => { document.addEventListener('mousedown', off, true); document.addEventListener('keydown', key, true); }, 0);
  popover = { el, off, key };
  const inp = el.querySelector('input');
  if (inp) setTimeout(() => inp.focus(), 20);
}

function repoPicker(anchor) {
  const d = cur();
  const filter = h('input', { placeholder: 'Filter repositories' });
  const list = h('div', { class: 'git-pop-list' });
  const rel = (p) => {
    const root = d.roots.find((r) => p.startsWith(r.replace(/[\\/]+$/, '')));
    return root ? p.slice(root.replace(/[\\/]+$/, '').length).replace(/^[\\/]/, '') || p : p;
  };
  const fill = () => {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    const items = (d.repos || []).filter((r) => !q || r.path.toLowerCase().includes(q));
    if (!items.length) list.appendChild(h('div', { class: 'git-empty-row' }, d.repos && d.repos.length ? 'No match' : 'No repositories found'));
    for (const r of items) {
      list.appendChild(h('div', { class: 'git-pop-item' + (r.path === d.repo ? ' sel' : ''), title: r.path, onclick: () => { closePopover(); selectRepo(r.path); } },
        h('div', { class: 'git-pop-main' }, h('b', null, r.name), h('span', { class: 'muted' }, rel(r.path) !== r.name ? rel(r.path) : '')),
        h('span', { class: 'muted' }, r.head || ''),
        r.changes ? h('span', { class: 'git-count' }, r.changes) : null,
        r.ahead ? h('span', { class: 'muted' }, '↑' + r.ahead) : null));
    }
  };
  filter.addEventListener('input', fill);
  fill();
  openPopover(anchor, [
    h('div', { class: 'git-pop-head' }, filter),
    list,
    h('div', { class: 'git-pop-foot' },
      h('span', { class: 'muted', title: d.roots.join('\n') }, 'In ' + d.roots.join(', ')),
      h('div', { class: 'spacer' }),
      h('button', { onclick: () => { closePopover(); mounted.ctx.editProject(project()); } }, 'Folders…'),
      h('button', { onclick: () => { closePopover(); scan(true); } }, 'Rescan')),
  ], 420);
}

function selectRepo(path) {
  const d = cur();
  if (d.repo === path) return;
  d.repo = path;
  saveRepo(mounted.projectId, path);
  Object.assign(d, { state: null, stateErr: '', selFile: null, diff: null, selCommit: null, commitInfo: null, commitFile: null, commitDiff: null });
  mounted.els.summary.value = '';
  mounted.els.desc.value = '';
  draw();
  refresh();
}

function branchPicker(anchor) {
  const d = cur();
  const st = d.state;
  if (!st) return;
  const filter = h('input', { placeholder: 'Filter branches' });
  const list = h('div', { class: 'git-pop-list' });
  const localNames = new Set(st.branches.local.map((b) => b.name));
  const track = (b) => [b.ahead ? '↑' + b.ahead : '', b.behind ? '↓' + b.behind : '', b.gone ? 'upstream gone' : ''].filter(Boolean).join(' ');
  const fill = () => {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    const loc = st.branches.local.filter((b) => !q || b.name.toLowerCase().includes(q));
    const rem = st.branches.remote.filter((b) => !localNames.has(b.name.split('/').slice(1).join('/')) && (!q || b.name.toLowerCase().includes(q)));
    if (loc.length) list.appendChild(h('div', { class: 'git-pop-sect' }, 'Branches'));
    for (const b of loc) {
      list.appendChild(h('div', {
        class: 'git-pop-item' + (b.current ? ' sel' : ''),
        title: `${b.name}${b.upstream ? ' → ' + b.upstream : ''}\n${b.subject}`,
        onclick: () => { closePopover(); if (!b.current) checkout(b.name, false); },
        oncontextmenu: (e) => {
          e.preventDefault();
          if (b.current) return;
          contextMenu(e.clientX, e.clientY, [{ label: `Delete branch “${b.name}”…`, action: () => deleteBranch(b.name) }]);
        },
      }, h('span', { class: 'git-check' }, b.current ? '✓' : ''), h('div', { class: 'git-pop-main' }, h('span', null, b.name)), h('span', { class: 'muted' }, track(b)), h('span', { class: 'muted' }, ago(b.date))));
    }
    if (rem.length) list.appendChild(h('div', { class: 'git-pop-sect' }, 'Remote branches'));
    for (const b of rem) {
      list.appendChild(h('div', { class: 'git-pop-item', title: b.subject, onclick: () => { closePopover(); checkout(b.name, true); } },
        h('span', { class: 'git-check' }), h('div', { class: 'git-pop-main' }, h('span', null, b.name)), h('span', { class: 'muted' }, ago(b.date))));
    }
    if (!loc.length && !rem.length) list.appendChild(h('div', { class: 'git-empty-row' }, st.branch.initial ? 'No commits yet' : 'No match'));
  };
  filter.addEventListener('input', fill);
  fill();
  openPopover(anchor, [
    h('div', { class: 'git-pop-head' }, filter, h('button', { onclick: () => { closePopover(); newBranch(filter.value.trim()); } }, 'New branch')),
    list,
  ], 400);
}

async function checkout(name, remote) {
  const d = cur();
  if (d.state && d.state.files.length && !(await confirmDialog('Switch branch', h('div', null,
    h('p', null, `There are ${d.state.files.length} changed files. Git takes them along to “${remote ? name.split('/').slice(1).join('/') : name}” if they do not conflict; otherwise it refuses to switch.`),
    h('p', { class: 'muted' }, 'Commit or discard the changes first to be on the safe side.')), 'Switch'))) return;
  act('checkout', { name, remote }, 'Switch branch');
}

async function newBranch(initial) {
  const d = cur();
  const name = await prompt(`New branch (from ${d.state ? d.state.branch.head : 'HEAD'})`, initial || '');
  if (name) act('createBranch', { name: name.replace(/\s+/g, '-') }, 'New branch');
}

async function deleteBranch(name) {
  if (!(await confirmDialog('Delete branch', `Delete the local branch “${name}”? Git refuses when it has commits that are not merged.`, 'Delete'))) return;
  act('deleteBranch', { name }, 'Delete branch');
}

// ---------- sync button ----------

function syncInfo(st) {
  if (!st) return { label: 'Fetch origin', action: null };
  const b = st.branch;
  const remote = (st.remotes.find((r) => r.name === 'origin') || st.remotes[0] || {}).name;
  if (!remote) return { label: 'No remote', sub: 'nothing to push to', action: null };
  if (b.detached) return { label: 'Fetch ' + remote, sub: 'detached HEAD', action: 'fetch' };
  if (!b.upstream) return { label: 'Publish branch', sub: `push to ${remote}`, action: 'push', icon: '↑' };
  const up = b.upstream.split('/')[0];
  if (b.behind) return { label: 'Pull ' + up, sub: `${b.behind} behind${b.ahead ? `, ${b.ahead} ahead` : ''}`, action: 'pull', icon: '↓' };
  if (b.ahead) return { label: 'Push ' + up, sub: `${b.ahead} commit${b.ahead > 1 ? 's' : ''} ahead`, action: 'push', icon: '↑' };
  return { label: 'Fetch ' + up, sub: 'up to date', action: 'fetch', icon: '⟳' };
}

const ACTION_LABEL = { push: 'Push', pull: 'Pull', fetch: 'Fetch' };

function syncMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 2, [
    { label: 'Fetch (all remotes)', action: () => act('fetch', {}, 'Fetch') },
    { label: 'Pull (fast-forward only)', action: () => act('pull', {}, 'Pull') },
    { label: 'Push', action: () => act('push', {}, 'Push') },
  ]);
}

// ---------- layout ----------

function build() {
  const summary = h('input', { class: 'git-summary', placeholder: 'Summary (required)', oninput: () => drawCommitBox(), onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit(); } });
  const desc = h('textarea', { class: 'git-desc', placeholder: 'Description', rows: 3, onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit(); } });
  const commitBtn = h('button', { class: 'primary git-commit-btn', onclick: () => commit() }, 'Commit');
  const els = {
    toolbar: h('div', { class: 'git-toolbar' }),
    banner: h('div', { class: 'git-banner' }),
    tabs: h('div', { class: 'git-tabs' }),
    listHead: h('div', { class: 'git-list-head' }),
    list: h('div', { class: 'git-list' }),
    commitBox: h('div', { class: 'git-commitbox' }, summary, desc, commitBtn),
    right: h('div', { class: 'git-right' }),
    summary, desc, commitBtn,
  };
  mounted.els = els;
  mounted.root.append(els.toolbar, els.banner, h('div', { class: 'git-body' },
    h('div', { class: 'git-left' }, els.tabs, els.listHead, els.list, els.commitBox),
    els.right));
}

function draw() {
  if (!mounted) return;
  const d = cur();
  drawToolbar(d);
  drawBanner(d);
  const empty = !d.repo;
  mounted.root.classList.toggle('git-norepo', empty);
  drawLeft(d);
  drawCommitBox();
  drawRight();
}

function drawToolbar(d) {
  const st = d.state;
  const repo = d.repos && d.repos.find((r) => r.path === d.repo);
  const s = syncInfo(st);
  const b = st && st.branch;
  add(clear(mounted.els.toolbar), 
    h('button', { class: 'git-tool', title: d.repo || '', onclick: (e) => repoPicker(e.currentTarget) },
      h('span', { class: 'git-tool-label' }, 'Current repository'),
      h('span', { class: 'git-tool-value' }, d.scanning && !repo ? 'Searching…' : repo ? repo.name : 'None', ' ▾')),
    h('button', { class: 'git-tool', disabled: !st, title: b && b.upstream ? `${b.head} → ${b.upstream}` : '', onclick: (e) => branchPicker(e.currentTarget) },
      h('span', { class: 'git-tool-label' }, 'Current branch'),
      h('span', { class: 'git-tool-value' }, b ? (b.detached ? 'detached at ' + b.oid.slice(0, 7) : b.head) : '–', ' ▾')),
    h('span', { class: 'split-btn' },
      h('button', { class: 'git-tool', disabled: !s.action || !!d.busy, onclick: () => act(s.action, {}, ACTION_LABEL[s.action]) },
        h('span', { class: 'git-tool-label' }, d.busy ? d.busy + '…' : s.sub || ''),
        h('span', { class: 'git-tool-value' }, s.icon ? s.icon + ' ' : '', s.label)),
      h('button', { class: 'git-tool git-tool-more', disabled: !st || !!d.busy, title: 'Fetch, pull or push', onclick: syncMenu }, '▾')),
    h('div', { class: 'spacer' }),
    d.loading || d.scanning ? h('span', { class: 'muted' }, 'Loading…') : st ? h('span', { class: 'muted', title: 'Refreshed every few seconds while this tab is open' }, st.stashes ? `${st.stashes} stash${st.stashes > 1 ? 'es' : ''} · ` : '', (st.remotes[0] || {}).url || 'no remote') : null,
    h('button', { class: 'icon', title: 'Refresh (searches the folders again)', onclick: () => scan(true) }, '⟳'));
}

function drawBanner(d) {
  const msg = d.scanErr || d.stateErr;
  clear(mounted.els.banner);
  mounted.els.banner.style.display = msg ? '' : 'none';
  if (msg) add(mounted.els.banner, h('span', null, msg), h('button', { class: 'icon', onclick: () => (d.scanErr ? scan(true) : refresh()) }, 'Retry'));
}

function drawLeft(d) {
  const st = d.state;
  const els = mounted.els;
  clear(els.tabs);
  clear(els.listHead);
  clear(els.list);
  if (!d.repo) {
    els.tabs.style.display = 'none';
    els.listHead.style.display = 'none';
    add(els.list, h('div', { class: 'git-none' },
      d.scanning ? 'Searching for git repositories…' : h('div', null,
        h('div', null, 'No git repositories found in'),
        h('div', { class: 'mono' }, (d.roots || []).join(', ') || '…'),
        h('div', { class: 'muted', style: { margin: '8px 0' } }, 'TermClaw looks for .git folders up to the configured depth (hidden folders and node_modules are skipped).'),
        h('div', { class: 'row' }, h('button', { onclick: () => mounted.ctx.editProject(project()) }, 'Configure folders…'), h('button', { onclick: () => scan(true) }, 'Search again')))));
    return;
  }
  els.tabs.style.display = '';
  els.listHead.style.display = '';
  const n = st ? st.files.length : 0;
  add(els.tabs, 
    h('div', { class: 'git-tab' + (d.tab === 'changes' ? ' active' : ''), onclick: () => { d.tab = 'changes'; draw(); if (d.selFile) loadDiff(); } }, 'Changes', n ? h('span', { class: 'git-count' }, n) : null),
    h('div', { class: 'git-tab' + (d.tab === 'history' ? ' active' : ''), onclick: () => { d.tab = 'history'; draw(); if (!d.selCommit && st && st.log.length) selectCommit(st.log[0].hash); } }, 'History'));
  if (!st) { add(els.list, h('div', { class: 'git-none muted' }, d.stateErr ? '' : 'Loading…')); return; }
  if (d.tab === 'changes') drawChanges(d, st); else drawHistory(d, st);
}

const STATUS_ICON = { modified: ['M', 'mod'], new: ['+', 'add'], deleted: ['−', 'del'], renamed: ['→', 'ren'], copied: ['C', 'ren'], conflict: ['!', 'del'] };
const statusIcon = (status) => { const [t, c] = STATUS_ICON[status] || ['M', 'mod']; return h('span', { class: 'git-st git-st-' + c, title: status }, t); };

function fileLabel(p, orig) {
  const i = p.lastIndexOf('/');
  return h('span', { class: 'git-path', title: orig ? `${orig} → ${p}` : p },
    orig ? h('span', { class: 'muted' }, orig.split('/').pop() + ' → ') : null,
    i >= 0 ? h('span', { class: 'muted' }, p.slice(0, i + 1)) : null, p.slice(i + 1));
}

function drawChanges(d, st) {
  const els = mounted.els;
  const off = unchecked(d);
  for (const p of [...off]) if (!st.files.some((f) => f.path === p)) off.delete(p);
  const checkedCount = st.files.filter((f) => !off.has(f.path)).length;
  const all = h('input', { type: 'checkbox', checked: checkedCount === st.files.length && st.files.length > 0, disabled: !st.files.length, title: 'Select all',
    onchange: (e) => { if (e.target.checked) off.clear(); else st.files.forEach((f) => off.add(f.path)); draw(); } });
  all.indeterminate = checkedCount > 0 && checkedCount < st.files.length;
  add(els.listHead, all, h('span', null, st.files.length ? `${st.files.length} changed file${st.files.length > 1 ? 's' : ''}` : 'No local changes'), h('div', { class: 'spacer' }),
    st.files.length ? h('button', { class: 'icon', title: 'More', onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 2, [{ label: 'Discard all changes…', action: () => discard(st.files) }]);
    } }, '⋯') : null);
  if (!st.files.length) {
    add(els.list, h('div', { class: 'git-none' },
      h('div', { class: 'muted' }, `Branch ${st.branch.head}${st.branch.upstream ? ` · ${st.branch.ahead ? st.branch.ahead + ' to push' : st.branch.behind ? st.branch.behind + ' to pull' : 'up to date with ' + st.branch.upstream}` : ' · not published'}`)));
    return;
  }
  for (const f of st.files) {
    const cb = h('input', { type: 'checkbox', checked: !off.has(f.path), onclick: (e) => e.stopPropagation(), onchange: (e) => { if (e.target.checked) off.delete(f.path); else off.add(f.path); draw(); } });
    add(els.list, h('div', {
      class: 'git-row' + (d.selFile === f.path ? ' sel' : ''),
      onclick: () => { d.selFile = f.path; d.diff = null; d.diffErr = ''; drawLeft(d); drawRight(); loadDiff(); },
      oncontextmenu: (e) => { e.preventDefault(); fileMenu(e, f, st); },
    }, cb, fileLabel(f.path, f.orig), statusIcon(f.status)));
  }
}

function fileMenu(e, f, st) {
  const d = cur();
  const checked = st.files.filter((x) => !unchecked(d).has(x.path));
  const s = sep(d.repo);
  const full = d.repo.replace(/[\\/]+$/, '') + s + (s === '\\' ? f.path.replace(/\//g, '\\') : f.path);
  contextMenu(e.clientX, e.clientY, [
    { label: 'Discard changes…', action: () => discard([f]) },
    ...(checked.length > 1 ? [{ label: `Discard ${checked.length} selected changes…`, action: () => discard(checked) }] : []),
    '-',
    { label: 'Copy file path', action: () => navigator.clipboard.writeText(full) },
    { label: 'Copy relative path', action: () => navigator.clipboard.writeText(f.path) },
    { label: 'Show in file browser', action: () => files.openBrowser(mounted.ctx, mounted.projectId, full.slice(0, full.lastIndexOf(s)) || d.repo) },
  ]);
}

async function discard(list) {
  const del = list.filter((f) => f.x === '?' || f.x === 'A');
  const body = h('div', null,
    h('p', null, list.length === 1 ? `Discard the changes to “${list[0].path}”?` : `Discard the changes to ${list.length} files?`),
    list.length > 1 ? h('div', { class: 'git-confirm-list mono' }, list.slice(0, 30).map((f) => h('div', null, f.path)), list.length > 30 ? h('div', { class: 'muted' }, `… and ${list.length - 30} more`) : null) : null,
    h('p', { class: 'warn' }, del.length ? `The changes are lost. ${del.length} new file${del.length > 1 ? 's are' : ' is'} deleted permanently (there is no recycle bin on the project machine).` : 'The changes are lost; this cannot be undone.'));
  if (!(await confirmDialog('Discard changes', body, 'Discard'))) return;
  act('discard', { files: list.map((f) => ({ path: f.path, orig: f.orig, x: f.x, status: f.status })) }, 'Discard');
}

function drawCommitBox() {
  if (!mounted) return;
  const d = cur();
  const els = mounted.els;
  const st = d.state;
  els.commitBox.style.display = d.repo && d.tab === 'changes' ? '' : 'none';
  if (!st) { els.commitBtn.disabled = true; return; }
  const off = unchecked(d);
  const n = st.files.filter((f) => !off.has(f.path)).length;
  els.commitBtn.disabled = !n || !els.summary.value.trim() || !!d.busy || st.branch.detached;
  els.commitBtn.textContent = d.busy === 'Commit' ? 'Committing…' : `Commit ${n ? n + ' file' + (n > 1 ? 's' : '') + ' ' : ''}to ${st.branch.detached ? '(detached)' : st.branch.head}`;
  els.commitBtn.title = st.branch.detached ? 'Not on a branch' : !n ? 'Select files to commit' : !els.summary.value.trim() ? 'Enter a summary' : 'Ctrl+Enter';
}

async function commit() {
  const d = cur();
  const st = d && d.state;
  const els = mounted && mounted.els;
  if (!st || els.commitBtn.disabled) return;
  const off = unchecked(d);
  const sel = st.files.filter((f) => !off.has(f.path));
  const ok = await act('commit', {
    files: sel.map((f) => ({ path: f.path, orig: f.orig })),
    all: sel.length === st.files.length,
    summary: els.summary.value.trim(),
    description: els.desc.value,
  }, 'Commit');
  if (ok && mounted && cur() === d) {
    els.summary.value = '';
    els.desc.value = '';
    off.clear();
    drawCommitBox();
  }
}

function refBadges(refs) {
  return refs.filter((r) => r !== 'HEAD').map((r) => {
    const tag = r.startsWith('tag: ');
    const name = r.replace(/^HEAD -> /, '').replace(/^tag: /, '');
    return h('span', { class: 'git-ref' + (tag ? ' tag' : r.startsWith('HEAD -> ') ? ' head' : '') }, tag ? '🏷 ' + name : name);
  });
}

function drawHistory(d, st) {
  const els = mounted.els;
  const unpushed = new Set(st.unpushed || []);
  add(els.listHead, h('span', null, st.log.length ? `${st.branch.head}` : 'No commits yet'), h('div', { class: 'spacer' }),
    st.log.length >= 300 ? h('span', { class: 'muted' }, 'last 300') : null);
  st.log.forEach((c, i) => {
    add(els.list, h('div', {
      class: 'git-row git-commit' + (d.selCommit === c.hash ? ' sel' : ''),
      onclick: () => selectCommit(c.hash),
      oncontextmenu: (e) => {
        e.preventDefault();
        const canUndo = i === 0 && (st.unpushed ? unpushed.has(c.hash) : true) && c.parents.length === 1;
        contextMenu(e.clientX, e.clientY, [
          ...(canUndo ? [{ label: 'Undo commit (changes go back to the list)', action: () => act('undoCommit', {}, 'Undo commit') }] : []),
          { label: 'Revert changes in commit…', action: async () => { if (await confirmDialog('Revert commit', `Create a new commit that reverts “${c.subject}”?`, 'Revert')) act('revertCommit', { hash: c.hash }, 'Revert'); } },
          '-',
          { label: 'Copy SHA', action: () => navigator.clipboard.writeText(c.hash) },
          { label: 'Copy summary', action: () => navigator.clipboard.writeText(c.subject) },
        ]);
      },
    },
    h('div', { class: 'git-commit-main' },
      h('div', { class: 'git-commit-subject', title: c.subject }, c.subject || '(no message)'),
      h('div', { class: 'git-commit-meta' }, unpushed.has(c.hash) ? h('span', { class: 'git-unpushed', title: 'Not pushed yet' }, '↑') : null, c.author, ' · ', ago(c.date), refBadges(c.refs)))));
  });
}

// ---------- right pane: diff ----------

function drawRight() {
  if (!mounted) return;
  const d = cur();
  const el = clear(mounted.els.right);
  if (!d.repo || !d.state) return;
  if (d.tab === 'changes') {
    const f = d.state.files.find((x) => x.path === d.selFile);
    if (!f) {
      add(el, h('div', { class: 'git-none' }, d.state.files.length ? 'Select a file to see its changes' : h('div', null, h('div', { class: 'git-clean-title' }, 'No local changes'),
        h('div', { class: 'muted' }, 'There are no uncommitted changes in this repository.'))));
      return;
    }
    add(el, h('div', { class: 'git-diff-head' }, statusIcon(f.status), fileLabel(f.path, f.orig)));
    if (d.diffErr) add(el, h('div', { class: 'git-none bad' }, d.diffErr));
    else if (!d.diff || d.diff.key !== d.repo + '\n' + f.path) add(el, h('div', { class: 'git-none muted' }, 'Loading diff…'));
    else add(el, renderDiff(d.diff.diff, d.diff.truncated));
    return;
  }
  // history
  const c = d.commitInfo;
  if (!d.selCommit) { add(el, h('div', { class: 'git-none muted' }, 'Select a commit')); return; }
  if (!c) { add(el, h('div', { class: 'git-none muted' }, 'Loading…')); return; }
  add(el, h('div', { class: 'git-commit-head' },
    h('div', { class: 'git-commit-title' }, c.subject),
    c.body ? h('div', { class: 'git-commit-body' }, c.body) : null,
    h('div', { class: 'git-commit-meta' }, h('b', null, c.author), ` <${c.email}> · ${new Date(c.date).toLocaleString()} · `,
      h('span', { class: 'mono git-sha', title: 'Copy SHA', onclick: () => { navigator.clipboard.writeText(c.hash); toast('SHA copied'); } }, c.hash.slice(0, 10)),
      c.parents.length > 1 ? ' · merge commit (changes against the first parent)' : '', refBadges(c.refs))));
  const fl = h('div', { class: 'git-commit-files' },
    h('div', { class: 'git-list-head' }, `${c.files.length} changed file${c.files.length === 1 ? '' : 's'}`),
    c.files.map((f) => h('div', { class: 'git-row' + (d.commitFile === f ? ' sel' : ''), onclick: () => selectCommitFile(f) }, fileLabel(f.path, f.orig), statusIcon(f.status))));
  const diffBox = h('div', { class: 'git-commit-diff' });
  if (d.commitFile) {
    if (!d.commitDiff) add(diffBox, h('div', { class: 'git-none muted' }, 'Loading diff…'));
    else if (d.commitDiff.error) add(diffBox, h('div', { class: 'git-none bad' }, d.commitDiff.error));
    else add(diffBox, renderDiff(d.commitDiff.diff, d.commitDiff.truncated));
  }
  add(el, h('div', { class: 'git-commit-split' }, fl, diffBox));
}

// Unified diff → rows with old / new line numbers.
export function parseDiff(text) {
  const rows = [];
  const notes = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (!inHunk) {
      if (line.startsWith('Binary files')) notes.push('Binary file changed');
      else if (line.startsWith('rename from ')) notes.push('Renamed from ' + line.slice(12));
      else if (line.startsWith('new file mode')) notes.push('New file');
      else if (line.startsWith('deleted file mode')) notes.push('File deleted');
      else if (line.startsWith('old mode ')) notes.push('Mode ' + line.slice(9));
      else if (line.startsWith('new mode ')) notes[notes.length - 1] = (notes[notes.length - 1] || '') + ' → ' + line.slice(9);
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) { o = Number(m[1]); n = Number(m[2]); inHunk = true; rows.push({ t: 'hunk', text: line }); continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) rows.push({ t: 'add', n: n++, text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ t: 'del', o: o++, text: line.slice(1) });
    else if (line.startsWith(' ')) rows.push({ t: 'ctx', o: o++, n: n++, text: line.slice(1) });
    else if (line.startsWith('\\')) rows.push({ t: 'note', text: line.slice(2) });
  }
  return { rows, notes };
}

function renderDiff(text, truncated) {
  const { rows, notes } = parseDiff(text);
  const box = h('div', { class: 'git-diff' });
  if (notes.length) add(box, h('div', { class: 'git-diff-notes' }, notes.join(' · ')));
  if (!rows.length) {
    add(box, h('div', { class: 'git-none muted' }, notes.some((x) => /Binary/.test(x)) ? 'Binary file — no text diff.' : 'No content changes.'));
    return box;
  }
  const frag = document.createDocumentFragment();
  for (const r of rows.slice(0, MAX_LINES)) {
    frag.appendChild(h('div', { class: 'git-dl git-dl-' + r.t },
      h('span', { class: 'git-ln' }, r.o ?? ''), h('span', { class: 'git-ln' }, r.n ?? ''),
      h('span', { class: 'git-code' }, r.t === 'add' ? '+' : r.t === 'del' ? '-' : r.t === 'ctx' ? ' ' : '', r.text)));
  }
  box.appendChild(h('div', { class: 'git-diff-lines' }, frag));
  if (rows.length > MAX_LINES || truncated) add(box, h('div', { class: 'git-diff-notes' }, 'The diff is too large to show completely.'));
  return box;
}
