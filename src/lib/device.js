/**
 * The drawn reader. Renders exactly what Pocket Pages puts on the screen
 * (the same card layout the EPUB produces on CrossPoint), at each device's
 * real shape. Used at build time for the static page and in the browser for
 * the live hero and the converter preview.
 *
 *   X3: 528 x 792 (3.7 in, 259 ppi)   X4 / X4 Pro: 480 x 800 (4.3 in, 220 ppi)
 */
export const MODELS = {
  X3: { aspect: "528 / 792", bezel: "91%", scale: 480 / 528, caption: "X3 · 3.7 in · 528 × 792", note: "Shown on X3 · 528 × 792", name: "Xteink X3" },
  X4: { aspect: "480 / 800", bezel: "100%", scale: 1, caption: "X4 and X4 Pro · 4.3 in · 480 × 800", note: "Shown on X4 · 480 × 800", name: "Xteink X4" },
};

export const HERO_CARD = {
  kind: "end", complete: "Pocket 1 complete", read: "2% read", next: "Up next: Pocket 2", nextMins: "6 min read",
  quote: "\"When I came back to the front we still lived in that town.\"",
  status: "1. Chapter I (6 min)", page: "1/1", pct: "2%",
};

export const SAMPLE_OPEN = {
  kind: "open", pocket: "Pocket 2 of 61", mins: "6 min read", where: "Book 1 · Chapter III",
  body: ["When I came back to the front we still lived in that town. There were many more guns in the country around and the spring had come. The fields were green and there were small green shoots on the vines, the trees along the road had small leaves and a breeze came from the sea."],
  status: "2. Chapter III (6 min)", page: "~1/13", pct: "3%",
};

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MOON = '<svg class="pd-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 3.2a8.6 8.6 0 1 0 5.3 13.3A7.2 7.2 0 0 1 15.5 3.2Z" fill="currentColor"/><path d="M19 3.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5zM21.6 8.2l.3.8.8.3-.8.3-.3.8-.3-.8-.8-.3.8-.3z" fill="currentColor"/></svg>';

/** Inner HTML of the screen for a card ("end" | "open") and whether it is asleep. */
export function screenHTML(card, asleep = false) {
  const c = card || HERO_CARD;
  const status = `<div class="pd-status">${asleep ? MOON : "<span>94%</span>"}<span class="pd-chap">${esc(c.status)}</span><span>${esc(c.page)}&nbsp;&nbsp;${esc(c.pct)}</span></div>`;
  if (c.kind === "open") {
    const body = (c.body || []).map((p) => `<p>${esc(p)}</p>`).join("");
    return `<div class="pd-page pd-open"><div class="pd-head"><span class="pd-rule"></span><b>${esc(c.pocket)}</b><span>${esc(c.mins)}</span><span>${esc(c.where)}</span><span class="pd-rule"></span></div><div class="pd-body">${body}</div>${status}</div>`;
  }
  return `<div class="pd-page pd-end"><div class="pd-card"><span class="pd-rule"></span><b>${esc(c.complete)}</b><span>${esc(c.read)}</span><span class="pd-rule"></span><b>${esc(c.next)}</b>${c.nextMins ? `<span>${esc(c.nextMins)}</span>` : ""}${c.quote ? `<span class="pd-rule"></span><i>${esc(c.quote)}</i>` : ""}</div>${status}</div>`;
}

export function deviceLabel(model, card, asleep) {
  const m = MODELS[model] || MODELS.X4;
  const c = card || HERO_CARD;
  if (c.kind === "open") return `${m.name} showing the start of a pocket: ${c.pocket}, ${c.mins}, ${c.where}.`;
  return `${m.name} ${asleep ? "asleep on" : "showing"} the end card: ${c.complete}, ${c.read}. ${c.next}${c.nextMins ? ", " + c.nextMins : ""}.`;
}
