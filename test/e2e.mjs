// End to end through the real page: choose a file, wait, download, save.
//   node test/e2e.mjs <url> <epub> <out.epub> [minutes]
import { chromium } from "playwright";
const [url, epub, out, minutes = "6"] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await p.goto(url, { waitUntil: "networkidle" });
const shown = await p.locator("[data-result]").isVisible();
await p.selectOption('select[name="minutes"]', minutes);
await p.setInputFiles("[data-file]", epub);
await p.locator("[data-result]").waitFor({ state: "visible", timeout: 60000 });
const summary = await p.locator("[data-r-summary]").innerText();
const detail = await p.locator("[data-r-detail]").innerText();
const warnHidden = await p.locator("[data-r-warn]").isHidden();
const [dl] = await Promise.all([p.waitForEvent("download"), p.click("[data-r-download]")]);
await dl.saveAs(out);
await p.locator("#convert").screenshot({ path: out.replace(/\.epub$/, ".png") });
// bad input
await p.setInputFiles("[data-file]", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
const err1 = await p.locator("[data-status]").innerText();
await p.setInputFiles("[data-file]", { name: "broken.epub", mimeType: "application/epub+zip", buffer: Buffer.from("not a zip") });
await p.waitForTimeout(500);
const err2 = await p.locator("[data-status]").innerText();
console.log(JSON.stringify({ resultVisibleBeforeConvert: shown, summary, detail, warnHidden, file: dl.suggestedFilename(), err1, err2, errors }, null, 1));
await b.close();
