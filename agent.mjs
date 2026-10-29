#!/usr/bin/env node
// Explainer agent: connects your local Claude Code to a hosted Explainer, so everything the site
// writes for you runs on your own machine and your own Claude subscription.
//
//   curl -fsSL https://<site>/agent.mjs | node --input-type=module - https://<site> <key>
//
// The site sends `claude -p` jobs; this runs them and streams the output back. It only ever runs
// `claude` with tools, MCP servers, settings and slash commands switched off (checked below), so the
// site can ask Claude to write text and nothing else.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [site, key] = process.argv.slice(2);
const CLI = process.env.EXPLAINER_CLI || 'claude';
const dim = s => `\x1b[2m${s}\x1b[0m`, green = s => `\x1b[32m${s}\x1b[0m`, red = s => `\x1b[31m${s}\x1b[0m`;

if (!site || !key) {
  console.error('Usage: node agent.mjs <site-url> <workspace-key>\nCopy the exact command from "Connect your agent" on the site.');
  process.exit(1);
}
if (typeof WebSocket !== 'function') {
  console.error(red(`Node ${process.versions.node} is too old: the agent needs Node 22 or newer.`));
  process.exit(1);
}

// The same folder every run, so `--resume` finds the chat sessions Claude Code saved earlier.
const CWD = path.join(os.homedir(), '.explainer-agent');
fs.mkdirSync(CWD, { recursive: true });

// Every argument the site may pass, and what its value must look like (null: a flag with no value).
const ALLOWED = {
  '-p': null, '--verbose': null, '--strict-mcp-config': null, '--disable-slash-commands': null,
  '--include-partial-messages': null, '--no-session-persistence': null, '--fork-session': null,
  '--tools': v => v === '',
  '--setting-sources': v => v === '',
  '--input-format': v => v === 'stream-json',
  '--output-format': v => v === 'stream-json',
  '--model': v => /^[\w.[\]-]{1,64}$/.test(v),
  '--effort': v => /^(low|medium|high|xhigh|max)$/.test(v),
  '--system-prompt': v => typeof v === 'string',
  '--json-schema': v => { try { JSON.parse(v); return true; } catch { return false; } },
  '--resume': v => /^[\w-]{1,64}$/.test(v),
};
function safeArgs(args) {
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) return false;
  for (let i = 0; i < args.length; i++) {
    if (!(args[i] in ALLOWED)) return false;
    const check = ALLOWED[args[i]];
    if (check && !check(args[++i])) return false;
  }
  const at = flag => args.indexOf(flag);
  return at('-p') >= 0 && at('--tools') >= 0 && at('--setting-sources') >= 0 && at('--strict-mcp-config') >= 0;
}

const jobs = new Map(); // job id → child process
let retry = 1000;

function connect() {
  const ws = new WebSocket(site.replace(/^http/, 'ws').replace(/\/+$/, '') + '/agent');
  const send = msg => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  ws.onopen = () => send({ type: 'hello', key, name: os.hostname(), cli: CLI });
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.type === 'ready') {
      retry = 1000;
      console.log(green('● Connected') + ` to ${site}. Leave this running while you study; Ctrl+C to disconnect.`);
    }
    if (msg.type === 'kill') jobs.get(msg.id)?.kill('SIGTERM');
    if (msg.type !== 'run') return;

    const { id, args, input, task, model } = msg;
    if (!safeArgs(args)) {
      console.log(red(`✕ refused a job with unexpected arguments`));
      return send({ type: 'error', id, message: 'The agent refused these arguments' });
    }
    const t0 = Date.now();
    console.log(dim(`→ ${task || 'job'}${model ? ` (${model})` : ''}`));
    const child = spawn(CLI, args, { cwd: CWD });
    jobs.set(id, child);
    child.stdout.setEncoding('utf8').on('data', data => send({ type: 'out', id, data }));
    child.stderr.setEncoding('utf8').on('data', data => send({ type: 'err', id, data }));
    child.on('error', err => { jobs.delete(id); send({ type: 'error', id, message: `${err.message} (is Claude Code installed and on your PATH?)` }); });
    child.on('close', code => {
      jobs.delete(id);
      console.log(dim(`${code === 0 ? '✓' : '✕'} ${task || 'job'} · ${((Date.now() - t0) / 1000).toFixed(1)}s`));
      send({ type: 'exit', id, code });
    });
    child.stdin.end(input);
  };
  ws.onclose = ({ code, reason }) => {
    for (const child of jobs.values()) child.kill('SIGTERM');
    jobs.clear();
    if (code === 4003) {
      console.error(red('✕ The site rejected this workspace key. Copy the command again from the site.'));
      process.exit(1);
    }
    console.log(dim(`Disconnected${reason ? ` (${reason})` : ''}; reconnecting in ${retry / 1000}s…`));
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30_000);
  };
  ws.onerror = () => {}; // onclose follows and handles it
}

console.log(`Explainer agent · running jobs with ${CLI} in ${dim(CWD)}`);
connect();
