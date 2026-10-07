import { chromium } from "playwright";
const out = process.argv[2];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
for (const [name, vw, vh, scheme, path, wait] of [
  ["home-desktop", 1280, 860, "light", "/", 3200],
  ["home-desktop-early", 1280, 860, "light", "/", 600],
  ["home-mobile", 390, 844, "light", "/", 3200],
  ["home-desktop-dark", 1280, 860, "dark", "/", 3200],
  ["story-desktop", 1280, 860, "light", "/story", 300],
]) {
  const ctx = await b.newContext({ viewport: { width: vw, height: vh }, colorScheme: scheme, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.goto("http://localhost:4321" + path, { waitUntil: "networkidle" });
  await p.evaluate(() => { for (const i of document.images) i.loading = "eager"; }); await p.waitForTimeout(wait);
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: !name.includes("early") });
  await ctx.close();
}
await b.close();
