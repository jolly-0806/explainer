// Explainer — local server. All AI work is done by the Claude Code CLI (`claude -p`)
// using your existing login, so there is no API key and no extra cost.
// Hosted (EXPLAINER_HOSTED=1), the server runs no CLI itself: each visitor gets a private workspace
// and connects their own Claude Code with agent.mjs, which runs every job on their machine.
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 4321;
const ROOT = import.meta.dirname;
const DATA = process.env.EXPLAINER_DATA || path.join(ROOT, 'data');
const HOSTED = !!process.env.EXPLAINER_HOSTED;
const MODEL = process.env.EXPLAINER_MODEL; // unset → your Claude Code default model
const MAX_SOURCE_CHARS = 500_000;
const MAX_VISIBLE_FIGS = 40;
const CHAT_MODELS = ['opus', 'sonnet', 'haiku']; // Claude Code aliases, always the latest of each

const LEVELS = [
  { name: "Like I'm 5", words: 400, brief: 'a curious 5-year-old. Tiny words, everyday analogies, a story-like feel, zero jargon.' },
  { name: 'Beginner', words: 800, brief: 'a high-school student who has never seen this topic. Plain language, define every term, intuitive examples.' },
  { name: 'Student', words: 1500, brief: 'an undergraduate studying for the exam. Cover every key concept, definition and formula, and show how they connect.' },
  { name: 'Exam-ready', words: 2500, brief: 'a student who wants top marks tomorrow. Dense and precise: every definition, formula, derivation step, edge case, common mistake, plus likely exam questions with short model answers.' },
  { name: 'Expert', words: 3000, brief: 'an advanced student who wants mastery. Rigorous and complete: nuance, derivations, connections to the wider field, limitations and subtle points.' },
];

// Which model and how much reasoning each job gets: cheaper models take the jobs they do just as well.
// No model means your Claude Code default (or EXPLAINER_MODEL).
const ROUTES = {
  level: [
    { model: 'sonnet', effort: 'medium' }, // Like I'm 5
    { model: 'sonnet', effort: 'medium' }, // Beginner
    { effort: 'medium' },                  // Student
    { effort: 'high' },                    // Exam-ready
    { effort: 'high' },                    // Expert
  ],
  mindmap: { model: 'sonnet', effort: 'medium' },
  deeper: { model: 'sonnet', effort: 'low' },
  tabs: { model: 'haiku', effort: 'low' },
  typeset: { model: 'sonnet', effort: 'low' }, // one-off: old explanations' plain-text formulas → LaTeX  // tab summaries + quizzes (reads one explanation, not the sources)
  cite: { model: 'sonnet', effort: 'low' },    // where each explanation's claims come from in the PDFs
  note: { model: 'haiku', effort: 'low' },  // inline questions
  chat: { effort: 'medium' },               // the big chat's model is the student's choice
};

const FIGURE_RULES = `Figures: you are shown figures extracted from the student's PDFs, each with an id like f3. To show one, put exactly ![short caption](fig:f3) on its own line. Only use ids you were given, only when the figure genuinely helps, and never use any other image or URL.
Formulas: typeset them in LaTeX the way a textbook or paper would. Put each important equation on its own line as display math, \$\$ … \$\$ with a blank line before and after, then a short "where …" sentence defining every symbol (with units where they matter). Use \$…\$ for symbols and short expressions inside sentences (e.g. the angular frequency \$\\omega = 2\\pi f\$). Use proper notation: \\frac{}{}, sub/superscripts, \\mathrm{} for units and multi-letter labels (e.g. \$T_\\mathrm{eff}\$, \$10\\,\\mathrm{Hz}\$), \\mathbf{} for vectors and matrices, \\cdot, \\approx, \\propto. Never use a dollar sign for money (write USD).`;

// One system prompt for every call that reads the sources, so they all share one cached prefix
// (system → sources). What each call should do goes in the message, after the sources.
const SOURCE_SYSTEM = `You are Explainer, a study tutor for a student who is cramming the night before an exam and wants maximum synthesis. The student's sources come first; your task follows them.
When you answer the student's questions: ground answers in their sources and say so when something is not covered by them. Lead with the direct answer, keep it tight, then offer to go deeper. Match the reading level they mention unless asked otherwise. Passages they quote usually come from the study explanations written for them from these sources (often simplified), not word-for-word from the sources, so explain the idea rather than searching for the exact sentence. Use markdown.
${FIGURE_RULES}`;

// ---------- storage ----------
const projects = new Map(); // id → project (in memory, persisted to data/<id>/project.json)
const writeChains = new Map();
const dir = id => path.join(DATA, id);

function save(p) {
  const prev = writeChains.get(p.id) || Promise.resolve();
  const next = prev.then(() => fs.writeFile(path.join(dir(p.id), 'project.json'), JSON.stringify(p)));
  writeChains.set(p.id, next.catch(() => {}));
  return next;
}

async function loadAll() {
  await fs.mkdir(DATA, { recursive: true });
  for (const id of await fs.readdir(DATA)) {
    try {
      const p = JSON.parse(await fs.readFile(path.join(dir(id), 'project.json'), 'utf8'));
      // Anything that was mid-generation when the server stopped is dead now.
      for (const job of [...(p.levels || []), p.mindmap].filter(Boolean))
        if (job.status === 'running') Object.assign(job, { status: 'error', error: 'Interrupted — retry' });
      for (const job of p.levels || []) if (job.tabsStatus === 'running') job.tabsStatus = null; // re-requested on view
      for (const job of p.levels || []) if (job.citeStatus === 'running') job.citeStatus = null; // likewise
      projects.set(id, p);
    } catch { /* not a project folder */ }
  }
  // One at a time in the background, so it never competes with what the student is doing.
  // (Not hosted: there it would need every student's agent to be connected.)
  if (!HOSTED) (async () => {
    for (const p of projects.values()) for (let i = 0; i < (p.levels || []).length; i++) await typesetLevel(p, i);
  })();
}

// ---------- claude ----------
// Our cache marker (after the sources) must use the same TTL as the CLI's own markers:
// 1h on most setups. If the API rejects it, switch to the default 5m once and remember.
let cacheTtl = '1h';
const isTtlError = e => /cache_control/.test(e.message) && /ttl/i.test(e.message);

async function runClaude(opts) {
  try {
    return await spawnClaude(opts);
  } catch (e) {
    if (cacheTtl !== '1h' || !isTtlError(e)) throw e;
    cacheTtl = '5m';
    return spawnClaude(opts);
  }
}

// Token usage per call, for measuring cost: data/<project>/usage.jsonl (never shown in the app).
function logUsage(log, result, model, effort) {
  const u = result.usage || {};
  const row = {
    t: new Date().toISOString(), task: log.task, model, effort: effort || null, ok: !result.is_error,
    input: u.input_tokens, cacheWrite: u.cache_creation_input_tokens, cacheRead: u.cache_read_input_tokens, output: u.output_tokens,
  };
  fs.appendFile(path.join(dir(log.p.id), 'usage.jsonl'), JSON.stringify(row) + '\n').catch(() => {});
}

