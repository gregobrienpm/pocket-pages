#!/usr/bin/env python3
"""
Pocket Pages splitter (v1)
--------------------------
Turns any EPUB into a single "Pocket Pages edition": the book is cut into
short reading sessions ("pockets") that end at natural breaks, and each
pocket is followed by an end card designed to be shown on the sleep screen
by CrossPoint's Quick Resume.

    python3 pocketpages.py book.epub out.epub --minutes 6 --wpm 260

How the book is read (first that works wins)
  1. Project Gutenberg's own EPUBs: <h2> chapters, <h1> parts.
  2. The book's table of contents (EPUB 3 nav or EPUB 2 NCX). Entries with
     children and little text of their own ("Volume II") become part names;
     entries nested inside a real chapter become preferred cut points.
     A single entry covering a huge stretch ("Begin Reading") is opened up
     using chapter headings found in the text.
  3. No usable contents: chapter headings found in the text ("Chapter 7",
     "BOOK II", "XIV", or the most frequent <h1>/<h2>/<h3>).
  4. Last resort: one section per file.
  Front matter (title page, imprint, introduction...) and back matter
  (notes, colophon, licence, about the author) are kept but not pocketed,
  using epub:type where present and section names otherwise.
  After building, the source and output word counts are compared and a
  warning is printed if anything went missing.

Design rules
  * One file in the library. Pockets are internal chapters, so the device's
    chapter list becomes the pocket list.
  * Pockets end at the strongest break available: chapter end > scene
    break or sub-section > paragraph end. Never mid-paragraph, so one very
    long paragraph can make a long pocket. Cut points for a chapter are
    chosen together so pockets stay close to the target length.
  * A long quoted letter can be cut between its paragraphs; each piece
    stays inside its own quote block.
  * Internal links are unlinked (pockets no longer match the source files);
    image paths are kept working.
  * Very short consecutive chapters are merged into one pocket; long
    chapters are split into roughly equal parts.
  * Each pocket is followed by its own end-card page (a separate spine
    item, so it always starts on a fresh page).
  * "% read" on end cards = story words up to the end of that pocket / total
    story words, fixed at build time (front matter, end cards and licence are
    excluded), so it can differ slightly from the reader's own position-based %.
  * Plain Latin-1 characters only on generated pages, so small e-ink
    fonts don't show missing-glyph boxes.
"""
import argparse, copy, html, math, os, re, sys, uuid, zipfile
from urllib.parse import unquote
from lxml import etree

XHTML = "http://www.w3.org/1999/xhtml"
NS = {"x": XHTML}
OPF_NS = {"opf": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "blockquote", "table", "ul", "ol",
              "pre", "figure", "img", "dl", "section", "article"}


def local(el):
    return etree.QName(el).localname if isinstance(el.tag, str) else ""


def words(el):
    return len(re.findall(r"\w+", "".join(el.itertext())))


ROMAN = re.compile(r"^(?=[IVXLCDM])M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$", re.I)


def tidy_label(s):
    """'CHAPTER VII' -> 'Chapter VII'; 'BOOK 1' -> 'Book 1'."""
    out = []
    for w in s.split():
        out.append(w.upper() if ROMAN.match(w) else w.capitalize())
    return " ".join(out)


def text_of(el):
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip()


# ----------------------------------------------------------------------------
# 1. Read the source EPUB
# ----------------------------------------------------------------------------
def read_epub(path):
    z = zipfile.ZipFile(path)
    container = etree.fromstring(z.read("META-INF/container.xml"))
    opf_path = container.find(".//{*}rootfile").get("full-path")
    base = os.path.dirname(opf_path)
    opf = etree.fromstring(z.read(opf_path))
    manifest = {i.get("id"): i for i in opf.find("{*}manifest") if isinstance(i.tag, str)}
    spine = [manifest[r.get("idref")] for r in opf.find("{*}spine") if isinstance(r.tag, str) and r.get("idref") in manifest]
    meta = opf.find("{*}metadata")
    title = (meta.findtext("{*}title") or "Untitled").strip()
    author = (meta.findtext("{*}creator") or "").strip()
    lang = (meta.findtext("{*}language") or "en").strip()
    cover_id = None
    for m in meta.findall("{*}meta"):
        if m.get("name") == "cover":
            cover_id = m.get("content")
    for item in manifest.values():
        if "cover-image" in (item.get("properties") or ""):
            cover_id = item.get("id")
    join = lambda h: os.path.normpath(os.path.join(base, h)).replace("\\", "/")
    resources = {}  # zip path -> (href relative to OPF dir, media-type, id)
    for item in manifest.values():
        mt = item.get("media-type")
        if join(item.get("href")) not in z.namelist():
            continue  # listed in the manifest but missing from the file
        if mt.startswith("image/") or mt in ("text/css", "font/ttf", "font/otf", "application/vnd.ms-opentype",
                                             "application/font-woff", "font/woff", "font/woff2"):
            resources[join(item.get("href"))] = (item.get("href"), mt, item.get("id"))
    docs = []
    for item in spine:
        if "xhtml" in item.get("media-type") or "html" in item.get("media-type"):
            href = norm(unquote(item.get("href")))
            try:
                raw = z.read(join(href))
            except KeyError:
                continue
            root = etree.fromstring(raw, etree.XMLParser(recover=True, huge_tree=True))
            if root is not None:
                docs.append((href, root))
    css_links = []
    for href, (h, mt, _id) in resources.items():
        if mt == "text/css":
            css_links.append(h)
    ident = " ".join(i.text or "" for i in meta.findall("{*}identifier"))
    # Table of contents: EPUB 3 nav document first, then EPUB 2 NCX.
    toc = []
    nav = next((i for i in manifest.values() if "nav" in (i.get("properties") or "").split()), None)
    if nav is not None:
        try:
            toc = read_nav(etree.fromstring(z.read(join(unquote(nav.get("href")))),
                                            etree.XMLParser(recover=True)), norm(unquote(nav.get("href"))))
        except (KeyError, etree.XMLSyntaxError):
            toc = []
    if not toc:
        ncx = next((i for i in manifest.values() if i.get("media-type") == "application/x-dtbncx+xml"), None)
        if ncx is not None:
            try:
                toc = read_ncx(etree.fromstring(z.read(join(unquote(ncx.get("href")))),
                                                etree.XMLParser(recover=True)), norm(unquote(ncx.get("href"))))
            except (KeyError, etree.XMLSyntaxError):
                toc = []
    return dict(zip=z, base=base, title=title, author=author, lang=lang, cover_id=cover_id,
                manifest=manifest, resources=resources, docs=docs, css=css_links, ident=ident, toc=toc,
                doc_of={id(r): h for h, r in docs})


