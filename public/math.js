// Textbook-style formulas: $…$ inline and $$…$$ display, typeset with KaTeX.
import katex from '/vendor/katex.mjs';

const attr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// `src` keeps its delimiters ($…$ or $$…$$): it's what gets quoted when someone asks about the formula.
export function mathHtml(tex, display, src = display ? `$$${tex}$$` : `$${tex}$`) {
  const html = katex.renderToString(tex, { displayMode: display, throwOnError: false });
  return `<span class="math${display ? ' display' : ''}" data-tex="${attr(src)}">${html}</span>`;
}

// $…$ must hug its content and not be followed by a digit, so "$5 and $6" stays text.
export const INLINE = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/;
const ANY = /\$\$([\s\S]+?)\$\$|\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/g;

// Plain text (quiz options, summaries, mindmap nodes, typed messages) with any formulas typeset.
export function setMathText(el, text = '') {
  el.textContent = '';
  let last = 0;
  for (const m of text.matchAll(ANY)) {
    el.append(text.slice(last, m.index));
    el.insertAdjacentHTML('beforeend', mathHtml((m[1] ?? m[2]).trim(), m[1] != null, m[0]));
    last = m.index + m[0].length;
  }
  el.append(text.slice(last));
}
