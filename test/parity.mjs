// Runs every test book through the JS converter (in headless Chromium) and the
// Python reference, then compares pocket boundaries, labels and word counts.
//   node test/parity.mjs <books dir> <out dir>
import { build } from "esbuild";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [booksDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
await build({ entryPoints: ["test/entry.js"], bundle: true, format: "iife", outfile: path.join(outDir, "pp.js"), logLevel: "error" });
fs.writeFileSync(path.join(outDir, "index.html"), '<!doctype html><meta charset="utf-8"><script src="pp.js"></script>');
const exe = ["/opt/pw-browsers/chromium", ...require_dirs()].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const pg = await browser.newPage();
pg.on("pageerror", (e) => console.error("page error:", e.message));
await pg.goto("file://" + path.resolve(outDir, "index.html"));
let fails = 0;
for (const f of fs.readdirSync(booksDir).filter((f) => f.endsWith(".epub")).sort()) {
  const inPath = path.join(booksDir, f);
  const b64 = fs.readFileSync(inPath).toString("base64");
  const t0 = Date.now();
  const res = await pg.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    try {
      const { epub, stats } = await window.PP.convert(bin);
      let s = ""; for (let i = 0; i < epub.length; i += 0x8000) s += String.fromCharCode(...epub.subarray(i, i + 0x8000));
      return { ok: true, stats, epub: btoa(s) };
    } catch (e) { return { ok: false, err: String(e && e.stack || e) }; }
  }, b64);
  const ms = Date.now() - t0;
  if (!res.ok) { console.log(`FAIL ${f}: ${res.err}`); fails++; continue; }
  fs.writeFileSync(path.join(outDir, "js-" + f), Buffer.from(res.epub, "base64"));
  const pyJson = path.join(outDir, "py-" + f + ".json");
  execFileSync("python3", ["python/pocketpages.py", inPath, path.join(outDir, "py-" + f), "--json", pyJson], { stdio: "pipe" });
  const py = JSON.parse(fs.readFileSync(pyJson, "utf8"));
  const js = res.stats;
  const diffs = [];
  if (py.how !== js.how) diffs.push(`method: py=${py.how} js=${js.how}`);
  if (py.chapters !== js.chapters) diffs.push(`chapters: py=${py.chapters} js=${js.chapters}`);
  if (py.front_words !== js.frontWords) diffs.push(`front words: py=${py.front_words} js=${js.frontWords}`);
  if (py.back_words !== js.backWords) diffs.push(`back words: py=${py.back_words} js=${js.backWords}`);
  if (py.pockets.length !== js.list.length) diffs.push(`pockets: py=${py.pockets.length} js=${js.list.length}`);
  const n = Math.min(py.pockets.length, js.list.length);
  for (let i = 0; i < n; i++) {
    const a = py.pockets[i], b = js.list[i];
    for (const k of ["label", "part", "words", "first"]) {
      if ((a[k] ?? null) !== (b[k] ?? null)) { diffs.push(`pocket ${i + 1} ${k}: py=${JSON.stringify(a[k])} js=${JSON.stringify(b[k])}`); break; }
    }
    if (diffs.length > 6) break;
  }
  console.log(`${diffs.length ? "DIFF" : "SAME"} ${f}: ${js.pockets} pockets, ${js.how}, complete=${js.complete}, ${ms} ms`);
  for (const d of diffs.slice(0, 6)) console.log("     " + d);
  if (diffs.length) fails++;
}
await browser.close();
console.log(fails ? `${fails} book(s) differ` : "All books identical in both versions");
process.exit(fails ? 1 : 0);
function require_dirs() {
  // pre-installed Chromium location varies; find a chrome binary under /opt/pw-browsers
  const out = [];
  try {
    for (const d of fs.readdirSync("/opt/pw-browsers")) {
      for (const c of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) out.push(path.join("/opt/pw-browsers", d, c));
    }
  } catch {}
  return out;
}
