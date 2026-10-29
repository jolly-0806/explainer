import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { mathHtml, setMathText, INLINE } from '/math.js';
import { extractSources, upload } from '/extract.js';
import { createMindmap } from '/mindmap.js';
import { createPdfViewer } from '/pdfview.js';
import { icon, hydrateIcons, bigChatLabel } from '/icons.js';
import { initAgent, agentConnected, openAgentDialog } from '/agent.js';

hydrateIcons();
initAgent();

const LEVEL_COLORS = ['var(--l1)', 'var(--l2)', 'var(--l3)', 'var(--l4)', 'var(--l5)'];
const $ = s => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(`/api/projects${path}`, {
    ...opts, headers: { 'content-type': 'application/json' },
    body: opts.body && JSON.stringify(opts.body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
};

const state = { projects: [], project: null, level: 0, chatId: null, attachments: [], gate: null, sel: null, mini: null, streaming: false, mmKey: null, section: 0, seen: new Set(), tabByLevel: {}, summaryOpen: false, answers: {}, wrong: {}, showDifficulty: true, quizzesOn: true, folded: new Set(), noteOpen: new Set(), histTab: 'history', view: 'explain', scrolls: {}, target: null };
const figUrl = f => `/api/projects/${state.project.id}/figs/${f}.jpg`;

// ---------- math: $…$ and $$…$$ in markdown are typeset by math.js ----------
marked.use({ extensions: [
  {
    name: 'mathBlock', level: 'block',
    start: src => src.match(/^ {0,3}\$\$/m)?.index,
    tokenizer(src) {
      const m = /^ {0,3}\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/.exec(src);
      if (m) return { type: 'mathBlock', raw: m[0], tex: m[1].trim() };
    },
    renderer: t => `<p>${mathHtml(t.tex, true)}</p>`,
  },
  {
    name: 'mathInline', level: 'inline',
    start: src => src.indexOf('$') < 0 ? undefined : src.indexOf('$'),
    tokenizer(src) {
      // $$…$$ mid-line is display math
      const m = /^\$\$([^$]+?)\$\$/.exec(src) || INLINE.exec(src);
      if (m) return { type: 'mathInline', raw: m[0], tex: m[1].trim(), display: m[0].startsWith('$$') };
    },
    renderer: t => mathHtml(t.tex, t.display),
  },
  {
    // [@k]: a citation the server placed (k indexes the level's cites); numbered per tab by citeList
    name: 'cite', level: 'inline',
    start: src => { const i = src.indexOf('[@'); return i < 0 ? undefined : i; },
    tokenizer(src) {
      const m = /^\[@(\d+)\]/.exec(src);
      if (m) return { type: 'cite', raw: m[0], k: m[1] };
    },
    renderer: t => `<sup class="cite" data-k="${t.k}"></sup>`,
  },
] });

// ---------- markdown (figures may only come from the uploaded PDFs) ----------
function renderMd(el, md) {
  const withFigs = md.replace(/\]\(fig:(f\d+)\)/g, (_, f) => `](${figUrl(f)})`);
  el.innerHTML = DOMPurify.sanitize(marked.parse(withFigs));
  el.querySelectorAll('img').forEach(img => {
    if (!img.getAttribute('src')?.startsWith('/api/projects/')) return img.remove();
    const fig = document.createElement('figure');
    fig.className = 'fig';
    img.replaceWith(fig);
    const media = document.createElement('span'); // image + its hover buttons, so overlays sit on the image
    media.className = 'fig-media';
    media.append(img);
    fig.append(media);
    if (img.alt) fig.insertAdjacentHTML('beforeend', `<figcaption>${DOMPurify.sanitize(img.alt)}</figcaption>`);
    const id = img.getAttribute('src').match(/figs\/(f\d+)\.jpg$/)?.[1];
    if (id) { fig.dataset.fig = id; media.append(figActions(id, img.alt)); }
    const p = fig.parentElement; // marked wraps images in <p>; lift the figure out
    if (p?.tagName === 'P' && p.childNodes.length === 1) p.replaceWith(fig);
  });
  el.querySelectorAll('.math').forEach(m => m.append(mathActions(m.dataset.tex)));
}

// Hover actions on every figure: ask about it inline, or take it to the big chat.
function figActions(id, caption = '') {
  const d = document.createElement('div');
  d.className = 'fig-actions';
  d.innerHTML = `<button class="btn dark" data-fig-ask="${id}">${icon('help', 14)}<span class="lbl">Ask question</span></button>
    <button class="btn dark fig-add" data-fig="${id}">${bigChatLabel(14)}</button>`;
  d.querySelectorAll('button').forEach(b => { b.dataset.caption = caption; });
  return d;
}

// The same two actions on every formula.
function mathActions(src) {
  const d = document.createElement('span');
  d.className = 'fig-actions math-actions';
  d.innerHTML = `<button class="btn dark" data-math-ask aria-label="Ask about this formula" title="Ask about this formula">${icon('help', 13)}<span class="lbl">Ask</span></button>
    <button class="btn dark math-add">${bigChatLabel(13, true)}</button>`;
  return d;
}

// ---------- history sidebar ----------
async function loadProjects() {
  state.projects = await api('');
  const list = $('#project-list');
  list.innerHTML = '';
  for (const p of state.projects) {
    const box = document.createElement('div');
    box.className = 'proj';
    // File tree: the project is the folder, its chats sit indented underneath on a guide line.
    const folded = state.folded.has(p.id);
    const row = document.createElement('div');
    row.className = 'proj-row';
    const twisty = document.createElement('button');
    twisty.className = 'twisty';
    twisty.hidden = !p.chats.length;
    twisty.setAttribute('aria-expanded', String(!folded));
    twisty.setAttribute('aria-label', `${folded ? 'Show' : 'Hide'} chats in ${p.name}`);
    twisty.innerHTML = icon('chevron', 12);
    twisty.onclick = () => { folded ? state.folded.delete(p.id) : state.folded.add(p.id); loadProjects(); };
    const a = document.createElement('a');
    a.innerHTML = `${icon('file', 15)}<span></span>`;
    a.querySelector('span').textContent = p.name;
    a.classList.toggle('on', state.project?.id === p.id && !state.chatId);
    a.onclick = () => openProject(p.id);
    renamable(a, 'project', p.name, async name => {
      await api(`/${p.id}`, { method: 'PUT', body: { name } });
      if (state.project?.id === p.id) {
        state.project.name = name;
        $('.top h1').textContent = name;
      }
    }, async () => {
      if (!confirm(`Delete the project “${p.name}”, with its explanations, chats and saved PDFs? This can't be undone.`)) return;
      await api(`/${p.id}`, { method: 'DELETE' });
      if (state.project?.id === p.id) { clearTimeout(pollTimer); state.project = null; showUpload(); }
      else loadProjects();
    });
    row.append(twisty, a);
    box.append(row);
    if (p.chats.length && !folded) {
      const tree = document.createElement('div');
      tree.className = 'proj-chats';
      for (const c of p.chats) {
        const link = document.createElement('a');
        link.className = 'chat-link';
        link.innerHTML = `${c.busy ? '<i class="spinner" role="img" aria-label="Claude is answering"></i>' : icon('chat', 13)}<span></span>`;
        link.querySelector('span').textContent = c.title;
        link.classList.toggle('on', state.chatId === c.id);
        link.onclick = () => { setSideCollapsed(false); openProject(p.id, c.id); }; // a chat always opens in the panel
        renamable(link, 'chat', c.title, async title => {
          await api(`/${p.id}/chats/${c.id}`, { method: 'PUT', body: { title } });
          const open = state.project?.id === p.id && state.project.chats.find(x => x.id === c.id);
          if (open) open.title = title;
        }, async () => {
          if (!confirm(`Delete the chat “${c.title}”? This can't be undone.`)) return;
          await api(`/${p.id}/chats/${c.id}`, { method: 'DELETE' });
          if (state.project?.id === p.id) {
            state.project.chats = state.project.chats.filter(x => x.id !== c.id);
            if (state.chatId === c.id) { state.chatId = null; renderChat(); }
          }
          loadProjects();
        });
        tree.append(link);
      }
      box.append(tree);
    }
    list.append(box);
  }
  renderNotes();
  // while any chat is being answered (even from before a reload) keep the spinners honest
  clearTimeout(busyTimer);
  if (state.projects.some(p => p.chats.some(c => c.busy))) busyTimer = setTimeout(loadProjects, 2000);
}
let busyTimer;

// ---------- the sidebar's two tabs: chat history, and notes ----------
function setHistTab(tab) {
  state.histTab = tab;
  document.querySelectorAll('.hist-tabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.htab === tab)));
  $('#project-list').hidden = tab !== 'history';
  $('#notes-view').hidden = tab !== 'notes';
  try { localStorage.setItem('explainer.histTab', tab); } catch {}
}
$('.hist-tabs').onclick = e => { const b = e.target.closest('button'); if (b) setHistTab(b.dataset.htab); };
try { setHistTab(localStorage.getItem('explainer.histTab') === 'notes' ? 'notes' : 'history'); } catch {}

// ---------- notes: starred answers and added highlights, as sticky notes stacked down the sidebar ----------
const noteKey = (p, it) => `${p.id}:${it.type}:${it.id}`;
const plain = t => t.replace(/\$+/g, '').replace(/\s+/g, ' ').trim();

function renderNotes() {
  const box = $('#notes-list');
  box.innerHTML = '';
  const keys = [];
  for (const p of state.projects) {
    const items = [
      ...(p.stickies || []).map(s => ({ ...s, type: 'sticky' })).reverse(), // newest first
      ...(p.starred || []).map(s => ({ ...s, type: 'star', id: `${s.chatId}:${s.i}` })),
    ];
    for (const it of items) { keys.push(noteKey(p, it)); box.append(noteCard(p, it)); }
  }
  $('#notes-count').textContent = keys.length || '';
  $('#notes-empty').hidden = keys.length > 0;
  $('#notes-toggle').hidden = !keys.length;
  $('#notes-bar-label').textContent = `${keys.length} note${keys.length === 1 ? '' : 's'}`;
  $('#notes-toggle').textContent = keys.every(k => state.noteOpen.has(k)) ? 'Collapse all' : 'Expand all';
}

function noteCard(p, it) {
  const star = it.type === 'star';
  const key = noteKey(p, it);
  const card = document.createElement('div');
  card.className = `note-card ${it.type}`;
  card.classList.toggle('open', state.noteOpen.has(key));
  const head = document.createElement('div');
  head.className = 'note-head';
  head.innerHTML = `${icon(star ? 'star' : 'note', 13)}<span></span>`;
  head.querySelector('span').textContent = star ? it.title : (it.title || 'Highlight');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ghost note-toggle';
  toggle.innerHTML = icon('chevron', 13);
  const sync = () => {
    toggle.setAttribute('aria-expanded', String(card.classList.contains('open')));
    toggle.setAttribute('aria-label', card.classList.contains('open') ? 'Collapse note' : 'Expand note');
  };
  sync();
  toggle.onclick = e => {
    e.stopPropagation();
    card.classList.toggle('open');
    card.classList.contains('open') ? state.noteOpen.add(key) : state.noteOpen.delete(key);
    sync();
    $('#notes-toggle').textContent = [...document.querySelectorAll('.note-card')].every(c => c.classList.contains('open')) ? 'Collapse all' : 'Expand all';
  };
  head.append(toggle);
  const body = document.createElement('div');
  body.className = 'note-body';
  if (star) renderMd(body, it.text.replace(/!\[[^\]]*\]\(fig:f\d+\)/g, '')); // figures belong to the project that's open
  else setMathText(body, it.text);
  const src = document.createElement('div');
  src.className = 'note-src';
  const where = star ? `Chat · ${it.chatTitle}` : it.kind === 'chat'
    ? `Chat · ${p.chats.find(c => c.id === it.ref.chatId)?.title || it.label.replace(/^Chat · /, '')}` : it.label;
  src.textContent = (state.projects.length > 1 ? `${p.name} · ` : '') + plain(where);
  card.title = 'Open where this came from';
  card.append(head, body, src);
  card.onclick = e => {
    if (e.target.closest('button, input') || getSelection().toString().trim()) return;
    openNote(p, it);
  };
  renamable(head, star ? 'starred note' : 'note', head.querySelector('span').textContent,
    title => star ? api(`/${p.id}/chats/${it.chatId}/messages/${it.i}/title`, { method: 'PUT', body: { title } })
      : api(`/${p.id}/stickies/${it.id}`, { method: 'PUT', body: { title } }),
    async () => {
      if (star) {
        await api(`/${p.id}/chats/${it.chatId}/messages/${it.i}/star`, { method: 'PUT', body: { on: false } });
        if (state.project?.id === p.id) {
          const m = state.project.chats.find(c => c.id === it.chatId)?.messages[it.i];
          if (m) { delete m.starred; if (state.chatId === it.chatId) renderChat(); }
        }
      } else {
        if (!confirm('Delete this note?')) return;
        await api(`/${p.id}/stickies/${it.id}`, { method: 'DELETE' });
      }
      loadProjects();
    }, star ? 'Remove star' : 'Delete note');
  card.oncontextmenu = head.oncontextmenu;
  return card;
}

$('#notes-toggle').onclick = () => {
  const cards = [...document.querySelectorAll('.note-card')];
  const open = !cards.every(c => c.classList.contains('open'));
  cards.forEach(c => c.classList.toggle('open', open));
  for (const p of state.projects) for (const it of [...(p.stickies || []).map(s => ({ ...s, type: 'sticky' })), ...(p.starred || []).map(s => ({ ...s, type: 'star', id: `${s.chatId}:${s.i}` }))]) {
    open ? state.noteOpen.add(noteKey(p, it)) : state.noteOpen.delete(noteKey(p, it));
  }
  renderNotes();
};

// A note opens the place it came from, with the highlighted words lit up for a moment.
async function openNote(p, it) {
  if (it.type === 'star') return openStarred(p.id, it);
  const { kind, ref, text } = it;
  if (kind === 'chat') {
    await openStarred(p.id, { chatId: ref.chatId, i: ref.i });
    return flashText(document.querySelector(`#messages [data-hlkey="m:${ref.chatId}:${ref.i}"]`), it.quote || text);
  }
  if (kind === 'pdf') {
    await openProject(p.id);
    return setView(ref.source, { page: ref.page, quote: it.quote || text });
  }
  await openProject(p.id);
  await setView('explain');
  setLevel(ref.level);
  state.section = ref.section;
  renderArticle();
  $('#main').scrollTop = 0;
  flashText($('#article'), it.quote || text);
}

// Lights up `text` inside `root` (the exact words, else the start or end of them), then lets go.
function flashText(root, text) {
  if (!root) return;
  const words = text.split(/\s+/);
  let marks = [];
  for (const t of [text, words.slice(0, 8).join(' '), words.slice(-8).join(' '), words.slice(0, 4).join(' ')]) {
    if ((marks = markText(root, t, { cls: 'note-hl', loose: true })).length || marks.maths.length) break;
  }
  (marks[0] || marks.maths[0])?.scrollIntoView({ block: 'center' });
  setTimeout(() => {
    marks.maths.forEach(m => m.classList.remove('note-hl-math'));
    marks.forEach(m => m.replaceWith(...m.childNodes));
    root.normalize();
  }, 3000);
}

// Where a highlight came from, from the key of the box it was selected in.
function noteSource(key) {
  let m;
  if ((m = /^a:(\d+):(\d+)$/.exec(key || ''))) {
    const [level, section] = [+m[1], +m[2]];
    const title = splitSections(state.project.levels[level]?.md || '')[section]?.title || '';
    return { kind: 'explanation', ref: { level, section }, label: `Explanation · ${state.project.levelNames[level]} › ${title}` };
  }
  if ((m = /^m:([^:]+):(\d+)$/.exec(key || ''))) {
    const chat = state.project.chats.find(c => c.id === m[1]);
    return { kind: 'chat', ref: { chatId: m[1], i: +m[2] }, label: `Chat · ${chat?.title || ''}` };
  }
  if ((m = /^pdf:(\d+):(\d+)$/.exec(key || ''))) {
    const name = state.project.sources[+m[1]]?.name.replace(/\.pdf$/i, '') || 'PDF';
    return { kind: 'pdf', ref: { source: +m[1], page: +m[2] }, label: `${name} · page ${m[2]}` };
  }
  return null;
}

async function addNote(text, key, quote) {
  const src = noteSource(key);
  if (!src) return;
  try {
    await api(`/${state.project.id}/stickies`, { method: 'POST', body: { text, quote, ...src } });
    await loadProjects();
    toast('Added to Notes');
    const c = $('#notes-count');
    c.classList.remove('pulse');
    void c.offsetWidth;
    c.classList.add('pulse');
  } catch (e) {
    alert(`Couldn't add the note: ${e.message}`);
  }
}

let toastTimer;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

// A small right-click menu.
const ctx = document.createElement('div');
ctx.id = 'ctx';
ctx.hidden = true;
ctx.setAttribute('role', 'menu');
document.body.append(ctx);
function openMenu(e, items) {
  e.preventDefault();
  ctx.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.className = it.danger ? 'danger' : '';
    b.innerHTML = `${icon(it.icon, 14)}<span>${it.label}</span>`;
    b.onclick = () => { closeMenu(); it.run(); };
    ctx.append(b);
  }
  ctx.hidden = false;
  ctx.style.left = `${Math.min(e.clientX, innerWidth - ctx.offsetWidth - 8)}px`;
  ctx.style.top = `${Math.min(e.clientY, innerHeight - ctx.offsetHeight - 8)}px`;
  ctx.querySelector('button').focus();
}
const closeMenu = () => { ctx.hidden = true; };
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx')) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); }, true);
addEventListener('blur', closeMenu);
addEventListener('resize', closeMenu);
$('#history').addEventListener('scroll', closeMenu);

