// ASCII-art logo ("ANSI Shadow" style), assembled from per-letter glyphs.
const G = {
  B: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██████╔╝', '╚═════╝ '],
  L: ['██╗     ', '██║     ', '██║     ', '██║     ', '███████╗', '╚══════╝'],
  I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
  N: ['███╗   ██╗', '████╗  ██║', '██╔██╗ ██║', '██║╚██╗██║', '██║ ╚████║', '╚═╝  ╚═══╝'],
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
  C: [' ██████╗', '██╔════╝', '██║     ', '██║     ', '╚██████╗', ' ╚═════╝'],
  H: ['██╗  ██╗', '██║  ██║', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
  ' ': ['  ', '  ', '  ', '  ', '  ', '  '],
};

/** The logo as DOM: solid blocks and their box-drawing "shadow" in separate spans. */
export function logoNode(text = 'BLIND CHESS') {
  const pre = document.createElement('pre');
  pre.className = 'banner';
  pre.setAttribute('aria-label', text);
  for (const row of logo(text).split('\n')) {
    let i = 0;
    while (i < row.length) {
      const solid = row[i] === '█';
      let j = i;
      while (j < row.length && (row[j] === '█') === solid) j++;
      const span = document.createElement('span');
      span.className = solid ? 'b-solid' : 'b-shade';
      span.textContent = row.slice(i, j);
      pre.appendChild(span);
      i = j;
    }
    pre.appendChild(document.createTextNode('\n'));
  }
  return pre;
}

export function logo(text = 'BLIND CHESS') {
  const rows = ['', '', '', '', '', ''];
  for (const ch of text) {
    const g = G[ch] || G[' '];
    for (let i = 0; i < 6; i++) rows[i] += g[i] + ' ';
  }
  return rows.map((r) => r.replace(/\s+$/, '')).join('\n');
}
