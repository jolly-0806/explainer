// Finds the formulas and images on a PDF page, so they get the same hover actions as in the explanation.
// Pure geometry on pdf.js output (no DOM), so it can be tested outside the browser.
// Boxes are [x, y, w, h] in page units with the origin at the top left.

// a 2D affine matrix product, as pdf.js's Util.transform
const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const rect = (m, x0, y0, x1, y1) => {
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => apply(m, x, y));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
};

// Figures, from the operator list: raster images (drawn into the unit square under the current
// transform) and vector drawings (clusters of drawn paths, found on a coarse grid).
export function figureBoxes(ops, OPS, viewport) {
  const images = [], paths = [], stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const area = viewport.width * viewport.height;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args?.[0]) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const box = rect(mul(viewport.transform, ctm), 0, 0, 1, 1);
      // icons and logos are too small to ask about; a full-page background isn't a figure
      if (box[2] >= 40 && box[3] >= 40 && box[2] * box[3] < 0.9 * area) images.push(box);
    } else if (fn === OPS.constructPath && args?.[2]) {
      const [x0, y0, x1, y1] = args[2];
      const box = rect(mul(viewport.transform, ctm), x0, y0, x1, y1);
      if (box[2] * box[3] < 0.9 * area && (box[2] > 0.5 || box[3] > 0.5)) paths.push(box);
    }
  }
  // panels of one figure, and a drawing around an image, become one figure
  const out = [...images, ...pathClusters(paths, viewport)];
  for (let merged = true; merged;) {
    merged = false;
    for (let a = 0; a < out.length && !merged; a++) {
      const b = out.findIndex((o, k) => k > a && overlap(out[a], o) > 0.5);
      if (b > 0) { out[a] = union(out[a], out[b]); out.splice(b, 1); merged = true; }
    }
  }
  return out;
}

// Paths within a few points of each other form one drawing; only big, busy drawings are figures
// (a fraction bar, an underline or a table's rules are not).
function pathClusters(paths, viewport, cell = 4) {
  const cols = Math.ceil(viewport.width / cell) + 2, rows = Math.ceil(viewport.height / cell) + 2;
  const grid = new Int32Array(cols * rows).fill(-1);
  const at = (x, y) => Math.max(0, Math.min(rows - 1, Math.floor(y / cell) + 1)) * cols + Math.max(0, Math.min(cols - 1, Math.floor(x / cell) + 1));
  // mark each path's outline (a big frame is a ring, so its inside stays free to join on its own)
  const mark = new Uint8Array(cols * rows);
  for (const [x, y, w, h] of paths) {
    const c0 = at(x, y) % cols, c1 = at(x + w, y) % cols, r0 = Math.floor(at(x, y) / cols), r1 = Math.floor(at(x, y + h) / cols);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (r === r0 || r === r1 || c === c0 || c === c1 || (c1 - c0) * (r1 - r0) < 400) mark[r * cols + c] = 1;
    }
  }
  // connected components, bridging gaps of one cell
  const comps = [];
  for (let s = 0; s < mark.length; s++) {
    if (!mark[s] || grid[s] >= 0) continue;
    const id = comps.length, q = [s];
    let minC = Infinity, maxC = -1, minR = Infinity, maxR = -1;
    grid[s] = id;
    while (q.length) {
      const k = q.pop(), r = Math.floor(k / cols), c = k % cols;
      minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const rr = r + dr, cc = c + dc, n = rr * cols + cc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols || !mark[n] || grid[n] >= 0) continue;
        grid[n] = id;
        q.push(n);
      }
    }
    comps.push({ box: [(minC - 1) * cell, (minR - 1) * cell, (maxC - minC + 1) * cell, (maxR - minR + 1) * cell], n: 0 });
  }
  for (const [x, y, w, h] of paths) { const id = grid[at(x + w / 2, y + h / 2)]; if (id >= 0) comps[id].n++; }
  return comps.filter(c => c.n >= 8 && c.box[2] >= 60 && c.box[3] >= 60).map(c => c.box);
}

