// Renders public/og.png (1200×630) from the live hero.  node test/og.mjs <url> <out>
import { chromium } from "playwright";
const [url = "http://localhost:4321/", out = "public/og.png"] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: "light" });
await p.goto(url, { waitUntil: "networkidle" });
await p.addStyleTag({ content: `
  .site-head, .hero-actions, .aside, .switch, [data-caption], main > .wrap > section:not(.hero) { display: none !important; }
  .wrap { padding: 0 72px !important; max-width: none !important; }
  .hero { padding: 0 !important; height: 630px; flex-wrap: nowrap !important; gap: 64px !important; }
  .hero h1 { font-size: 78px !important; }
  .hero-device { flex: 0 0 300px !important; }
  .hero-device .hero-pd { width: 290px !important; }
  .hero-text::before { content: "Pocket Pages"; font-size: 24px; font-weight: 600; }
` });
await p.waitForTimeout(3400); // let the reader fall asleep
await p.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
await b.close();
