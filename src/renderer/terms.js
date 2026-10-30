// One xterm.js instance per terminal session. Its element is moved between views (single, tiles, overview)
// so the terminal, its scrollback and its connection stay alive while hidden.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import { schemeById, READABLE_CONTRAST } from './schemes.js';

// Programs copy with OSC 52 (Copilot, Claude Code, tmux, vim, ... over SSH too). Reading the clipboard
// that way is refused: a remote program must not see what the user copied elsewhere.
const COPY_ONLY = {
  readText: () => '',
  writeText: (selection, text) => (selection === 'c' || selection === 'p' ? navigator.clipboard.writeText(text) : undefined),
};

export const FONT_MIN = 6;
export const FONT_MAX = 40;
const clampFont = (n) => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));

export class TermView {
  constructor(id, { fontSize = 13, zoom = 0, scheme = 'default', contrast = false, onZoom, onKey, onDropFiles, onPasteImage, isMac }) {
    this.id = id;
    this.baseFontSize = fontSize;
    // Per-session font zoom in px on top of the size the current view asks for (single, tiles, overview).
    this.zoom = zoom;
    this.onZoom = onZoom;
    this.el = document.createElement('div');
    this.el.className = 'termwrap';
    this.el.dataset.sid = id;
    // Ctrl+wheel (Cmd+wheel on macOS) changes the font size instead of scrolling.
    this.el.addEventListener('wheel', (e) => {
      if (!(isMac ? e.metaKey : e.ctrlKey) || !e.deltaY) return;
      e.preventDefault();
      e.stopPropagation();
      this.zoomBy(e.deltaY < 0 ? 1 : -1);
    }, { capture: true, passive: false });
    // Files dropped from the Explorer / Finder: handed over as local paths.
    const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    this.el.addEventListener('dragover', (e) => { if (!isFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; this.el.classList.add('drop-files'); });
    this.el.addEventListener('dragleave', (e) => { if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('drop-files'); });
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('drop-files');
      if (!isFiles(e)) return;
      e.preventDefault();
      const paths = [...e.dataTransfer.files].map((f) => window.termclaw.pathForFile(f)).filter(Boolean);
      if (paths.length && onDropFiles) onDropFiles(id, paths);
    });
    this.term = new Terminal({
      fontSize: clampFont(fontSize + zoom),
      fontFamily: '"Cascadia Mono", "SF Mono", Menlo, Consolas, monospace',
      theme: schemeById(scheme).theme,
      scrollback: 10000,
      allowProposedApi: true,
      cursorBlink: true,
      macOptionIsMeta: true,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((e, uri) => window.termclaw.call('openExternal', uri)));
    this.term.loadAddon(new ClipboardAddon(undefined, COPY_ONLY));
    this.opened = false;
    this.setScheme(scheme, contrast);
    this.lastSize = null;

    this.term.onData((d) => window.termclaw.call('write', id, d));
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      // Copy / paste
      if ((mod && e.shiftKey && e.code === 'KeyC') || (isMac && e.metaKey && e.code === 'KeyC')) {
        const sel = this.term.getSelection();
        if (sel) navigator.clipboard.writeText(sel);
        return false;
      }
      if (!isMac && e.ctrlKey && !e.shiftKey && e.code === 'KeyC' && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      }
      if ((mod && e.shiftKey && e.code === 'KeyV') || (isMac && e.metaKey && e.code === 'KeyV') || (!isMac && e.ctrlKey && e.code === 'KeyV')) {
        // The browser default and the Edit menu accelerator would fire a native paste event as well,
        // which xterm handles too: prevent it and swallow a native paste right after this one.
        e.preventDefault();
        this.shortcutPasteAt = Date.now();
        // No text: maybe an image (screenshot), pasted as a file path.
        navigator.clipboard.readText().then((t) => (t ? this.term.paste(t) : onPasteImage && onPasteImage(id)));
        return false;
      }
      // App shortcuts are handled globally.
      if (onKey && onKey(e)) return false;
      return true;
    });

    this.el.addEventListener('paste', (e) => {
      if (Date.now() - (this.shortcutPasteAt || 0) < 500) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    this.ro = new ResizeObserver(() => this.scheduleFit());
    this.ro.observe(this.el);
  }

  // Move into a container; opens the terminal on first attach.
  attach(container) {
    if (this.el.parentElement !== container) container.appendChild(this.el);
    if (!this.opened) {
      this.term.open(this.el);
      this.opened = true;
    }
    this.scheduleFit();
  }

  detach() {
    if (this.el.parentElement) this.el.parentElement.removeChild(this.el);
  }

  // Color scheme (see schemes.js); contrast = "Increase contrast" setting.
  setScheme(id, contrast = false) {
    const s = schemeById(id);
    const ratio = Math.max(s.contrast || 1, contrast ? READABLE_CONTRAST : 1);
    if (this.schemeId === s.id && this.term.options.minimumContrastRatio === ratio) return;
    this.schemeId = s.id;
    this.term.options.theme = s.theme;
    this.term.options.minimumContrastRatio = ratio;
    this.el.style.background = s.theme.background;
  }

  // Base size of the view the terminal is shown in; the session's zoom is added on top.
  setFontSize(size) {
    this.baseFontSize = size;
    this.applyFont();
  }

  applyFont() {
    const size = clampFont(this.baseFontSize + this.zoom);
    if (this.term.options.fontSize !== size) {
      this.term.options.fontSize = size;
      this.scheduleFit();
    }
    return size;
  }

  // delta in px; 0 resets to the view's size.
  zoomBy(delta) {
    const before = this.zoom;
    if (delta === 0) this.zoom = 0;
    else this.zoom = clampFont(this.baseFontSize + this.zoom + delta) - this.baseFontSize;
    const size = this.applyFont();
    if (this.zoom !== before && this.onZoom) this.onZoom(this.id, this.zoom);
    this.showBadge(size);
  }

  // Short "15 px" hint in the corner while zooming.
  showBadge(size) {
    if (!this.badge) {
      this.badge = document.createElement('div');
      this.badge.className = 'term-zoom';
    }
    this.badge.textContent = size + ' px' + (this.zoom ? ` (${this.zoom > 0 ? '+' : ''}${this.zoom})` : '');
    this.el.appendChild(this.badge);
    clearTimeout(this._badgeTimer);
    this._badgeTimer = setTimeout(() => this.badge.remove(), 1200);
  }

  scheduleFit() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this.doFit());
  }

  doFit() {
    if (!this.opened || !this.el.isConnected || this.el.offsetWidth < 20 || this.el.offsetHeight < 20) return;
    try { this.fit.fit(); } catch { return; }
    const { cols, rows } = this.term;
    const key = cols + 'x' + rows;
    if (key !== this.lastSize) {
      this.lastSize = key;
      // The remote program gets the new size and may re-wrap.
      window.termclaw.call('resize', this.id, cols, rows);
    }
  }

  write(data) { this.term.write(data); }
  focus() { this.term.focus(); }

  dispose() {
    this.ro.disconnect();
    this.term.dispose();
    this.detach();
  }
}