def norm(p):
    return os.path.normpath(p).replace("\\", "/")


def resolve(from_href, link):
    """Resolve a link found in file `from_href` (OPF-relative) -> (OPF-relative path, fragment)."""
    path, _, frag = link.partition("#")
    path = unquote(path)
    target = norm(os.path.join(os.path.dirname(from_href), path)) if path else from_href
    return target, frag or None


def _toc_entry(label, link, toc_href, depth, parent):
    href, frag = resolve(toc_href, link) if link else (None, None)
    return dict(label=re.sub(r"\s+", " ", label).strip(), href=href, frag=frag, depth=depth, parent=parent)


def read_nav(root, nav_href):
    navs = root.xpath('//x:nav', namespaces=NS)
    nav = next((n for n in navs if "toc" in (n.get("{http://www.idpf.org/2007/ops}type") or "").split()),
               navs[0] if navs else None)
    out = []
    if nav is None:
        return out

    def walk(ol, depth, parent):
        for li in ol.xpath("./x:li", namespaces=NS):
            a = li.find("{%s}a" % XHTML)
            lab = a if a is not None else li.find("{%s}span" % XHTML)
            if lab is None:
                continue
            out.append(_toc_entry("".join(lab.itertext()), a.get("href") if a is not None else None,
                                  nav_href, depth, parent))
            me = len(out) - 1
            for sub in li.xpath("./x:ol", namespaces=NS):
                walk(sub, depth + 1, me)

    for ol in nav.xpath("./x:ol", namespaces=NS):
        walk(ol, 0, None)
    return out


def read_ncx(root, ncx_href):
    out = []

    def walk(el, depth, parent):
        for np_ in el.findall("{*}navPoint"):
            lab = np_.find("{*}navLabel")
            src = np_.find("{*}content")
            out.append(_toc_entry("".join(lab.itertext()) if lab is not None else "",
                                  src.get("src") if src is not None else None, ncx_href, depth, parent))
            walk(np_, depth + 1, len(out) - 1)

    nm = root.find("{*}navMap")
    if nm is not None:
        walk(nm, 0, None)
    return out


# ----------------------------------------------------------------------------
# 2. Flatten the book into a stream of blocks with structural markers
# ----------------------------------------------------------------------------
def flatten(el, out):
    """Push block-level elements in reading order. Divs that wrap headings
    or breaks are expanded; other divs are kept whole."""
    for child in el:
        name = local(child)
        if not name:
            continue
        if name in ("header", "footer"):
            out.append(("matter-" + name, child))
            continue
        if name in ("div", "section", "article", "main", "body") and child.xpath(
                ".//x:h1|.//x:h2|.//x:hr", namespaces=NS):
            flatten(child, out)
            continue
        out.append(("block", child))


def classify(el):
    name = local(el)
    if name == "h1":
        return "part"
    if name == "h2" or (name in ("h3",) and False):
        return "chapter"
    if name == "hr":
        cls = el.get("class") or ""
        return "pagebreak" if "pbk" in cls else "scene"
    if name in ("p", "div"):
        t = "".join(el.itertext()).strip()
        if t and len(t) <= 12 and re.fullmatch(r"[*#~\u00b7\u2022\u2042\u2217\u2731\s]+", t):
            return "scene"  # "* * *", "#", "~" as a scene break
    return "text"


def build_structure(docs):
    """Return front matter, chapters and back matter.
    chapter = dict(part, label, units=[unit]) where a unit is a list of
    elements that end at a scene break or paragraph."""
    stream = []
    for href, root in docs:
        body = root.find(".//{%s}body" % XHTML)
        if body is None:
            continue
        flatten(body, stream)

    front, back, chapters = [], [], []
    current_part, cur = None, None
    seen_text = False
    for kind, el in stream:
        if kind == "matter-header":
            front.append(el); continue
        if kind == "matter-footer":
            back.append(el); continue
        c = classify(el)
        if c == "part":
            current_part = tidy_label(text_of(el))
            continue
        if c == "chapter":
            cur = dict(part=current_part, label=tidy_label(text_of(el)), heading=el, blocks=[])
            chapters.append(cur)
            continue
        if c == "pagebreak":
            continue
        if cur is None:
            # text before the first chapter (cover wrapper, epigraph...)
            if words(el) or local(el) in ("img", "figure"):
                front.append(el)
            continue
        cur["blocks"].append(el)
    return front, chapters, back


# ----------------------------------------------------------------------------
# 2b. Any other EPUB: use the book's own table of contents
# ----------------------------------------------------------------------------
CONTAINERS = {"div", "section", "article", "main", "body", "header", "footer", "aside", "span"}
OPS_TYPE = "{http://www.idpf.org/2007/ops}type"
FRONT_WORDS = re.compile(r"^(cover|title ?page|half ?title|imprint|copyright|contents|table of contents|"
                         r"dedication|epigraph|foreword|preface|introduction|prologue by|editor|"
                         r"translator|praise|also by|other books|maps?|list of|acknowledg|a note on)", re.I)
