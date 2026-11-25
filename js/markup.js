// Script markup -> prompter HTML. Deliberately small and forgiving:
//   # Heading            section cue (jump target, not read aloud)
//   **bold** *italic* __underline__
//   {y}highlight{/}      y g b p o r
//   [pause 3]            hold the scroll for 3 seconds ([pause] waits for a tap)
//   [speed 120]          change the reading pace from this point on
//   [[note]]             director note, shown small, not counted or voice-tracked
//   NAME: line           speaker label, colour-coded per speaker
//   ---                  divider

export const HL = { y: 'Yellow', g: 'Green', b: 'Blue', p: 'Pink', o: 'Orange', r: 'Red' };
const SPEAKER_COLORS = ['#ffd166', '#6ee7b7', '#7cc4ff', '#f9a8d4', '#fdba74', '#c4b5fd'];

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function normWord(w) {
  return w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
}

const TOKEN = /(\[pause(?:\s+(\d+(?:\.\d+)?))?\s*s?\])|(\[\[(.+?)\]\])|(\{([ygbpor])\})|(\{\/\})|(\*\*)|(__)|(\*)|(\[speed\s+(\d{2,3})\s*(?:wpm)?\s*\])/gi;
const SPEAKER = /^(\s*)([A-Z][A-Z0-9 .'&-]{0,24}):(\s+|$)/;

export function parseScript(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const norms = []; // normalised form of every tracked word, by index
  const sections = []; // { title, word }
  const speakers = new Map();
  let wi = 0;

  const words = (text) => text.split(/(\s+)/).map((part) => {
    if (!part) return '';
    if (/^\s+$/.test(part)) return ' ';
    const n = normWord(part);
    norms.push(n);
    return `<span class="w" data-i="${wi++}">${esc(part)}</span>`;
  }).join('');

  const inline = (text) => {
    let html = '';
    let last = 0;
    const st = { b: false, u: false, i: false, hl: 0 };
    TOKEN.lastIndex = 0;
    let m;
    while ((m = TOKEN.exec(text))) {
      const before = text.slice(last, m.index);
      const next = text[TOKEN.lastIndex] || '';
      let handled = true;
      let piece = '';
      if (m[1]) {
        const secs = m[2] ? Math.min(600, parseFloat(m[2])) : 0;
        piece = `<span class="pz" data-s="${secs}">${secs ? `⏸ ${secs}s` : '⏸ tap'}</span>`;
      } else if (m[3]) {
        piece = `<span class="note">${esc(m[4])}</span>`;
      } else if (m[5]) {
        st.hl++;
        piece = `<span class="hl hl-${m[6].toLowerCase()}">`;
      } else if (m[7]) {
        if (st.hl > 0) { st.hl--; piece = '</span>'; } else handled = false;
      } else if (m[8]) {
        if (st.b) { st.b = false; piece = '</b>'; } else if (next && !/\s/.test(next)) { st.b = true; piece = '<b>'; } else handled = false;
      } else if (m[9]) {
        if (st.u) { st.u = false; piece = '</u>'; } else if (next && !/\s/.test(next)) { st.u = true; piece = '<u>'; } else handled = false;
      } else if (m[10]) {
        if (st.i) { st.i = false; piece = '</i>'; } else if (next && !/\s/.test(next)) { st.i = true; piece = '<i>'; } else handled = false;
      } else if (m[11]) {
        const wpm = Math.min(400, Math.max(40, parseInt(m[12], 10)));
        piece = `<span class="pz sp" data-wpm="${wpm}">${wpm} wpm</span>`;
      }
      if (handled) {
        html += words(before) + piece;
        last = TOKEN.lastIndex;
      }
    }
    html += words(text.slice(last));
    if (st.i) html += '</i>';
    if (st.u) html += '</u>';
    if (st.b) html += '</b>';
    while (st.hl-- > 0) html += '</span>';
    return html;
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    let m;
    if (!line.trim()) {
      out.push('<div class="gap"></div>');
    } else if ((m = /^\s*#{1,3}\s+(.+?)\s*#*\s*$/.exec(line))) {
      sections.push({ title: m[1], word: wi });
      out.push(`<div class="sec" data-sec="${sections.length - 1}">${esc(m[1])}</div>`);
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<div class="rule"></div>');
    } else if ((m = SPEAKER.exec(line)) && /[A-Z]{2}/.test(m[2])) {
      const name = m[2].trim();
      if (!speakers.has(name)) speakers.set(name, SPEAKER_COLORS[speakers.size % SPEAKER_COLORS.length]);
      const rest = line.slice(m[0].length);
      out.push(`<p dir="auto" class="spoken" style="--spk:${speakers.get(name)}"><span class="spk">${esc(name)}</span>${inline(rest)}</p>`);
    } else {
      out.push(`<p dir="auto">${inline(line)}</p>`);
    }
  }
  return { html: out.join(''), norms, sections, wordCount: norms.filter(Boolean).length };
}

// Plain text for search, snippets, export and word counts.
export function stripMarkup(body) {
  return String(body || '')
    .replace(/\[pause[^\]]*\]/gi, '')
    .replace(/\[speed[^\]]*\]/gi, '')
    .replace(/\[\[.+?\]\]/g, '')
    .replace(/\{[ygbpor/]\}/gi, '')
    .replace(/\*\*|__|\*/g, '')
    .replace(/^\s*#{1,3}\s+/gm, '')
    .replace(/^\s*-{3,}\s*$/gm, '');
}

export function countWords(body) {
  const t = stripMarkup(body).trim();
  return t ? t.split(/\s+/).filter((w) => normWord(w)).length : 0;
}

export function fmtDuration(secs) {
  if (!isFinite(secs) || secs < 0) secs = 0;
  secs = Math.round(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// Word/Google Docs HTML -> our markup. Keeps bold, italic, underline, headings and lists; drops everything else.
export function htmlToMarkup(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = [];
  const inlineOf = (node) => {
    let s = '';
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { s += n.nodeValue.replace(/\s+/g, ' '); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (tag === 'br') { s += '\n'; return; }
      const inner = inlineOf(n);
      if (!inner.trim()) { s += inner; return; }
      const wrap = (mark) => {
        const lead = inner.match(/^\s*/)[0];
        const trail = inner.match(/\s*$/)[0];
        return lead + mark + inner.trim() + mark + trail;
      };
      if (tag === 'strong' || tag === 'b') s += wrap('**');
      else if (tag === 'em' || tag === 'i') s += wrap('*');
      else if (tag === 'u') s += wrap('__');
      else s += inner;
    });
    return s;
  };
  const walk = (node) => {
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { if (n.nodeValue.trim()) blocks.push(n.nodeValue.trim()); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) blocks.push('# ' + n.textContent.trim());
      else if (tag === 'p') blocks.push(inlineOf(n).trim());
      else if (tag === 'li') blocks.push('• ' + inlineOf(n).trim());
      else if (tag === 'tr') blocks.push(Array.from(n.children).map((c) => c.textContent.trim()).join('  —  '));
      else if (tag === 'hr') blocks.push('---');
      else walk(n);
    });
  };
  walk(doc.body);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
