// Hosted only: the student's own Claude Code does all the writing, through agent.mjs on their machine.
// The sidebar shows whether it's connected; the dialog gives the one command that connects it.
import { icon } from '/icons.js';

const $ = s => document.querySelector(s);
let status = { hosted: false, agents: [] };
let timer = null;

export const agentConnected = () => !status.hosted || status.agents.length > 0;

const command = key => `curl -fsSL ${location.origin}/agent.mjs | node --input-type=module - ${location.origin} ${key}`;

async function poll() {
  clearTimeout(timer);
  try { status = await (await fetch('/api/agent')).json(); } catch { /* offline: keep the last status */ }
  render();
  // quickly while the dialog waits for the agent, slowly otherwise
  if (status.hosted) timer = setTimeout(poll, $('#agent-dialog')?.open ? 1500 : 8000);
}

function render() {
  const box = $('#agent');
  box.hidden = !status.hosted;
  if (!status.hosted) return;
  const on = status.agents.length > 0;
  const busy = status.agents.reduce((n, a) => n + a.jobs, 0);
  box.classList.toggle('on', on);
  $('#agent-label').textContent = on ? `Agent connected${busy ? ` · ${busy} running` : ''}` : 'Connect your agent';
  $('#agent-sub').textContent = on ? status.agents.map(a => a.name).join(', ') : 'Runs Claude on your machine';
  const d = $('#agent-dialog');
  if (d.open) d.querySelector('.agent-state').outerHTML = stateHtml(on);
}

const stateHtml = on => on
  ? `<p class="agent-state on">${icon('check', 14)}Connected to ${status.agents.map(a => a.name).join(', ')}. You can close this.</p>`
  : `<p class="agent-state"><span class="agent-dot"></span>Waiting for your agent…</p>`;

export function openAgentDialog() {
  const d = $('#agent-dialog');
  const on = status.agents.length > 0;
  d.innerHTML = `
    <form method="dialog" class="agent-dlg">
      <header><h2>Connect your agent</h2><button class="ghost icon-btn" aria-label="Close">${icon('x')}</button></header>
      <p>Explainer doesn't use an API key. Your own Claude Code writes the explanations, mindmap and chat answers on your computer, using your Claude subscription.</p>
      <ol>
        <li>Make sure <a href="https://claude.com/claude-code" target="_blank" rel="noopener">Claude Code</a> is installed and logged in, and you have Node 22 or newer.</li>
        <li>Run this in a terminal and leave it open while you study:</li>
      </ol>
      <div class="agent-cmd"><code>${command(status.key)}</code><button type="button" class="btn" data-copy="cmd" autofocus>${icon('note', 14)}Copy</button></div>
      ${stateHtml(on)}
      <details>
        <summary>What can the site run on my machine?</summary>
        <p>Only <code>claude -p</code>, with tools, MCP servers, settings and slash commands switched off, so Claude can only write text. The agent checks every job's arguments before it runs (<a href="/agent.mjs" target="_blank">read the script</a>).</p>
      </details>
      <details>
        <summary>Use this workspace on another device</summary>
        <p>Your projects are tied to a private key stored in this browser. Open this link on another device to see the same projects. Anyone with the link can see them too, so keep it private.</p>
        <div class="agent-cmd"><code>${location.origin}/?ws=${status.key}</code><button type="button" class="btn" data-copy="link">${icon('note', 14)}Copy</button></div>
      </details>
    </form>`;
  d.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    await navigator.clipboard.writeText(b.previousElementSibling.textContent);
    b.innerHTML = `${icon('check', 14)}Copied`;
    setTimeout(() => { b.innerHTML = `${icon('note', 14)}Copy`; }, 1500);
  });
  d.showModal();
  poll();
}

export async function initAgent() {
  $('#agent-btn').onclick = openAgentDialog;
  await poll();
  // a first visit with nothing connected: show how to connect straight away
  if (status.hosted && !status.agents.length) openAgentDialog();
}