BACK_WORDS = re.compile(r"^(endnotes?|notes|colophon|uncopyright|copyright|licen[cs]e|acknowledg|"
                        r"about the (author|publisher|translator|type)|also by|other books|appendix|index|"
                        r"glossary|bibliography|further reading|reading group|discussion|"
                        r"the full project gutenberg|end of the project gutenberg)", re.I)
FRONT_TYPES = {"frontmatter", "titlepage", "halftitlepage", "imprint", "copyright-page", "dedication", "toc",
               "foreword", "preface", "introduction", "acknowledgments", "cover", "landmarks", "loi", "lot"}
BACK_TYPES = {"backmatter", "colophon", "endnotes", "rearnotes", "footnotes", "index", "glossary",
              "bibliography", "appendix"}


def flatten_fine(el, out):
    """Reading-order stream of blocks for arbitrary EPUBs. Any wrapper that
    holds block-level children is opened up (Calibre and store books often
    wrap a whole file in one <div>); ids on opened wrappers become anchors."""
    for child in el:
        name = local(child)
        if not name:
            continue
        if name in CONTAINERS and any(local(c) in BLOCK_TAGS | CONTAINERS | {"hgroup"} for c in child):
            if child.get("id"):
                out.append(("anchor", child))
            flatten_fine(child, out)
            continue
        out.append(("block", child))


def epub_types(el):
    t = set()
    while el is not None:
        t |= set((el.get(OPS_TYPE) or "").replace("z3998:", "").split())
        el = el.getparent()
    return t


def is_heading(el):
    return local(el) in ("h1", "h2", "h3", "h4", "h5", "h6", "hgroup")


def ntext(s):
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


CHAP_RE = re.compile(r"^(chapter|letter|book|part|volume|act|canto|stave|section)\b|^[IVXLC]+\.?$|^\d{1,3}\.?$", re.I)
PART_RE = re.compile(r"^(book|part|volume)\b", re.I)


def find_headings(stream):
    """Chapter starts for books without a usable table of contents: short
    blocks that read like "Chapter 7", "BOOK II", "XIV"; failing that, the
    most frequent of <h1>/<h2>/<h3>. Part-like headings become dividers."""
    cand = [(i, el) for i, (k, el) in enumerate(stream) if k == "block" and 0 < words(el) <= 10
            and CHAP_RE.match(text_of(el))]
    if len(cand) < 3:
        for tag in ("h1", "h2", "h3"):
            c = [(i, el) for i, (k, el) in enumerate(stream) if k == "block" and local(el) == tag and words(el)]
            if len(c) >= 3:
                cand = c
                break
    out, part = [], None
    for i, el in cand:
        lab = text_of(el)
        if PART_RE.match(lab):
            out.append(dict(label=lab, href=None, frag=None, depth=0, parent=None, pos=i, idx=len(out)))
            part = len(out) - 1
        else:
            out.append(dict(label=lab, href=None, frag=None, depth=1 if part is not None else 0,
                            parent=part, pos=i, idx=len(out)))
    return out