// Sidebar items can be renamed in place: the pencil (shown on hover), a double-click, or the
// right-click menu (which also deletes, when `del` is given). Enter or clicking away saves, Escape cancels.
function renamable(link, what, current, save, del, delLabel = `Delete ${what}…`) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost rename-btn';
  b.innerHTML = icon('pencil', 13);
  b.setAttribute('aria-label', `Rename ${what}`);
  b.title = 'Rename';
  link.append(b);
  const start = e => {
    e.stopPropagation();
    e.preventDefault();
    const span = link.querySelector('span');
    const input = document.createElement('input');
    input.className = 'rename-input';
    input.value = current;
    input.setAttribute('aria-label', `New name for this ${what}`);
    span.replaceWith(input);
    b.hidden = true;
    link.classList.add('renaming');
    input.focus();
    input.select();
    let done = false;
    const finish = async keep => {
      if (done) return;
      done = true;
      const title = input.value.replace(/\s+/g, ' ').trim();
      if (keep && title && title !== current) {
        try { await save(title); } catch (err) { alert(`Couldn't rename: ${err.message}`); }
      }
      loadProjects();
    };
    input.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    input.onblur = () => finish(true);
    input.onclick = e => e.stopPropagation(); // clicking in the box must not open the chat
  };
  b.onclick = start;
  link.ondblclick = start;
  link.oncontextmenu = e => openMenu(e, [
    { label: 'Rename', icon: 'pencil', run: () => start(e) },
    ...(del ? [{ label: delLabel, icon: 'trash', danger: true, run: () => del().catch(err => alert(`Couldn't delete: ${err.message}`)) }] : []),
  ]);
}

