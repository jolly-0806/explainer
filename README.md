# Explainer

Upload PDFs the night before an exam and get:

- **One explanation at five depths** (Like I'm 5 → Expert), written in parallel and shown as a colored level bar.
- **A mindmap** on an infinite canvas: click a topic to dive in (the camera zooms to it), open each node's explanation, "Go deeper" on any leaf, or "Study this in a new chat".
- **A tutor chat** that has read all your sources. Select any text → **↩ Reply** to ask about it.
- **Figures only from your PDFs**: embedded images, plus snapshots of pages with vector diagrams.

## How it costs nothing

There is no API key. All generation runs through the Claude Code CLI (`claude -p`) you are already logged in to, so it
runs on your existing Claude subscription.

## Use the hosted version

Open the site and click **Connect your agent** in the bottom-left corner. It gives you one command to paste into a terminal:

```sh
curl -fsSL https://<site>/agent.mjs | node --input-type=module - https://<site> <your-workspace-key>
```

That connects your local Claude Code to the site. Leave it running while you study. Every explanation, mindmap and
chat answer is then written on your machine and streamed back to the page. You need [Claude Code](https://claude.com/claude-code)
installed and logged in, and Node 22 or newer.

What the agent will run: only `claude -p` with tools, MCP servers, settings and slash commands switched off, so Claude
can only write text. [`agent.mjs`](agent.mjs) checks every job's arguments before it runs it. Your projects live in a
private workspace tied to a key in your browser; "Use this workspace on another device" in the same dialog gives you
a link that opens them elsewhere.

## Run it locally

```sh
npm install
npm start          # → http://localhost:4321
```

Locally the server calls `claude` itself, so no agent is needed. Requires `claude` on your PATH.
Set `EXPLAINER_MODEL=sonnet` for faster generation (default: your Claude Code default model).
Everything is stored in `./data/<project>/`.

## Host your own

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/jolly-0806/explainer)

The deploy button uses [`render.yaml`](render.yaml): a Node web service with a persistent disk. You can host it anywhere
that runs a long-lived Node 22 process and allows WebSockets:

```sh
EXPLAINER_HOSTED=1 EXPLAINER_DATA=/path/to/disk npm start
```

| Variable | Meaning |
| --- | --- |
| `EXPLAINER_HOSTED=1` | Per-browser workspaces; the server never runs `claude` itself. Jobs go to the workspace's connected agent and wait up to 15 minutes for one to connect. |
| `EXPLAINER_DATA` | Where projects, PDFs and figures are stored (default `./data`). |
| `PORT` | HTTP port (default 4321). |
