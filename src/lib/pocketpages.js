/**
 * Pocket Pages converter (JavaScript port of python/pocketpages.py).
 *
 * Turns an EPUB into a "Pocket Pages edition": the book is cut into short
 * reading sessions ("pockets") that end at natural breaks. Each pocket opens
 * with a small card (Pocket N of M, minutes, where you are) and is followed by
 * an end card meant to be shown on the sleep screen by CrossPoint's Quick
 * Resume.
 *
 * Runs entirely in the browser: the book never leaves the reader's device.
 * The Python version is the reference; test/parity.mjs checks that both cut
 * every test book at the same places.
 *
 *   const { epub, stats } = await convert(arrayBuffer, { minutes: 6, wpm: 260 })
 */
import JSZip from "jszip";

const XHTML = "http://www.w3.org/1999/xhtml";
const OPS = "http://www.idpf.org/2007/ops";
const XLINK = "http://www.w3.org/1999/xlink";
const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "blockquote", "table", "ul", "ol",
  "pre", "figure", "img", "dl", "section", "article"]);
const CONTAINERS = new Set(["div", "section", "article", "main", "body", "header", "footer", "aside", "span"]);

// ---------------------------------------------------------------------------
// Small helpers that mirror Python behaviour exactly (parity matters)
// ---------------------------------------------------------------------------
const WORD_RE = /[\p{L}\p{N}_]+/gu;
const words = (el) => {
  if (el == null) return 0;
  const m = (el.textContent || "").match(WORD_RE);
  return m ? m.length : 0;
};
const textOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
const local = (el) => (el && el.nodeType === 1 ? (el.localName || "").toLowerCase() : "");
const kids = (el) => Array.from(el.children || []);
const pyRound = (x) => { // Python's round(): halves go to the even neighbour
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
};
const isUpper = (s) => s === s.toUpperCase() && s !== s.toLowerCase();
const isLower = (s) => s === s.toLowerCase() && s !== s.toUpperCase();
const capitalize = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
const ROMAN = /^(?=[IVXLCDM])M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i;
const tidyLabel = (s) => s.split(/\s+/).filter(Boolean).map((w) => (ROMAN.test(w) ? w.toUpperCase() : capitalize(w))).join(" ");
const ntext = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const latin1 = (s) => {
  const rep = { "‘": "'", "’": "'", "“": '"', "”": '"', "—": " - ", "–": "-", "…": "..." };
  for (const [a, b] of Object.entries(rep)) s = s.split(a).join(b);
  return Array.from(s).filter((c) => c.codePointAt(0) <= 0xff).join("");
};
const unquote = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
function normpath(p) {
  const out = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else out.push(".."); }
    else out.push(part);
  }
  return out.join("/") || ".";
}
const dirname = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
const join = (a, b) => normpath(a ? a + "/" + b : b);
function resolve(fromHref, link) {
  const i = link.indexOf("#");
  const path = unquote(i < 0 ? link : link.slice(0, i));
  const frag = i < 0 ? null : link.slice(i + 1) || null;
  return [path ? join(dirname(fromHref), path) : fromHref, frag];
}
const epubType = (el) => (el.getAttributeNS && el.getAttributeNS(OPS, "type")) || el.getAttribute("epub:type") || "";

export class DrmError extends Error {
  constructor() { super("This book is DRM-protected, so it can't be converted. Books from Standard Ebooks, Project Gutenberg and many independent shops are DRM-free."); this.name = "DrmError"; this.code = "drm"; }
}
const unreadable = (msg) => Object.assign(new Error(msg), { code: "unreadable" });

// ---------------------------------------------------------------------------
// 1. Read the source EPUB
// ---------------------------------------------------------------------------
function parseXml(text, { html = true } = {}) {
  const P = new DOMParser();
  let doc = P.parseFromString(text, "application/xhtml+xml");
  if (doc.getElementsByTagName("parsererror").length) {
    // Many real books are not well-formed XML (stray &nbsp;, unclosed tags). Be forgiving.
    if (!html) doc = P.parseFromString(text, "application/xml");
    if (html || doc.getElementsByTagName("parsererror").length) doc = P.parseFromString(text, "text/html");
  }
  return doc;
}
const byLocal = (root, name) => Array.from(root.getElementsByTagNameNS("*", name));
const childByLocal = (el, name) => kids(el).find((c) => local(c) === name) || null;
const bodyOf = (doc) => byLocal(doc, "body")[0] || null;