// A starred answer opens its chat, scrolled to that answer.
async function openStarred(projectId, { chatId, i }) {
  setSideCollapsed(false);
  await openProject(projectId, chatId);
  const el = document.querySelector(`#messages [data-hlkey="m:${chatId}:${i}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation when the same answer is opened twice
  el.classList.add('flash');
}

// ---------- main: upload or explanation ----------
function showUpload() {
  state.project = null;
  state.chatId = null;
  state.view = 'explain';
  viewer.close();
  $('#main').innerHTML = `
    <div class="upload">
      <label class="drop">
        ${icon('upload', 28)}
        <h2>Drop your study material</h2>
        <p>PDFs (lecture slides, notes, papers) or .txt / .md files.</p>
        <p>You'll get one explanation at five depths, a mindmap, and a tutor that has read everything.</p>
        <div class="pills">
          <span style="--c:var(--l1)">Like I'm 5</span><span style="--c:var(--l2)">Beginner</span>
          <span style="--c:var(--l3)">Student</span><span style="--c:var(--l4)">Exam-ready</span>
          <span style="--c:var(--l5)">Expert</span>
        </div>
        <input type="file" multiple accept=".pdf,.txt,.md" hidden>
        <p class="progress"></p>
      </label>
    </div>`;
  const drop = $('.drop');
  drop.querySelector('input').onchange = e => startProject([...e.target.files]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); startProject([...e.dataTransfer.files]); };
  renderSide();
  loadProjects();
}

async function startProject(files) {
  if (!files.length) return;
  const progress = $('.drop .progress');
  try {
    const name = files[0].name.replace(/\.[^.]+$/, '') + (files.length > 1 ? ` +${files.length - 1}` : '');
    const p = await api('', { method: 'POST', body: { name } });
    if (!agentConnected()) openAgentDialog(); // the work waits until the agent connects
    const sources = await extractSources(files, p.id, msg => { progress.textContent = msg; });
    // the PDFs themselves are kept too, to read alongside the explanation (index = order in the sources)
    progress.textContent = 'Saving your PDFs…';
    await Promise.all(files.map((f, k) => f.name.toLowerCase().endsWith('.pdf') && fetch(`/api/projects/${p.id}/pdfs/${k}`, { method: 'PUT', body: f })));
    progress.textContent = `Found ${sources.figures.length} figures. Handing everything to Claude…`;
    await api(`/${p.id}/sources`, { method: 'POST', body: sources });
    await openProject(p.id);
  } catch (e) {
    progress.textContent = `Something went wrong: ${e.message}`;
  }
}

async function openProject(id, chatId = null) {
  const switching = state.project?.id !== id;
  state.project = await api(`/${id}`);
  state.chatId = chatId;
  if (switching) {
    state.level = 0;
    state.seen = new Set();
    state.tabByLevel = {};
    state.answers = {};
    state.wrong = {};
    state.section = 0;
    state.mmKey = '';
    state.attachments = [];
    state.draftTitle = null;
    state.view = 'explain';
    state.scrolls = {};
    state.target = null;
    viewer.close();
    if (state.mini) closeMini();
    $('#main').classList.remove('pdf-mode');
    $('#main').innerHTML = `<div class="top"><div class="top-row"><h1></h1><div class="doc-switch seg" role="group" aria-label="Explanation or sources"></div><span class="pdf-pageno"></span><button class="switch" data-quizzes aria-pressed="${state.quizzesOn}"><span class="track"><span class="knob"></span></span>Quizzes</button></div><div class="levels"></div><div class="sections" role="tablist" aria-label="Sections"></div><div class="sources-bar" role="tablist" aria-label="Sources"></div></div><article id="article"></article>`;
    $('#main').append(pdfRoot);
    $('.top h1').textContent = state.project.name;
  }
  renderDocSwitch();
  setLevel(state.level);
  renderSide();
  setTab(chatId ? 'chat' : switching ? 'mindmap' : currentTab());
  loadProjects();
  poll();
}

function renderLevels() {
  const { levels, levelNames } = state.project;
  const html = levelNames.map((name, i) => {
    const s = levels[i]?.status;
    const done = levelComplete(i);
    const cls = [i <= state.level && 'filled', i === state.level && 'on', (s === 'running' || s === 'pending') && 'busy', s === 'error' && 'failed', done && 'complete'];
    return `<button class="lvl ${cls.filter(Boolean).join(' ')}" data-i="${i}" style="--c:${LEVEL_COLORS[i]}" aria-pressed="${i === state.level}" aria-label="Level ${i + 1}: ${name}${done ? ', all quizzes passed' : ''}" title="${name}${done ? ' — all quizzes passed' : ''}"><span class="bar"></span><span class="lbl"><b>${done ? icon('check', 13) : i + 1}</b><span>${name}</span></span></button>`;
  }).join('');
  document.querySelectorAll('.levels').forEach(el => { el.innerHTML = html; });
}

// A level is complete when every tab that has a quiz has been passed.
function levelComplete(i) {
  const job = state.project.levels[i];
  if (job?.tabsStatus !== 'done' || !job.tabs?.length) return false;
  const passed = state.project.progress?.[i] || [];
  return job.tabs.every((t, k) => !t.quiz?.length || passed.includes(k));
}

function setLevel(i) {
  state.tabByLevel[state.level] = state.section; // each level remembers its open tab
  state.level = i;
  state.section = state.tabByLevel[i] ?? 0;
  renderLevels();
  renderArticle();
}

const SKELETON = `<div class="skeleton" aria-hidden="true">${'<span class="h"></span><span></span><span></span><span></span>'.repeat(3)}</div>`;
let shownMd = null, shownTab = null;
function renderArticle(force = true) {
  const art = $('#article');
  const job = state.project.levels[state.level];
  if (!job) return;
  document.body.style.setProperty('--lc', LEVEL_COLORS[state.level]);
  const key = job.status + job.md + state.section + job.tabsStatus + job.citeStatus;
  if (!force && key === shownMd) return;
  shownMd = key;
  const name = state.project.levelNames[state.level];
  const status = {
    pending: `<div class="status"><span class="dot"></span>Waiting for Claude…</div>${SKELETON}`,
    running: `<div class="status"><span class="dot"></span>Claude is writing the “${name}” explanation…</div>${job.md ? '' : SKELETON}`,
    error: `<div class="error"><span>This level failed: ${DOMPurify.sanitize(job.error || '')}</span><button class="btn" data-retry="${state.level}">Retry</button></div>`,
  }[job.status] || '';
  // Progressive disclosure: one section per tab, in the order Claude wrote them.
  const sections = splitSections(job.md || '');
  const open = maxOpenTab(job, sections.length);
  state.section = Math.min(state.section, open);
  const sec = sections[state.section];
  if (sec) state.seen.add(`${state.level}:${state.section}`);
  const gateReady = !!job.tabs?.[open]?.quiz?.length; // can the quiz for the last open tab be taken yet?
  renderSectionTabs(sections, open, gateReady);
  art.innerHTML = status;
  if (!sec) return;
  const body = document.createElement('div');
  renderMd(body, `## ${sec.title}\n\n${sec.md}`);
  body.dataset.hlkey = `a:${state.level}:${state.section}`;
  if (body.dataset.hlkey !== shownTab) body.className = 'enter'; // animate tab/level switches, not streamed updates
  shownTab = body.dataset.hlkey;
  body.querySelector('h2').after(summaryPanel(job, state.section));
  art.append(body);
  decorate(body);
  art.append(citeList(body, job));

  const last = state.section === sections.length - 1;
  const next = sections[state.section + 1];
  const nav = document.createElement('nav');
  nav.className = 'sec-nav';
  nav.setAttribute('aria-label', 'Section navigation');
  nav.innerHTML = `
    <button class="btn" data-sec="${state.section - 1}" ${state.section ? '' : 'disabled'}>Previous</button>
    <span class="sec-mid"><span>${state.section + 1} / ${sections.length}</span>${state.quizzesOn && passedTabs().includes(state.section) ? `<button class="btn" data-review>${icon('check', 14)}Review quiz</button>` : ''}</span>
    ${next ? (state.section < open || gateReady
        ? `<button class="btn dark" data-sec="${state.section + 1}"><span></span>${icon('chevron', 14)}</button>`
        : `<button class="btn" disabled>${icon('lock', 14)}${job.status === 'done' ? 'Writing the quiz for this tab…' : 'Quiz appears when Claude finishes'}</button>`)
      : finishButton(job, state.section)}`;
  if (next && (state.section < open || gateReady)) setMathText(nav.querySelector('.dark span'), `Next: ${next.title}`);
  art.append(nav);
}

// ---------- citations: numbered markers in the text, and the tab's sources at its end ----------
// Markers on the same page of the same PDF share a number; each opens the PDF at its passage.
function citeList(body, job) {
  const sups = [...body.querySelectorAll('sup.cite')];
  const entries = [];
  for (const s of sups) {
    const k = s.dataset.k, c = job.cites?.[k], src = c && state.project.sources?.[c.source - 1];
    if (!src) { s.remove(); continue; }
    let e = entries.find(x => x.source === c.source && x.page === c.page);
    if (!e) entries.push(e = { source: c.source, page: c.page, src, n: entries.length + 1, ks: [] });
    e.ks.push(k);
    s.innerHTML = `<button data-cite="${k}"></button>`;
    const b = s.firstChild;
    b.textContent = e.n;
    b.title = `${src.name}, page ${c.page}: “${c.quote}”`;
    b.setAttribute('aria-label', `Source ${e.n}: ${src.name}, page ${c.page}`);
  }
  const box = document.createElement('section');
  box.className = 'cites';
  box.setAttribute('aria-label', 'Sources for this tab');
  const pdfs = state.project.sources?.some(s => s.pdf);
  if (job.status === 'done' && pdfs && !job.citeStatus && !job.cites) requestCite(state.level);
  const busy = job.status === 'done' && pdfs && (job.citeStatus === 'running' || (!job.citeStatus && !job.cites));
  if (busy) {
    box.innerHTML = `<h3>Sources</h3><div class="status"><span class="dot"></span>Finding where this comes from in your PDF…</div>`;
    return box;
  }
  if (job.citeStatus === 'error') {
    box.innerHTML = `<h3>Sources</h3><div class="cite-err">Couldn't find where this level comes from in your PDF. <button class="btn" data-cite-retry>Try again</button></div>`;
    return box;
  }
  if (!entries.length) return document.createComment('no sources');
  box.innerHTML = '<h3>Sources</h3><ol></ol>';
  for (const e of entries) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="cite-n">${e.n}</span><div class="cite-body"><button class="cite-src" data-cite="${e.ks[0]}">${icon('file', 13)}<span></span></button></div>`;
    li.querySelector('.cite-src span').textContent = `${e.src.name.replace(/\.pdf$/i, '')} · page ${e.page}`;
    for (const k of new Set(e.ks)) {
      const q = document.createElement('button');
      q.className = 'cite-quote';
      q.dataset.cite = k;
      q.textContent = `“${job.cites[k].quote}”`;
      li.querySelector('.cite-body').append(q);
    }
    box.querySelector('ol').append(li);
  }
  return box;
}

const citeRequested = new Set();
async function requestCite(level) {
  const key = `${state.project.id}:${level}`;
  if (citeRequested.has(key)) return;
  citeRequested.add(key);
  state.project.levels[level].citeStatus = 'running';
  await api(`/${state.project.id}/cite`, { method: 'POST', body: { level } });
  poll();
}

$('#main').addEventListener('click', async e => {
  const b = e.target.closest('[data-cite]');
  if (b) {
    const c = state.project.levels[state.level].cites?.[b.dataset.cite];
    if (c) setView(c.source - 1, { page: c.page, quote: c.quote });
    return;
  }
  if (e.target.closest('[data-cite-retry]')) {
    state.project.levels[state.level].citeStatus = 'running';
    renderArticle();
    await api(`/${state.project.id}/cite`, { method: 'POST', body: { level: state.level } });
    poll();
  }
  const v = e.target.closest('.doc-switch [data-view]');
  if (v) setView(v.dataset.view === 'explain' ? 'explain' : v.dataset.view === 'sources' ? firstSource() : Number(v.dataset.view));
  const src = e.target.closest('.sources-bar [data-src]');
  if (src) setView(Number(src.dataset.src));
});

// ---------- the source PDFs, read in place of the explanation ----------
const pdfRoot = document.createElement('div');
pdfRoot.id = 'pdf';
const viewer = createPdfViewer(pdfRoot, {
  scroller: $('#main'),
  onPage: preparePage,
  onPageChange: (n, total) => { $('.pdf-pageno').textContent = `Page ${n} / ${total}`; },
});

// Explanation | Sources. Under Sources, every PDF is a tab where the explanation's sections would
// be, and the selected one starts right beneath. Other kinds of source can't be shown, so aren't listed.
const pdfSources = () => (state.project.sources || []).map((s, k) => ({ ...s, k })).filter(s => s.pdf);
const firstSource = () => (pdfSources().find(s => s.k === state.lastSource) || pdfSources()[0]).k;
function renderDocSwitch() {
  const box = $('.doc-switch');
  if (!box) return;
  const pdfs = pdfSources();
  const reading = state.view !== 'explain';
  box.hidden = !pdfs.length;
  box.innerHTML = `<button data-view="explain" aria-pressed="${!reading}">${icon('book', 14)}<span>Explanation</span></button><button data-view="sources" aria-pressed="${reading}">${icon('file', 14)}<span>Sources</span></button>`;
  const bar = $('.sources-bar');
  bar.innerHTML = '';
  for (const s of pdfs) {
    const b = document.createElement('button');
    b.className = 'sec';
    b.dataset.src = s.k;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(state.view === s.k));
    b.title = s.name;
    b.innerHTML = `<b>${s.k + 1}</b><span></span>`;
    b.querySelector('span').textContent = s.name.replace(/\.pdf$/i, '');
    bar.append(b);
  }
}

// view: 'explain' or a source's index; target: { page, quote } to open the PDF at.
async function setView(view, target = null) {
  const main = $('#main');
  if (view !== state.view) state.scrolls[state.view] = main.scrollTop;
  const changed = view !== state.view;
  state.view = view;
  if (view !== 'explain') state.lastSource = view;
  main.classList.toggle('pdf-mode', view !== 'explain');
  renderDocSwitch();
  if (view === 'explain') {
    $('.pdf-pageno').textContent = '';
    if (changed) main.scrollTop = state.scrolls.explain ?? 0;
    return;
  }
  const src = state.project.sources[view];
  if (!src?.stored) {
    state.target = target;
    viewer.close();
    return showAttach(view);
  }
  try {
    const project = state.project.id;
    await viewer.open(`/api/projects/${project}/pdfs/${view}`, `pdf:${view}`);
    if (state.view !== view || state.project?.id !== project) return;
    $('.pdf-pageno').textContent = `Page ${viewer.page} / ${viewer.pages}`;
    if (target) {
      const page = await viewer.show(target.page);
      if (page && target.quote) showQuote(page, target.quote);
    } else if (changed) main.scrollTop = state.scrolls[view] ?? 0;
  } catch (e) {
    pdfRoot.innerHTML = `<div class="error">Couldn't open the PDF: ${DOMPurify.sanitize(e.message)}</div>`;
  }
}