def build_structure_toc(src, min_entries=3):
    """front, chapters, back from the table of contents (or, failing that,
    one chapter per spine file). Returns None if neither gives a usable shape."""
    # 1. one stream for the whole book; remember where each file and id starts
    stream, pos_of = [], {}
    for href, root in src["docs"]:
        body = root.find(".//{%s}body" % XHTML)
        if body is None:
            continue
        pos_of.setdefault((href, None), len(stream))
        if body.get("id"):
            pos_of.setdefault((href, body.get("id")), len(stream))
        flatten_fine(body, stream)
        for i in range(pos_of[(href, None)], len(stream)):
            kind, el = stream[i]
            for x in ([el] if kind == "anchor" else el.iter()):
                if isinstance(x.tag, str) and x.get("id"):
                    pos_of.setdefault((href, x.get("id")), i)
                if isinstance(x.tag, str) and x.get("name") and local(x) == "a":
                    pos_of.setdefault((href, x.get("name")), i)
    blocks = [(i, el) for i, (k, el) in enumerate(stream) if k == "block"]
    if not blocks:
        return None
    nxt_block = {}
    j = len(stream)
    for i in range(len(stream) - 1, -1, -1):
        if stream[i][0] == "block":
            j = i
        nxt_block[i] = j

    # 2. place each TOC entry in the stream
    entries = []
    for k, e in enumerate(src["toc"]):
        p = pos_of.get((e["href"], e["frag"])) if e["href"] else None
        if p is None and e["href"] and e["frag"]:
            p = pos_of.get((e["href"], None))  # broken anchor: fall back to file start
        entries.append(dict(e, pos=nxt_block.get(p, len(stream)) if p is not None else None, idx=k))
    placed = [e for e in entries if e["pos"] is not None and e["pos"] < len(stream)]
    source = "toc"
    if len({e["pos"] for e in placed}) < min_entries:
        # no usable TOC: look for chapter headings in the text itself
        placed = find_headings(stream)
        entries = placed
        source = "headings found in the text"
    if len({e["pos"] for e in placed}) < min_entries:
        # no usable TOC: one section per spine file
        source = "spine"
        placed = []
        for href, _ in src["docs"]:
            p = pos_of.get((href, None))
            if p is None or nxt_block.get(p, len(stream)) >= len(stream):
                continue
            title_el = next((el for h, r in src["docs"] if h == href
                             for el in r.iter("{%s}title" % XHTML)), None)
            first = stream[nxt_block[p]][1]
            lab = text_of(first) if is_heading(first) else (text_of(title_el) if title_el is not None else "")
            placed.append(dict(label=lab or f"Section {len(placed) + 1}", href=href, frag=None, depth=0,
                               parent=None, pos=nxt_block[p], idx=len(placed)))
        entries = placed
    if not placed:
        return None

    # 2b. a TOC entry that swallows a huge stretch ("Begin Reading") is opened
    # up using chapter headings found inside it
    starts = sorted({e["pos"] for e in placed})
    extra = []
    for e in list(placed):
        b = next((x for x in starts if x > e["pos"]), len(stream))
        if sum(words(stream[i][1]) for i in range(e["pos"], b) if stream[i][0] == "block") > 15000:
            found = find_headings(stream[e["pos"]:b])
            if len(found) >= 3:
                base = len(entries) + len(extra)
                for f in found:
                    f["pos"] += e["pos"]; f["idx"] += base
                    f["parent"] = f["parent"] + base if f["parent"] is not None else None
                    f["depth"] += e["depth"] + 1  # outranks the vague entry at the same spot
                    extra.append(f)
                source = "table of contents + headings found in the text"
    entries = entries + extra
    placed = placed + extra

    # 3. own text of each entry = blocks from its position to the next entry's
    starts = sorted({e["pos"] for e in placed})
    def span_words(a):
        b = next((s for s in starts if s > a), len(stream))
        return sum(words(stream[i][1]) for i in range(a, b) if stream[i][0] == "block")
    by_idx = {e["idx"]: e for e in entries}
    for e in placed:
        e["own"] = span_words(e["pos"])
    # an entry is a divider ("Volume I", "Part Two") if it has children and
    # little or no text of its own; children of a divider are chapters.
    # Children of an entry that has real text are sub-sections: they become
    # preferred cut points inside that chapter, not chapters of their own.
    kids = {}
    for e in placed:
        if e["parent"] is not None:
            kids.setdefault(e["parent"], []).append(e)
    def is_divider(e):
        return e["idx"] in kids and e.get("own", 0) < 60
    def boundary(e):
        p = e["parent"]
        while p is not None:
            pe = by_idx.get(p)
            if pe is not None and pe.get("pos") is not None and not is_divider(pe):
                return False
            p = pe["parent"] if pe is not None else None
        return True
    cuts, soft = [], set()
    for e in sorted(placed, key=lambda e: (e["pos"], e["depth"])):
        if boundary(e):
            cuts.append(e)
        else:
            soft.add(e["pos"])
    # same position: keep the deepest entry (e.g. "Part One" and "Chapter 1" both at file start)
    dedup = {}
    for e in cuts:
        d = dedup.get(e["pos"])
        if d is None or (e["depth"], e["idx"]) > (d["depth"], d["idx"]):
            dedup[e["pos"]] = e
    cuts = [dedup[p] for p in sorted(dedup)]

    title_n = ntext(src["title"])
    def part_of(e):
        p = e["parent"]
        while p is not None:
            pe = by_idx[p]
            if ntext(pe["label"]) and ntext(pe["label"]) != title_n and "halftitlepage" not in pe.get("types", ()):
                return tidy_label(pe["label"]) if pe["label"].isupper() else pe["label"]
            p = pe["parent"]
        return None

    # 4. segments, classified as front / story / back
    segs = []
    first_pos = cuts[0]["pos"]
    for k, e in enumerate(cuts):
        end = cuts[k + 1]["pos"] if k + 1 < len(cuts) else len(stream)
        els = [stream[i][1] for i in range(e["pos"], end) if stream[i][0] == "block"]
        soft_at = {stream[i][1] for i in range(e["pos"], end) if i in soft and stream[i][0] == "block"}
        types = epub_types(stream[e["pos"]][1]) if e["pos"] < len(stream) else set()
        e["types"] = types
        lab = e["label"]
        kind = "story"
        if types & FRONT_TYPES or FRONT_WORDS.match(lab):
            kind = "front"
        if types & BACK_TYPES or BACK_WORDS.match(lab):
            kind = "back"
        if "bodymatter" in types and not (types & (FRONT_TYPES | BACK_TYPES) - {"frontmatter", "backmatter"}):
            kind = "story"
        if ntext(lab) == title_n and sum(words(x) for x in els) < 60:
            kind = "front"  # half-title page
        segs.append(dict(entry=e, kind=kind, blocks=els, soft=soft_at, label=lab))
    lead = [stream[i][1] for i in range(0, first_pos) if stream[i][0] == "block"]

    story_idx = [k for k, s in enumerate(segs) if s["kind"] == "story"]
    if not story_idx:
        return None
    a, b = story_idx[0], story_idx[-1]
    front = lead + [x for s in segs[:a] for x in s["blocks"]]
    front_labels = [s["label"] for s in segs[:a] if sum(words(x) for x in s["blocks"]) >= 150]
    back = [x for s in segs[b + 1:] for x in s["blocks"]]

    chapters, carry = [], []
    for s in segs[a:b + 1]:
        e = s["entry"]
        els = carry + s["blocks"]
        carry = []
        w = sum(words(x) for x in els)
        only_heads = all(is_heading(x) or not words(x) or len(text_of(x).split()) <= 4 for x in els)
        if ((e["idx"] in kids and w < 60) or (w < 30 and only_heads)) and s is not segs[b]:
            # divider page: its heading is shown as the part name; keep any other text
            carry = [x for x in els if not is_heading(x) and words(x) > 4
                     and ntext(text_of(x)) != ntext(s["label"])]
            continue
        # the chapter's own heading: first block, if it is a heading or matches the label
        heading, body = None, els
        firsts = [x for x in els if words(x) or local(x) in ("img", "figure")]
        if firsts:
            f = firsts[0]
            ft, lt = ntext(text_of(f)), ntext(s["label"])
            if is_heading(f) or (ft and lt and (ft == lt or ft in lt or lt in ft)) or \
                    (len(ft.split()) <= 8 and not re.search(r"[.!?\"”]$", text_of(f)) and len(firsts) > 1):
                heading = f
                body = [x for x in els if x is not f]
        lab = tidy_label(s["label"]) if s["label"].isupper() else s["label"]
        lab = re.sub(r"\b(Chapter|Letter|Book|Part|Volume|Act|Canto|Stave)\s+([IVXLCDM]+)\b",
                      lambda m: m.group(1) + " " + m.group(2).upper(), lab, flags=re.I)
        if re.fullmatch(r"[IVXLCDM]+\.?|\d+\.?", lab.strip(), re.I):
            lab = "Chapter " + lab.strip().rstrip(".")
        if not lab:
            lab = text_of(heading) if heading is not None else f"Section {len(chapters) + 1}"
        chapters.append(dict(part=part_of(e), label=lab, heading=lab, blocks=body, soft=s["soft"]))
    if carry and chapters:
        chapters[-1]["blocks"] += carry
    return dict(front=front, chapters=chapters, back=back, source=source, front_labels=front_labels, stream_words=sum(
        words(el) for _, el in blocks))