async function readEpub(buf) {
  const zip = await JSZip.loadAsync(buf);
  const read = async (p) => { const f = zip.file(p); return f ? f.async("string") : null; };
  // DRM: encrypted text can't be read. (Obfuscated fonts are fine and common.)
  const enc = await read("META-INF/encryption.xml");
  if (enc) {
    const algs = [...enc.matchAll(/EncryptionMethod[^>]*Algorithm="([^"]+)"/g)].map((m) => m[1]);
    const fontOnly = (a) => a === "http://www.idpf.org/2008/embedding" || a === "http://ns.adobe.com/pdf/enc#RC";
    if (algs.some((a) => !fontOnly(a))) throw new DrmError();
  }
  const container = parseXml(await read("META-INF/container.xml"), { html: false });
  const opfPath = byLocal(container, "rootfile")[0].getAttribute("full-path");
  const base = dirname(opfPath);
  const opf = parseXml(await read(opfPath), { html: false });
  const manifest = new Map();
  for (const i of kids(byLocal(opf, "manifest")[0])) manifest.set(i.getAttribute("id"), i);
  const spine = kids(byLocal(opf, "spine")[0]).map((r) => manifest.get(r.getAttribute("idref"))).filter(Boolean);
  const meta = byLocal(opf, "metadata")[0];
  const first = (n) => { const e = byLocal(meta, n)[0]; return e ? e.textContent.trim() : ""; };
  const title = first("title") || "Untitled";
  const author = first("creator");
  const lang = first("language") || "en";
  let coverId = null;
  for (const m of byLocal(meta, "meta")) if (m.getAttribute("name") === "cover") coverId = m.getAttribute("content");
  for (const item of manifest.values()) if ((item.getAttribute("properties") || "").includes("cover-image")) coverId = item.getAttribute("id");
  const zjoin = (h) => join(base, h);
  const FONT = new Set(["text/css", "font/ttf", "font/otf", "application/vnd.ms-opentype", "application/font-woff", "font/woff", "font/woff2"]);
  const resources = new Map(); // zip path -> {href, mt, id}
  for (const item of manifest.values()) {
    const mt = item.getAttribute("media-type") || "";
    if (!zip.file(zjoin(item.getAttribute("href")))) continue; // listed in the manifest but missing from the file
    if (mt.startsWith("image/") || FONT.has(mt)) resources.set(zjoin(item.getAttribute("href")), { href: item.getAttribute("href"), mt, id: item.getAttribute("id") });
  }
  const docs = [];
  for (const item of spine) {
    const mt = item.getAttribute("media-type") || "";
    if (!mt.includes("html")) continue;
    const href = normpath(unquote(item.getAttribute("href")));
    const raw = await read(zjoin(href));
    if (raw == null) continue;
    docs.push({ href, doc: parseXml(raw) });
  }
  const css = [...resources.values()].filter((r) => r.mt === "text/css").map((r) => r.href);
  const ident = byLocal(meta, "identifier").map((i) => i.textContent || "").join(" ");
  let toc = [];
  const nav = [...manifest.values()].find((i) => (i.getAttribute("properties") || "").split(/\s+/).includes("nav"));
  if (nav) {
    const raw = await read(zjoin(unquote(nav.getAttribute("href"))));
    if (raw) toc = readNav(parseXml(raw), normpath(unquote(nav.getAttribute("href"))));
  }
  if (!toc.length) {
    const ncx = [...manifest.values()].find((i) => i.getAttribute("media-type") === "application/x-dtbncx+xml");
    if (ncx) {
      const raw = await read(zjoin(unquote(ncx.getAttribute("href"))));
      if (raw) toc = readNcx(parseXml(raw, { html: false }), normpath(unquote(ncx.getAttribute("href"))));
    }
  }
  const docOf = new Map(docs.map((d) => [d.doc, d.href]));
  return { zip, base, title, author, lang, coverId, resources, docs, css, ident, toc, docOf };
}

const tocEntry = (label, link, tocHref, depth, parent) => {
  const [href, frag] = link ? resolve(tocHref, link) : [null, null];
  return { label: label.replace(/\s+/g, " ").trim(), href, frag, depth, parent };
};

function readNav(doc, navHref) {
  const navs = byLocal(doc, "nav");
  const nav = navs.find((n) => epubType(n).split(/\s+/).includes("toc")) || navs[0];
  const out = [];
  if (!nav) return out;
  const walk = (ol, depth, parent) => {
    for (const li of kids(ol).filter((c) => local(c) === "li")) {
      const a = childByLocal(li, "a");
      const lab = a || childByLocal(li, "span");
      if (!lab) continue;
      out.push(tocEntry(lab.textContent, a ? a.getAttribute("href") : null, navHref, depth, parent));
      const me = out.length - 1;
      for (const sub of kids(li).filter((c) => local(c) === "ol")) walk(sub, depth + 1, me);
    }
  };
  for (const ol of kids(nav).filter((c) => local(c) === "ol")) walk(ol, 0, null);
  return out;
}

function readNcx(doc, ncxHref) {
  const out = [];
  const walk = (el, depth, parent) => {
    for (const np of kids(el).filter((c) => local(c) === "navpoint")) {
      const lab = childByLocal(np, "navlabel");
      const src = childByLocal(np, "content");
      out.push(tocEntry(lab ? lab.textContent : "", src ? src.getAttribute("src") : null, ncxHref, depth, parent));
      walk(np, depth + 1, out.length - 1);
    }
  };
  const nm = byLocal(doc, "navMap")[0] || byLocal(doc, "navmap")[0];
  if (nm) walk(nm, 0, null);
  return out;
}

// ---------------------------------------------------------------------------
// 2. Project Gutenberg layout: <h2> chapters, <h1> parts, header/footer matter
// ---------------------------------------------------------------------------
function flatten(el, out) {
  for (const child of kids(el)) {
    const name = local(child);
    if (name === "header" || name === "footer") { out.push(["matter-" + name, child]); continue; }
    if (["div", "section", "article", "main", "body"].includes(name) && child.querySelector("h1, h2, hr")) {
      flatten(child, out); continue;
    }
    out.push(["block", child]);
  }
}