function spawnClaude({ content, system, schema, resume, fork = false, persist = false, onText, onStart, model = MODEL, effort, log, signal }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    if (onText || onStart) args.push('--include-partial-messages');
    if (!persist) args.push('--no-session-persistence');
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (system) args.push('--system-prompt', system);
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    if (resume) args.push('--resume', resume);
    if (fork) args.push('--fork-session');

    const child = HOSTED ? remoteSpawn(log.p.owner, args, { task: log.task, model }) : spawn('claude', args, { cwd: DATA });
    let buf = '', result = null, stderr = '', usedModel = null, started = false, sessionId = null;
    signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init') sessionId = ev.session_id;
        if (!started && ev.type === 'stream_event' && ev.event.type === 'message_start') { started = true; onStart?.(); }
        const d = ev.type === 'stream_event' && ev.event.type === 'content_block_delta' && ev.event.delta;
        if (d && d.type === 'text_delta') onText?.(d.text);
        if (ev.type === 'assistant') usedModel = ev.message.model;
        if (ev.type === 'result') result = ev;
      }
    });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => reject(new Error(`Could not start the claude CLI: ${err.message}`)));
    child.on('close', () => {
      if (log && result) logUsage(log, result, usedModel, effort);
      if (signal?.aborted) reject(Object.assign(new Error('stopped'), { stopped: true, sessionId, model: usedModel }));
      else if (!result || result.is_error) reject(new Error(result?.result || stderr.trim() || 'Claude returned nothing'));
      else resolve({ ...result, model: usedModel });
    });
    const marked = content.map(b => b.cache_control ? { ...b, cache_control: { type: 'ephemeral', ...(cacheTtl === '1h' && { ttl: '1h' }) } } : b);
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: marked } }) + '\n');
  });
}

// ---------- agents (hosted) ----------
// A student's agent (agent.mjs, on their machine) holds a WebSocket open to us. Each job is a
// `claude` run: we send the arguments and the stdin line, it streams stdout back. remoteSpawn looks
// like a child process to spawnClaude, so nothing else changes.
const AGENT_WAIT_MS = 15 * 60_000; // a job waits this long for the student to connect their agent
const agents = new Map(); // workspace id → Set of sockets
const agentWaiters = new Map(); // workspace id → Set of callbacks waiting for an agent
const workspaceId = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);

function pickAgent(owner) {
  // the least busy of the workspace's agents
  return [...(agents.get(owner) || [])].sort((a, b) => a.jobs.size - b.jobs.size)[0];
}

function waitForAgent(owner, signal) {
  const now = pickAgent(owner);
  if (now) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    const waiters = agentWaiters.get(owner) || new Set();
    agentWaiters.set(owner, waiters);
    const done = () => { clearTimeout(timer); waiters.delete(cb); };
    const cb = sock => { done(); resolve(sock); };
    const timer = setTimeout(() => { done(); reject(new Error('No agent connected: use "Connect your agent" in the sidebar, then retry')); }, AGENT_WAIT_MS);
    signal.addEventListener('abort', () => { done(); reject(new Error('stopped')); }, { once: true });
    waiters.add(cb);
  });
}

function remoteSpawn(owner, args, info) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const jobId = crypto.randomUUID();
  const ac = new AbortController();
  let sock = null, input = null, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sock?.jobs.delete(jobId);
    child.emit('close');
  };
  child.on('agent', msg => {
    if (msg.type === 'out') child.stdout.emit('data', msg.data);
    else if (msg.type === 'err') child.stderr.emit('data', msg.data);
    else if (msg.type === 'error') { closed = true; sock?.jobs.delete(jobId); child.emit('error', new Error(msg.message)); }
    else if (msg.type === 'exit') close();
  });
  child.on('agent-lost', () => { child.stderr.emit('data', 'Your agent disconnected during this job: reconnect it and retry'); close(); });
  child.kill = () => {
    ac.abort();
    if (sock) sock.send(JSON.stringify({ type: 'kill', id: jobId }));
    else close();
  };
  const start = async () => {
    try { sock = await waitForAgent(owner, ac.signal); } catch (e) { if (!ac.signal.aborted) child.stderr.emit('data', e.message); return close(); }
    sock.jobs.set(jobId, child);
    sock.send(JSON.stringify({ type: 'run', id: jobId, args, input, ...info }));
  };
  child.stdin = { end: line => { input = line; start(); } };
  return child;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 << 20 });
wss.on('connection', sock => {
  sock.jobs = new Map();
  sock.alive = true;
  sock.on('pong', () => { sock.alive = true; });
  const hello = setTimeout(() => sock.close(4001, 'expected hello'), 10_000);
  sock.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello' && !sock.owner) {
      clearTimeout(hello);
      if (!WS_KEY.test(msg.key || '')) return sock.close(4003, 'bad key');
      sock.owner = workspaceId(msg.key);
      sock.info = { name: String(msg.name || 'agent').slice(0, 60), cli: String(msg.cli || '').slice(0, 60), since: Date.now() };
      const set = agents.get(sock.owner) || new Set();
      agents.set(sock.owner, set.add(sock));
      sock.send(JSON.stringify({ type: 'ready' }));
      for (const cb of [...(agentWaiters.get(sock.owner) || [])]) { const s = pickAgent(sock.owner); if (s) cb(s); }
      return;
    }
    sock.jobs.get(msg.id)?.emit('agent', msg);
  });
  sock.on('close', () => {
    clearTimeout(hello);
    agents.get(sock.owner)?.delete(sock);
    for (const child of sock.jobs.values()) child.emit('agent-lost');
  });
});
// Proxies close idle connections: ping every agent, and drop the ones that stopped answering.
setInterval(() => {
  for (const sock of wss.clients) {
    if (!sock.alive) { sock.terminate(); continue; }
    sock.alive = false;
    sock.ping();
  }
}, 25_000).unref();

// Drops text no explanation needs: running page headers/footers and reference lists.
// Deterministic, so every call sends byte-identical sources and the cache stays valid.
const REF_HEADING = /^(\d+(\.\d+)*\.?\s+)?(references( cited)?|bibliography|works cited|literature cited|references and notes)\s*:?$/i;
const pageLine = l => l.trim().replace(/\d+/g, '#');
const FIGURE_CAPTION = /^(figure|fig\.)\s*\d+[a-z]?[.:]/i;
const TABLE_CAPTION = /^table\s*\d+[a-z]?[.:]/i;

