// Mindmap on an infinite canvas. Drag to pan, scroll/pinch to zoom.
// Clicking a branch expands it and the camera zooms in on it; leaves are
// "exit points" that can start a study chat or be divided further.
// The map reads like a story: chapters in order, each opening onto what lies underneath.
import { icon, bigChatLabel } from '/icons.js';
import { setMathText } from '/math.js';

const W = 250, COL = 320, GAP = 18;

export function createMindmap(container, { figUrl, onStudy, onDeeper }) {
  container.innerHTML = `
    <div class="mm-viewport">
      <div class="mm-world"><svg class="mm-edges"></svg></div>
    </div>
    <div class="mm-controls">
      <button class="btn icon-btn" data-z="1.25" aria-label="Zoom in">${icon('plus')}</button>
      <button class="btn icon-btn" data-z="0.8" aria-label="Zoom out">${icon('minus')}</button>
      <button class="btn icon-btn" data-fit aria-label="Fit everything">${icon('expand')}</button>
    </div>
    <div class="mm-hint">click to uncover what’s underneath · drag to move · scroll to zoom</div>`;
  const viewport = container.querySelector('.mm-viewport');
  const world = container.querySelector('.mm-world');
  const svg = container.querySelector('.mm-edges');

  let byId = new Map(), kids = new Map(), rootId = null;
  const expanded = new Set(), els = new Map(), pos = new Map();
  const disp = new Map(); // where each node is drawn right now (moves toward `pos` while animating)
  const leaving = new Map(); // nodes folding back into a parent: id → the ancestor they shrink into
  let selected = null, focused = null, cam = { x: 0, y: 0, k: 1 }, anim = null;

  // ---------- camera ----------
  function applyCam(animate) {
    world.classList.toggle('animate', !!animate);
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
  }
  function zoomAt(f, cx, cy) {
    const k = Math.min(2.5, Math.max(0.15, cam.k * f));
    cam.x = cx - (cx - cam.x) * (k / cam.k);
    cam.y = cy - (cy - cam.y) * (k / cam.k);
    cam.k = k;
  }
  // The camera that fits `ids` on screen.
  function frame(ids, maxK = 1.1) {
    if (!ids.length || !viewport.clientWidth) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) {
      const p = pos.get(id);
      if (!p) continue;
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + W); y1 = Math.max(y1, p.y + p.h);
    }
    const vw = viewport.clientWidth, vh = viewport.clientHeight, pad = 40;
    const k = Math.max(0.15, Math.min(maxK, (vw - pad * 2) / (x1 - x0), (vh - pad * 2) / (y1 - y0)));
    return { k, x: (vw - (x1 - x0) * k) / 2 - x0 * k, y: (vh - (y1 - y0) * k) / 2 - y0 * k };
  }
  // A clicked node's children are what it opened up, so they get the camera (the node itself stays in view).
  const focusCam = id => frame(expanded.has(id) && kids.get(id)?.length ? [id, ...kids.get(id)] : [id]);
  const fitCam = () => frame([...pos.keys()], 1);
  function fit() {
    focused = null;
    markFocus();
    move(fitCam());
  }

  // ---------- motion: nodes, edges and camera glide together, so nothing jumps ----------
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const ease = t => 1 - (1 - t) ** 3; // ease-out
  function move(camTo, duration = 350) {
    if (anim) cancelAnimationFrame(anim.raf);
    const from = new Map([...els.keys()].map(id => [id, { ...(disp.get(id) || pos.get(id)) }]));
    const camFrom = { ...cam };
    const t0 = performance.now(), d = reduced.matches ? 0 : duration;
    anim = { cam: camTo };
    const step = now => {
      const t = d ? Math.min(1, (now - t0) / d) : 1, e = ease(t);
      for (const [id, a] of from) {
        const b = targetOf(id);
        if (b) disp.set(id, { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, h: b.h });
      }
      if (anim.cam) {
        for (const key of ['x', 'y', 'k']) cam[key] = camFrom[key] + (anim.cam[key] - camFrom[key]) * e;
        applyCam(false);
      }
      draw();
      if (t < 1) anim.raf = requestAnimationFrame(step);
      else {
        for (const id of leaving.keys()) { els.get(id)?.remove(); els.delete(id); disp.delete(id); }
        leaving.clear();
        draw();
        anim = null;
      }
    };
    step(t0); // draw the starting frame now, so new nodes never flash at the origin
  }
  // Leaving nodes head for the ancestor they fold into.
  const targetOf = id => leaving.has(id) ? pos.get(leaving.get(id)) : pos.get(id);
  const stopCamAnim = () => { if (anim) anim.cam = null; }; // the user took the camera

  function draw() {
    for (const [id, el] of els) {
      const p = disp.get(id);
      if (p) el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    let paths = '';
    for (const id of els.keys()) {
      const n = byId.get(id), a = disp.get(n?.parent), b = disp.get(id);
      if (!a || !b || !els.has(n.parent)) continue;
      const x1 = a.x + W, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2;
      paths += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
    }
    svg.innerHTML = paths;
  }

  // Dim everything that isn't the focused node, its path from the root, or what it opened.
  function markFocus() {
    const lit = new Set();
    if (focused) {
      for (let n = byId.get(focused); n; n = byId.get(n.parent)) lit.add(n.id);
      if (expanded.has(focused)) (kids.get(focused) || []).forEach(c => lit.add(c));
    }
    for (const [id, el] of els) el.classList.toggle('dim', !!focused && !lit.has(id));
  }

  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50);
    if (e.ctrlKey || e.metaKey || mouseWheel) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    else { cam.x -= e.deltaX; cam.y -= e.deltaY; }
    stopCamAnim();
    applyCam(false);
  }, { passive: false });

  let drag = null;
  viewport.addEventListener('pointerdown', e => {
    if (e.target.closest('.mm-node')) return;
    drag = { x: e.clientX, y: e.clientY };
    stopCamAnim();
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('grabbing');
  });
  viewport.addEventListener('pointermove', e => {
    if (!drag) return;
    cam.x += e.clientX - drag.x; cam.y += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    applyCam(false);
  });
  viewport.addEventListener('pointerup', () => { drag = null; viewport.classList.remove('grabbing'); });

  container.querySelector('.mm-controls').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.fit !== undefined) return fit();
    stopCamAnim();
    zoomAt(Number(b.dataset.z), viewport.clientWidth / 2, viewport.clientHeight / 2);
    applyCam(true);
  });

  // ---------- nodes ----------
  function buildEl(n) {
    const el = document.createElement('div');
    el.className = n.id === rootId ? 'mm-node root' : 'mm-node';
    el.innerHTML = `
      ${n.figure ? `<div class="mm-thumb-wrap"><img class="mm-thumb" src="${figUrl(n.figure)}" alt=""><div class="fig-actions"><button class="btn dark" data-fig-ask="${n.figure}" aria-label="Ask question">${icon('help', 13)}<span class="lbl">Ask</span></button><button class="btn dark fig-add" data-fig="${n.figure}">${bigChatLabel(13, true)}</button></div></div>` : ''}
      <span class="mm-step"></span>
      <button class="mm-title"></button>
      <div class="mm-summary"></div>
      <div class="mm-actions">
        <button class="btn dark" data-act="study">${icon('chat', 14)}Study this in a new chat</button>
        <button class="btn" data-act="deeper">${icon('deeper', 14)}Go deeper</button>
      </div>
      <span class="mm-count"></span>`;
    el.querySelector('.mm-step').textContent = n.id === rootId ? '' : n.id.replace(/^r\./, '');
    setMathText(el.querySelector('.mm-title'), n.title);
    setMathText(el.querySelector('.mm-summary'), n.summary);
    el.addEventListener('click', e => onNodeClick(n.id, e));
    world.appendChild(el);
    return el;
  }

  async function onNodeClick(id, e) {
    if (e.target.closest('.fig-actions')) return; // handled app-wide: ask inline or attach to the big chat
    const act = e.target.closest('button');
    if (act?.dataset.act === 'study') return onStudy(byId.get(id), trail(id));
    if (act?.dataset.act === 'deeper') {
      act.disabled = true;
      act.lastChild.textContent = 'Thinking…';
      try {
        const fresh = await onDeeper(id);
        fresh.forEach(n => byId.set(n.id, n));
        index();
        expanded.add(id);
      } catch (err) {
        alert(`Couldn't go deeper: ${err.message}`);
      }
      focused = id;
      layout();
      return move(focusCam(id));
    }
    selected = id;
    if (kids.get(id)?.length) expanded.has(id) ? collapse(id) : expanded.add(id);
    // closing a branch hands the focus back to its parent's level
    focused = expanded.has(id) || !kids.get(id)?.length ? id : byId.get(id).parent || null;
    layout();
    move(focusCam(id));
  }

  function collapse(id) {
    expanded.delete(id);
    (kids.get(id) || []).forEach(collapse);
  }

  const trail = id => {
    const t = [];
    for (let n = byId.get(id); n; n = byId.get(n.parent)) t.unshift(n.title);
    return t;
  };

  function index() {
    kids = new Map();
    for (const n of byId.values()) {
      if (!n.parent || !byId.has(n.parent)) { rootId ??= n.id; continue; }
      if (!kids.has(n.parent)) kids.set(n.parent, []);
      kids.get(n.parent).push(n.id);
    }
  }

  // ---------- layout: left→right tree, parents centred on their children ----------
  function layout() {
    const visible = [];
    (function walk(id) {
      visible.push(id);
      if (expanded.has(id)) (kids.get(id) || []).forEach(walk);
    })(rootId);

    const keep = new Set(visible);
    const fresh = [];
    for (const id of visible) {
      leaving.delete(id);
      if (!els.has(id)) { els.set(id, buildEl(byId.get(id))); fresh.push(id); }
      const el = els.get(id);
      const n = kids.get(id)?.length || 0;
      el.classList.toggle('selected', id === selected);
      el.classList.toggle('leaf', !n);
      el.classList.toggle('expanded', expanded.has(id));
      el.querySelector('.mm-title').setAttribute('aria-expanded', n ? String(expanded.has(id)) : 'false');
      el.querySelector('.mm-count').textContent = n && !expanded.has(id) ? `+${n}` : '';
    }

    (function place(id, depth, top) {
      const h = els.get(id).offsetHeight;
      const ch = expanded.has(id) ? kids.get(id) || [] : [];
      let y = top;
      for (const c of ch) y += place(c, depth + 1, y) + GAP;
      const total = ch.length ? y - top - GAP : 0;
      pos.set(id, { x: depth * COL, y: total > h ? top + (total - h) / 2 : top, h });
      return Math.max(total, h);
    })(rootId, 0, 0);

    // Hidden nodes fold back into their nearest visible ancestor; new ones grow out of their parent.
    for (const id of els.keys()) {
      if (keep.has(id)) continue;
      let a = byId.get(id)?.parent;
      while (a && !keep.has(a)) a = byId.get(a)?.parent;
      leaving.set(id, a || rootId);
      pos.delete(id);
    }
    for (const id of fresh) {
      const from = disp.get(byId.get(id).parent) || pos.get(byId.get(id).parent) || pos.get(id);
      disp.set(id, { ...from, h: pos.get(id).h });
    }
    for (const [id, el] of els) el.classList.toggle('leaving', leaving.has(id));
    markFocus();
  }

  return {
    setNodes(nodes) {
      if (anim) cancelAnimationFrame(anim.raf);
      anim = null;
      els.forEach(el => el.remove());
      els.clear(); pos.clear(); disp.clear(); leaving.clear(); expanded.clear();
      focused = null;
      byId = new Map(nodes.map(n => [n.id, n]));
      rootId = null;
      selected = null;
      index();
      if (!rootId) return;
      expanded.add(rootId);
      layout();
      pos.forEach((p, id) => disp.set(id, { ...p }));
      draw();
      const c = fitCam();
      if (c) { Object.assign(cam, c); applyCam(false); }
    },
    // Back to the opening: just the root and its chapters.
    compact() {
      if (!rootId) return;
      expanded.clear();
      expanded.add(rootId);
      selected = null;
      layout();
      fit();
    },
    fit,
  };
}