const MATH_CH = /[=<>+−±×÷·∂∇∑∏∫∮√∞≈≠≡≤≥≪≫∼≃∝→←↔⇒⇔∈∉⊂⊃⊆⊇∪∩∀∃′″‖⊥\u0000-\u001fͰ-Ͽ∀-⋿\u{1D400}-\u{1D7FF}]/u;
const MATH_FONT = /(^|\+)(CM(MI|SY|EX|BSY|MIB)|MSAM|MSBM|EUFM|EUSM|RSFS|STIX|TXMI|TXSY|PXMI|PXSY|MTMI|MTSY|MTEX|Symbol|Esint|AdvP[0-9A-F])|Math/i;
const ITALIC_FONT = /\.B?I\b|Italic|-It\b|Oblique|CMMI|MTMI/i;
const WEAK = /^[\w().,;:'[\]{}/|-]{1,3}$/; // subscripts, digits and brackets: math only next to math

// Formulas, from the text layer's items. `fontName(item)` returns the font's real name if known.
export function formulaBoxes(items, viewport, fontName = () => '', avoid = []) {
  // token-level pieces: a long prose item contributes only the words that hold math
  const toks = [];
  for (const it of items) {
    const str = it.str || '';
    if (!str.trim()) continue;
    const m = mul(viewport.transform, it.transform);
    const h = Math.hypot(m[2], m[3]);
    if (!h || Math.abs(m[1]) > 0.01 * h) continue; // rotated text (axis labels) is never a formula here
    const x = m[4], y = m[5] - h, w = it.width * viewport.scale;
    const font = fontName(it) || '';
    const mathFont = MATH_FONT.test(font), italic = ITALIC_FONT.test(font);
    if (mathFont || str.trim().length <= 6) {
      toks.push({ box: [x, y, w, h], str: str.trim(), strong: mathFont || MATH_CH.test(str), italic });
      continue;
    }
    const per = w / str.length;
    for (const t of str.matchAll(/\S+/g)) {
      toks.push({ box: [x + per * t.index, y, per * t[0].length, h], str: t[0], strong: MATH_CH.test(t[0]), italic });
    }
  }
  for (const t of toks) {
    t.math = t.strong || (t.italic && /^[A-Za-z]{1,2}$/.test(t.str.replace(/\s/g, '')));
    t.weak = !t.math && WEAK.test(t.str);
    t.chars = t.str.replace(/\s/g, '').length;
  }

  // lines: tokens whose vertical extents overlap enough (super/subscripts join their base line)
  toks.sort((a, b) => a.box[1] - b.box[1]);
  // and that sit near each other across the page, so a two-column page's columns stay apart
  const sameLine = (a, b, h) => vOverlap(a, b) >= 0.4 * Math.min(a[3], b[3]) && -hOverlap(a, b) <= 1.5 * h;
  let lines = [];
  for (const t of toks) {
    const line = lines.find(l => sameLine(l.box, t.box, Math.max(l.h, t.box[3])));
    if (line) { line.toks.push(t); line.box = union(line.box, t.box); line.h = Math.max(line.h, t.box[3]); }
    else lines.push({ toks: [t], box: [...t.box], h: t.box[3] });
  }
  for (let merged = true; merged;) { // pieces of one line that met out of order
    merged = false;
    for (let a = 0; a < lines.length && !merged; a++) {
      const b = lines.findIndex((l, k) => k > a && sameLine(lines[a].box, l.box, Math.max(lines[a].h, l.h)));
      if (b > 0) {
        const [l] = lines.splice(b, 1);
        Object.assign(lines[a], { toks: [...lines[a].toks, ...l.toks], box: union(lines[a].box, l.box), h: Math.max(lines[a].h, l.h) });
        merged = true;
      }
    }
  }

  const regions = [];
  const display = [];
  for (const l of lines) {
    l.toks.sort((a, b) => a.box[0] - b.box[0]);
    const total = l.toks.reduce((s, t) => s + t.chars, 0);
    const math = l.toks.reduce((s, t) => s + (t.math ? t.chars : t.weak ? t.chars / 2 : 0), 0);
    // a display equation: a line that is mostly math
    if (l.toks.some(t => t.strong) && total >= 2 && math >= 0.5 * total) { display.push(l); continue; }
    // a row of nothing but math (a vector's entry, a bracket piece): kept only if it joins a display equation
    if (l.toks.every(t => t.math || t.weak) && l.toks.some(t => t.math)) {
      regions.push({ box: [...l.box], txt: l.toks.map(t => t.str).join(''), part: true });
      continue;
    }
    // inline: runs of math tokens, with brackets/indices between them
    let run = [];
    const flush = () => {
      while (run.length && !run.at(-1).math) run.pop();
      while (run.length && !run[0].math) run.shift();
      const n = run.filter(t => t.math).length;
      if (n >= 2 || run.some(t => t.strong && t.chars >= 2) || (n && run.length >= 3)) regions.push({ box: run.map(t => t.box).reduce(union), txt: run.map(t => t.str).join('') });
      run = [];
    };
    for (const t of l.toks) {
      const prev = run.at(-1);
      if (prev && t.box[0] - (prev.box[0] + prev.box[2]) > 1.2 * l.h) flush();
      if (t.math || (t.weak && run.length)) run.push(t);
      else flush();
    }
    flush();
  }
  // stacked display lines (fractions, multi-line equations) become one formula
  for (const l of display) {
    const near = regions.find(r => r.display && hOverlap(r.box, l.box) > 0 && gapY(r.box, l.box) < 0.9 * l.h);
    const txt = l.toks.map(t => t.str).join('');
    if (near) { near.box = union(near.box, l.box); near.txt += txt; }
    else regions.push({ display: true, box: [...l.box], txt });
  }
  // merge anything touching (an inline run's superscript, a fraction's numerator)
  for (let merged = true; merged;) {
    merged = false;
    for (let a = 0; a < regions.length && !merged; a++) {
      for (let b = a + 1; b < regions.length; b++) {
        const A = regions[a], B = regions[b];
        // a display equation also takes rows stacked tightly above and below it (a column vector, a matrix)
        const stacked = (A.display || B.display) && hOverlap(A.box, B.box) > 0 && gapY(A.box, B.box) < 0.3 * Math.min(A.box[3], B.box[3]);
        if (stacked || overlap(pad(A.box, 1), pad(B.box, 1), true) > 0) {
          A.display ||= B.display;
          A.part &&= B.part;
          regions[a].box = union(regions[a].box, regions[b].box);
          regions[a].txt += regions[b].txt;
          regions.splice(b, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return regions
    .filter(r => !r.part)
    // an equation's number, "(7a)", or a lone page number is not a formula (math fonts draw brackets as \u0001…)
    .filter(r => !/^[\s()\u0000-\u001f\d.,a-z]{0,6}$/i.test(r.txt))
    .map(r => pad(r.box, 2))
    .filter(b => b[2] >= 8 && b[3] >= 6 && b[2] * b[3] < 0.25 * viewport.width * viewport.height)
    .filter(b => !avoid.some(a => contains(a, [b[0] + b[2] / 2, b[1] + b[3] / 2])));
}

const union = (a, b) => {
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
};
const pad = (b, p) => [b[0] - p, b[1] - p, b[2] + 2 * p, b[3] + 2 * p];
const vOverlap = (a, b) => Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
const hOverlap = (a, b) => Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
const gapY = (a, b) => Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]);
const contains = (b, [x, y]) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
// shared area as a fraction of the smaller box (or the raw area)
function overlap(a, b, raw = false) {
  const w = hOverlap(a, b), h = vOverlap(a, b);
  if (w <= 0 || h <= 0) return 0;
  return raw ? w * h : (w * h) / Math.min(a[2] * a[3], b[2] * b[3]);
}

// A drawing's boxes miss its text (tick labels, axis titles, panel letters): each short piece of text
// just outside a figure joins the nearest one, a few times over so a label beside a label joins too.
export function withLabels(figs, items, viewport) {
  let labels = [];
  for (const it of items) {
    const str = (it.str || '').trim();
    if (!str || str.length > 16) continue;
    const m = mul(viewport.transform, it.transform);
    const h = Math.hypot(m[2], m[3]), len = it.width * viewport.scale;
    const ux = m[0] / Math.hypot(m[0], m[1]), uy = m[1] / Math.hypot(m[0], m[1]); // along the text
    const vx = -m[2] / h, vy = -m[3] / h; // up the glyphs
    const pts = [[0, 0], [len, 0], [0, h], [len, h]].map(([a, b]) => [m[4] + ux * a + vx * b, m[5] + uy * a + vy * b]);
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    labels.push([Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]);
  }
  const boxes = figs.map(f => [...f]);
  const dist = (a, b) => Math.hypot(Math.max(0, -hOverlap(a, b)), Math.max(0, gapY(a, b)));
  for (let round = 0; round < 3 && labels.length; round++) {
    const grown = boxes.map(b => [...b]);
    labels = labels.filter(l => {
      const d = boxes.map(b => dist(b, l));
      const k = d.indexOf(Math.min(...d));
      if (!(d[k] <= 10)) return true;
      grown[k] = union(grown[k], l);
      return false;
    });
    boxes.splice(0, boxes.length, ...grown);
  }
  return boxes;
}
