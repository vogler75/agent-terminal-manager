// One xterm.js instance per terminal session. Its element is moved between views (single, tiles, overview)
// so the terminal, its scrollback and its connection stay alive while hidden.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

const THEME = {
  background: '#14161b',
  foreground: '#d7dae0',
  cursor: '#5b9dff',
  selectionBackground: '#3a4a6b',
  black: '#1b1e25', red: '#f85149', green: '#3fb950', yellow: '#e3b341', blue: '#5b9dff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#d7dae0',
  brightBlack: '#6b7280', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#f2cc60', brightBlue: '#79b8ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#ffffff',
};

export class TermView {
  constructor(id, { fontSize = 13, onKey, isMac }) {
    this.id = id;
    this.baseFontSize = fontSize;
    this.el = document.createElement('div');
    this.el.className = 'termwrap';
    this.term = new Terminal({
      fontSize,
      fontFamily: '"Cascadia Mono", "SF Mono", Menlo, Consolas, monospace',
      theme: THEME,
      scrollback: 10000,
      allowProposedApi: true,
      cursorBlink: true,
      macOptionIsMeta: true,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((e, uri) => window.atm.call('openExternal', uri)));
    this.opened = false;
    this.lastSize = null;

    this.term.onData((d) => window.atm.call('write', id, d));
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
        navigator.clipboard.readText().then((t) => t && this.term.paste(t));
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

  setFontSize(size) {
    if (this.term.options.fontSize !== size) {
      this.term.options.fontSize = size;
      this.scheduleFit();
    }
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
      window.atm.call('resize', this.id, cols, rows);
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