# ----------------------------------------------------------------------------
# 3. Cut chapters into pockets
# ----------------------------------------------------------------------------
def split_chapter(ch, target):
    """Split a chapter's blocks into pieces of about `target` words.

    Chooses the cut points for the whole chapter at once (dynamic
    programming) rather than greedily, so no piece is left over-long at the
    end. Cost of a piece = squared distance from target; cutting at a plain
    paragraph costs a little more than at a natural break (a scene break,
    whose rule is then dropped, or a sub-section from the table of contents)."""
    blocks = explode(ch["blocks"], target)
    soft = ch.get("soft") or set()
    w = [words(b) for b in blocks]
    total = sum(w)
    if total <= target * 1.3 or len(blocks) < 2:
        return [blocks]
    is_scene = [classify(b) == "scene" for b in blocks]
    is_soft = [b in soft for b in blocks]
    B = len(blocks)
    pre = [0]
    for x in w:
        pre.append(pre[-1] + x)
    # cut "before block j" (1 <= j < B). Cost of cutting there:
    def cut_cost(j):
        if is_scene[j] or is_soft[j]:
            return 0.0
        if j > 0 and is_scene[j - 1]:
            return 0.0
        return 0.06
    INF = float("inf")
    best = [INF] * (B + 1)
    prev = [0] * (B + 1)
    best[0] = 0.0
    for j in range(1, B + 1):
        i = j - 1
        while i >= 0:
            seg = pre[j] - pre[i]
            if seg > target * 2.5 and i < j - 1:
                break
            if best[i] < INF:
                c = best[i] + ((seg - target) / target) ** 2 + (cut_cost(j) if j < B else 0.0)
                if c < best[j]:
                    best[j], prev[j] = c, i
            i -= 1
    cuts, j = [], B
    while j > 0:
        cuts.append(j); j = prev[j]
    cuts = sorted(cuts)
    pieces, i = [], 0
    for j in cuts:
        piece = blocks[i:j]
        # a scene-break rule at either edge of a pocket is redundant
        while piece and classify(piece[0]) == "scene" and i > 0:
            piece = piece[1:]
        while piece and classify(piece[-1]) == "scene" and j < B:
            piece = piece[:-1]
        if piece:
            pieces.append(coalesce(piece))
        i = j
    return pieces


FRAG = {}  # id(fragment) -> (original block, fragment)


def explode(blocks, target):
    """A long quoted letter or similar wrapper (> half a pocket) is opened at
    its paragraphs so a pocket can end inside it. Each fragment is a copy of
    the wrapper holding one child; coalesce() rejoins neighbours afterwards."""
    out = []
    for b in blocks:
        kids = [c for c in b if isinstance(c.tag, str)]
        if words(b) > target * 0.5 and len(kids) >= 2 and local(b) in ("blockquote", "div", "section", "aside") \
                and not (b.text or "").strip():
            href = DOC_OF.get(id(b.getroottree().getroot()))
            for c in kids:
                f = etree.Element(b.tag, dict(b.attrib), nsmap={None: XHTML})  # no "html:" prefixes
                cc = copy.deepcopy(c); cc.tail = None
                f.append(cc)
                FRAG[id(f)] = (b, f)
                if href:
                    DOC_OF[id(f)] = href
                out.append(f)
        else:
            out.append(b)
    return out


def coalesce(piece):
    out = []
    for b in piece:
        if id(b) in FRAG and out and id(out[-1]) in FRAG and FRAG[id(out[-1])][0] is FRAG[id(b)][0]:
            prev = out[-1]
            for c in list(b):
                prev.append(c)
        else:
            out.append(b)
    return out