// Projects made before PDFs were kept only have their text: the student adds the file once.
function showAttach(k) {
  const src = state.project.sources[k];
  pdfRoot.innerHTML = `
    <label class="drop pdf-attach">
      ${icon('upload', 28)}
      <h2>Add this PDF to read it here</h2>
      <p>This project was made before PDFs were kept with it. Choose <b></b> once and it's saved with the project.</p>
      <input type="file" accept=".pdf,application/pdf" hidden>
      <p class="progress"></p>
    </label>`;
  pdfRoot.querySelector('b').textContent = src.name;
  const drop = pdfRoot.querySelector('.drop');
  const take = async file => {
    if (!file) return;
    if (file.name !== src.name && !confirm(`This file is called “${file.name}”, not “${src.name}”. Use it anyway?`)) return;
    drop.querySelector('.progress').textContent = 'Saving…';
    await fetch(`/api/projects/${state.project.id}/pdfs/${k}`, { method: 'PUT', body: file });
    state.project.sources = (await api(`/${state.project.id}`)).sources;
    const target = state.target;
    state.target = null;
    setView(k, target);
  };
  drop.querySelector('input').onchange = e => take(e.target.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); take(e.dataTransfer.files[0]); };
}

// A cited passage: highlighted on its page and scrolled to. PDF text differs from what Claude copied
// (hyphenation, spacing), so letters and digits are matched; failing that, part of the quote.
function showQuote(page, quote) {
  pdfRoot.querySelectorAll('mark.cite-hl').forEach(m => m.replaceWith(...m.childNodes));
  const layer = page.querySelector('.textLayer');
  const words = quote.split(/\s+/);
  let marks = [];
  for (const t of [quote, words.slice(0, 8).join(' '), words.slice(-8).join(' '), words.slice(0, 4).join(' ')]) {
    if (layer && (marks = markText(layer, t, { cls: 'cite-hl', loose: true })).length) break;
  }
  (marks[0] || page).scrollIntoView({ block: marks.length ? 'center' : 'start' });
  const el = marks.length ? null : page;
  if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
}

// A page finished drawing: its formulas and figures get the hover actions, its notes their highlights.
function preparePage(el, n) {
  const src = state.project.sources[el.dataset.hlkey.split(':')[1]];
  for (const r of el.querySelectorAll('.pdf-region')) {
    const box = JSON.parse(r.dataset.box);
    const fig = state.project.figures.find(f => f.crop && f.source === src.name && f.page === n && f.box.every((v, i) => Math.abs(v - box[i]) < 0.004));
    if (fig) r.dataset.fig = fig.id;
    const formula = r.dataset.kind === 'formula';
    const d = document.createElement('div');
    d.className = `fig-actions region-actions${formula ? ' math-actions' : ''}`;
    d.innerHTML = `<button class="btn dark" data-region-ask aria-label="Ask about this ${formula ? 'formula' : 'figure'}">${icon('help', 13)}<span class="lbl">${formula ? 'Ask' : 'Ask question'}</span></button>
      <button class="btn dark region-add">${bigChatLabel(13, formula)}</button>`;
    r.append(d);
  }
  decorate(el);
}

// The formula or figure under a region, as a figure of its own (cropped from the page once).
async function regionFigure(r) {
  if (r.dataset.fig) return r.dataset.fig;
  const [, k, page] = r.closest('.pdf-page').dataset.hlkey.split(':');
  const id = state.project.id;
  const fig = await api(`/${id}/figures`, {
    method: 'POST', body: { source: state.project.sources[k].name, page: Number(page), box: JSON.parse(r.dataset.box), kind: r.dataset.kind },
  });
  const c = viewer.crop(r);
  await Promise.all([upload(id, `${fig.id}.jpg`, c, 1400), upload(id, `${fig.id}-sm.jpg`, c, 640)]);
  if (!state.project.figures.some(f => f.id === fig.id)) state.project.figures.push(fig);
  r.dataset.fig = fig.id;
  return fig.id;
}

pdfRoot.addEventListener('click', async e => {
  const ask = e.target.closest('[data-region-ask]'), add = e.target.closest('.region-add');
  if (!ask && !add) return;
  const r = e.target.closest('.pdf-region');
  const page = r.closest('.pdf-page').dataset.page;
  const what = r.dataset.kind === 'formula' ? 'Formula' : 'Figure';
  let id;
  try { id = await regionFigure(r); } catch (err) { return alert(`Couldn't take that ${what.toLowerCase()} from the page: ${err.message}`); }
  if (add) return attach({ type: 'figure', id, caption: `${what} from page ${page}` });
  const existing = (state.project.notes || []).find(n => n.figure === id && !n.text);
  openMini(existing ? { note: existing } : { draft: { key: `fig:${id}`, text: '', figure: id } }, r.getBoundingClientRect());
});

// Expandable "what happens in this tab" panel. Summaries are written after a level finishes.
function summaryPanel(job, i) {
  const panel = document.createElement('details');
  panel.className = 'tab-summary';
  panel.open = state.summaryOpen;
  panel.ontoggle = () => { state.summaryOpen = panel.open; };
  const s = job.tabs?.[i];
  if (!s) {
    if (job.status === 'done' && !job.tabsStatus) requestTabs(state.level);
    const msg = job.status !== 'done' ? 'Summary appears when Claude finishes this level'
      : job.tabsStatus === 'error' ? 'Summary and quiz could not be written, so this level is unlocked.' : 'Summarizing this tab…';
    panel.innerHTML = `<summary><span class="ts-label">In this tab</span><span class="ts-gist muted"></span>${icon('chevron', 14)}</summary>`;
    panel.querySelector('.ts-gist').textContent = msg;
    if (job.tabsStatus === 'error') panel.querySelector('summary').insertAdjacentHTML('beforeend', '<button class="btn" data-tabs-retry>Retry quiz &amp; summary</button>');
    panel.classList.add('pending');
    panel.querySelector('summary').onclick = e => e.preventDefault();
    return panel;
  }
  panel.innerHTML = `<summary><span class="ts-label">In this tab</span><span class="ts-gist"></span>${icon('chevron', 14)}</summary><ul></ul>`;
  setMathText(panel.querySelector('.ts-gist'), s.gist);
  for (const pt of s.points) {
    const li = document.createElement('li');
    setMathText(li, pt);
    panel.querySelector('ul').append(li);
  }
  return panel;
}

const tabsRequested = new Set();
async function requestTabs(level) {
  const key = `${state.project.id}:${level}`;
  if (tabsRequested.has(key)) return;
  tabsRequested.add(key);
  state.project.levels[level].tabsStatus = 'running';
  await api(`/${state.project.id}/tabs`, { method: 'POST', body: { level } });
  poll();
}

// ---------- quiz after every tab ----------
const passedTabs = () => state.project.progress?.[state.level] || [];

// Tabs unlock one at a time: you can open up to the first tab whose quiz you haven't passed.
// Tabs without a quiz (or a level whose quizzes failed to generate) never block.
function maxOpenTab(job, count) {
  if (!state.quizzesOn || job.tabsStatus === 'error') return count - 1;
  const passed = passedTabs();
  const clear = k => passed.includes(k) || (job.tabsStatus === 'done' && !job.tabs?.[k]?.quiz?.length);
  let i = 0;
  while (i < count - 1 && clear(i)) i++;
  return i;
}

const DIFF = { easy: 'Easy ●○○', medium: 'Medium ●●○', hard: 'Hard ●●●' };

function quizSection(job, i) {
  const box = document.createElement('section');
  box.className = 'quiz';
  box.classList.toggle('hide-diff', !state.showDifficulty);
  box.setAttribute('aria-label', 'Quiz');
  const quiz = job.tabs?.[i]?.quiz;
  if (!quiz?.length) {
    const msg = job.status !== 'done' ? 'The quiz for this tab appears when Claude finishes this level.'
      : job.tabsStatus === 'error' ? 'The quiz could not be written, so this level is unlocked.'
      : job.tabsStatus === 'done' ? '' : 'Claude is writing a quiz for this tab…';
    if (!msg) return document.createComment('no quiz');
    box.innerHTML = `<header><h3>Check yourself</h3></header><p class="quiz-sub"></p>${job.tabsStatus === 'error' ? '<button class="btn" data-tabs-retry>Retry quiz</button>' : ''}`;
    box.querySelector('.quiz-sub').textContent = msg;
    return box;
  }
  const key = `${state.level}:${i}`;
  const passed = passedTabs().includes(i);
  const right = state.answers[key] ||= new Set();
  const wrong = state.wrong[key] ||= new Set();
  box.innerHTML = `
    <header>
      <h3>Check yourself</h3>
      <button class="switch" data-diff aria-pressed="${state.showDifficulty}"><span class="track"><span class="knob"></span></span>Difficulty</button>
    </header>
    <p class="quiz-sub">${passed ? `${icon('check', 14)} Passed — the next tab is unlocked.` : `Answer all ${quiz.length} correctly to unlock the next tab.`}</p>`;
  quiz.forEach((q, qi) => {
    const done = passed || right.has(qi);
    const fs = document.createElement('fieldset');
    fs.className = done ? 'q done' : 'q';
    fs.innerHTML = `<legend><span class="diff" data-d="${q.difficulty}">${DIFF[q.difficulty] || ''}</span><span class="qtext"></span></legend><div class="opts"></div>`;
    setMathText(fs.querySelector('.qtext'), `${qi + 1}. ${q.q}`);
    q.options.forEach((o, oi) => {
      const b = document.createElement('button');
      b.className = 'opt';
      b.dataset.q = qi;
      b.dataset.o = oi;
      b.innerHTML = `<b>${'ABCD'[oi]}</b><span></span>`;
      setMathText(b.querySelector('span'), o);
      if (done && oi === q.answer) b.classList.add('right');
      if (wrong.has(`${qi}:${oi}`)) b.classList.add('wrong');
      b.disabled = done || wrong.has(`${qi}:${oi}`);
      fs.querySelector('.opts').append(b);
    });
    const fb = document.createElement('p');
    fb.className = 'feedback';
    if (done) setMathText(fb, q.why);
    else if ([...wrong].some(w => w.startsWith(`${qi}:`))) fb.textContent = 'Not quite — try another option.';
    else fb.hidden = true;
    fs.append(fb);
    box.append(fs);
  });
  return box;
}