function cleanSource(src) {
  // A running header/footer: a line (digits ignored) of 25+ characters on at least 40% of the pages.
  const pages = src.split(/^(?=## Page \d+\n)/m).filter(pg => pg.startsWith('## Page'));
  const seen = new Map();
  for (const pg of pages) {
    for (const l of new Set(pg.split('\n').map(pageLine))) {
      if (l.length >= 25 && !l.startsWith('[FIGURE ') && !l.startsWith('## Page')) seen.set(l, (seen.get(l) || 0) + 1);
    }
  }
  const running = new Set([...seen].filter(([, n]) => pages.length >= 3 && n >= 3 && n >= 0.4 * pages.length).map(([l]) => l));
  let lines = src.split('\n').filter(l => !running.has(pageLine(l)));

  // The reference list: from an exact "References"-style heading in the second half, to the end or an appendix.
  const total = lines.reduce((a, l) => a + l.length + 1, 0);
  let start = -1;
  for (let k = 0, pos = 0; k < lines.length; pos += lines[k].length + 1, k++) {
    if (pos > total / 2 && REF_HEADING.test(lines[k].trim())) { start = k; break; }
  }
  if (start >= 0) {
    let end = lines.findIndex((l, k) => k > start && /^(appendix|supplement(al|ary)?)\b/i.test(l.trim()));
    if (end < 0) end = lines.length;
    const region = lines.slice(start, end);
    // Figures and tables often share pages with the references. A table's data follows its caption and
    // can't be told apart from reference entries, so then nothing is cut; figure captions are kept.
    if (!region.some(l => TABLE_CAPTION.test(l.trim()))) {
      lines = [...lines.slice(0, start), '[reference list omitted; figure captions from those pages kept]', ...figureCaptions(region), ...lines.slice(end)];
    }
  }
  return lines.join('\n');
}

// Figure markers plus each "Figure N." caption: up to a blank line, a marker, a bare number, or 12 lines.
function figureCaptions(region) {
  const keep = [];
  for (let k = 0; k < region.length; k++) {
    const l = region[k].trim();
    if (/^\[FIGURE f\d+\]$/.test(l)) { keep.push(region[k]); continue; }
    if (!FIGURE_CAPTION.test(l)) continue;
    const first = k;
    keep.push(region[k]);
    while (k + 1 < region.length && k + 1 - first < 12) {
      const t = region[k + 1].trim();
      if (!t || t.startsWith('[FIGURE') || t.startsWith('## Page') || /^[\d.,–−-]+$/.test(t) || FIGURE_CAPTION.test(t)) break;
      keep.push(region[++k]);
    }
  }
  return keep;
}
const cleanSources = text => text.split(/^(?=# Source: )/m).map(cleanSource).join('');

// The sources as the student uploaded them: one entry per file, its text page by page ("## Page n").
// Crops of the PDF the student asked about are figures too, but never part of the sources.
const sourceCache = new Map(); // project id → parsed sources.md
async function readSources(p) {
  if (sourceCache.has(p.id)) return sourceCache.get(p.id);
  let text = '';
  try { text = await fs.readFile(path.join(dir(p.id), 'sources.md'), 'utf8'); } catch { /* not uploaded yet */ }
  const list = text.split(/^(?=# Source: )/m).filter(s => s.startsWith('# Source: ')).map(s => {
    const name = s.match(/^# Source: (.+)/)[1].trim();
    const pages = new Map();
    for (const pg of s.split(/^(?=## Page \d+\n)/m)) {
      const m = pg.match(/^## Page (\d+)\n([\s\S]*)$/);
      if (m) pages.set(Number(m[1]), m[2]);
    }
    return { name, pages, pdf: name.toLowerCase().endsWith('.pdf') };
  });
  sourceCache.set(p.id, list);
  return list;
}
const pdfFile = (p, k) => path.join(dir(p.id), 'pdfs', `${k}.pdf`);
const exists = f => fs.access(f).then(() => true, () => false);

// What the browser needs to show the sources: names, page counts, and whether the PDF itself is stored.
async function sourceSummary(p) {
  return Promise.all((await readSources(p)).map(async (s, k) => ({
    name: s.name, pages: s.pages.size, pdf: s.pdf, stored: s.pdf && await exists(pdfFile(p, k)),
  })));
}

// The sources (text + figures Claude can actually see) as message content blocks.
// The last block carries a cache marker: every call on these sources reuses them from cache.
async function sourceContent(p) {
  const text = cleanSources(await fs.readFile(path.join(dir(p.id), 'sources.md'), 'utf8'));
  const clipped = text.length > MAX_SOURCE_CHARS ? text.slice(0, MAX_SOURCE_CHARS) + '\n\n[…sources truncated…]' : text;
  const content = [{ type: 'text', text: `<sources>\n${clipped}\n</sources>` }];
  for (const f of p.figures.filter(f => !f.crop).slice(0, MAX_VISIBLE_FIGS)) {
    const data = await fs.readFile(path.join(dir(p.id), 'figs', `${f.id}-sm.jpg`));
    content.push({ type: 'text', text: `Figure ${f.id} (page ${f.page} of ${f.source}):` },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') } });
  }
  // The cache marker goes on a closing text block: the CLI ignores a marker placed on an image.
  content.push({ type: 'text', text: '(End of sources.)', cache_control: { type: 'ephemeral' } }); // TTL set in spawnClaude
  return content;
}

async function generateLevel(p, i, onStart) {
  const L = LEVELS[i], job = p.levels[i];
  Object.assign(job, { status: 'running', md: '', error: null, tabs: null, tabsStatus: null, cites: null, citeStatus: null });
  if (p.progress) delete p.progress[i];
  const task = `Task: write ONE cohesive explanation that synthesizes ALL the sources above (not a page-by-page summary) for ${L.brief}
About ${L.words} words. GitHub markdown. Start with a 2–3 sentence "Big picture" paragraph (no heading), then ## sections ordered so understanding builds step by step. Bold key terms. Use tables for comparisons and numbered lists for processes.${i >= 2 ? ' End with "## Cheat sheet" (tight bullet recap) and "## Likely exam questions".' : ' End with "## Remember" (3–5 short bullets).'}
Include 2–6 figures if relevant ones exist.
Output only the explanation itself.`;
  try {
    const content = [...await sourceContent(p), { type: 'text', text: task }];
    const r = await runClaude({
      content, system: SOURCE_SYSTEM, ...ROUTES.level[i], onStart, log: { p, task: `level-${i + 1}` },
      onText: t => { job.md += t; },
    });
    Object.assign(job, { status: 'done', md: r.result, math: 1 });
  } catch (e) {
    Object.assign(job, { status: 'error', error: e.message });
  }
  await save(p);
  prepareTabs(p, i);
  citeLevel(p, i);
}

// Explanations written before formulas were typeset have them as plain text (σ_ij, k_h = √(k_x² + k_y²)).
// Rewrite just those formulas into LaTeX, once per level; anything that changes more than that is rejected.
const PLAIN_MATH = /[α-ωΓΔΘΛΞΠΣΦΨΩ∂∫∑∏√≈≠≤≥±×·∇∞²³⁰-⁹⁻₀-₉]|\b[A-Za-z]+_[A-Za-z0-9{]/;
async function typesetLevel(p, i) {
  const job = p.levels[i];
  if (job.status !== 'done' || job.math) return;
  if (!PLAIN_MATH.test(job.md)) { job.math = 1; return save(p); }
  const system = `You convert the formulas in a markdown study explanation into LaTeX, the way a textbook typesets them. Rewrite every formula, equation, symbol with a subscript or superscript, Greek-letter quantity and unit expression as LaTeX: $…$ inside sentences, and $$…$$ on its own line (blank line before and after) only where an equation already stands on its own line. Drop bold around a formula (**ρü = …** becomes $\\rho\\ddot{u} = …$). Change nothing else: keep every other word, heading, list, table, bold term and figure line (![…](fig:…)) exactly as it is. Never use a dollar sign for anything but math. Output only the full markdown.`;
  try {
    const r = await runClaude({ content: [{ type: 'text', text: job.md }], system, ...ROUTES.typeset, log: { p, task: `typeset-${i + 1}` } });
    const md = r.result.trim().replace(/^```(?:markdown)?\n([\s\S]*)\n```$/, '$1');
    // headings may gain formulas (u₀ → $u_0$), so compare their words only
    const titles = m => splitSections(m).map(x => x.title.replace(/\$[^$]*\$/g, '').replace(/[^A-Za-z ]/g, '').trim().split(/\s+/).slice(0, 4).join(' ')).join('\n');
    const figs = m => [...m.matchAll(/\(fig:(f\d+)\)/g)].map(x => x[1]).sort().join();
    const ratio = md.length / job.md.length;
    if (titles(md) !== titles(job.md) || figs(md) !== figs(job.md) || ratio < 0.85 || ratio > 1.8 || !md.includes('$'))
      throw new Error(`rewrite changed more than the formulas (ratio ${ratio.toFixed(2)})`);
    if (job.math || job.status !== 'done') return; // regenerated meanwhile
    Object.assign(job, { md, math: 1 });
  } catch (e) {
    console.error(`typesetting formulas for level ${i + 1} of ${p.id} failed:`, e.message);
    job.math = -1; // don't retry on every start
  }
  await save(p);
}

// Same split as the browser's tabs: intro paragraph → "Big picture", then one tab per ## heading.
function splitSections(md) {
  const out = [];
  for (const part of md.split(/^(?=## )/m)) {
    const m = part.match(/^## (.+)\n?([\s\S]*)$/);
    if (m) out.push({ title: m[1].trim().replace(/^\d+[.)]\s*/, ''), md: m[2] });
    else if (part.trim()) out.push({ title: 'Big picture', md: part });
  }
  return out;
}

const TABS_SCHEMA = {
  type: 'object', required: ['tabs'],
  properties: {
    tabs: {
      type: 'array',
      items: {
        type: 'object', required: ['gist', 'points', 'quiz'],
        properties: {
          gist: { type: 'string', description: 'one sentence: what happens in this tab' },
          points: { type: 'array', items: { type: 'string' }, description: '2–4 key takeaways, plain text' },
          quiz: {
            type: 'array', minItems: 2, maxItems: 4,
            items: {
              type: 'object', required: ['q', 'options', 'answer', 'why', 'difficulty'],
              properties: {
                q: { type: 'string' },
                options: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 },
                answer: { type: 'integer', description: 'index (0–3) of the correct option' },
                why: { type: 'string', description: 'one sentence explaining the correct answer' },
                difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
              },
            },
          },
        },
      },
    },
  },
};

// Models favour some answer positions, so options are reordered here, seeded by the question
// text so the same question always comes out in the same order.
function shuffleOptions(q) {
  const seed = crypto.createHash('sha256').update(q.q).digest();
  const right = q.options[q.answer];
  for (let k = q.options.length - 1; k > 0; k--) {
    const j = seed[k] % (k + 1);
    [q.options[k], q.options[j]] = [q.options[j], q.options[k]];
  }
  q.answer = q.options.indexOf(right);
}

// For every tab of a finished level: a "what happens in this tab" summary and a quiz on it.
async function prepareTabs(p, i) {
  const job = p.levels[i];
  if (job.status !== 'done' || job.tabs || job.tabsStatus === 'running') return;
  job.tabsStatus = 'running';
  const tabs = splitSections(job.md.replace(CITE_MARK, ''));
  const system = `A study explanation for "${LEVELS[i].name}" readers (${LEVELS[i].brief}) is shown to the student as ${tabs.length} tabs. For EACH tab, in order, write (1) a one-sentence gist of what happens in that tab, (2) 2–4 key takeaways, and (3) a quiz of 2–4 multiple-choice questions that test ONLY what that tab taught (2 for short tabs, up to 4 for dense ones). Each question has 4 plausible options, one correct, a one-sentence "why", and a difficulty: easy (recall), medium (apply/explain), hard (combine or reason through a tricky case). Mix difficulties. Test the subject matter itself, never the explanation's layout (no questions about section or question numbers, or what "the tab says"). Match the reading level. Plain text, no markdown. Write any formula in LaTeX between single dollar signs, the way a textbook would (e.g. $\\omega = 2\\pi f$), never as plain Unicode. Return exactly ${tabs.length} items.`;
  const text = tabs.map((t, k) => `<tab n="${k + 1}" title="${t.title}">\n${t.md}\n</tab>`).join('\n\n');
  try {
    const r = await runClaude({ content: [{ type: 'text', text }], system, schema: TABS_SCHEMA, ...ROUTES.tabs, log: { p, task: `tabs-${i + 1}` } });
    const out = r.structured_output.tabs.slice(0, tabs.length);
    out.forEach(t => t.quiz.forEach(shuffleOptions));
    Object.assign(job, { tabs: out, tabsStatus: 'done' });
  } catch (e) {
    console.error(`tab summaries/quizzes for level ${i + 1} failed:`, e.message);
    job.tabsStatus = 'error';
  }
  await save(p);
}

// ---------- citations: where each part of an explanation comes from in the PDFs ----------
// Claude names the sentence a citation belongs to and the passage of the source that backs it; the
// marker [@k] (k indexes job.cites) is then placed here, so the explanation's own words never change.
const CITE_MARK = /\[@\d+\]/g;
const CITES_SCHEMA = {
  type: 'object', required: ['cites'],
  properties: {
    cites: {
      type: 'array',
      items: {
        type: 'object', required: ['after', 'source', 'page', 'quote'],
        properties: {
          after: { type: 'string', description: 'the last 4–10 words of the sentence, list item or table row that makes the claim, copied character for character from the explanation' },
          source: { type: 'integer', description: 'the source number' },
          page: { type: 'integer', description: 'the page number, from its "## Page" heading' },
          quote: { type: 'string', description: '6–25 consecutive words copied exactly from that page, the passage that backs the claim' },
        },
      },
    },
  },
};

async function citeLevel(p, i) {
  const job = p.levels[i];
  if (job.status !== 'done' || !job.math || job.citeStatus === 'running' || job.citeStatus === 'done') return;
  const srcs = await readSources(p);
  if (!srcs.some(s => s.pdf)) return;
  job.citeStatus = 'running';
  const md = job.md;
  const most = Math.max(4, Math.round(md.split(/\s+/).length / 70));
  const task = `Task: the study explanation below was written for the student from the sources above. Show the student where it comes from, so they can check each point in their PDF. For the key claims, about one per paragraph, list or table (the opening paragraph too) and at most ${most} in total, in the order they appear in the explanation, give: "after", the last 4–10 words of the sentence (or list item, or table row) that makes the claim, copied character for character from the explanation, including any $…$ formulas and ** exactly as written; "source", the source's number (${srcs.map((s, k) => `${k + 1} = ${s.name}`).join(', ')}); "page", its page number from the "## Page" heading; and "quote", 6–25 consecutive words copied exactly from that page that back the claim (plain words, no formulas). Only cite what the sources actually say: skip the explanation's own analogies, examples and exam advice.

<explanation>
${md}
</explanation>`;
  try {
    const r = await runClaude({ content: [...await sourceContent(p), { type: 'text', text: task }], system: SOURCE_SYSTEM, schema: CITES_SCHEMA, ...ROUTES.cite, log: { p, task: `cite-${i + 1}` } });
    if (job.md !== md) return; // regenerated meanwhile
    Object.assign(job, placeCites(md, r.structured_output.cites, srcs), { citeStatus: 'done' });
  } catch (e) {
    console.error(`citations for level ${i + 1} of ${p.id} failed:`, e.message);
    if (job.md === md) job.citeStatus = 'error';
  }
  await save(p);
}

// Letters and digits only, so hyphenation, ligatures and spacing in the PDF's text don't matter.
const loose = s => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function placeCites(md, raw, srcs) {
  // The quote decides the page: Claude sometimes names a neighbouring one.
  const pages = srcs.map(s => new Map([...s.pages].map(([n, t]) => [n, loose(t)])));
  const locate = c => {
    const q = loose(c.quote || '');
    const order = [c.source - 1, ...srcs.keys()].filter((k, j, a) => pages[k] && a.indexOf(k) === j);
    if (q.length >= 12) for (const k of order) {
      if (pages[k].get(c.page)?.includes(q)) return { source: k + 1, page: c.page };
      for (const [n, t] of pages[k]) if (t.includes(q)) return { source: k + 1, page: n };
    }
    return pages[c.source - 1]?.has(c.page) ? { source: c.source, page: c.page } : null;
  };
  // `after` is matched ignoring case, spacing and ** (Claude may drop the bold markers).
  const hay = [], at = [];
  for (let k = 0; k < md.length; k++) {
    const ch = md[k];
    if (ch === '*') continue;
    if (/\s/.test(ch)) { if (hay.at(-1) !== ' ') { hay.push(' '); at.push(k); } continue; }
    hay.push(ch.toLowerCase());
    at.push(k);
  }
  const text = hay.join('');
  const cites = [], spots = [];
  let from = 0;
  for (const c of raw) {
    const where = locate(c);
    const needle = (c.after || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!where || needle.length < 8) continue;
    let hit = text.indexOf(needle, from);
    if (hit < 0) hit = text.indexOf(needle);
    if (hit < 0) continue;
    const pos = settle(md, at[hit + needle.length - 1] + 1);
    if (pos < 0) continue;
    from = hit + needle.length;
    spots.push({ pos, k: cites.length });
    cites.push({ ...where, quote: c.quote });
  }
  // insert from the end so earlier positions stay valid; markers sharing a spot stay in order
  let out = md;
  for (const { pos, k } of spots.sort((a, b) => b.pos - a.pos || b.k - a.k)) out = out.slice(0, pos) + `[@${k}]` + out.slice(pos);
  return { md: out, cites };
}

// Where a marker can go: after the sentence's closing punctuation and bold, never inside a formula,
// a heading or a figure line.
function settle(md, pos) {
  const start = md.lastIndexOf('\n', pos - 1) + 1;
  let end = md.indexOf('\n', pos);
  if (end < 0) end = md.length;
  if (/^\s*(#|!\[)/.test(md.slice(start, end))) return -1;
  if ((md.slice(0, pos).match(/\$\$/g) || []).length % 2) return -1;
  if ((md.slice(start, pos).replace(/\\\$/g, '').match(/\$/g) || []).length % 2) {
    const close = md.indexOf('$', pos);
    if (close < 0 || close >= end) return -1;
    pos = close + 1;
  }
  while (pos < end && /[*_.,;:!?)]/.test(md[pos])) pos++;
  return pos;
}

const NODE_SCHEMA = {
  type: 'object', required: ['id', 'parent', 'title', 'summary'],
  properties: {
    id: { type: 'string' },
    parent: { type: 'string', description: 'id of the parent node; empty string for the root' },
    title: { type: 'string', description: '2–6 words' },
    summary: { type: 'string', description: 'one clear sentence, under 25 words, no markdown' },
    figure: { type: 'string', description: 'optional figure id (like f3) that illustrates this node, else empty' },
  },
};
const nodesSchema = { type: 'object', required: ['nodes'], properties: { nodes: { type: 'array', items: NODE_SCHEMA } } };

async function generateMindmap(p) {
  const job = p.mindmap;
  Object.assign(job, { status: 'running', nodes: [], error: null });
  const task = `Task: turn the sources above into a short mindmap that reads like a story, with deeper levels to uncover. The root sets the scene: what this is about and why it matters. Its 3–6 children are the chapters, in the order the story unfolds (for example: the situation, the problem, the key idea, how it works, what happened, why it matters), so reading them top to bottom tells the whole story. Each chapter has 2–4 children that uncover what lies underneath it, again in story order, and those may have 2–3 children of their own where there's more worth uncovering. Stay at most 3 levels below the root and 15–30 nodes in total; the reader can dig deeper later. Write titles and summaries at the "${LEVELS[2].name}" level, for ${LEVELS[2].brief.split('.')[0]}: titles of 2–6 words using the subject's proper terms, and a summary that is one clear sentence moving the story along (no markdown). Write any formula in LaTeX between single dollar signs, the way a textbook would (e.g. $\\omega = 2\\pi f$), never as plain Unicode. Ids: root is "r", children are parent id + "." + index (r.1, r.1.2, …), numbered in story order. Attach a figure id to a node when a figure shows it.`;
  try {
    const content = [...await sourceContent(p), { type: 'text', text: task }];
    const r = await runClaude({ content, system: SOURCE_SYSTEM, schema: nodesSchema, ...ROUTES.mindmap, log: { p, task: 'mindmap' } });
    Object.assign(job, { status: 'done', nodes: r.structured_output.nodes });
  } catch (e) {
    Object.assign(job, { status: 'error', error: e.message });
  }
  await save(p);
}

async function goDeeper(p, nodeId) {
  const byId = new Map(p.mindmap.nodes.map(n => [n.id, n]));
  const trail = [];
  for (let n = byId.get(nodeId); n; n = byId.get(n.parent)) trail.unshift(n.title);
  const task = `Task: extend the study mindmap built from the sources above. The map reads like a story with deeper levels to uncover. Return 2–4 child nodes that uncover what lies underneath the node at path "${trail.join(' › ')}", in story order, written at the "${LEVELS[2].name}" level, for ${LEVELS[2].brief.split('.')[0]}: titles of 2–6 words using the subject's proper terms and a one-sentence summary each (no markdown). Write any formula in LaTeX between single dollar signs, the way a textbook would (e.g. $\\omega = 2\\pi f$), never as plain Unicode. Attach a figure id when a figure shows it. Their parent is "${nodeId}" and their ids are "${nodeId}.1", "${nodeId}.2", ….`;
  const content = [...await sourceContent(p), { type: 'text', text: task }];
  const r = await runClaude({ content, system: SOURCE_SYSTEM, schema: nodesSchema, ...ROUTES.deeper, log: { p, task: 'deeper' } });
  const fresh = r.structured_output.nodes
    .filter(n => !byId.has(n.id))
    .map(n => ({ ...n, parent: nodeId }));
  p.mindmap.nodes.push(...fresh);
  await save(p);
  return fresh;
}

// Starting a chat message with /short asks for a brief answer.
const SHORT = /^\/short\b\s*/i;

async function chatReply(p, chat, msg, onText, route, signal) {
  const { quotes, figures, level } = msg;
  const brief = SHORT.test(msg.text);
  // The short-answer note stays in the resumed conversation, so Claude kept answering briefly after it.
  const wasBrief = chat.messages.slice(0, -1).some(m => m.role === 'user' && SHORT.test(m.text));
  const text = msg.text.replace(SHORT, '') || 'Explain this.';
  const passages = quotes.map((q, k) => `Passage ${quotes.length > 1 ? k + 1 : ''}:\n> ${q.replace(/\n/g, '\n> ')}`.replace(' :', ':')).join('\n\n');
  const short = route === ROUTES.note
    ? '\n(This is a quick inline question shown in a small box: answer in 2–4 sentences, under 70 words, plain prose. No bullet points, numbered lists, headings or tables, bold at most one key term, and no offer to go deeper.)'
    : brief ? '\n(Keep this answer short: under 10 lines in total. Lead with the direct answer; at most one short list or one key equation; no headings; no offer to go deeper. This applies to this answer only.)'
    : wasBrief ? '\n(Answer at your normal length and depth: earlier requests for a short answer applied only to those answers.)'
    : '';
  const inChat = route === ROUTES.note && !chat.session && chat.forkFrom;
  const ask = `${inChat ? '(The passage below is from our conversation above: answer in that context.)\n\n' : ''}${passages ? `I'm asking about ${quotes.length > 1 ? 'these passages' : 'this passage'}:\n\n${passages}\n\n` : ''}${figures.length ? `(I attached figure${figures.length > 1 ? 's' : ''} ${figures.join(', ')} above.)\n\n` : ''}${text}\n\n(I'm currently reading the "${LEVELS[level]?.name || 'Student'}" level explanation.)${short}`;
  // Attached figures are sent as images so Claude actually looks at them.
  const figBlocks = [];
  for (const id of figures) {
    const f = p.figures.find(x => x.id === id);
    const data = await fs.readFile(path.join(dir(p.id), 'figs', `${id}-sm.jpg`));
    const what = f.crop === 'formula' ? `A formula cropped from page ${f.page} of ${f.source}` : f.crop ? `A figure cropped from page ${f.page} of ${f.source}` : `Figure ${id} (page ${f.page} of ${f.source})`;
    figBlocks.push({ type: 'text', text: `${what}:` },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') } });
  }
  // A chat continued from an inline question branches off that question's session (it already has the sources).
  const resume = chat.session || chat.forkFrom;
  const content = [...(resume ? [] : await sourceContent(p)), ...figBlocks, { type: 'text', text: ask }];
  const r = await runClaude({
    content, system: SOURCE_SYSTEM, resume, fork: !chat.session && !!chat.forkFrom, persist: true, onText, signal, ...route,
    log: { p, task: route === ROUTES.note ? 'note' : 'chat' },
  });
  chat.session = r.session_id;
  return r;
}

// Sends one message on a chat or an inline note and streams the answer back as server-sent events.
async function streamReply(res, p, thread, msg, route) {
  msg.quotes = (msg.quotes || []).filter(q => typeof q === 'string' && q.trim());
  msg.figures = [...new Set(msg.figures || [])].filter(id => p.figures.some(f => f.id === id));
  thread.messages.push({ role: 'user', text: msg.text, quotes: msg.quotes, figures: msg.figures });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  generating.add(thread.id);
  send({ start: true }); // the question is saved: the sidebar can list this chat now
  // The reader pressing Stop closes the request: stop Claude and keep what it wrote so far.
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  let partial = '';
  try {
    const r = await chatReply(p, thread, msg, t => { partial += t; send({ t }); }, route, ac.signal);
    thread.messages.push({ role: 'assistant', text: r.result, model: r.model });
    send({ done: true, model: r.model });
  } catch (e) {
    if (e.stopped) {
      // the CLI already saved the question in its session, so the conversation carries on from there
      if (e.sessionId && !thread.session) thread.session = e.sessionId;
      thread.messages.push({ role: 'assistant', text: partial, model: e.model, stopped: true });
    } else {
      thread.messages.pop();
      send({ error: e.message });
    }
  }
  generating.delete(thread.id);
  await save(p);
  res.end();
}

// ---------- http ----------
const MIME = { '.pdf': 'application/pdf', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const VENDOR = {
  'pdf.mjs': 'pdfjs-dist/build/pdf.mjs',
  'pdf.worker.mjs': 'pdfjs-dist/build/pdf.worker.mjs',
  'marked.js': 'marked/lib/marked.esm.js',
  'purify.js': 'dompurify/dist/purify.es.mjs',
  'katex.mjs': 'katex/dist/katex.mjs',
  'katex.css': 'katex/dist/katex.min.css',
};

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const id = () => crypto.randomBytes(5).toString('hex');
const SAFE = /^[\w.-]+$/;

const MAX_BODY = 200 << 20;
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    if ((size += c.length) > MAX_BODY) throw new Error('upload too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// Hosted, each browser gets a private workspace: a random key in a cookie. The key is also what the
// student's agent connects with, and opening /?ws=<key> on another device brings the workspace along.
// Run locally, there is one workspace and it has no key.
const WS_KEY = /^[\w-]{20,64}$/;
const wsCookie = key => `explainer_ws=${key}; Path=/; Max-Age=${400 * 86400}; HttpOnly; SameSite=Lax; Secure`;
function workspace(req, res) {
  if (!HOSTED) return { id: 'local', key: null };
  const key = /(?:^|;\s*)explainer_ws=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
  if (key && WS_KEY.test(key)) return { id: workspaceId(key), key };
  const fresh = crypto.randomBytes(18).toString('base64url');
  res.setHeader('set-cookie', wsCookie(fresh));
  return { id: workspaceId(fresh), key: fresh };
}
const ownerOf = p => p.owner || 'local';

async function sendFile(res, file) {
  try {
    await fs.access(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// Chats with an answer being written right now (in memory only: they're dead after a restart).
const generating = new Set();

const summary = p => ({
  id: p.id, name: p.name, created: p.created,
  // a chat is listed once a question has been asked in it, not when it's opened
  chats: p.chats.filter(c => c.messages.length).map(c => ({ id: c.id, title: c.title, busy: generating.has(c.id) })),
  // starred answers, named after the question they answer
  starred: p.chats.flatMap(c => c.messages.flatMap((m, i) => m.starred ? [{
    chatId: c.id, i,
    title: m.starTitle || (c.messages[i - 1]?.text || '').replace(SHORT, '').replace(/\s+/g, ' ').trim().slice(0, 60) || c.title,
    text: m.text, chatTitle: c.title,
  }] : [])),
  // highlights the student added as notes, oldest first
  stickies: p.stickies || [],
});

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const M = req.method;

  // katex.css loads its fonts from ./fonts/
  if (parts[0] === 'vendor' && parts[1] === 'fonts' && /^KaTeX_[\w-]+\.woff2$/.test(parts[2] || '')) return sendFile(res, path.join(ROOT, 'node_modules/katex/dist/fonts', parts[2]));
  if (parts[0] === 'vendor') return VENDOR[parts[1]] ? sendFile(res, path.join(ROOT, 'node_modules', VENDOR[parts[1]])) : json(res, 404, {});
  if (url.pathname === '/agent.mjs') return sendFile(res, path.join(ROOT, 'agent.mjs'));
  // a workspace link from another device: adopt its key
  const adopt = url.searchParams.get('ws');
  if (HOSTED && !parts.length && adopt && WS_KEY.test(adopt)) {
    res.writeHead(302, { 'set-cookie': wsCookie(adopt), location: '/' });
    return res.end();
  }
  const ws = workspace(req, res);
  if (parts[0] !== 'api') {
    const file = path.join(ROOT, 'public', parts.join('/') || 'index.html');
    return file.startsWith(path.join(ROOT, 'public')) ? sendFile(res, file) : json(res, 404, {});
  }

  // whether this workspace's agent is connected (hosted only)
  if (parts[1] === 'agent' && M === 'GET') {
    if (!HOSTED) return json(res, 200, { hosted: false });
    return json(res, 200, { hosted: true, key: ws.key, agents: [...(agents.get(ws.id) || [])].map(s => ({ ...s.info, jobs: s.jobs.size })) });
  }

  // /api/projects
  if (parts[1] !== 'projects') return json(res, 404, {});
  if (parts.length === 2) {
    if (M === 'GET') return json(res, 200, [...projects.values()].filter(p => ownerOf(p) === ws.id).sort((a, b) => b.created - a.created).map(summary));
    if (M === 'POST') {
      const { name } = JSON.parse(await body(req));
      const p = { id: id(), name: name || 'Untitled', created: Date.now(), figures: [], levels: [], mindmap: null, chats: [], ...(HOSTED && { owner: ws.id }) };
      await fs.mkdir(path.join(dir(p.id), 'figs'), { recursive: true });
      projects.set(p.id, p);
      await save(p);
      return json(res, 200, summary(p));
    }
  }

  const p = projects.get(parts[2]);
  if (!p || ownerOf(p) !== ws.id) return json(res, 404, { error: 'no such project' });
  const sub = parts[3];

  // delete the project, with its PDFs, figures and chats
  if (!sub && M === 'DELETE') {
    projects.delete(p.id);
    sourceCache.delete(p.id);
    await (writeChains.get(p.id) || Promise.resolve());
    writeChains.delete(p.id);
    await fs.rm(dir(p.id), { recursive: true, force: true });
    return json(res, 200, {});
  }

  // rename the project
  if (!sub && M === 'PUT') {
    const name = String(JSON.parse(await body(req)).name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (name) p.name = name;
    await save(p);
    return json(res, 200, { name: p.name });
  }

  if (!sub && M === 'GET') return json(res, 200, { ...p, levelNames: LEVELS.map(l => l.name), sources: await sourceSummary(p) });

  // the uploaded PDFs themselves, by their position in the sources
  if (sub === 'pdfs' && /^\d+$/.test(parts[4] || '')) {
    const file = pdfFile(p, parts[4]);
    if (M === 'PUT') {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, await body(req));
      return json(res, 200, {});
    }
    if (M === 'GET') return sendFile(res, file);
  }

  // A formula or figure cropped from a PDF page, so it can be asked about like any figure.
  // The same spot on the same page is always the same figure.
  if (sub === 'figures' && M === 'POST') {
    const { source, page, box, kind } = JSON.parse(await body(req));
    if (typeof source !== 'string' || !Number.isInteger(page) || !Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite))
      return json(res, 400, { error: 'bad figure' });
    const same = p.figures.find(f => f.crop && f.source === source && f.page === page && f.box.every((v, k) => Math.abs(v - box[k]) < 0.004));
    if (same) return json(res, 200, same);
    const n = Math.max(0, ...p.figures.map(f => Number(f.id.slice(1)) || 0)) + 1;
    const fig = { id: `f${n}`, page, source, crop: kind === 'formula' ? 'formula' : 'figure', box };
    p.figures.push(fig);
    await save(p);
    return json(res, 200, fig);
  }

  // figures: PUT uploads (from the browser's PDF extraction), GET serves
  if (sub === 'figs' && SAFE.test(parts[4] || '')) {
    const file = path.join(dir(p.id), 'figs', parts[4]);
    if (M === 'PUT') { await fs.writeFile(file, await body(req)); return json(res, 200, {}); }
    if (M === 'GET') return sendFile(res, file);
  }

  // sources: save extracted text + figure list, then kick off all generation in parallel
  if (sub === 'sources' && M === 'POST') {
    const { text, figures } = JSON.parse(await body(req));
    await fs.writeFile(path.join(dir(p.id), 'sources.md'), text);
    sourceCache.delete(p.id);
    p.figures = figures;
    p.levels = LEVELS.map(() => ({ status: 'pending', md: '' }));
    p.mindmap = { status: 'pending', nodes: [] };
    await save(p);
    // Per model, one level starts first; the others start as soon as it is under way,
    // so they read the sources from its cache instead of paying for them again.
    const groups = new Map();
    ROUTES.level.forEach((r, i) => {
      const key = r.model || MODEL || 'default';
      groups.set(key, [...(groups.get(key) || []), i]);
    });
    for (const [leader, ...followers] of groups.values()) {
      let start = () => { start = () => {}; followers.forEach(i => generateLevel(p, i)); };
      generateLevel(p, leader, () => start()).finally(() => start());
    }
    generateMindmap(p);
    return json(res, 200, {});
  }

  if (sub === 'cite' && M === 'POST') {
    const { level } = JSON.parse(await body(req));
    if (p.levels[level]) citeLevel(p, level);
    return json(res, 200, {});
  }

  if (sub === 'tabs' && M === 'POST') {
    const { level } = JSON.parse(await body(req));
    if (p.levels[level]) prepareTabs(p, level);
    return json(res, 200, {});
  }

  // quiz progress: which tabs of a level the student has passed
  if (sub === 'progress' && M === 'POST') {
    const { level, tab } = JSON.parse(await body(req));
    p.progress ||= {};
    p.progress[level] = [...new Set([...(p.progress[level] || []), tab])];
    await save(p);
    return json(res, 200, p.progress);
  }

  if (sub === 'retry' && M === 'POST') {
    const { level } = JSON.parse(await body(req));
    level === 'mindmap' ? generateMindmap(p) : generateLevel(p, level);
    return json(res, 200, {});
  }

  if (sub === 'deeper' && M === 'POST') {
    const { nodeId } = JSON.parse(await body(req));
    try { return json(res, 200, { nodes: await goDeeper(p, nodeId) }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (sub === 'chats' && !parts[4] && M === 'POST') {
    const { title } = JSON.parse(await body(req));
    const chat = { id: id(), title: title || 'New chat', session: null, messages: [] };
    p.chats.unshift(chat);
    await save(p);
    return json(res, 200, chat);
  }

  // send a message: streams Claude's reply back as server-sent events
  if (sub === 'chats' && parts[5] === 'messages' && M === 'POST') {
    const chat = p.chats.find(c => c.id === parts[4]);
    if (!chat) return json(res, 404, { error: 'no such chat' });
    const msg = JSON.parse(await body(req));
    if (chat.title === 'New chat') chat.title = msg.text.replace(SHORT, '').slice(0, 48) || 'New chat';
    const model = CHAT_MODELS.includes(msg.model) ? msg.model : MODEL;
    return streamReply(res, p, chat, msg, { ...ROUTES.chat, model });
  }

  // sticky notes: a highlight from the explanation, a chat or a PDF, kept with where it came from
  if (sub === 'stickies' && !parts[4] && M === 'POST') {
    const { text, kind, ref, label, quote } = JSON.parse(await body(req));
    if (typeof text !== 'string' || !text.trim() || !['explanation', 'chat', 'pdf'].includes(kind) || typeof ref !== 'object' || !ref)
      return json(res, 400, { error: 'bad note' });
    const st = { id: id(), text: text.trim().slice(0, 6000), kind, ref, label: String(label || '').slice(0, 200), title: null, created: Date.now(), ...(typeof quote === 'string' && quote.trim() ? { quote: quote.trim().slice(0, 2000) } : {}) };
    (p.stickies ||= []).push(st);
    await save(p);
    return json(res, 200, st);
  }
  const sticky = sub === 'stickies' && (p.stickies || []).find(s => s.id === parts[4]);
  if (sub === 'stickies' && parts[4] && !sticky) return json(res, 404, { error: 'no such note' });
  if (sticky && M === 'PUT') {
    const title = String(JSON.parse(await body(req)).title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    sticky.title = title || null;
    await save(p);
    return json(res, 200, {});
  }
  if (sticky && M === 'DELETE') {
    p.stickies = p.stickies.filter(s => s !== sticky);
    await save(p);
    return json(res, 200, {});
  }

  // delete a chat (notes made from the explanation are not part of any chat)
  if (sub === 'chats' && parts[4] && !parts[5] && M === 'DELETE') {
    if (!p.chats.some(c => c.id === parts[4])) return json(res, 404, { error: 'no such chat' });
    p.chats = p.chats.filter(c => c.id !== parts[4]);
    await save(p);
    return json(res, 200, {});
  }

  // rename a chat
  if (sub === 'chats' && parts[4] && !parts[5] && M === 'PUT') {
    const chat = p.chats.find(c => c.id === parts[4]);
    if (!chat) return json(res, 404, { error: 'no such chat' });
    const title = String(JSON.parse(await body(req)).title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (title) chat.title = title;
    await save(p);
    return json(res, 200, { title: chat.title });
  }

  // rename a starred answer (as it's listed in the sidebar); an empty name goes back to the question
  if (sub === 'chats' && parts[5] === 'messages' && parts[7] === 'title' && M === 'PUT') {
    const m = p.chats.find(c => c.id === parts[4])?.messages[parts[6]];
    if (m?.role !== 'assistant') return json(res, 404, { error: 'no such answer' });
    const title = String(JSON.parse(await body(req)).title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (title) m.starTitle = title; else delete m.starTitle;
    await save(p);
    return json(res, 200, {});
  }

  // star or unstar one of Claude's answers
  if (sub === 'chats' && parts[5] === 'messages' && parts[7] === 'star' && M === 'PUT') {
    const m = p.chats.find(c => c.id === parts[4])?.messages[parts[6]];
    if (m?.role !== 'assistant') return json(res, 404, { error: 'no such answer' });
    const { on } = JSON.parse(await body(req));
    if (on) m.starred = true; else delete m.starred;
    await save(p);
    return json(res, 200, {});
  }

  // Inline notes: a highlighted passage (or figure) with its own small, fast chat.
  if (sub === 'notes' && !parts[4] && M === 'POST') {
    const { key, text, figure, occ } = JSON.parse(await body(req));
    const note = { id: id(), key, text: text || '', occ: Number.isInteger(occ) && occ > 0 ? occ : 0, figure: figure || null, session: null, messages: [], created: Date.now() };
    (p.notes ||= []).push(note);
    await save(p);
    return json(res, 200, note);
  }
  const note = sub === 'notes' && (p.notes || []).find(n => n.id === parts[4]);
  if (sub === 'notes' && !note) return json(res, 404, { error: 'no such note' });
  if (note && !parts[5] && M === 'DELETE') {
    p.notes = p.notes.filter(n => n !== note);
    await save(p);
    return json(res, 200, {});
  }
  if (note && parts[5] === 'messages' && M === 'POST') {
    const { text, level } = JSON.parse(await body(req));
    const first = !note.session; // the passage/figure goes with the first question only
    // a passage from a side chat is asked about in that chat's context: the small chat branches off its session
    const from = first && /^m:([^:]+):\d+$/.exec(note.key || '');
    const source = from && p.chats.find(c => c.id === from[1]);
    if (source?.session) note.forkFrom = source.session;
    return streamReply(res, p, note, {
      text, level, quotes: first && note.text ? [note.text] : [], figures: first && note.figure ? [note.figure] : [],
    }, ROUTES.note); // inline answers always use the fastest model
  }
  // "Continue in big chat": a new chat that branches off the note's conversation
  if (note && parts[5] === 'continue' && M === 'POST') {
    const chat = {
      id: id(), title: (note.text || `Figure ${note.figure}`).replace(/\s+/g, ' ').slice(0, 48),
      session: null, forkFrom: note.session, messages: structuredClone(note.messages),
    };
    p.chats.unshift(chat);
    await save(p);
    return json(res, 200, chat);
  }

  json(res, 404, { error: 'unknown route' });
}

await loadAll();
const server = http.createServer((req, res) => route(req, res).catch(e => {
  console.error(e);
  if (!res.headersSent) json(res, 500, { error: e.message });
  else res.end();
}));
server.on('upgrade', (req, socket, head) => {
  if (!HOSTED || new URL(req.url, 'http://x').pathname !== '/agent') return socket.destroy();
  wss.handleUpgrade(req, socket, head, sock => wss.emit('connection', sock, req));
});
server.listen(PORT, () => console.log(`Explainer${HOSTED ? ' (hosted)' : ''} running → http://localhost:${PORT}`));