def make_pockets(chapters, target):
    pockets = []
    i = 0
    while i < len(chapters):
        ch = chapters[i]
        w = sum(words(b) for b in ch["blocks"])
        # merge consecutive short chapters (same part) up to ~1.15 x target
        group, gw = [ch], w
        while w < target * 0.6 and i + 1 < len(chapters) and chapters[i + 1]["part"] == ch["part"]:
            nxt = chapters[i + 1]
            nw = sum(words(b) for b in nxt["blocks"])
            if gw + nw > target * 1.15:
                break
            group.append(nxt); gw += nw; i += 1
            w = gw
        if len(group) > 1:
            pockets.append(dict(part=ch["part"], chapters=group, piece=None, n=None,
                                label=f"{group[0]['label']} - {group[-1]['label'].replace('Chapter ', '')}",
                                content=[x for g in group for x in ([("heading", g["heading"])] +
                                                                    [("block", b) for b in g["blocks"]])]))
        else:
            pieces = split_chapter(ch, target)
            for k, piece in enumerate(pieces, 1):
                content = ([("heading", ch["heading"])] if k == 1 else []) + [("block", b) for b in piece]
                label = ch["label"] + (f", part {k} of {len(pieces)}" if len(pieces) > 1 else "")
                pockets.append(dict(part=ch["part"], chapters=[ch], piece=k, n=len(pieces), label=label,
                                    content=content))
        i += 1
    for p in pockets:
        p["words"] = sum(words(el) for k, el in p["content"] if k == "block")
    # A very short pocket (a one-page letter, an epilogue) rides along with a
    # neighbour in the same part if the pair still fits comfortably.
    k = 0
    while k < len(pockets):
        p = pockets[k]
        if p["words"] < target * 0.4 and len(pockets) > 1:
            cands = []
            for nb in (k - 1, k + 1):
                if 0 <= nb < len(pockets) and pockets[nb]["part"] == p["part"] and \
                        pockets[nb]["words"] + p["words"] <= target * 1.35:
                    cands.append((pockets[nb]["words"], nb))
            if cands:
                _, nb = min(cands)
                a, b = (pockets[nb], p) if nb < k else (p, pockets[nb])
                merged = dict(part=a["part"], chapters=a["chapters"] + b["chapters"], piece=None, n=None,
                              label=a["label"] + " & " + b["label"], content=a["content"] + b["content"],
                              words=a["words"] + b["words"])
                lo = min(k, nb)
                pockets[lo:lo + 2] = [merged]
                k = lo
                continue
        k += 1
    return pockets


# ----------------------------------------------------------------------------
# 4. Write the new EPUB
# ----------------------------------------------------------------------------
def first_sentence(pocket, max_words=22):
    for kind, el in pocket["content"]:
        if kind == "block" and local(el) == "p" and words(el) > 3:
            t = text_of(el)
            m = re.match(r"(.+?[.!?][\u201d\"']?)(\s|$)", t)
            s = m.group(1) if m else t
            w = s.split()
            return " ".join(w[:max_words]) + ("..." if len(w) > max_words else "")
    return ""


def latin1(s):
    """Generated text only: swap characters small e-ink fonts may lack."""
    rep = {"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2014": " - ",
           "\u2013": "-", "\u2026": "..."}
    for a, b in rep.items():
        s = s.replace(a, b)
    return s.encode("latin-1", "ignore").decode("latin-1")


def page(title, body_xml, css_hrefs, lang):
    links = "".join(f'<link href="{html.escape(h)}" rel="stylesheet" type="text/css"/>' for h in css_hrefs)
    return (f'<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
            f'<html xmlns="{XHTML}" xmlns:epub="http://www.idpf.org/2007/ops" lang="{lang}" xml:lang="{lang}">'
            f'<head><meta charset="utf-8"/><title>{html.escape(title)}</title>{links}'
            f'<link href="pocketpages.css" rel="stylesheet" type="text/css"/></head>'
            f'<body>{body_xml}</body></html>')


DOC_OF = {}  # id(root element) -> OPF-relative href of the source file


def ser(el):
    """Serialise a block for a generated page (pages sit next to the OPF).
    Image paths are re-based; links into the old file layout are unlinked
    (the text stays), because pockets no longer match the source files."""
    src_href = DOC_OF.get(id(el.getroottree().getroot()))
    el = copy.deepcopy(el)
    el.tail = None
    if src_href:
        XL = "{http://www.w3.org/1999/xlink}href"
        for x in el.iter():
            if not isinstance(x.tag, str):
                continue
            n = local(x)
            if n == "img" and x.get("src") and not re.match(r"^[a-z]+:", x.get("src")):
                x.set("src", resolve(src_href, x.get("src"))[0])
            elif n == "image" and x.get(XL) and not re.match(r"^[a-z]+:", x.get(XL)):
                x.set(XL, resolve(src_href, x.get(XL))[0])
            elif n == "a" and x.get("href") and not re.match(r"^[a-z]+:", x.get("href")):
                del x.attrib["href"]
    for x in el.iter():
        if not isinstance(x.tag, str):
            continue
        # ids may repeat once files are merged; semantic epub:type tags would
        # need the source's vocabulary prefixes. Neither affects the reader.
        for k in ("id", OPS_TYPE, "role"):
            if k in x.attrib:
                del x.attrib[k]
    return etree.tostring(el, encoding="unicode", with_tail=False)


PP_CSS = """
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
"""