async function answerQuiz(qi, oi) {
  const level = state.level, tab = state.gate.tab;
  const quiz = state.project.levels[level].tabs[tab].quiz;
  const key = `${level}:${tab}`;
  if (oi === quiz[qi].answer) state.answers[key].add(qi);
  else state.wrong[key].add(`${qi}:${oi}`);
  if (state.answers[key].size === quiz.length && !passedTabs().includes(tab)) {
    state.project.progress = await api(`/${state.project.id}/progress`, { method: 'POST', body: { level, tab } });
    renderLevels();
  }
  renderGate();
}

document.addEventListener('click', async e => {
  const opt = e.target.closest('.opt');
  if (opt && !opt.disabled) return answerQuiz(Number(opt.dataset.q), Number(opt.dataset.o));
  if (e.target.closest('[data-diff]')) {
    state.showDifficulty = !state.showDifficulty;
    try { localStorage.setItem('explainer.difficulty', state.showDifficulty ? '1' : '0'); } catch {}
    document.querySelectorAll('.quiz').forEach(q => q.classList.toggle('hide-diff', !state.showDifficulty));
    document.querySelectorAll('[data-diff]').forEach(b => b.setAttribute('aria-pressed', String(state.showDifficulty)));
  }
  const qs = e.target.closest('[data-quizzes]');
  if (qs) {
    state.quizzesOn = !state.quizzesOn;
    try { localStorage.setItem('explainer.quizzes', state.quizzesOn ? '1' : '0'); } catch {}
    qs.setAttribute('aria-pressed', String(state.quizzesOn));
    renderArticle();
  }
  if (e.target.closest('[data-tabs-retry]')) {
    state.project.levels[state.level].tabsStatus = 'running';
    renderArticle();
    await api(`/${state.project.id}/tabs`, { method: 'POST', body: { level: state.level } });
    poll();
  }
});
try {
  state.showDifficulty = localStorage.getItem('explainer.difficulty') !== '0';
  state.quizzesOn = localStorage.getItem('explainer.quizzes') !== '0';
} catch {}

function finishButton(job, i) {
  if (job.status === 'running') return `<span class="sec-end">Claude is still writing…</span>`;
  const needsQuiz = state.quizzesOn && job.tabs?.[i]?.quiz?.length && !passedTabs().includes(i);
  if (needsQuiz) return `<button class="btn dark" data-finish>${icon('check', 14)}Finish level</button>`;
  return `<span class="sec-end">${levelComplete(state.level) ? 'Level complete — every quiz passed' : 'You reached the end of this level'}</span>`;
}

function splitSections(md) {
  const out = [];
  for (const part of md.split(/^(?=## )/m)) {
    const m = part.match(/^## (.+)\n?([\s\S]*)$/);
    if (m) out.push({ title: m[1].trim().replace(/^\d+[.)]\s*/, ''), md: m[2] });
    else if (part.trim()) out.push({ title: 'Big picture', md: part });
  }
  return out;
}

function renderSectionTabs(sections, open, gateReady) {
  const bar = $('.sections');
  bar.hidden = sections.length < 2;
  bar.innerHTML = '';
  sections.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'sec';
    b.setAttribute('role', 'tab');
    b.dataset.sec = i;
    b.setAttribute('aria-selected', String(i === state.section));
    b.tabIndex = i === state.section ? 0 : -1;
    b.classList.toggle('seen', state.seen.has(`${state.level}:${i}`));
    const locked = i > open;
    b.disabled = i > open + 1 || (i === open + 1 && !gateReady);
    b.classList.toggle('passed', passedTabs().includes(i));
    const passed = passedTabs().includes(i);
    b.innerHTML = `<b>${locked ? icon('lock', 11) : passed ? icon('check', 12) : i + 1}</b><span></span>`;
    if (passed) b.setAttribute('aria-label', `${s.title}, quiz passed`);
    setMathText(b.querySelector('span'), s.title);
    b.title = !locked ? s.title : b.disabled ? `${s.title} — pass the earlier quizzes to unlock` : `${s.title} — take the quiz to unlock`;
    bar.append(b);
  });
}

function showSection(i) {
  state.section = i;
  renderArticle();
  $('#main').scrollTop = 0;
}

// Moving past the furthest open tab means taking that tab's quiz first.
function goToTab(i) {
  const job = state.project.levels[state.level];
  const open = maxOpenTab(job, splitSections(job.md || '').length);
  if (i <= open) return showSection(i);
  if (i === open + 1 && job.tabs?.[open]?.quiz?.length) openGate(open, i);
}

function openGate(tab, target, review = false) {
  state.gate = { tab, target, review };
  renderGate();
  $('#quiz-gate').showModal();
}

function renderGate() {
  const { tab, target, review } = state.gate;
  const job = state.project.levels[state.level];
  const titles = splitSections(job.md).map(s => s.title);
  const passed = passedTabs().includes(tab);
  const d = $('#quiz-gate');
  d.innerHTML = `<p class="gate-kicker">${review ? 'Quiz review' : 'Before you move on'}</p>`;
  const quiz = quizSection(job, tab);
  setMathText(quiz.querySelector('h3'), titles[tab]);
  d.append(quiz);
  const foot = document.createElement('div');
  foot.className = 'gate-foot';
  foot.innerHTML = `<button class="btn" data-gate-close>Back to reading</button>
    <button class="btn dark" data-gate-go ${passed ? '' : 'disabled'}><span></span>${icon('chevron', 14)}</button>`;
  foot.querySelector('[data-gate-go] span').textContent = !passed ? 'Answer all to continue' : target == null ? 'Finish level' : `Continue to ${titles[target]}`;
  if (review) foot.innerHTML = `<span></span><button class="btn dark" data-gate-close>Close</button>`;
  d.append(foot);
}

$('#quiz-gate').addEventListener('click', e => {
  const d = $('#quiz-gate');
  if (e.target === d || e.target.closest('[data-gate-close]')) return d.close(); // backdrop click = back to reading
  if (e.target.closest('[data-gate-go]')) {
    const { target } = state.gate;
    d.close();
    if (target != null) showSection(target);
  }
});
$('#quiz-gate').addEventListener('close', () => { state.gate = null; renderArticle(); });

// Show the explanation's scrollbar only while it is being scrolled.
let scrollIdle;
$('#main').addEventListener('scroll', () => {
  $('#main').classList.add('scrolling');
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(() => $('#main').classList.remove('scrolling'), 900);
}, { passive: true });
$('#main').addEventListener('click', e => {
  if (e.target.closest('[data-finish]')) return openGate(state.section, null);
  if (e.target.closest('[data-review]')) return openGate(state.section, null, true);
  const b = e.target.closest('[data-sec]');
  if (b && !b.disabled) goToTab(Number(b.dataset.sec));
});
$('#main').addEventListener('keydown', e => {
  if (!e.target.closest('.sections') || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = document.querySelectorAll('.sections .sec');
  const i = Math.max(0, Math.min(tabs.length - 1, state.section + (e.key === 'ArrowRight' ? 1 : -1)));
  if (tabs[i].disabled) return;
  goToTab(i);
  if (!state.gate) document.querySelectorAll('.sections .sec')[i].focus();
});

let pollTimer = null;
function poll() {
  clearTimeout(pollTimer);
  const p = state.project;
  if (!p) return;
  const busy = j => j && (j.status === 'pending' || j.status === 'running' || j.tabsStatus === 'running' || j.citeStatus === 'running');
  if (busy(p.mindmap) || p.levels.some(busy)) {
    pollTimer = setTimeout(async () => {
      if (state.project?.id !== p.id) return;
      const fresh = await api(`/${p.id}`);
      if (state.project?.id !== p.id) return;
      state.project = { ...fresh, chats: state.project.chats };
      renderLevels();
      renderArticle(false);
      renderMindmap();
      poll();
    }, 1200);
  }
}

document.addEventListener('click', e => {
  const lvl = e.target.closest('.lvl');
  if (!lvl || !state.project) return;
  setLevel(Number(lvl.dataset.i));
  if (lvl.closest('#main')) $('#main').scrollTop = 0;
});

$('#main').addEventListener('click', async e => {
  const retry = e.target.closest('[data-retry]');
  if (retry) {
    const level = retry.dataset.retry === 'mindmap' ? 'mindmap' : Number(retry.dataset.retry);
    await api(`/${state.project.id}/retry`, { method: 'POST', body: { level } });
    openProject(state.project.id, state.chatId);
  }
});

// ---------- right side: tabs ----------
const currentTab = () => $('#side .seg [aria-pressed="true"]').dataset.tab;
function setTab(tab) {
  const fromChat = currentTab() === 'chat';
  document.querySelectorAll('#side .seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
  $('#mindmap-view').hidden = tab !== 'mindmap';
  $('#chat-view').hidden = tab !== 'chat';
  if (tab === 'mindmap') requestAnimationFrame(() => fromChat ? mm.compact() : mm.fit());
}
$('#side .seg').onclick = e => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); };
function setFull(on) {
  document.body.classList.toggle('mm-full', on);
  const b = $('#mm-full');
  b.innerHTML = icon(on ? 'shrink' : 'expand');
  b.title = on ? 'Exit full screen' : 'Open full screen';
  b.setAttribute('aria-label', b.title);
  if (currentTab() === 'mindmap') requestAnimationFrame(() => mm.fit());
}
$('#mm-full').onclick = () => setFull(!document.body.classList.contains('mm-full'));
$('#new-chat').onclick = () => newChat();
$('#new-project').onclick = showUpload;

function renderSide() {
  renderMindmap();
  renderChat();
}

// ---------- mindmap ----------
const mmEmpty = document.createElement('div');
const mm = createMindmap($('#mindmap-view'), {
  figUrl,
  onStudy: (node, trail) => newChat(node.title,
    `Teach me "${node.title}" (${trail.join(' › ')}). Start with the core idea in two sentences, then walk me through it step by step, and finish with one exam-style question to test me.`),
  onDeeper: async nodeId => (await api(`/${state.project.id}/deeper`, { method: 'POST', body: { nodeId } })).nodes,
});
mmEmpty.className = 'mm-empty';
$('#mindmap-view').append(mmEmpty);

function renderMindmap() {
  const m = state.project?.mindmap;
  const key = m ? `${state.project.id}:${m.status}:${m.nodes.length}` : '';
  if (key === state.mmKey) return;
  state.mmKey = key;
  mmEmpty.hidden = m?.status === 'done';
  if (!m) mmEmpty.innerHTML = 'Upload sources to get a mindmap.';
  else if (m.status === 'error') mmEmpty.innerHTML = `<div class="error">Mindmap failed: ${DOMPurify.sanitize(m.error || '')} <button class="btn" data-retry="mindmap">Retry</button></div>`;
  else if (m.status !== 'done') mmEmpty.innerHTML = `<div><div class="status" style="justify-content:center"><span class="dot"></span>Claude is mapping your topics…</div>This takes a few minutes.</div>`;
  mm.setNodes(m?.status === 'done' ? m.nodes : []);
}
mmEmpty.addEventListener('click', async e => {
  if (!e.target.closest('[data-retry]')) return;
  await api(`/${state.project.id}/retry`, { method: 'POST', body: { level: 'mindmap' } });
  state.project.mindmap.status = 'running';
  renderMindmap();
  poll();
});

