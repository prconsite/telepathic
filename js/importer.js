// File import: .txt .md .docx .pdf .rtf .html and JSON backups. Parsers load on demand so the app starts fast.
import { CONFIG } from './config.js';
import { htmlToMarkup } from './markup.js';

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.dataset.src = src;
    s.onload = () => res();
    s.onerror = () => { s.remove(); rej(new Error(CONFIG.preview ? 'Word and PDF import are switched off in this preview. Text and RTF files work.' : 'Could not load the file reader. Connect to the internet once so it can be saved for offline use.')); };
    document.head.appendChild(s);
  });
}

function titleFromName(name) {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || 'Imported script';
}

function rtfToText(rtf) {
  let out = '';
  let depth = 0;
  let skipDepth = 0;
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i];
    if (c === '{') {
      depth++;
      if (!skipDepth && /^\{\\(\*|fonttbl|colortbl|stylesheet|info|pict|header|footer|generator)/.test(rtf.slice(i, i + 14))) skipDepth = depth;
    } else if (c === '}') {
      if (skipDepth === depth) skipDepth = 0;
      depth--;
    } else if (c === '\\') {
      const rest = rtf.slice(i + 1);
      let m;
      if ((m = /^'([0-9a-fA-F]{2})/.exec(rest))) {
        if (!skipDepth) out += String.fromCharCode(parseInt(m[1], 16));
        i += 3;
      } else if ((m = /^u(-?\d+)\s?\??/.exec(rest))) {
        if (!skipDepth) { let n = parseInt(m[1], 10); if (n < 0) n += 65536; out += String.fromCharCode(n); }
        i += m[0].length;
      } else if ((m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(rest))) {
        if (!skipDepth) {
          if (m[1] === 'par' || m[1] === 'line') out += '\n';
          else if (m[1] === 'tab') out += '    ';
          else if (m[1] === 'emdash') out += '—';
          else if (m[1] === 'endash') out += '–';
          else if (m[1] === 'lquote') out += '‘';
          else if (m[1] === 'rquote') out += '’';
          else if (m[1] === 'ldblquote') out += '“';
          else if (m[1] === 'rdblquote') out += '”';
        }
        i += m[0].length;
      } else {
        if (!skipDepth && /[\\{}]/.test(rest[0] || '')) out += rest[0];
        i += 1;
      }
    } else if (!skipDepth && c !== '\r' && c !== '\n') {
      out += c;
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

async function pdfToText(buf) {
  await loadScript('vendor/pdf.min.js');
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const pdf = await lib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let text = '';
    let lastY = null;
    let lastH = 12;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform[5];
      const h = item.height || lastH;
      if (lastY !== null && Math.abs(y - lastY) > 1) {
        // new line; a bigger jump means a new paragraph
        text = text.replace(/[ \t]+$/, '');
        text += Math.abs(y - lastY) > h * 1.8 ? '\n\n' : (/-$/.test(text) ? '' : ' ');
      }
      text += item.str;
      if (item.hasEOL && !item.str) text += '';
      lastY = y;
      if (item.height) lastH = item.height;
    }
    pages.push(text.replace(/[ \t]{2,}/g, ' ').trim());
  }
  return pages.filter(Boolean).join('\n\n');
}

// Minimal zip reader, enough for PowerPoint files, using the browser's own inflate.
async function unzip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a valid PowerPoint file.');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const local = dv.getUint32(off + 42, true);
    files.set(dec.decode(u8.subarray(off + 46, off + 46 + nlen)), { method, csize, local });
    off += 46 + nlen + elen + clen;
  }
  const read = async (name) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.local + 30 + dv.getUint16(f.local + 26, true) + dv.getUint16(f.local + 28, true);
    const data = u8.subarray(start, start + f.csize);
    if (f.method === 0) return dec.decode(data);
    if (f.method !== 8 || typeof DecompressionStream === 'undefined') throw new Error('This device cannot unpack PowerPoint files. Export the notes as Word or PDF instead.');
    return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  };
  return { names: Array.from(files.keys()), read };
}

// PowerPoint: one section per slide. Speaker notes are the script; slides without notes fall back to their own text.
async function pptxToText(buf) {
  const zip = await unzip(buf);
  const num = (n) => parseInt(n.match(/(\d+)\.xml$/)[1], 10);
  const slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  if (!slides.length) throw new Error('No slides were found in this PowerPoint file.');
  const unxml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
  const paras = (xml) => {
    const out = [];
    for (const p of (xml || '').match(/<a:p\b[\s\S]*?<\/a:p>/g) || []) {
      if (/<a:fld\b[^>]*type="slidenum"/.test(p)) continue;
      const t = Array.from(p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g), (m) => m[1]).join('');
      if (t.trim()) out.push(unxml(t).trim());
    }
    return out;
  };
  const sections = [];
  for (let i = 0; i < slides.length; i++) {
    const text = paras(await zip.read(slides[i]));
    const rels = await zip.read(slides[i].replace('slides/slide', 'slides/_rels/slide') + '.rels');
    const target = rels && /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(rels);
    const notes = target ? paras(await zip.read(`ppt/notesSlides/${target[1]}`)) : [];
    const title = text[0] || `Slide ${i + 1}`;
    const body = notes.length ? notes.join('\n\n') : text.slice(1).join('\n');
    sections.push(`# ${title}${body ? `\n${body}` : ''}`);
  }
  return sections.join('\n\n');
}

// Returns { kind: 'script', title, body } or { kind: 'backup', scripts }.
export async function importFile(file) {
  const name = file.name || 'Imported script';
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  const title = titleFromName(name);

  if (ext === 'docx') {
    await loadScript('vendor/mammoth.browser.min.js');
    const res = await window.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    return { kind: 'script', title, body: htmlToMarkup(res.value) };
  }
  if (ext === 'pptx') return { kind: 'script', title, body: await pptxToText(await file.arrayBuffer()) };
  if (ext === 'pdf') {
    const body = await pdfToText(await file.arrayBuffer());
    if (!body.trim()) throw new Error('This PDF has no selectable text (it may be a scan).');
    return { kind: 'script', title, body };
  }
  if (ext === 'doc' || ext === 'ppt' || ext === 'key' || ext === 'pages' || ext === 'odt' || ext === 'gdoc') {
    throw new Error(`.${ext} files can't be read directly. Export it as Word (.docx) or PDF, or copy the text and use Paste.`);
  }
  const text = await file.text();
  if (ext === 'json') {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('That JSON file is not a Telepathic backup.'); }
    const scripts = Array.isArray(data) ? data : data && data.scripts;
    if (!Array.isArray(scripts)) throw new Error('That JSON file is not a Telepathic backup.');
    return { kind: 'backup', scripts };
  }
  if (ext === 'rtf' || /^\{\\rtf/.test(text)) return { kind: 'script', title, body: rtfToText(text) };
  if (ext === 'html' || ext === 'htm') return { kind: 'script', title, body: htmlToMarkup(text) };
  return { kind: 'script', title, body: text.replace(/\r\n?/g, '\n').replace(/ /g, ' ').trim() };
}
