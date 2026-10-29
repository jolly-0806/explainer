// The student's own PDF, one page under another: each page is drawn as it scrolls into view, with
// pdf.js's text layer on top (so passages can be selected and asked about) and a box over every
// formula and figure (so they get the same hover actions as in the explanation).
import * as pdfjs from '/vendor/pdf.mjs';
import { figureBoxes, formulaBoxes, withLabels } from '/regions.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';

const MAX_WIDTH = 1000, GUTTER = 48;

// scroller: the element that scrolls; onPage(el, n): a page finished drawing; onPageChange(n, total).
export function createPdfViewer(root, { scroller, onPage, onPageChange }) {
  let doc = null, url = null, sizes = [], width = 0, prefix = '', current = 1;
  let pages = []; // { el, n, ready: Promise | null }
  const io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) render(Number(e.target.dataset.page));
  }, { root: scroller, rootMargin: '800px 0px' });

  // url: where the PDF is served; key: prefix of each page's highlight key ("pdf:0" → "pdf:0:3")
  async function open(u, key) {
    if (u === url) return;
    close();
    url = u;
    prefix = key;
    root.innerHTML = '<div class="status pdf-status"><span class="dot"></span>Opening the PDF…</div>';
    const d = await pdfjs.getDocument(u).promise;
    if (url !== u) return d.destroy();
    const s = [];
    for (let n = 1; n <= d.numPages; n++) {
      const v = (await d.getPage(n)).getViewport({ scale: 1 });
      s.push([v.width, v.height]);
    }
    if (url !== u) return d.destroy();
    doc = d;
    sizes = s;
    layout();
  }

  function close() {
    io.disconnect();
    doc?.destroy();
    doc = null;
    url = null;
    pages = [];
    root.innerHTML = '';
  }

  // Empty page boxes at their final size, so scrolling to any page works before it is drawn.
  function layout() {
    io.disconnect();
    root.innerHTML = '';
    lastWidth = root.clientWidth;
    width = Math.max(320, Math.min(root.clientWidth - GUTTER, MAX_WIDTH));
    pages = sizes.map(([w, h], i) => {
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.page = i + 1;
      el.dataset.hlkey = `${prefix}:${i + 1}`;
      el.style.width = `${width}px`;
      el.style.height = `${Math.round((width * h) / w)}px`;
      el.setAttribute('aria-label', `Page ${i + 1}`);
      root.append(el);
      io.observe(el);
      return { el, n: i + 1, ready: null };
    });
  }

  function render(n) {
    const pg = pages[n - 1];
    if (!pg || pg.ready) return pg?.ready;
    const d = doc;
    pg.ready = (async () => {
      const page = await d.getPage(n);
      const scale = width / sizes[n - 1][0];
      const vp = page.getViewport({ scale });
      const dpr = devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      pg.el.style.setProperty('--scale-factor', scale);
      pg.el.style.setProperty('--total-scale-factor', scale);
      pg.el.append(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] }).promise;

      const text = await page.getTextContent();
      const layer = document.createElement('div');
      layer.className = 'textLayer';
      pg.el.append(layer);
      await new pdfjs.TextLayer({ textContentSource: text, container: layer, viewport: vp }).render();
      const end = document.createElement('div'); // lets a selection run past the last line, as in pdf.js's viewer
      end.className = 'endOfContent';
      layer.append(end);

      // formulas and figures, measured at scale 1 and stored as fractions of the page
      const v1 = page.getViewport({ scale: 1 });
      const figs = withLabels(figureBoxes(await page.getOperatorList(), pdfjs.OPS, v1), text.items, v1);
      const font = it => { try { return page.commonObjs.get(it.fontName)?.name || ''; } catch { return ''; } };
      const forms = formulaBoxes(text.items, v1, font, figs);
      const frac = b => [b[0] / v1.width, b[1] / v1.height, b[2] / v1.width, b[3] / v1.height].map(x => Number(x.toFixed(4)));
      const regions = document.createElement('div');
      regions.className = 'pdf-regions';
      for (const [kind, list] of [['figure', figs], ['formula', forms]]) {
        for (const b of list) {
          const box = frac(b);
          const r = document.createElement('div');
          r.className = 'pdf-region';
          r.dataset.kind = kind;
          r.dataset.box = JSON.stringify(box);
          Object.assign(r.style, { left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${box[2] * 100}%`, height: `${box[3] * 100}%` });
          regions.append(r);
        }
      }
      pg.el.append(regions);
      if (d === doc) onPage(pg.el, n);
    })().catch(e => { if (d === doc) console.error(`page ${n} failed to draw:`, e); });
    return pg.ready;
  }

  // Scrolls to a page and resolves with it once it is drawn.
  async function show(n) {
    const pg = pages[Math.max(1, Math.min(n, pages.length)) - 1];
    if (!pg) return null;
    pg.el.scrollIntoView({ block: 'start' });
    await render(pg.n);
    return pg.el;
  }

  // The part of a page's drawing under a region, as a canvas (a little margin keeps it legible).
  function crop(region) {
    const canvas = region.closest('.pdf-page').querySelector('canvas');
    const [x, y, w, h] = JSON.parse(region.dataset.box);
    const m = 0.006;
    const sx = Math.max(0, (x - m) * canvas.width), sy = Math.max(0, (y - m) * canvas.height);
    const sw = Math.min(canvas.width - sx, (w + 2 * m) * canvas.width), sh = Math.min(canvas.height - sy, (h + 2 * m) * canvas.height);
    const c = document.createElement('canvas');
    c.width = Math.round(sw);
    c.height = Math.round(sh);
    c.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  // Hovering a formula or figure lights it up and shows its actions. The boxes don't take the
  // pointer (the text under them stays selectable), so the hit test is done here.
  let hot = null;
  const setHot = el => {
    if (el === hot) return;
    hot?.classList.remove('hot');
    hot = el;
    hot?.classList.add('hot');
  };
  root.addEventListener('mousemove', e => {
    if (e.buttons) return setHot(null); // selecting text
    const own = e.target.closest('.pdf-region');
    if (own) return setHot(own); // on its buttons
    const pageEl = e.target.closest('.pdf-page');
    if (!pageEl) return setHot(null);
    const r = pageEl.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    let best = null, area = Infinity;
    for (const el of pageEl.querySelectorAll('.pdf-region')) {
      const [bx, by, bw, bh] = JSON.parse(el.dataset.box);
      if (x >= bx && x <= bx + bw && y >= by && y <= by + bh && bw * bh < area) { best = el; area = bw * bh; }
    }
    setHot(best);
  });
  root.addEventListener('mouseleave', () => setHot(null));

  // pdf.js's selection trick: while selecting, the end-of-content block covers the page.
  root.addEventListener('mousedown', e => e.target.closest('.textLayer')?.classList.add('selecting'));
  document.addEventListener('mouseup', () => root.querySelectorAll('.textLayer.selecting').forEach(l => l.classList.remove('selecting')));

  // the page at the top of the view
  let ticking = false;
  scroller.addEventListener('scroll', () => {
    if (ticking || !pages.length || root.offsetParent === null) return; // not shown
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      const pg = pages.find(p => p.el.getBoundingClientRect().bottom > line) || pages.at(-1);
      if (pg.n !== current) { current = pg.n; onPageChange?.(current, pages.length); }
    });
  }, { passive: true });

  // a narrower or wider panel redraws the pages at the new width, staying on the same page
  let lastWidth = 0, resizeTimer;
  new ResizeObserver(() => {
    if (!doc || root.offsetParent === null || Math.abs(root.clientWidth - lastWidth) < 24) return;
    lastWidth = root.clientWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { const n = current; layout(); show(n); }, 200);
  }).observe(root);

  return {
    open, close, show, crop,
    get page() { return current; },
    get pages() { return pages.length; },
  };
}