// ---------- chat ----------
// While an answer streams in, a chat box follows its bottom only until the
// reader scrolls up; scrolling back down to the end re-attaches it.
const pinned = new WeakMap(), lastTop = new WeakMap();
document.addEventListener('scroll', e => {
  const el = e.target;
  if (!(el instanceof Element) || !el.matches('#messages, .mini-msgs')) return;
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (el.scrollTop < (lastTop.get(el) ?? 0) && gap > 1) pinned.set(el, false);
  else if (gap < 40) pinned.set(el, true);
  lastTop.set(el, el.scrollTop);
}, { capture: true, passive: true });
function scrollToEnd(el, force) {
  if (force) pinned.set(el, true);
  if (pinned.get(el) !== false) el.scrollTop = el.scrollHeight;
}

const activeChat = () => state.project?.chats.find(c => c.id === state.chatId);

function renderChat() {
  const box = $('#messages');
  const chat = activeChat();
  box.innerHTML = '';
  if (!chat?.messages.length) {
    box.innerHTML = state.project
      ? `<div class="empty-chat">Ask Claude anything about your sources.<br>Tip: select any text and press <b>Add to reply</b>.
          <div class="suggest">
            <button>What are the 5 ideas most likely to be on the exam?</button>
            <button>Quiz me with 5 questions, one at a time.</button>
            <button>What do students usually get wrong here?</button>
          </div></div>`
      : `<div class="empty-chat">Upload sources to start chatting.</div>`;
    box.querySelectorAll('.suggest button').forEach(b => { b.onclick = () => { $('#input').value = b.textContent; send(); }; });
  }
  chat?.messages.forEach((m, i) => addMessage(m, i));
  scrollToEnd(box, true);
  renderAttachments();
}

// "claude-sonnet-5-5" → "Sonnet 5.5"
const modelName = id => id.replace(/^claude-([a-z]+)-(\d+)-(\d+).*$/, (_, f, a, b) => `${f[0].toUpperCase()}${f.slice(1)} ${a}.${b}`);
function labelModel(el, id, stopped) {
  if (!id && !stopped) return;
  const tag = document.createElement('div');
  tag.className = 'msg-model';
  tag.textContent = [id && modelName(id), stopped && 'Stopped'].filter(Boolean).join(' · ');
  el.append(tag);
}

function addMessage(m, i) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  if (i != null) el.dataset.hlkey = `m:${state.chatId}:${i}`;
  if (m.role === 'user') {
    for (const quote of m.quotes || (m.quote ? [m.quote] : [])) {
      const q = document.createElement('span');
      q.className = 'q';
      setMathText(q, quote);
      el.append(q);
    }
    if (m.figures?.length) {
      const row = document.createElement('div');
      row.className = 'msg-figs';
      for (const id of m.figures) {
        const fig = document.createElement('figure');
        fig.className = 'fig';
        fig.dataset.fig = id;
        fig.innerHTML = `<span class="fig-media"><img src="${figUrl(id)}" alt="Figure ${id}"></span>`;
        fig.querySelector('.fig-media').append(figActions(id));
        row.append(fig);
      }
      el.append(row);
    }
    const body = document.createElement('span');
    setMathText(body, m.text);
    el.append(body);
  } else {
    renderMd(el, m.text);
    labelModel(el, m.model, m.stopped);
    if (i != null) el.prepend(starButton(m, i));
  }
  $('#messages').append(el);
  if (i != null) decorate(el);
  return el;
}

// The star above each answer saves it to the history sidebar.
function starButton(m, i, chatId = state.chatId) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost star-btn';
  b.innerHTML = icon('star', 15);
  const show = () => {
    b.setAttribute('aria-pressed', String(!!m.starred));
    b.setAttribute('aria-label', m.starred ? 'Unstar this answer' : 'Star this answer');
    b.title = b.getAttribute('aria-label');
  };
  show();
  b.onclick = async () => {
    m.starred = !m.starred;
    show();
    try {
      await api(`/${state.project.id}/chats/${chatId}/messages/${i}/star`, { method: 'PUT', body: { on: m.starred } });
    } catch {
      m.starred = !m.starred;
      show();
    }
    loadProjects();
  };
  return b;
}

// ---------- attachments: any number of quoted passages and figures ----------
function attach(item) {
  const dupe = state.attachments.some(a => a.type === item.type && (a.text ?? a.id) === (item.text ?? item.id));
  if (!dupe) state.attachments.push(item);
  if (document.body.classList.contains('side-collapsed')) peekSide(true); else setSideCollapsed(false);
  setTab('chat');
  renderAttachments();
  if (!dupe) $('#attachments').lastElementChild.classList.add('enter');
  $('#input').focus();
}

function renderAttachments() {
  const box = $('#attachments');
  box.hidden = !state.attachments.length;
  box.innerHTML = '';
  state.attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = `chip ${a.type}`;
    chip.innerHTML = a.type === 'quote'
      ? `${icon('reply', 14)}<span></span>`
      : `<img src="${figUrl(a.id)}" alt=""><span></span>`;
    if (a.type === 'quote') setMathText(chip.querySelector('span'), a.text);
    else chip.querySelector('span').textContent = a.caption || `Figure ${a.id}`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'ghost';
    x.setAttribute('aria-label', 'Remove');
    x.innerHTML = icon('x', 14);
    x.onclick = () => { state.attachments.splice(i, 1); renderAttachments(); };
    chip.append(x);
    box.append(chip);
  });
}

// A new chat is only a blank page (and maybe a prewritten prompt): it isn't saved, or listed in
// the history, until a question is sent in it.
function newChat(title, draft = '') {
  if (!state.project) return;
  state.chatId = null;
  state.draftTitle = title || null;
  renderChat();
  setTab('chat');
  $('#input').value = draft;
  $('#input').focus();
  loadProjects();
}

async function createChat() {
  const chat = await api(`/${state.project.id}/chats`, { method: 'POST', body: { title: state.draftTitle } });
  state.draftTitle = null;
  state.project.chats.unshift(chat);
  state.chatId = chat.id;
  return chat;
}

// POSTs a message and reads the server-sent-event stream of Claude's answer.
async function streamPost(url, body, onAnswer, signal, onStart) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '', answer = '', model = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const events = buf.split('\n\n');
    buf = events.pop();
    for (const ev of events) {
      const data = JSON.parse(ev.replace(/^data: /, ''));
      if (data.error) throw new Error(data.error);
      if (data.start) onStart?.();
      if (data.model) model = data.model;
      if (data.t) onAnswer(answer += data.t);
    }
  }
  return { answer, model };
}

async function send() {
  const text = $('#input').value.trim() || (state.attachments.length ? 'Explain this.' : '');
  if (!text || state.streaming || !state.project) return;
  if (!activeChat()) await createChat();
  const chat = activeChat();
  const quotes = state.attachments.filter(a => a.type === 'quote').map(a => a.text);
  const figures = state.attachments.filter(a => a.type === 'figure').map(a => a.id);
  const msg = { text, quotes, figures, level: state.level, model: $('#model').value };
  if (!chat.messages.length) $('#messages').innerHTML = '';
  chat.messages.push({ role: 'user', text, quotes, figures });
  addMessage(chat.messages.at(-1), chat.messages.length - 1).classList.add('enter');
  $('#input').value = '';
  state.attachments = [];
  renderAttachments();

  state.streaming = new AbortController();
  setSendButton(true);
  let partial = '';
  const out = addMessage({ role: 'assistant', text: '' });
  out.classList.add('enter');
  out.innerHTML = `<div class="status"><span class="dot"></span>Thinking…</div>`;
  scrollToEnd($('#messages'), true);
  try {
    const { answer, model } = await streamPost(`/api/projects/${state.project.id}/chats/${chat.id}/messages`, msg, answer => {
      renderMd(out, partial = answer);
      scrollToEnd($('#messages'));
    }, state.streaming.signal, loadProjects);
    chat.messages.push({ role: 'assistant', text: answer, model });
    out.dataset.hlkey = `m:${chat.id}:${chat.messages.length - 1}`;
    labelModel(out, model);
    out.prepend(starButton(chat.messages.at(-1), chat.messages.length - 1, chat.id));
    if (chat.title === 'New chat') chat.title = text.replace(/^\/short\b\s*/i, '').slice(0, 48) || 'New chat';
  } catch (e) {
    if (e.name === 'AbortError') {
      // stopped: keep what was written so far (the server saves the same)
      chat.messages.push({ role: 'assistant', text: partial, stopped: true });
      out.dataset.hlkey = `m:${chat.id}:${chat.messages.length - 1}`;
      renderMd(out, partial);
      labelModel(out, null, true);
      out.prepend(starButton(chat.messages.at(-1), chat.messages.length - 1, chat.id));
    } else {
      chat.messages.pop();
      out.innerHTML = `<div class="error">Claude couldn't answer: ${DOMPurify.sanitize(e.message)}</div>`;
    }
  }
  state.streaming = null;
  setSendButton(false);
  loadProjects();
}
// The chosen model is a per-browser preference.
try { $('#model').value = localStorage.getItem('explainer.model') || ''; } catch {}
$('#model').onchange = () => { try { localStorage.setItem('explainer.model', $('#model').value); } catch {} };

// While an answer streams in, the send button becomes a stop button.
function setSendButton(streaming) {
  const b = $('#send');
  b.innerHTML = icon(streaming ? 'stop' : 'up');
  b.setAttribute('aria-label', streaming ? 'Stop generating' : 'Send');
  b.title = streaming ? 'Stop generating' : '';
}
$('#composer').onsubmit = e => {
  e.preventDefault();
  if (state.streaming) state.streaming.abort();
  else send();
};
$('#input').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
};

// ---------- collapse the chat panel ----------
// Collapsed, the panel is a floating island: hovering the right edge slides it in, and it stays
// while a reply is being written (something attached, text typed, or the cursor inside it).
let peekTimer;
function peekSide(on) {
  clearTimeout(peekTimer);
  const body = document.body;
  if (!body.classList.contains('side-collapsed') || body.classList.contains('side-peek') === on) return;
  body.classList.toggle('side-peek', on);
  if (on && currentTab() === 'mindmap') setTimeout(() => mm.fit(), 220);
}
const replying = () => state.attachments.length || $('#input').value.trim() || $('#side').contains(document.activeElement) && document.activeElement.matches('textarea, select');
$('#side-edge').onmouseenter = () => peekSide(true);
$('#side').addEventListener('mouseenter', () => clearTimeout(peekTimer));
const leaveSide = () => {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => { if (!replying()) peekSide(false); }, 350);
};
$('#side').addEventListener('mouseleave', leaveSide);
$('#side-edge').addEventListener('mouseleave', leaveSide);
document.addEventListener('mousedown', e => {
  if (document.body.classList.contains('side-peek') && !e.target.closest('#side, #sel-actions, #mini') && !replying()) peekSide(false);
});
function setSideCollapsed(on) {
  document.body.classList.toggle('side-collapsed', on);
  document.body.classList.remove('side-peek');
  $('#side-open').hidden = !on;
  try { localStorage.setItem('explainer.side', on ? 'collapsed' : 'open'); } catch {}
  if (!on && currentTab() === 'mindmap') requestAnimationFrame(() => mm.fit());
}
$('#side-collapse').onclick = () => setSideCollapsed(true);
$('#side-open').onclick = () => setSideCollapsed(false);
try { if (localStorage.getItem('explainer.side') === 'collapsed') setSideCollapsed(true); } catch {}