def write_epub(src, front, pockets, back, out_path, minutes, wpm):
    title, author, lang = src["title"], src["author"], src["lang"]
    pretty_title = title
    if title.islower() or title.isupper():  # "A farewell to arms" -> "A Farewell to Arms"; "iPhone" left alone
        pretty_title = " ".join(w.lower() if w.lower() in ("a", "an", "to", "of", "the", "and", "in", "on", "or")
                                and i else w.capitalize() for i, w in enumerate(title.split()))
    total_words = sum(p["words"] for p in pockets)
    N = len(pockets)
    css = src["css"]
    files = []  # (href, xml, in_toc_label or None)

    # Intro page
    days = N
    front_words = sum(words(x) for x in front)
    front_labels = [l for l in src.get("front_labels", []) if l]
    front_note, front_toc = "", None
    if front_words > 300:
        what = ", ".join(front_labels[:4]) or "front matter"
        fm = max(1, round(front_words / wpm))
        front_toc = latin1(f"Before the story: {what} ({fm} min)")
        front_note = (f'<p class="pp-ip">Next comes the book\'s own front matter ({html.escape(latin1(what))}, about {fm} min). '
                      f'Read it, or skip straight to Pocket 1 from the table of contents.</p>')
    intro = (f'<div class="pp-intro"><p class="pp-kicker">Pocket Pages edition</p>'
             f'<p class="pp-nexttitle">{html.escape(latin1(pretty_title))}</p>'
             f'<p class="pp-meta">{html.escape(latin1(author))}</p><hr class="pp-rule"/>'
             f'<p class="pp-ip">This book has been arranged into <b>{N} pockets</b> of about {minutes} minutes each, '
             f'cut at natural stopping points. One pocket a day finishes the book in about {math.ceil(days/7)} weeks.</p>'
             f'<p class="pp-ip">Each pocket is a chapter in your table of contents. When you finish one, turn one more '
             f'page to reach its end card, then put the reader to sleep. With Quick Resume turned on, the '
             f'end card becomes your sleep screen, showing what is next.</p>'
             f'<p class="pp-ip">The "% read" on each end card counts the story text only, not this page, the end cards or the licence, so it can differ slightly from the reader\'s own percentage.</p>'
             + front_note +
             f'<p class="pp-ip">Read more if you want to. Miss a day if you need to. The next pocket simply waits.</p></div>')
    files.append(("pp-intro.xhtml", page("About this edition", intro, css, lang), "About this edition"))

    if front:
        files.append(("pp-front.xhtml", page("Front matter", "".join(ser(e) for e in front), css, lang), front_toc))

    done_words = 0
    for i, p in enumerate(pockets, 1):
        mins = max(1, round(p["words"] / wpm))
        where = (p["part"] + " - " if p["part"] else "") + p["label"]
        # Opening card: the same frame as the end card, so a session starts
        # and stops the same way. Time first (the commitment is minutes, not
        # pages), then the count, then where you are in the book.
        e = lambda t: html.escape(latin1(t))
        H = lambda inner: f'<h3 class="pp-h">{inner}</h3>'
        soft = lambda t: f'<span class="pp-soft">{e(t)}</span>'
        first_ch = p["chapters"][0]
        if p["piece"] and p["piece"] > 1:
            where = f"{first_ch['label']}, continued"
        elif len(p["chapters"]) > 1:
            where = re.sub(r", part \d+ of \d+", "", p["label"])
        else:
            where = first_ch["label"]
        if p["part"]:
            where = f"{p['part']} \u00b7 {where}"
        head = ('<hr class="pp-open-top"/>' + H(f"Pocket {i} of {N}") + H(soft(f"{mins} min read")) +
                H(soft(where)) + '<hr class="pp-open-end"/>')
        parts, skipped_first = [], False
        for kind, el in p["content"]:
            if kind == "heading":
                if not skipped_first and not parts:
                    skipped_first = True  # already named in the opening card
                    continue
                t = el if isinstance(el, str) else tidy_label(text_of(el))
                parts.append(f'<p class="pp-chap">{html.escape(latin1(t))}</p>')
            else:
                parts.append(ser(el))
        body = head + "".join(parts)
        toc_label = f"{i}. {latin1(p['label'])} ({mins} min)"
        files.append((f"pocket-{i:03d}.xhtml", page(f"Pocket {i}", body, css, lang), toc_label))

        # End card
        done_words += p["words"]
        pct = round(done_words / total_words * 100)
        e = lambda t: html.escape(latin1(t))
        # Simple class selectors only: CrossPoint ignores descendant selectors.
        # Headings are the only centred element; the firmware forces them bold,
        # so pp-soft (font-weight: normal) takes effect only with the firmware fix.
        H = lambda inner: f'<h3 class="pp-h">{inner}</h3>'
        soft = lambda t: f'<span class="pp-soft">{e(t)}</span>'
        if i < N:
            nxt = pockets[i]
            nmins = max(1, round(nxt["words"] / wpm))
            hook = first_sentence(nxt, max_words=16)
            card = ('<hr class="pp-edge-top"/>'
                    + H(f"Pocket {i} complete") + H(soft(f"{pct}% read")) +
                    '<hr class="pp-edge"/>'
                    + H(f"Up next: Pocket {i+1}") + H(soft(f"{nmins} min read")) +
                    '<hr class="pp-edge"/>'
                    + (H(f'<i>{soft(chr(34) + hook + chr(34))}</i>') if hook else ""))
        else:
            card = ('<hr class="pp-edge-top"/>'
                    + H(e(pretty_title)) + H(soft(f"Finished - {N} pockets")) +
                    '<hr class="pp-edge"/>'
                    + H(f'<i>{soft("Well read.")}</i>'))
        files.append((f"pocket-{i:03d}-end.xhtml", page(f"Pocket {i} done", card, [], lang), None))

    if back:
        files.append(("pp-back.xhtml", page("Licence and notes", "".join(ser(e) for e in back), css, lang),
                      "Licence and notes"))

    # ---- package
    book_id = "urn:uuid:" + str(uuid.uuid4())
    res_items, cover_href = [], None
    for zpath, (href, mt, rid) in src["resources"].items():
        props = ""
        if rid == src["cover_id"]:
            props = ' properties="cover-image"'; cover_href = href
        res_items.append((href, mt, rid, props))

    nav_lis = "".join(f'<li><a href="{h}">{html.escape(t)}</a></li>' for h, _, t in files if t)
    nav = (f'<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="{XHTML}" '
           f'xmlns:epub="http://www.idpf.org/2007/ops" lang="{lang}"><head><meta charset="utf-8"/>'
           f'<title>Pockets</title></head><body><nav epub:type="toc" id="toc"><h1>Pockets</h1><ol>{nav_lis}</ol>'
           f'</nav></body></html>')
    nps = "".join(f'<navPoint id="np{k}" playOrder="{k}"><navLabel><text>{html.escape(t)}</text></navLabel>'
                  f'<content src="{h}"/></navPoint>'
                  for k, (h, _, t) in enumerate([f for f in files if f[2]], 1))
    ncx = (f'<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
           f'<head><meta name="dtb:uid" content="{book_id}"/><meta name="dtb:depth" content="1"/>'
           f'<meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>'
           f'<docTitle><text>{html.escape(pretty_title)} (Pocket Pages)</text></docTitle><navMap>{nps}</navMap></ncx>')

    man = "".join(f'<item id="f{k}" href="{h}" media-type="application/xhtml+xml"/>' for k, (h, _, _) in enumerate(files))
    man += "".join(f'<item id="r_{rid}" href="{html.escape(h)}" media-type="{mt}"{props}/>' for h, mt, rid, props in res_items)
    man += ('<item id="ppcss" href="pocketpages.css" media-type="text/css"/>'
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
    spine = "".join(f'<itemref idref="f{k}"/>' for k in range(len(files)))
    cover_meta = f'<meta name="cover" content="r_{src["cover_id"]}"/>' if cover_href else ""
    opf = (f'<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
           f'unique-identifier="bookid" xml:lang="{lang}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
           f'<dc:identifier id="bookid">{book_id}</dc:identifier>'
           f'<dc:title>{html.escape(pretty_title)} (Pocket Pages)</dc:title>'
           f'<dc:creator>{html.escape(author)}</dc:creator><dc:language>{lang}</dc:language>'
           f'<meta property="dcterms:modified">2026-10-02T00:00:00Z</meta>{cover_meta}</metadata>'
           f'<manifest>{man}</manifest><spine toc="ncx">{spine}</spine></package>')

    base = src["base"]
    with zipfile.ZipFile(out_path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml",
                   '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                   '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
                   '</rootfiles></container>', compress_type=zipfile.ZIP_DEFLATED)
        put = lambda name, data: z.writestr("OEBPS/" + name, data, compress_type=zipfile.ZIP_DEFLATED)
        put("content.opf", opf); put("nav.xhtml", nav); put("toc.ncx", ncx); put("pocketpages.css", PP_CSS)
        for h, xml, _ in files:
            put(h, xml)
        for zpath, (href, mt, rid) in src["resources"].items():
            # keep the same relative href under OEBPS
            put(href, src["zip"].read(zpath))
    return N, total_words


def is_gutenberg_html(src):
    """Project Gutenberg's own EPUBs: <h2> chapters, <h1> parts, header/footer matter."""
    if "gutenberg" not in src["ident"].lower():
        return False
    h2 = sum(len(r.findall(".//{%s}h2" % XHTML)) for _, r in src["docs"])
    return h2 >= 3


def main():
    ap = argparse.ArgumentParser(description="Make a Pocket Pages edition of an EPUB")
    ap.add_argument("epub"); ap.add_argument("out")
    ap.add_argument("--minutes", type=float, default=6)
    ap.add_argument("--wpm", type=int, default=260, help="reading speed (Brysbaert 2019: ~260 fiction, ~238 non-fiction)")
    ap.add_argument("--mode", choices=["auto", "headings", "toc"], default="auto",
                    help="headings = Project Gutenberg layout; toc = the book's table of contents")
    ap.add_argument("--json", help="also write a summary of every pocket to this file (used for testing)")
    a = ap.parse_args()
    src = read_epub(a.epub)
    DOC_OF.clear(); DOC_OF.update(src["doc_of"])
    mode = a.mode if a.mode != "auto" else ("headings" if is_gutenberg_html(src) else "toc")
    if mode == "headings":
        front, chapters, back = build_structure(src["docs"])
        how = "Gutenberg headings"
        if not chapters:
            mode = "toc"
    if mode == "toc":
        st = build_structure_toc(src)
        if st is None:
            sys.exit("Could not find the story in this EPUB (no table of contents or readable text).")
        front, chapters, back = st["front"], st["chapters"], st["back"]
        src["front_labels"] = st["front_labels"]
        how = {"toc": "table of contents", "spine": "one section per file (no usable table of contents)"}.get(
            st["source"], st["source"])
    target = a.minutes * a.wpm
    pockets = make_pockets(chapters, target)
    n, tw = write_epub(src, front, pockets, back, a.out, int(a.minutes), a.wpm)
    mins = [round(p["words"] / a.wpm, 1) for p in pockets]
    if a.json:
        import json
        def first_text(p):
            for k, el in p["content"]:
                if k == "block" and words(el):
                    return text_of(el)[:60]
            return ""
        json.dump(dict(title=src["title"], how=how, chapters=len(chapters),
                       front_words=sum(words(e) for e in front), back_words=sum(words(e) for e in back),
                       pockets=[dict(label=p["label"], part=p["part"], words=p["words"], first=first_text(p))
                                for p in pockets]), open(a.json, "w"), indent=1, ensure_ascii=False)
    print(f"{src['title']}: split by {how}; {len(chapters)} chapters, {tw:,} story words -> {n} pockets")
    print(f"pocket length: min {min(mins)} / median {sorted(mins)[len(mins)//2]} / max {max(mins)} minutes")
    # Nothing may go missing: every word of the source must land somewhere.
    src_words = 0
    for _, r in src["docs"]:
        body = r.find(".//{%s}body" % XHTML)
        if body is not None:
            src_words += words(body)
    kept = tw + sum(words(e) for e in front) + sum(words(e) for e in back)
    heads = sum(len(c["label"].split()) for c in chapters)
    if kept + heads < src_words * 0.98:
        print(f"WARNING: only {kept:,} of {src_words:,} source words were kept. Check the output.", file=sys.stderr)
    long_ = [i + 1 for i, m in enumerate(mins) if m > a.minutes * 2.5]
    if long_:
        print(f"note: {len(long_)} pocket(s) run long (no break to cut at): {long_[:10]}", file=sys.stderr)
    return pockets


if __name__ == "__main__":
    main()