function classify(el) {
  const name = local(el);
  if (name === "h1") return "part";
  if (name === "h2") return "chapter";
  if (name === "hr") return (el.getAttribute("class") || "").includes("pbk") ? "pagebreak" : "scene";
  if (name === "p" || name === "div") {
    const t = (el.textContent || "").trim();
    if (t && t.length <= 12 && /^[*#~·•⁂∗✱\s]+$/.test(t)) return "scene";
  }
  return "text";
}

function buildStructure(docs) {
  const stream = [];
  for (const { doc } of docs) { const body = bodyOf(doc); if (body) flatten(body, stream); }
  const front = [], back = [], chapters = [];
  let currentPart = null, cur = null;
  for (const [kind, el] of stream) {
    if (kind === "matter-header") { front.push(el); continue; }
    if (kind === "matter-footer") { back.push(el); continue; }
    const c = classify(el);
    if (c === "part") { currentPart = tidyLabel(textOf(el)); continue; }
    if (c === "chapter") { cur = { part: currentPart, label: tidyLabel(textOf(el)), heading: tidyLabel(textOf(el)), blocks: [] }; chapters.push(cur); continue; }
    if (c === "pagebreak") continue;
    if (cur == null) { if (words(el) || ["img", "figure"].includes(local(el))) front.push(el); continue; }
    cur.blocks.push(el);
  }
  return { front, chapters, back };
}

// ---------------------------------------------------------------------------
// 2b. Any other EPUB: the book's own table of contents, then headings found
//     in the text, then one section per file
// ---------------------------------------------------------------------------
const FRONT_WORDS = /^(cover|title ?page|half ?title|imprint|copyright|contents|table of contents|dedication|epigraph|foreword|preface|introduction|prologue by|editor|translator|praise|also by|other books|maps?|list of|acknowledg|a note on)/i;
const BACK_WORDS = /^(endnotes?|notes|colophon|uncopyright|copyright|licen[cs]e|acknowledg|about the (author|publisher|translator|type)|also by|other books|appendix|index|glossary|bibliography|further reading|reading group|discussion|the full project gutenberg|end of the project gutenberg)/i;
const FRONT_TYPES = new Set(["frontmatter", "titlepage", "halftitlepage", "imprint", "copyright-page", "dedication", "toc",
  "foreword", "preface", "introduction", "acknowledgments", "cover", "landmarks", "loi", "lot"]);
const BACK_TYPES = new Set(["backmatter", "colophon", "endnotes", "rearnotes", "footnotes", "index", "glossary", "bibliography", "appendix"]);
const CHAP_RE = /^(chapter|letter|book|part|volume|act|canto|stave|section)\b|^[IVXLC]+\.?$|^\d{1,3}\.?$/i;
const PART_RE = /^(book|part|volume)\b/i;

function flattenFine(el, out) {
  for (const child of kids(el)) {
    const name = local(child);
    if (CONTAINERS.has(name) && kids(child).some((c) => BLOCK_TAGS.has(local(c)) || CONTAINERS.has(local(c)) || local(c) === "hgroup")) {
      if (child.getAttribute("id")) out.push(["anchor", child]);
      flattenFine(child, out);
      continue;
    }
    out.push(["block", child]);
  }
}

function epubTypes(el) {
  const t = new Set();
  while (el && el.nodeType === 1) {
    for (const x of epubType(el).replace(/z3998:/g, "").split(/\s+/)) if (x) t.add(x);
    el = el.parentElement;
  }
  return t;
}
const isHeading = (el) => ["h1", "h2", "h3", "h4", "h5", "h6", "hgroup"].includes(local(el));
const intersects = (set, ref) => { for (const x of set) if (ref.has(x)) return true; return false; };

function findHeadings(stream) {
  let cand = [];
  stream.forEach(([k, el], i) => { if (k === "block") { const w = words(el); if (w > 0 && w <= 10 && CHAP_RE.test(textOf(el))) cand.push([i, el]); } });
  if (cand.length < 3) {
    for (const tag of ["h1", "h2", "h3"]) {
      const c = [];
      stream.forEach(([k, el], i) => { if (k === "block" && local(el) === tag && words(el)) c.push([i, el]); });
      if (c.length >= 3) { cand = c; break; }
    }
  }
  const out = [];
  let part = null;
  for (const [i, el] of cand) {
    const lab = textOf(el);
    if (PART_RE.test(lab)) {
      out.push({ label: lab, href: null, frag: null, depth: 0, parent: null, pos: i, idx: out.length });
      part = out.length - 1;
    } else {
      out.push({ label: lab, href: null, frag: null, depth: part !== null ? 1 : 0, parent: part, pos: i, idx: out.length });
    }
  }
  return out;
}

function buildStructureToc(src, minEntries = 3) {
  // 1. one stream for the whole book; remember where each file and id starts
  const stream = [], posOf = new Map();
  const key = (h, f) => h + "\u0000" + (f == null ? "" : "#" + f);
  const setDefault = (k, v) => { if (!posOf.has(k)) posOf.set(k, v); };
  for (const { href, doc } of src.docs) {
    const body = bodyOf(doc);
    if (!body) continue;
    setDefault(key(href, null), stream.length);
    if (body.getAttribute("id")) setDefault(key(href, body.getAttribute("id")), stream.length);
    flattenFine(body, stream);
    for (let i = posOf.get(key(href, null)); i < stream.length; i++) {
      const [kind, el] = stream[i];
      const all = kind === "anchor" ? [el] : [el, ...el.querySelectorAll("*")];
      for (const x of all) {
        if (x.getAttribute("id")) setDefault(key(href, x.getAttribute("id")), i);
        if (x.getAttribute("name") && local(x) === "a") setDefault(key(href, x.getAttribute("name")), i);
      }
    }
  }
  const N = stream.length;
  if (!stream.some(([k]) => k === "block")) return null;
  const nxtBlock = new Array(N);
  let j = N;
  for (let i = N - 1; i >= 0; i--) { if (stream[i][0] === "block") j = i; nxtBlock[i] = j; }
  const nb = (p) => (p >= 0 && p < N ? nxtBlock[p] : N);
  const blockWords = (a, b) => { let s = 0; for (let i = a; i < b; i++) if (stream[i][0] === "block") s += words(stream[i][1]); return s; };

  // 2. place each TOC entry in the stream
  let entries = src.toc.map((e, k) => {
    let p = e.href ? posOf.get(key(e.href, e.frag)) : undefined;
    if (p === undefined && e.href && e.frag) p = posOf.get(key(e.href, null)); // broken anchor: file start
    return { ...e, pos: p !== undefined ? nb(p) : null, idx: k };
  });
  let placed = entries.filter((e) => e.pos !== null && e.pos < N);
  let source = "toc";
  const distinct = (arr) => new Set(arr.map((e) => e.pos)).size;
  if (distinct(placed) < minEntries) {
    placed = findHeadings(stream); entries = placed; source = "headings found in the text";
  }
  if (distinct(placed) < minEntries) {
    source = "spine"; placed = [];
    for (const { href, doc } of src.docs) {
      const p = posOf.get(key(href, null));
      if (p === undefined || nb(p) >= N) continue;
      const titleEl = byLocal(doc, "title")[0];
      const firstEl = stream[nb(p)][1];
      const lab = isHeading(firstEl) ? textOf(firstEl) : (titleEl ? textOf(titleEl) : "");
      placed.push({ label: lab || `Section ${placed.length + 1}`, href, frag: null, depth: 0, parent: null, pos: nb(p), idx: placed.length });
    }
    entries = placed;
  }
  if (!placed.length) return null;

  // 2b. a contents entry that swallows a huge stretch ("Begin Reading") is opened up
  let starts = [...new Set(placed.map((e) => e.pos))].sort((a, b) => a - b);
  const nextStart = (a) => { const s = starts.find((x) => x > a); return s === undefined ? N : s; };
  const extra = [];
  for (const e of [...placed]) {
    const b = nextStart(e.pos);
    if (blockWords(e.pos, b) > 15000) {
      const found = findHeadings(stream.slice(e.pos, b));
      if (found.length >= 3) {
        const base = entries.length + extra.length;
        for (const f of found) {
          f.pos += e.pos; f.idx += base;
          f.parent = f.parent !== null ? f.parent + base : null;
          f.depth += e.depth + 1;
          extra.push(f);
        }
        source = "table of contents + headings found in the text";
      }
    }
  }
  entries = entries.concat(extra);
  placed = placed.concat(extra);

  // 3. own text of each entry; dividers, chapters and sub-sections
  starts = [...new Set(placed.map((e) => e.pos))].sort((a, b) => a - b);
  const byIdx = new Map(entries.map((e) => [e.idx, e]));
  for (const e of placed) e.own = blockWords(e.pos, nextStart(e.pos));
  const children = new Map();
  for (const e of placed) if (e.parent !== null) { if (!children.has(e.parent)) children.set(e.parent, []); children.get(e.parent).push(e); }
  const isDivider = (e) => children.has(e.idx) && (e.own ?? 0) < 60;
  const boundary = (e) => {
    let p = e.parent;
    while (p !== null && p !== undefined) {
      const pe = byIdx.get(p);
      if (pe && pe.pos !== null && pe.pos !== undefined && !isDivider(pe)) return false;
      p = pe ? pe.parent : null;
    }
    return true;
  };
  let cuts = [];
  const soft = new Set();
  for (const e of [...placed].sort((a, b) => a.pos - b.pos || a.depth - b.depth)) {
    if (boundary(e)) cuts.push(e); else soft.add(e.pos);
  }
  const dedup = new Map();
  for (const e of cuts) {
    const d = dedup.get(e.pos);
    if (!d || e.depth > d.depth || (e.depth === d.depth && e.idx > d.idx)) dedup.set(e.pos, e);
  }
  cuts = [...dedup.keys()].sort((a, b) => a - b).map((p) => dedup.get(p));

  const titleN = ntext(src.title);
  const partOf = (e) => {
    let p = e.parent;
    while (p !== null && p !== undefined) {
      const pe = byIdx.get(p);
      if (ntext(pe.label) && ntext(pe.label) !== titleN && !(pe.types && pe.types.has("halftitlepage")))
        return isUpper(pe.label) ? tidyLabel(pe.label) : pe.label;
      p = pe.parent;
    }
    return null;
  };

  // 4. segments: front / story / back
  const segs = [];
  const firstPos = cuts[0].pos;
  cuts.forEach((e, k) => {
    const end = k + 1 < cuts.length ? cuts[k + 1].pos : N;
    const els = [], softAt = new Set();
    for (let i = e.pos; i < end; i++) if (stream[i][0] === "block") { els.push(stream[i][1]); if (soft.has(i)) softAt.add(stream[i][1]); }
    const types = e.pos < N ? epubTypes(stream[e.pos][1]) : new Set();
    e.types = types;
    const lab = e.label;
    let kind = "story";
    if (intersects(types, FRONT_TYPES) || FRONT_WORDS.test(lab)) kind = "front";
    if (intersects(types, BACK_TYPES) || BACK_WORDS.test(lab)) kind = "back";
    if (types.has("bodymatter")) {
      const specific = [...types].some((t) => (FRONT_TYPES.has(t) || BACK_TYPES.has(t)) && t !== "frontmatter" && t !== "backmatter");
      if (!specific) kind = "story";
    }
    if (ntext(lab) === titleN && els.reduce((s, x) => s + words(x), 0) < 60) kind = "front";
    segs.push({ entry: e, kind, blocks: els, soft: softAt, label: lab });
  });
  const lead = [];
  for (let i = 0; i < firstPos; i++) if (stream[i][0] === "block") lead.push(stream[i][1]);
  const storyIdx = segs.map((s, k) => (s.kind === "story" ? k : -1)).filter((k) => k >= 0);
  if (!storyIdx.length) return null;
  const a = storyIdx[0], b = storyIdx[storyIdx.length - 1];
  const front = lead.concat(...segs.slice(0, a).map((s) => s.blocks));
  const frontLabels = segs.slice(0, a).filter((s) => s.blocks.reduce((t, x) => t + words(x), 0) >= 150).map((s) => s.label);
  const back = [].concat(...segs.slice(b + 1).map((s) => s.blocks));

  const chapters = [];
  let carry = [];
  for (const s of segs.slice(a, b + 1)) {
    const e = s.entry;
    const els = carry.concat(s.blocks);
    carry = [];
    const w = els.reduce((t, x) => t + words(x), 0);
    const onlyHeads = els.every((x) => isHeading(x) || !words(x) || textOf(x).split(" ").filter(Boolean).length <= 4);
    if (((children.has(e.idx) && w < 60) || (w < 30 && onlyHeads)) && s !== segs[b]) {
      carry = els.filter((x) => !isHeading(x) && words(x) > 4 && ntext(textOf(x)) !== ntext(s.label));
      continue;
    }
    let heading = null, body = els;
    const firsts = els.filter((x) => words(x) || ["img", "figure"].includes(local(x)));
    if (firsts.length) {
      const f = firsts[0];
      const ft = ntext(textOf(f)), lt = ntext(s.label);
      if (isHeading(f) || (ft && lt && (ft === lt || lt.includes(ft) || ft.includes(lt))) ||
        (ft.split(" ").filter(Boolean).length <= 8 && !/[.!?"”]$/.test(textOf(f)) && firsts.length > 1)) {
        heading = f;
        body = els.filter((x) => x !== f);
      }
    }
    let lab = isUpper(s.label) ? tidyLabel(s.label) : s.label;
    lab = lab.replace(/\b(Chapter|Letter|Book|Part|Volume|Act|Canto|Stave)\s+([IVXLCDM]+)\b/gi, (m, g1, g2) => g1 + " " + g2.toUpperCase());
    if (/^([IVXLCDM]+\.?|\d+\.?)$/i.test(lab.trim())) lab = "Chapter " + lab.trim().replace(/\.+$/, "");
    if (!lab) lab = heading ? textOf(heading) : `Section ${chapters.length + 1}`;
    chapters.push({ part: partOf(e), label: lab, heading: lab, blocks: body, soft: s.soft });
  }
  if (carry.length && chapters.length) chapters[chapters.length - 1].blocks.push(...carry);
  return { front, chapters, back, source, frontLabels };
}

// ---------------------------------------------------------------------------
// 3. Cut chapters into pockets
// ---------------------------------------------------------------------------
const FRAG = new Map(); // fragment element -> original block

function explode(blocks, target) {
  const out = [];
  for (const b of blocks) {
    const ks = kids(b);
    const ownText = Array.from(b.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
    const leadText = b.firstChild && b.firstChild.nodeType === 3 ? b.firstChild.textContent : "";
    if (words(b) > target * 0.5 && ks.length >= 2 && ["blockquote", "div", "section", "aside"].includes(local(b)) && !leadText.trim()) {
      void ownText;
      for (const c of ks) {
        const f = b.ownerDocument.createElementNS(XHTML, local(b));
        for (const at of Array.from(b.attributes)) f.setAttributeNS(at.namespaceURI, at.name, at.value);
        f.appendChild(c.cloneNode(true));
        FRAG.set(f, b);
        out.push(f);
      }
    } else out.push(b);
  }
  return out;
}

function coalesce(piece) {
  const out = [];
  for (const b of piece) {
    const prev = out[out.length - 1];
    if (FRAG.has(b) && prev && FRAG.has(prev) && FRAG.get(prev) === FRAG.get(b)) {
      for (const c of Array.from(b.childNodes)) prev.appendChild(c);
    } else out.push(b);
  }
  return out;
}

function splitChapter(ch, target) {
  const blocks = explode(ch.blocks, target);
  const soft = ch.soft || new Set();
  const w = blocks.map(words);
  const total = w.reduce((s, x) => s + x, 0);
  if (total <= target * 1.3 || blocks.length < 2) return [blocks];
  const isScene = blocks.map((b) => classify(b) === "scene");
  const isSoft = blocks.map((b) => soft.has(b));
  const B = blocks.length;
  const pre = [0];
  for (const x of w) pre.push(pre[pre.length - 1] + x);
  const cutCost = (j) => (isScene[j] || isSoft[j] || (j > 0 && isScene[j - 1]) ? 0 : 0.06);
  const best = new Array(B + 1).fill(Infinity), prev = new Array(B + 1).fill(0);
  best[0] = 0;
  for (let j = 1; j <= B; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const seg = pre[j] - pre[i];
      if (seg > target * 2.5 && i < j - 1) break;
      if (best[i] < Infinity) {
        const c = best[i] + ((seg - target) / target) ** 2 + (j < B ? cutCost(j) : 0);
        if (c < best[j]) { best[j] = c; prev[j] = i; }
      }
    }
  }
  const cuts = [];
  for (let j = B; j > 0; j = prev[j]) cuts.push(j);
  cuts.sort((x, y) => x - y);
  const pieces = [];
  let i = 0;
  for (const jj of cuts) {
    let piece = blocks.slice(i, jj);
    while (piece.length && classify(piece[0]) === "scene" && i > 0) piece = piece.slice(1);
    while (piece.length && classify(piece[piece.length - 1]) === "scene" && jj < B) piece = piece.slice(0, -1);
    if (piece.length) pieces.push(coalesce(piece));
    i = jj;
  }
  return pieces;
}

function makePockets(chapters, target) {
  const pockets = [];
  const cw = (c) => c.blocks.reduce((s, b) => s + words(b), 0);
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    let w = cw(ch);
    const group = [ch];
    let gw = w;
    while (w < target * 0.6 && i + 1 < chapters.length && chapters[i + 1].part === ch.part) {
      const nxt = chapters[i + 1], nw = cw(nxt);
      if (gw + nw > target * 1.15) break;
      group.push(nxt); gw += nw; i++; w = gw;
    }
    if (group.length > 1) {
      pockets.push({ part: ch.part, chapters: group, piece: null, n: null,
        label: `${group[0].label} - ${group[group.length - 1].label.replace("Chapter ", "")}`,
        content: [].concat(...group.map((g) => [["heading", g.heading], ...g.blocks.map((b) => ["block", b])])) });
    } else {
      const pieces = splitChapter(ch, target);
      pieces.forEach((piece, k0) => {
        const k = k0 + 1;
        pockets.push({ part: ch.part, chapters: [ch], piece: k, n: pieces.length,
          label: ch.label + (pieces.length > 1 ? `, part ${k} of ${pieces.length}` : ""),
          content: (k === 1 ? [["heading", ch.heading]] : []).concat(piece.map((b) => ["block", b])) });
      });
    }
  }
  for (const p of pockets) p.words = p.content.reduce((s, [k, el]) => s + (k === "block" ? words(el) : 0), 0);
  // a very short pocket rides along with a neighbour in the same part
  let k = 0;
  while (k < pockets.length) {
    const p = pockets[k];
    if (p.words < target * 0.4 && pockets.length > 1) {
      const cands = [];
      for (const n of [k - 1, k + 1]) {
        if (n >= 0 && n < pockets.length && pockets[n].part === p.part && pockets[n].words + p.words <= target * 1.35) cands.push([pockets[n].words, n]);
      }
      if (cands.length) {
        cands.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
        const n = cands[0][1];
        const [a, b] = n < k ? [pockets[n], p] : [p, pockets[n]];
        const merged = { part: a.part, chapters: a.chapters.concat(b.chapters), piece: null, n: null,
          label: a.label + " & " + b.label, content: a.content.concat(b.content), words: a.words + b.words };
        const lo = Math.min(k, n);
        pockets.splice(lo, 2, merged);
        k = lo;
        continue;
      }
    }
    k++;
  }
  return pockets;
}

// ---------------------------------------------------------------------------
// 4. Write the new EPUB
// ---------------------------------------------------------------------------
// "Book 1 · Chapter III", "Letter IV, continued": the third line of the opening card.
function whereOf(p) {
  const firstCh = p.chapters[0];
  let where;
  if (p.piece && p.piece > 1) where = `${firstCh.label}, continued`;
  else if (p.chapters.length > 1) where = p.label.replace(/, part \d+ of \d+/g, "");
  else where = firstCh.label;
  if (p.part) where = `${p.part} · ${where}`;
  return where;
}

function firstSentence(pocket, maxWords = 22) {
  for (const [kind, el] of pocket.content) {
    if (kind === "block" && local(el) === "p" && words(el) > 3) {
      const t = textOf(el);
      const m = t.match(/^(.+?[.!?][”"']?)(\s|$)/s);
      const s = m ? m[1] : t;
      const w = s.split(/\s+/).filter(Boolean);
      return w.slice(0, maxWords).join(" ") + (w.length > maxWords ? "..." : "");
    }
  }
  return "";
}

const page = (title, bodyXml, cssHrefs, lang) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="${XHTML}" xmlns:epub="${OPS}" lang="${lang}" xml:lang="${lang}">` +
  `<head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>` +
  cssHrefs.map((h) => `<link href="${escapeHtml(h)}" rel="stylesheet" type="text/css"/>`).join("") +
  `<link href="pocketpages.css" rel="stylesheet" type="text/css"/></head><body>${bodyXml}</body></html>`;

function ser(el, docOf) {
  const srcHref = docOf.get(el.ownerDocument);
  const c = el.cloneNode(true);
  const all = [c, ...c.querySelectorAll("*")];
  const ext = /^[a-z]+:/;
  for (const x of all) {
    const n = local(x);
    if (srcHref) {
      if (n === "img" && x.getAttribute("src") && !ext.test(x.getAttribute("src"))) x.setAttribute("src", resolve(srcHref, x.getAttribute("src"))[0]);
      else if (n === "image") {
        const v = x.getAttributeNS(XLINK, "href") || x.getAttribute("xlink:href");
        if (v && !ext.test(v)) { x.removeAttribute("xlink:href"); x.setAttributeNS(XLINK, "xlink:href", resolve(srcHref, v)[0]); }
      } else if (n === "a" && x.getAttribute("href") && !ext.test(x.getAttribute("href"))) x.removeAttribute("href");
    }
    // ids may repeat once files are merged; epub:type needs the source's prefixes. Neither affects the reader.
    for (const at of Array.from(x.attributes)) {
      if (at.localName === "id" || at.localName === "role" || at.name === "epub:type" || (at.namespaceURI === OPS && at.localName === "type")) x.removeAttributeNode(at);
    }
  }
  return new XMLSerializer().serializeToString(c);
}

export const PP_CSS = `
/* CrossPoint honours: text-align, bold/italic, margins, indent. It ignores
   borders, backgrounds, font sizes and descendant selectors, so every rule
   here is a flat class. Headings are always centred on the device. */
.pp-h { margin: 0; padding: 0; text-align: center; }
.pp-soft { font-weight: normal; }
hr.pp-edge-top { margin: 30% 0 0.3em 0; }
hr.pp-edge { margin: 0.4em 0 0.3em 0; }
hr.pp-open-top { margin: 0 0 0.3em 0; }
hr.pp-open-end { margin: 0.4em 0 1.4em 0; }
hr.pp-rule { margin: 0.6em 0 1.2em 0; }
.pp-chap { font-weight: bold; text-align: center !important; text-indent: 0 !important; margin: 0.8em 0 0.8em 0 !important; }
.pp-kicker { margin: 0; text-indent: 0 !important; }
.pp-nexttitle { font-weight: bold; margin: 0.2em 0 0 0; text-indent: 0 !important; }
.pp-meta { margin: 0.2em 0 0 0; text-indent: 0 !important; }
.pp-intro { text-align: left; }
.pp-ip { margin: 0 0 0.8em 0 !important; text-indent: 0 !important; text-align: left !important; }
`;

async function writeEpub(src, front, pockets, back, minutes, wpm, frontLabelsIn) {
  const { title, author, lang } = src;
  let prettyTitle = title;
  // "A farewell to arms" (Gutenberg's sentence case) -> "A Farewell to Arms"; "iPhone Stories" left alone
  const sentenceCase = title.split(/\s+/).length > 1 && /^\p{Lu}/u.test(title) && !/\p{Lu}/u.test(title.slice(1));
  if (isLower(title) || isUpper(title) || sentenceCase) {
    const small = new Set(["a", "an", "to", "of", "the", "and", "in", "on", "or"]);
    prettyTitle = title.split(/\s+/).filter(Boolean).map((w, i) => (small.has(w.toLowerCase()) && i ? w.toLowerCase() : capitalize(w))).join(" ");
  }
  const totalWords = pockets.reduce((s, p) => s + p.words, 0);
  const N = pockets.length;
  const css = src.css;
  const files = []; // [href, xml, tocLabel|null]
  const e = (t) => escapeHtml(latin1(t));
  const H = (inner) => `<h3 class="pp-h">${inner}</h3>`;
  const soft = (t) => `<span class="pp-soft">${e(t)}</span>`;

  const frontWords = front.reduce((s, x) => s + words(x), 0);
  const frontLabels = (frontLabelsIn || []).filter(Boolean);
  let frontNote = "", frontToc = null;
  if (frontWords > 300) {
    const what = frontLabels.slice(0, 4).join(", ") || "front matter";
    const fm = Math.max(1, pyRound(frontWords / wpm));
    frontToc = latin1(`Before the story: ${what} (${fm} min)`);
    frontNote = `<p class="pp-ip">Next comes the book's own front matter (${escapeHtml(latin1(what))}, about ${fm} min). Read it, or skip straight to Pocket 1 from the table of contents.</p>`;
  }
  const intro = `<div class="pp-intro"><p class="pp-kicker">Pocket Pages edition</p>` +
    `<p class="pp-nexttitle">${e(prettyTitle)}</p><p class="pp-meta">${e(author)}</p><hr class="pp-rule"/>` +
    `<p class="pp-ip">This book has been arranged into <b>${N} pockets</b> of about ${minutes} minutes each, cut at natural stopping points. One pocket a day finishes the book in about ${Math.ceil(N / 7)} weeks.</p>` +
    `<p class="pp-ip">Each pocket is a chapter in your table of contents. When you finish one, turn one more page to reach its end card, then put the reader to sleep. With Quick Resume turned on, the end card becomes your sleep screen, showing what is next.</p>` +
    `<p class="pp-ip">The "% read" on each end card counts the story text only, not this page, the end cards or the licence, so it can differ slightly from the reader's own percentage.</p>` +
    frontNote +
    `<p class="pp-ip">Read more if you want to. Miss a day if you need to. The next pocket simply waits.</p></div>`;
  files.push(["pp-intro.xhtml", page("About this edition", intro, css, lang), "About this edition"]);
  if (front.length) files.push(["pp-front.xhtml", page("Front matter", front.map((x) => ser(x, src.docOf)).join(""), css, lang), frontToc]);

  let doneWords = 0;
  pockets.forEach((p, i0) => {
    const i = i0 + 1;
    const mins = Math.max(1, pyRound(p.words / wpm));
    const where = whereOf(p);
    const head = `<hr class="pp-open-top"/>` + H(`Pocket ${i} of ${N}`) + H(soft(`${mins} min read`)) + H(soft(where)) + `<hr class="pp-open-end"/>`;
    const parts = [];
    let skippedFirst = false;
    for (const [kind, el] of p.content) {
      if (kind === "heading") {
        if (!skippedFirst && !parts.length) { skippedFirst = true; continue; }
        parts.push(`<p class="pp-chap">${escapeHtml(latin1(typeof el === "string" ? el : tidyLabel(textOf(el))))}</p>`);
      } else parts.push(ser(el, src.docOf));
    }
    files.push([`pocket-${String(i).padStart(3, "0")}.xhtml`, page(`Pocket ${i}`, head + parts.join(""), css, lang), `${i}. ${latin1(p.label)} (${mins} min)`]);

    doneWords += p.words;
    const pct = pyRound((doneWords / totalWords) * 100);
    let card;
    if (i < N) {
      const nxt = pockets[i];
      const nmins = Math.max(1, pyRound(nxt.words / wpm));
      const hook = firstSentence(nxt, 16);
      card = `<hr class="pp-edge-top"/>` + H(`Pocket ${i} complete`) + H(soft(`${pct}% read`)) + `<hr class="pp-edge"/>` +
        H(`Up next: Pocket ${i + 1}`) + H(soft(`${nmins} min read`)) + `<hr class="pp-edge"/>` +
        (hook ? H(`<i>${soft('"' + hook + '"')}</i>`) : "");
    } else {
      card = `<hr class="pp-edge-top"/>` + H(e(prettyTitle)) + H(soft(`Finished - ${N} pockets`)) + `<hr class="pp-edge"/>` + H(`<i>${soft("Well read.")}</i>`);
    }
    files.push([`pocket-${String(i).padStart(3, "0")}-end.xhtml`, page(`Pocket ${i} done`, card, [], lang), null]);
  });
  if (back.length) files.push(["pp-back.xhtml", page("Licence and notes", back.map((x) => ser(x, src.docOf)).join(""), css, lang), "Licence and notes"]);

  // ---- package
  const bookId = "urn:uuid:" + (globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()));
  let coverHref = null;
  const resItems = [];
  for (const [, r] of src.resources) {
    let props = "";
    if (r.id === src.coverId) { props = ' properties="cover-image"'; coverHref = r.href; }
    resItems.push([r.href, r.mt, r.id, props]);
  }
  const inToc = files.filter((f) => f[2]);
  const nav = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="${XHTML}" xmlns:epub="${OPS}" lang="${lang}"><head><meta charset="utf-8"/><title>Pockets</title></head>` +
    `<body><nav epub:type="toc" id="toc"><h1>Pockets</h1><ol>${inToc.map(([h, , t]) => `<li><a href="${h}">${escapeHtml(t)}</a></li>`).join("")}</ol></nav></body></html>`;
  const ncx = `<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${bookId}"/><meta name="dtb:depth" content="1"/>` +
    `<meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>${escapeHtml(prettyTitle)} (Pocket Pages)</text></docTitle><navMap>` +
    inToc.map(([h, , t], k) => `<navPoint id="np${k + 1}" playOrder="${k + 1}"><navLabel><text>${escapeHtml(t)}</text></navLabel><content src="${h}"/></navPoint>`).join("") + `</navMap></ncx>`;
  let man = files.map(([h], k) => `<item id="f${k}" href="${h}" media-type="application/xhtml+xml"/>`).join("");
  man += resItems.map(([h, mt, rid, props]) => `<item id="r_${rid}" href="${escapeHtml(h)}" media-type="${mt}"${props}/>`).join("");
  man += `<item id="ppcss" href="pocketpages.css" media-type="text/css"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`;
  const spine = files.map((_, k) => `<itemref idref="f${k}"/>`).join("");
  const coverMeta = coverHref ? `<meta name="cover" content="r_${src.coverId}"/>` : "";
  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const opf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:identifier id="bookid">${bookId}</dc:identifier><dc:title>${escapeHtml(prettyTitle)} (Pocket Pages)</dc:title><dc:creator>${escapeHtml(author)}</dc:creator><dc:language>${lang}</dc:language>` +
    `<meta property="dcterms:modified">${modified}</meta>${coverMeta}</metadata><manifest>${man}</manifest><spine toc="ncx">${spine}</spine></package>`;

  const out = new JSZip();
  out.file("mimetype", "application/epub+zip", { compression: "STORE" });
  out.file("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const put = (name, data) => out.file("OEBPS/" + name, data);
  put("content.opf", opf); put("nav.xhtml", nav); put("toc.ncx", ncx); put("pocketpages.css", PP_CSS);
  for (const [h, xml] of files) put(h, xml);
  for (const [zpath, r] of src.resources) put(r.href, await src.zip.file(zpath).async("uint8array"));
  const bytes = await out.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 }, mimeType: "application/epub+zip" });
  return { bytes, N, totalWords, prettyTitle };
}

/**
 * What the reader will show for the first few pockets: each pocket's opening
 * card with its first lines, and its end card. Same wording and numbers as the
 * EPUB itself. Page counts are estimates (CrossPoint marks those with "~" too).
 */
function previewOf(pockets, totalWords, wpm, count) {
  const N = pockets.length, WORDS_PER_PAGE = 120;
  const out = [];
  let done = 0;
  for (let k = 0; k < Math.min(count, N); k++) {
    const p = pockets[k], i = k + 1;
    const mins = Math.max(1, pyRound(p.words / wpm));
    const pages = Math.max(1, Math.round(p.words / WORDS_PER_PAGE));
    const startPct = pyRound((done / totalWords) * 100);
    done += p.words;
    const pct = pyRound((done / totalWords) * 100);
    const body = [];
    let budget = 110;
    for (const [kind, el] of p.content) {
      if (kind !== "block" || !words(el) || budget <= 0) continue;
      const w = textOf(el).split(" ");
      body.push(w.length > budget ? w.slice(0, budget).join(" ") : w.join(" "));
      budget -= w.length;
    }
    const status = `${i}. ${latin1(p.label)} (${mins} min)`;
    out.push({ kind: "open", pocket: `Pocket ${i} of ${N}`, mins: `${mins} min read`, where: latin1(whereOf(p)),
      body, status, page: `~1/${pages}`, pct: `${startPct}%` });
    const nxt = pockets[i];
    out.push(nxt
      ? { kind: "end", complete: `Pocket ${i} complete`, read: `${pct}% read`, next: `Up next: Pocket ${i + 1}`,
          nextMins: `${Math.max(1, pyRound(nxt.words / wpm))} min read`, quote: (() => { const h = firstSentence(nxt, 16); return h ? `"${latin1(h)}"` : ""; })(), status, page: "1/1", pct: `${pct}%` }
      : { kind: "end", complete: "Finished", read: `${N} pockets`, next: "Well read.", nextMins: "", quote: "", status, page: "1/1", pct: "100%" });
  }
  return out;
}

const isGutenbergHtml = (src) =>
  src.ident.toLowerCase().includes("gutenberg") &&
  src.docs.reduce((s, { doc }) => s + byLocal(doc, "h2").length, 0) >= 3;

/**
 * Convert an EPUB. `input` is an ArrayBuffer/Uint8Array/Blob.
 * Returns { epub: Uint8Array, stats } or throws an Error with a readable message.
 */
export async function convert(input, { minutes = 6, wpm = 260, mode = "auto" } = {}) {
  FRAG.clear();
  let src;
  try { src = await readEpub(input); } catch (err) {
    if (err instanceof DrmError) throw err;
    throw unreadable("This doesn't look like an EPUB file that can be read. Check it opens in another reader, then try again.");
  }
  let how, front, chapters, back, frontLabels = [];
  let m = mode !== "auto" ? mode : (isGutenbergHtml(src) ? "headings" : "toc");
  if (m === "headings") {
    ({ front, chapters, back } = buildStructure(src.docs));
    how = "Gutenberg headings";
    if (!chapters.length) m = "toc";
  }
  if (m === "toc") {
    const st = buildStructureToc(src);
    if (!st) throw unreadable("Couldn't find the story in this EPUB (no table of contents or readable text).");
    ({ front, chapters, back, frontLabels } = st);
    how = { toc: "table of contents", spine: "one section per file (no usable table of contents)" }[st.source] || st.source;
  }
  if (!chapters.length) throw unreadable("Couldn't find any chapters in this EPUB.");
  const target = minutes * wpm;
  const pockets = makePockets(chapters, target);
  const { bytes, N, totalWords, prettyTitle } = await writeEpub(src, front, pockets, back, Math.trunc(minutes), wpm, frontLabels);

  const mins = pockets.map((p) => Math.round((p.words / wpm) * 10) / 10);
  const sorted = [...mins].sort((x, y) => x - y);
  const srcWords = src.docs.reduce((s, { doc }) => s + words(bodyOf(doc)), 0);
  const kept = totalWords + front.reduce((s, x) => s + words(x), 0) + back.reduce((s, x) => s + words(x), 0);
  const heads = chapters.reduce((s, c) => s + c.label.split(/\s+/).filter(Boolean).length, 0);
  const firstText = (p) => { for (const [k, el] of p.content) if (k === "block" && words(el)) return textOf(el).slice(0, 60); return ""; };
  return {
    epub: bytes,
    stats: {
      title: prettyTitle, author: src.author, how, chapters: chapters.length, pockets: N, words: totalWords,
      weeks: Math.ceil(N / 7),
      minMinutes: sorted[0], medianMinutes: sorted[Math.floor(sorted.length / 2)], maxMinutes: sorted[sorted.length - 1],
      complete: kept + heads >= srcWords * 0.98, keptWords: kept, sourceWords: srcWords,
      frontWords: front.reduce((s, x) => s + words(x), 0), backWords: back.reduce((s, x) => s + words(x), 0),
      list: pockets.map((p) => ({ label: p.label, part: p.part, words: p.words, first: firstText(p) })),
      preview: previewOf(pockets, totalWords, wpm, 3),
    },
  };
}