// ---------- resize the chat panel ----------
const SIDE_MIN = 320, MAIN_MIN = 420;
function setSideWidth(w) {
  w = Math.round(Math.max(SIDE_MIN, Math.min(w, innerWidth - $('#history').offsetWidth - MAIN_MIN)));
  document.body.style.setProperty('--side-width', `${w}px`);
  $('#side-resize').setAttribute('aria-valuenow', String(w));
  return w;
}
const saveSideWidth = w => { try { localStorage.setItem('explainer.sideWidth', String(w)); } catch {} };
const resizer = $('#side-resize');
resizer.addEventListener('pointerdown', e => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  let w;
  const move = e => { w = setSideWidth(innerWidth - e.clientX); };
  const up = () => {
    resizer.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    if (w) saveSideWidth(w);
    if (currentTab() === 'mindmap') mm.fit();
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up, { once: true });
  resizer.addEventListener('pointercancel', up, { once: true });
});
resizer.addEventListener('dblclick', () => { saveSideWidth(setSideWidth(420)); if (currentTab() === 'mindmap') mm.fit(); });
resizer.addEventListener('keydown', e => {
  const step = e.shiftKey ? 80 : 20, d = { ArrowLeft: step, ArrowRight: -step }[e.key];
  if (!d) return;
  e.preventDefault();
  saveSideWidth(setSideWidth($('#side').offsetWidth + d));
});
try { const w = +localStorage.getItem('explainer.sideWidth'); if (w) setSideWidth(w); } catch {}
addEventListener('resize', () => {
  const w = parseInt(document.body.style.getPropertyValue('--side-width'));
  if (w) setSideWidth(w);
});

// ---------- collapse the history sidebar ----------
function setHistCollapsed(on) {
  document.body.classList.toggle('hist-collapsed', on);
  $('#hist-open').hidden = !on;
  try { localStorage.setItem('explainer.history', on ? 'collapsed' : 'open'); } catch {}
  if (currentTab() === 'mindmap') requestAnimationFrame(() => mm.fit());
}
$('#hist-collapse').onclick = () => setHistCollapsed(true);
$('#hist-open').onclick = () => setHistCollapsed(false);
try {
  const saved = localStorage.getItem('explainer.history');
  if (saved === 'collapsed' || (!saved && innerWidth < 1000)) setHistCollapsed(true); // a narrow window starts with the history tucked away
} catch {}

// ---------- select text → ask inline, or continue in the big chat ----------
const selBar = $('#sel-actions');
$('#sel-big').innerHTML = bigChatLabel(14);
document.addEventListener('mouseup', e => {
  if (e.target.closest('#sel-actions, #mini')) return;
  setTimeout(() => {
    const sel = getSelection();
    const node = sel.anchorNode?.parentElement;
    if (!sel.rangeCount || !sel.toString().trim() || !state.project || !node?.closest('#article, #messages, #pdf')) return (selBar.hidden = true);
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    state.sel = selectionAnchor(sel) || { text: sel.toString().trim(), key: null, occ: 0, rect };
    state.sel.rect = rect;
    selBar.querySelector('[data-sel="note"]').hidden = !noteSource(state.sel.key);
    selBar.hidden = false;
    selBar.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - selBar.offsetWidth - 8))}px`;
    selBar.style.top = `${rect.top - selBar.offsetHeight - 8 > 8 ? rect.top - selBar.offsetHeight - 8 : rect.bottom + 8}px`;
  });
});
selBar.addEventListener('click', e => {
  const b = e.target.closest('[data-sel]');
  if (!b || !state.sel) return;
  const { text, key, rect, occ } = state.sel;
  selBar.hidden = true;
  getSelection().removeAllRanges();
  if (b.dataset.sel === 'big') return attach({ type: 'quote', text });
  if (b.dataset.sel === 'note') return addNote(text, key);
  const existing = (state.project.notes || []).find(n => n.key === key && n.text === text && (n.occ || 0) === occ);
  openMini(existing ? { note: existing } : { draft: { key, text, occ } }, rect);
});

document.addEventListener('click', e => {
  if (!state.project) return;
  const add = e.target.closest('.fig-add');
  if (add) return attach({ type: 'figure', id: add.dataset.fig, caption: add.dataset.caption });
  const mathAdd = e.target.closest('.math-add');
  if (mathAdd) return attach({ type: 'quote', text: mathAdd.closest('.math').dataset.tex });
  const mathAsk = e.target.closest('[data-math-ask]');
  if (mathAsk) {
    const m = mathAsk.closest('.math'), text = m.dataset.tex, root = m.closest('[data-hlkey]'), key = root?.dataset.hlkey || null;
    const occ = root ? [...root.querySelectorAll('.math')].filter(x => x.dataset.tex === text).indexOf(m) : 0;
    const existing = (state.project.notes || []).find(n => n.key === key && n.text === text && (n.occ || 0) === occ);
    return openMini(existing ? { note: existing } : { draft: { key, text, occ } }, m.getBoundingClientRect());
  }
  const ask = e.target.closest('[data-fig-ask]');
  if (ask) {
    const id = ask.dataset.figAsk;
    const existing = (state.project.notes || []).find(n => n.figure === id && !n.text);
    const rect = (ask.closest('figure, .mm-thumb-wrap') || ask).getBoundingClientRect();
    return openMini(existing ? { note: existing } : { draft: { key: `fig:${id}`, text: '', figure: id } }, rect);
  }
  // clicking a yellow highlight (or a figure's "Asked" badge) reopens its small chat
  const mark = e.target.closest('mark.hl, .fig-note, .math.has-note');
  if (mark && !getSelection().toString().trim()) {
    const note = (state.project.notes || []).find(n => n.id === mark.dataset.note);
    if (note) openMini({ note }, mark.getBoundingClientRect());
  }
});

// ---------- yellow highlights for passages asked about ----------
const SKIP = 'button, .msg-model, .fig-note, .cites, .math-actions, .fig-actions';

// What can be matched in `root`, in reading order: each character of its text, and for a formula
// each character of its source (so a formula counts as one unit however KaTeX happens to draw it).
function flatten(root, keep) {
  const chars = [];
  const walk = node => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {
        for (let i = 0; i < c.data.length; i++) if (keep(c.data[i])) chars.push({ n: c, i, ch: c.data[i] });
      } else if (c.nodeType === 1 && !c.matches(SKIP)) {
        if (c.matches('.math')) { for (const ch of c.dataset.tex || '') if (keep(ch)) chars.push({ m: c, ch }); }
        else walk(c);
      }
    }
  };
  walk(root);
  return chars;
}

// Wraps the `occ`th occurrence of `needle` (ignoring whitespace, which differs between the selection
// and the DOM) in <mark>, one text node at a time so it can span bold text etc.; a formula inside it
// is lit up whole. `loose` matches letters and digits only, ignoring case. Returns the marks, in
// reading order, with the formulas in `.maths`.
function markText(root, needle, { note, cls = 'hl', loose = false, occ = 0 } = {}) {
  const keep = loose ? ch => /[\p{L}\p{N}]/u.test(ch) : ch => !/\s/.test(ch);
  const chars = flatten(root, keep);
  const hay = chars.map(c => (loose ? c.ch.toLowerCase() : c.ch)).join('');
  const pat = [...needle].filter(keep).join('');
  const want = loose ? pat.toLowerCase() : pat;
  const marks = [];
  marks.maths = [];
  if (!want) return marks;
  let at = -1;
  for (let k = 0, from = 0; k <= occ; k++) {
    at = hay.indexOf(want, from);
    if (at < 0) break;
    from = at + 1;
  }
  if (at < 0 && occ) at = hay.indexOf(want); // the text moved: the first one will do
  if (at < 0) return marks;
  const span = chars.slice(at, at + want.length);
  for (const m of new Set(span.filter(c => c.m).map(c => c.m))) {
    m.classList.add(cls === 'hl' || cls.startsWith('hl ') ? 'has-note' : `${cls}-math`);
    if (cls.endsWith('draft')) m.classList.add('draft');
    if (note) { m.dataset.note = note; m.title = 'You asked about this — click to reopen'; }
    marks.maths.push(m);
  }
  const nodes = [...new Set(span.filter(c => c.n).map(c => c.n))];
  for (const n of nodes.reverse()) {
    const mine = span.filter(c => c.n === n);
    const r = document.createRange();
    r.setStart(n, mine[0].i);
    r.setEnd(n, mine.at(-1).i + 1);
    const mark = document.createElement('mark');
    mark.className = cls;
    if (note) {
      mark.dataset.note = note;
      mark.title = 'You asked about this — click to reopen';
    }
    r.surroundContents(mark);
    marks.unshift(mark);
  }
  return marks;
}

// The selection as something that can be asked about and found again: its text (formulas as their
// source, even when only a bit of one is selected), where it is, and which occurrence of that text it is.
function selectionAnchor(sel) {
  const range = sel.getRangeAt(0).cloneRange();
  const el = n => (n.nodeType === 1 ? n : n.parentElement);
  const root = el(range.startContainer)?.closest('[data-hlkey]');
  if (!root) return null;
  const a = el(range.startContainer).closest('.math'), b = el(range.endContainer).closest('.math');
  if (a) range.setStartBefore(a);
  if (b) range.setEndAfter(b);
  if (!root.contains(range.endContainer)) range.setEnd(root, root.childNodes.length); // stays in the one message/page/section
  const frag = range.cloneContents();
  frag.querySelectorAll('.math').forEach(m => m.replaceWith(m.dataset.tex || ''));
  frag.querySelectorAll(SKIP).forEach(x => x.remove());
  const text = frag.textContent.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const chars = flatten(root, ch => !/\s/.test(ch));
  const first = chars.findIndex(c => (c.m ? range.intersectsNode(c.m) : range.comparePoint(c.n, c.i) === 0 && range.comparePoint(c.n, c.i + 1) === 0));
  let occ = 0;
  if (first > 0) {
    const hay = chars.map(c => c.ch).join(''), pat = [...text].filter(ch => !/\s/.test(ch)).join('');
    for (let at = hay.indexOf(pat); at >= 0 && at < first; at = hay.indexOf(pat, at + 1)) occ++;
  }
  return { text, key: root.dataset.hlkey, occ, rect: range.getBoundingClientRect() };
}

// The passage in a half-open small chat is lit up at once, and lets go again unless something is asked.
let draftMarks = null;
function showDraft({ key, text, occ }) {
  clearDraft();
  const root = [...document.querySelectorAll('[data-hlkey]')].find(e => e.dataset.hlkey === key);
  if (!root || !text) return;
  draftMarks = markText(root, text, { cls: 'hl draft', occ });
}
function clearDraft() {
  if (!draftMarks) return;
  const parents = new Set();
  for (const m of draftMarks) { parents.add(m.parentNode); m.replaceWith(...m.childNodes); }
  parents.forEach(p => p?.normalize());
  for (const m of draftMarks.maths) m.classList.remove('has-note', 'draft');
  draftMarks = null;
}

function decorate(el) {
  if (!state.project) return;
  el.querySelectorAll('mark.hl').forEach(m => m.replaceWith(...m.childNodes));
  el.normalize();
  const notes = state.project.notes || [];
  el.querySelectorAll('.math').forEach(m => { m.classList.remove('has-note'); delete m.dataset.note; });
  for (const n of notes) {
    if (!n.text || n.key !== el.dataset.hlkey) continue;
    const m = [...el.querySelectorAll('.math')].filter(x => x.dataset.tex === n.text)[n.occ || 0];
    if (m) { m.classList.add('has-note'); m.dataset.note = n.id; m.title = 'You asked about this — click to reopen'; }
    else markText(el, n.text, { note: n.id, occ: n.occ || 0 });
  }
  el.querySelectorAll('figure.fig[data-fig], .pdf-region[data-fig]').forEach(f => {
    const n = notes.find(x => x.figure === f.dataset.fig && !x.text);
    f.classList.toggle('has-note', !!n);
    f.querySelector(':scope > .fig-note, :scope > .fig-media > .fig-note')?.remove();
    if (n) (f.querySelector('.fig-media') || f).insertAdjacentHTML('beforeend', `<button class="fig-note" data-note="${n.id}">${icon('help', 12)}Asked</button>`);
  });
}
const decorateAll = () => document.querySelectorAll('[data-hlkey]').forEach(decorate);

// ---------- the small inline chat (always the fastest model) ----------
const mini = $('#mini');
function openMini(src, rect) {
  selBar.hidden = true;
  clearDraft();
  state.mini = { ...src, rect, busy: false };
  if (src.draft?.text) showDraft(src.draft);
  renderMini();
  mini.hidden = false;
  placeMini();
  mini.querySelector('textarea').focus();
}
function closeMini() {
  clearDraft();
  mini.hidden = true;
  state.mini = null;
}

// Beside the thing it's about: to the right if there's room, else left, else below/above.
function placeMini() {
  const r = state.mini.rect, w = mini.offsetWidth, h = mini.offsetHeight, gap = 10;
  let left, top = r.top;
  if (r.right + gap + w < innerWidth - 8) left = r.right + gap;
  else if (r.left - gap - w > 8) left = r.left - gap - w;
  else {
    left = r.left;
    top = r.bottom + gap + h < innerHeight - 8 ? r.bottom + gap : r.top - gap - h;
  }
  mini.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`;
  mini.style.top = `${Math.max(8, Math.min(top, innerHeight - h - 8))}px`;
}

