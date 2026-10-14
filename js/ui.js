// Small DOM builders for richer terminal output (cards, tables, bars).

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * A bordered card: card('Game over', [['Result', '1-0'], ['Moves', '34'], 'free text line'])
 * Values may be strings or { t, c } objects.
 */
export function card(title, rows = [], { cls = '', footer = null } = {}) {
  const box = el('div', 'card' + (cls ? ' ' + cls : ''));
  if (title) box.appendChild(el('div', 'card-title', title));
  for (const row of rows) {
    if (row == null) continue;
    if (Array.isArray(row)) {
      const r = el('div', 'card-row');
      r.appendChild(el('span', 'card-key', row[0]));
      const v = row[1];
      if (v && typeof v === 'object' && !(v instanceof Node)) r.appendChild(el('span', 'card-val ' + (v.c || ''), v.t));
      else if (v instanceof Node) r.appendChild(v);
      else r.appendChild(el('span', 'card-val', String(v)));
      box.appendChild(r);
    } else if (row instanceof Node) {
      box.appendChild(row);
    } else if (typeof row === 'object') {
      box.appendChild(el('div', 'card-line ' + (row.c || ''), row.t));
    } else {
      box.appendChild(el('div', 'card-line', String(row)));
    }
  }
  if (footer) box.appendChild(el('div', 'card-footer', footer));
  return box;
}

export function table(headers, rows, { cls = '' } = {}) {
  const t = el('table', 'tbl' + (cls ? ' ' + cls : ''));
  if (headers) {
    const tr = el('tr');
    for (const h of headers) tr.appendChild(el('th', null, h));
    t.appendChild(el('thead')).appendChild(tr);
  }
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) {
      if (cell && typeof cell === 'object' && !(cell instanceof Node)) tr.appendChild(el('td', cell.c || null, cell.t));
      else if (cell instanceof Node) { const td = el('td'); td.appendChild(cell); tr.appendChild(td); }
      else tr.appendChild(el('td', null, cell == null ? '' : String(cell)));
    }
    body.appendChild(tr);
  }
  t.appendChild(body);
  const wrap = el('div', 'tbl-wrap');
  wrap.appendChild(t);
  return wrap;
}

/** Text progress bar: ███████░░░ */
export function bar(value, max, width = 20) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const full = Math.round(ratio * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Values in [-1, 1] -> sparkline string. */
export function sparkline(values) {
  return values.map((v) => SPARK[Math.max(0, Math.min(7, Math.round(((v + 1) / 2) * 7)))]).join('');
}

export function stars(n, max = 5) {
  return '★'.repeat(n) + '☆'.repeat(max - n);
}
