// End to end through the real page: choose a file, check the preview, download, try bad input.
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
await p.click(`[data-min="${minutes}"]`);
await p.setInputFiles("[data-file]", epub);
await p.locator("[data-result]").waitFor({ state: "visible", timeout: 60000 });
await p.waitForTimeout(600);
const title = await p.locator("[data-title]").innerText();
const summary = await p.locator("[data-summary]").innerText();
const warnHidden = await p.locator("[data-warn]").isHidden();
const screen = () => p.locator("#cv-device .pd-content").innerText();
const pages = [[await p.locator("[data-page-label]").innerText(), await screen()]];
for (let i = 0; i < 3; i++) {
  await p.click("[data-next]"); await p.waitForTimeout(250);
  pages.push([await p.locator("[data-page-label]").innerText(), await screen()]);
}
await p.click("[data-prev]"); await p.waitForTimeout(250);
const back = await p.locator("[data-page-label]").innerText();
await p.locator("#convert").screenshot({ path: out.replace(/\.epub$/, ".png") });
const [dl] = await Promise.all([p.waitForEvent("download"), p.click("[data-download]")]);
await dl.saveAs(out);
// bad input
await p.click("[data-again]");
await p.setInputFiles("[data-file]", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
await p.waitForTimeout(300);
const err1 = await p.locator("[data-msg]").innerText();
await p.setInputFiles("[data-file]", { name: "broken.epub", mimeType: "application/epub+zip", buffer: Buffer.from("not a zip") });
await p.waitForTimeout(500);
const err2 = await p.locator("[data-msg]").innerText();
console.log(JSON.stringify({ resultVisibleBeforeConvert: shown, title, summary, warnHidden, pages, back, file: dl.suggestedFilename(), err1, err2, errors }, null, 1));
await b.close();