function renderMini() {
  const m = state.mini, subject = m.note || m.draft;
  mini.innerHTML = `
    <div class="mini-head">
      <span class="mini-label" title="Answered by the fastest model">${icon('help', 13)}Quick · fast</span>
      <div class="mini-tools">
        <button class="btn" data-mini="big">${bigChatLabel(13)}</button>
        ${m.note ? `<button class="ghost icon-btn" data-mini="expand" aria-label="Continue in the big chat" title="Continue in the big chat">${icon('expand', 15)}</button>` : ''}
        ${m.note ? `<button class="ghost icon-btn" data-mini="more" aria-label="More options" aria-expanded="false">${icon('more', 16)}</button>` : ''}
        <button class="ghost icon-btn" data-mini="close" aria-label="Close">${icon('x', 16)}</button>
      </div>
    </div>
    <div class="mini-menu" hidden><button data-mini="delete">${icon('trash', 14)}Delete highlight &amp; chat</button></div>
    <div class="mini-subject"></div>
    <div class="mini-msgs" aria-live="polite"></div>
    <form class="mini-form">
      <textarea rows="1" placeholder="Ask about this…" aria-label="Your question"></textarea>
      <button class="btn dark icon-btn" aria-label="Ask">${icon('up')}</button>
    </form>`;
  const subj = mini.querySelector('.mini-subject');
  if (subject.figure) subj.innerHTML = `<img src="${figUrl(subject.figure)}" alt="Figure ${subject.figure}">`;
  else setMathText(subj, subject.text);
  renderMiniMsgs();
}

// Keeps an inline answer as a note, remembering the passage it was about.
function miniNoteButton(m) {
  const { note, draft } = state.mini, subject = note || draft;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost mini-note-btn';
  b.innerHTML = `${icon('note', 13)}Add to notes`;
  if (!noteSource(subject.key)) b.hidden = true;
  b.onclick = async () => {
    b.disabled = true;
    await addNote(m.text, subject.key, subject.text);
    b.innerHTML = `${icon('check', 13)}Added`;
  };
  return b;
}

function renderMiniMsgs(streaming) {
  const box = mini.querySelector('.mini-msgs');
  box.innerHTML = '';
  const msgs = [...(state.mini.note?.messages || [])];
  if (streaming != null) msgs.push({ role: 'assistant', text: streaming || '…' });
  for (const m of msgs) {
    const el = document.createElement('div');
    el.className = `mini-msg ${m.role}`;
    if (m.role === 'user') setMathText(el, m.text);
    else {
      renderMd(el, m.text);
      if (!(streaming != null && m === msgs.at(-1))) el.append(miniNoteButton(m));
    }
    box.append(el);
  }
  box.hidden = !msgs.length;
  scrollToEnd(box, streaming === '');
}

async function miniSend() {
  const m = state.mini, ta = mini.querySelector('textarea');
  const text = ta.value.trim();
  if (!text || m.busy) return;
  m.busy = true;
  ta.value = '';
  ta.disabled = true;
  try {
    if (!m.note) {
      const { key, text: quote, figure, occ } = m.draft;
      m.note = await api(`/${state.project.id}/notes`, { method: 'POST', body: { key, text: quote, figure, occ } });
      clearDraft();
      (state.project.notes ||= []).push(m.note);
      decorateAll();
      renderMini(); // rebuilt with the ⋯ menu now that there is something to delete
      mini.querySelector('textarea').disabled = true;
    }
    const note = m.note;
    note.messages.push({ role: 'user', text });
    renderMiniMsgs('');
    placeMini();
    const { answer, model } = await streamPost(`/api/projects/${state.project.id}/notes/${note.id}/messages`, { text, level: state.level }, a => {
      if (state.mini?.note === note) renderMiniMsgs(a);
    });
    note.messages.push({ role: 'assistant', text: answer, model });
  } catch (e) {
    m.note?.messages.pop();
    alert(`Claude couldn't answer: ${e.message}`);
  }
  m.busy = false;
  if (state.mini === m) {
    renderMiniMsgs();
    const t = mini.querySelector('textarea');
    t.disabled = false;
    t.focus();
    placeMini();
  }
}

mini.addEventListener('submit', e => { e.preventDefault(); miniSend(); });
mini.addEventListener('keydown', e => {
  if (e.target.matches('textarea') && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); miniSend(); }
});
mini.addEventListener('click', async e => {
  const act = e.target.closest('[data-mini]')?.dataset.mini;
  const m = state.mini;
  if (!act || !m) return;
  if (act === 'close') return closeMini();
  if (act === 'more') {
    const menu = mini.querySelector('.mini-menu');
    menu.hidden = !menu.hidden;
    e.target.closest('button').setAttribute('aria-expanded', String(!menu.hidden));
    return placeMini();
  }
  if (act === 'delete') {
    if (!confirm('Delete this highlight and its chat?')) return;
    await fetch(`/api/projects/${state.project.id}/notes/${m.note.id}`, { method: 'DELETE' });
    state.project.notes = state.project.notes.filter(n => n.id !== m.note.id);
    closeMini();
    return decorateAll();
  }
  if (act === 'big') {
    if (m.busy) return; // wait for the answer so the big chat gets the whole conversation
    const subject = m.note || m.draft;
    closeMini();
    // panel open → "Add to reply": attach the passage/figure; collapsed → carry the whole conversation over
    const collapsed = document.body.classList.contains('side-collapsed');
    if (!collapsed || !m.note?.messages.length) return attach(subject.figure ? { type: 'figure', id: subject.figure } : { type: 'quote', text: subject.text });
    return continueInBig(m.note);
  }
  if (act === 'expand') {
    if (m.busy || !m.note) return;
    closeMini();
    continueInBig(m.note);
  }
});
// carry a small chat's conversation over: the big chat branches off it
async function continueInBig(note) {
  const chat = await api(`/${state.project.id}/notes/${note.id}/continue`, { method: 'POST' });
  state.project.chats.unshift(chat);
  state.chatId = chat.id;
  if (document.body.classList.contains('side-collapsed')) peekSide(true); else setSideCollapsed(false);
  renderChat();
  setTab('chat');
  $('#input').focus();
  loadProjects();
}
// clicking elsewhere closes the small chat
document.addEventListener('mousedown', e => {
  if (state.mini && !e.target.closest('#mini, #sel-actions, mark.hl, .fig-note, [data-fig-ask], [data-math-ask], [data-region-ask], .math.has-note')) closeMini();
});

// A formula's hover buttons sit above it; near the edge of the panel they slide back inside it.
document.addEventListener('mouseover', e => {
  const m = e.target.closest?.('.math:not(.display)');
  const bar = m?.querySelector(':scope > .math-actions');
  const box = m?.closest('#main, #messages, .mini-msgs');
  if (!bar || !box) return;
  bar.style.translate = '';
  const b = bar.getBoundingClientRect(), c = box.getBoundingClientRect();
  const dx = b.right > c.right - 8 ? c.right - 8 - b.right : b.left < c.left + 8 ? c.left + 8 - b.left : 0;
  if (dx) bar.style.translate = `${dx}px 0`;
});

// ---------- figure lightbox ----------
document.addEventListener('click', e => {
  if (e.target.matches('figure.fig img')) {
    $('#lightbox img').src = e.target.src;
    $('#lightbox').hidden = false;
  }
});
$('#lightbox').onclick = () => { $('#lightbox').hidden = true; };
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#lightbox').hidden) $('#lightbox').hidden = true;
  else if (state.mini) closeMini();
  else setFull(false);
});

showUpload();

// ---------- wide display formulas shrink to fit the chat instead of scrolling sideways ----------
function fitMath(root) {
  for (const el of root.querySelectorAll('.katex-display')) {
    el.style.zoom = '';
    if (el.clientWidth && el.scrollWidth > el.clientWidth + 1) el.style.zoom = Math.max(0.45, el.clientWidth / el.scrollWidth).toFixed(3);
  }
}
for (const box of [$('#messages'), $('#mini')]) {
  let queued = false;
  const refit = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fitMath(box); });
  };
  new MutationObserver(refit).observe(box, { childList: true, subtree: true });
  new ResizeObserver(refit).observe(box);
  document.fonts?.ready.then(refit);
  document.fonts?.addEventListener('loadingdone', refit); // KaTeX's fonts change the widths once they arrive
}
