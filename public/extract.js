// Turns uploaded files into (1) markdown text with [FIGURE fN] markers and
// (2) figure images taken straight from the PDFs. No other image source exists.
import * as pdfjs from '/vendor/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';

const MIN_FIG = 120;        // ignore icons/bullets smaller than this (px)
const VECTOR_PAGE_OPS = 40; // pages with this many drawn paths and no raster image get a snapshot

// files: File[] → { text, figures:[{id,page,source}] }, uploading each figure as it is found.
export async function extractSources(files, projectId, onProgress) {
  let text = '';
  const figures = [];
  const seen = new Set();

  for (const file of files) {
    text += `\n\n# Source: ${file.name}\n\n`;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      text += await file.text();
      continue;
    }
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress(`Reading ${file.name} — page ${n} of ${doc.numPages}`);
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      text += `\n## Page ${n}\n` + content.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('');

      const ops = await page.getOperatorList();
      const canvases = [];
      let paths = 0;
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] === pdfjs.OPS.constructPath) paths++;
        if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
        const c = toCanvas(await getObj(page, ops.argsArray[i][0]));
        if (!c || c.width < MIN_FIG || c.height < MIN_FIG) continue;
        const key = fingerprint(c);
        if (seen.has(key)) continue; // repeated logos/backgrounds
        seen.add(key);
        canvases.push(c);
      }
      if (!canvases.length && paths >= VECTOR_PAGE_OPS) canvases.push(await renderPage(page));

      for (const c of canvases) {
        const fig = { id: `f${figures.length + 1}`, page: n, source: file.name };
        await Promise.all([
          upload(projectId, `${fig.id}.jpg`, c, 1400),
          upload(projectId, `${fig.id}-sm.jpg`, c, 640),
        ]);
        figures.push(fig);
        text += `\n[FIGURE ${fig.id}]\n`;
      }
    }
  }
  return { text: text.trim(), figures };
}

function getObj(page, name) {
  const objs = name.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise(resolve => {
    setTimeout(() => resolve(null), 3000);
    try { objs.get(name, resolve); } catch { resolve(null); }
  });
}

// pdf.js hands images over either as an ImageBitmap or as raw pixel data.
function toCanvas(img) {
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
    return c;
  }
  if (!img.data) return null;
  const out = ctx.createImageData(img.width, img.height);
  const px = img.width * img.height;
  if (img.data.length === px * 4) out.data.set(img.data);
  else if (img.data.length === px * 3) {
    for (let i = 0, j = 0; i < px; i++, j += 3) {
      out.data[i * 4] = img.data[j];
      out.data[i * 4 + 1] = img.data[j + 1];
      out.data[i * 4 + 2] = img.data[j + 2];
      out.data[i * 4 + 3] = 255;
    }
  } else return null; // 1-bit masks etc. aren't useful figures
  ctx.putImageData(out, 0, 0);
  return c;
}

async function renderPage(page) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 1400 / base.width });
  const c = document.createElement('canvas');
  c.width = viewport.width;
  c.height = viewport.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return c;
}

function fingerprint(c) {
  const small = document.createElement('canvas');
  small.width = small.height = 8;
  small.getContext('2d').drawImage(c, 0, 0, 8, 8);
  return `${c.width}x${c.height}:` + small.getContext('2d').getImageData(0, 0, 8, 8).data.join(',');
}

export async function upload(projectId, name, canvas, maxSide) {
  const k = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * k);
  c.height = Math.round(canvas.height * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs would turn black as JPEG
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  await fetch(`/api/projects/${projectId}/figs/${name}`, { method: 'PUT', body: blob });
}
