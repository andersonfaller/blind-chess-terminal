// The terminal widget: output log, prompt, history, tab completion,
// status line and quick-action chips.
import { load, save } from './storage.js';

const MAX_LINES = 1500;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Terminal {
  constructor(root) {
    this.output = root.querySelector('#output');
    this.input = root.querySelector('#input');
    this.form = root.querySelector('#prompt-form');
    this.promptLabel = root.querySelector('#prompt-label');
    this.statusEl = root.querySelector('#status');
    this.actionsEl = root.querySelector('#actions');
    this.history = load('history', []);
    this.histIndex = this.history.length;
    this.draft = '';
    this.onSubmit = () => {};
    this.onInterrupt = () => {};
    this.completer = null;
    this.completionState = null;
    this._bind();
  }

  _bind() {
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener('keydown', (e) => this._onKey(e));
    this.input.addEventListener('input', () => { this.completionState = null; });
    // Click anywhere to focus the prompt, unless the user is selecting text.
    this.output.addEventListener('click', (e) => {
      const cmdEl = e.target.closest('[data-cmd]');
      if (cmdEl) {
        this.runOrFill(cmdEl.dataset.cmd, cmdEl.dataset.run === '1');
        return;
      }
      if (e.target.closest('a, button')) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel).length) return;
      this.focus();
    });
    this.actionsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cmd]');
      if (btn) this.runOrFill(btn.dataset.cmd, btn.dataset.run !== '0');
    });
  }

  runOrFill(cmd, run) {
    if (run) {
      this.input.value = '';
      this.onSubmit(cmd, { fromUi: true });
    } else {
      this.input.value = cmd;
      this.focus();
    }
  }

  focus() {
    // Avoid popping the on-screen keyboard on touch devices after every tap.
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches && document.activeElement !== this.input) return;
    this.input.focus({ preventScroll: true });
  }

  forceFocus() {
    this.input.focus({ preventScroll: true });
  }

  submit() {
    const text = this.input.value;
    this.input.value = '';
    this.completionState = null;
    const trimmed = text.trim();
    if (trimmed) {
      if (this.history[this.history.length - 1] !== trimmed) {
        this.history.push(trimmed);
        if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
        save('history', this.history);
      }
    }
    this.histIndex = this.history.length;
    this.onSubmit(trimmed, { fromUi: false });
  }

  _onKey(e) {
    if (e.key === 'ArrowUp') {
      if (this.histIndex === this.history.length) this.draft = this.input.value;
      if (this.histIndex > 0) {
        this.histIndex--;
        this.input.value = this.history[this.histIndex];
        this._caretToEnd();
      }
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      if (this.histIndex < this.history.length) {
        this.histIndex++;
        this.input.value = this.histIndex === this.history.length ? this.draft : this.history[this.histIndex];
        this._caretToEnd();
      }
      e.preventDefault();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this._complete(e.shiftKey);
    } else if (e.key === 'Escape') {
      this.input.value = '';
      this.completionState = null;
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      this.clear();
    } else if (e.key === 'c' && e.ctrlKey) {
      const sel = window.getSelection && String(window.getSelection());
      const inputSel = this.input.selectionStart !== this.input.selectionEnd;
      if (!sel && !inputSel) {
        e.preventDefault();
        this.print('^C', 'dim');
        this.input.value = '';
        this.onInterrupt();
      }
    }
  }

  _caretToEnd() {
    requestAnimationFrame(() => {
      const n = this.input.value.length;
      this.input.setSelectionRange(n, n);
    });
  }

  _complete(backwards) {
    if (!this.completer) return;
    let st = this.completionState;
    if (!st) {
      const value = this.input.value;
      const res = this.completer(value);
      if (!res || !res.options.length) return;
      if (res.options.length === 1) {
        this.input.value = res.prefix + res.options[0] + ' ';
        this._caretToEnd();
        return;
      }
      // Fill the longest common prefix first, then cycle.
      const common = commonPrefix(res.options);
      const typed = value.slice(res.prefix.length);
      if (common.length > typed.length) {
        this.input.value = res.prefix + common;
        this._caretToEnd();
        return;
      }
      this.print(res.options.join('   '), 'dim');
      st = this.completionState = { ...res, index: -1 };
    }
    st.index = (st.index + (backwards ? -1 : 1) + st.options.length) % st.options.length;
    this.input.value = st.prefix + st.options[st.index];
    this._caretToEnd();
  }

  // -- output ---------------------------------------------------------------

  _nearBottom() {
    const o = this.output;
    return o.scrollHeight - o.scrollTop - o.clientHeight < 120;
  }

  _append(node, { forceScroll = false } = {}) {
    const stick = forceScroll || this._nearBottom();
    this.output.appendChild(node);
    while (this.output.childElementCount > MAX_LINES) this.output.firstElementChild.remove();
    if (stick) this.scrollToBottom();
    return node;
  }

  scrollToBottom() {
    this.output.scrollTop = this.output.scrollHeight;
  }

  /**
   * print('text', 'cls') or print(['plain', {t: 'bold', c: 'hl'}, {t: 'help', cmd: 'help'}])
   */
  print(content = '', cls = '') {
    const line = document.createElement('div');
    line.className = 'line' + (cls ? ' ' + cls : '');
    fill(line, content);
    return this._append(line);
  }

  printLines(lines, cls = '') {
    for (const l of lines) this.print(l, cls);
  }

  /**
   * A "key  description" list. Laid out as a real grid (not padded text), so
   * long descriptions wrap under their own column, or stack on small screens.
   * rows: [[keyContent, descContent], ...] with the same content forms as print().
   */
  printList(rows, { cls = '' } = {}) {
    const box = document.createElement('div');
    box.className = 'items' + (cls ? ' ' + cls : '');
    for (const [key, desc] of rows) {
      const k = document.createElement('div');
      k.className = 'item-key';
      fill(k, key);
      const d = document.createElement('div');
      d.className = 'item-desc';
      fill(d, desc);
      box.append(k, d);
    }
    return this._append(box);
  }

  printNode(node, { forceScroll = false } = {}) {
    return this._append(node, { forceScroll });
  }

  blank() {
    return this.print('');
  }

  echo(text, label) {
    const line = document.createElement('div');
    line.className = 'line echo';
    const p = document.createElement('span');
    p.className = 'echo-prompt';
    p.textContent = (label || this.promptLabel.textContent) + ' ';
    line.appendChild(p);
    line.appendChild(document.createTextNode(text));
    return this._append(line, { forceScroll: true });
  }

  clear() {
    this.output.textContent = '';
  }

  spinner(text, cls = 'dim') {
    const line = this.print('', cls + ' spinner');
    const glyph = document.createElement('span');
    glyph.className = 'spin-glyph';
    const label = document.createElement('span');
    label.textContent = text;
    line.append(glyph, ' ', label);
    let i = 0;
    glyph.textContent = SPINNER[0];
    const timer = setInterval(() => {
      i = (i + 1) % SPINNER.length;
      glyph.textContent = SPINNER[i];
    }, 90);
    return {
      update: (t) => { label.textContent = t; },
      stop: (finalContent, finalCls) => {
        clearInterval(timer);
        if (finalContent == null) {
          line.remove();
        } else {
          line.className = 'line' + (finalCls ? ' ' + finalCls : '');
          line.textContent = '';
          fill(line, finalContent);
        }
      },
    };
  }

  // -- chrome ---------------------------------------------------------------

  setPrompt(text) {
    if (this.promptLabel.textContent !== text) this.promptLabel.textContent = text;
  }

  setStatus({ left = [], right = [] }) {
    const html = (segs) => segs.filter(Boolean).map((s) => {
      const span = document.createElement('span');
      span.className = 'seg' + (s.c ? ' ' + s.c : '');
      span.textContent = s.t;
      if (s.title) span.title = s.title;
      return span;
    });
    const l = document.createElement('div');
    l.className = 'status-left';
    l.append(...html(left));
    const r = document.createElement('div');
    r.className = 'status-right';
    r.append(...html(right));
    this.statusEl.replaceChildren(l, r);
  }

  setActions(actions) {
    const key = JSON.stringify(actions);
    if (key === this._actionsKey) return;
    this._actionsKey = key;
    this.actionsEl.replaceChildren(...actions.map((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (a.c ? ' ' + a.c : '');
      b.dataset.cmd = a.cmd;
      if (a.run === false) b.dataset.run = '0';
      b.textContent = a.label;
      if (a.title) b.title = a.title;
      return b;
    }));
  }
}

function fill(el, content) {
  if (content == null) return;
  if (content instanceof Node) {
    el.appendChild(content);
    return;
  }
  if (!Array.isArray(content)) {
    if (typeof content !== 'object') {
      el.textContent = String(content);
      return;
    }
    content = [content]; // a single { t, c, cmd } part
  }
  for (const part of content) {
    if (part == null || part === false) continue;
    if (typeof part === 'string' || typeof part === 'number') {
      el.appendChild(document.createTextNode(String(part)));
    } else if (part instanceof Node) {
      el.appendChild(part);
    } else {
      const span = document.createElement(part.cmd ? 'button' : 'span');
      if (part.cmd) {
        span.type = 'button';
        span.className = 'cmd-link' + (part.c ? ' ' + part.c : '');
        span.dataset.cmd = part.cmd;
        if (part.run) span.dataset.run = '1';
      } else if (part.c) {
        span.className = part.c;
      }
      if (part.title) span.title = part.title;
      span.textContent = part.t;
      el.appendChild(span);
    }
  }
}

function commonPrefix(list) {
  if (!list.length) return '';
  let p = list[0];
  for (const s of list) {
    while (!s.toLowerCase().startsWith(p.toLowerCase())) p = p.slice(0, -1);
  }
  return p;
}
