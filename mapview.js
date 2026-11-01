// Draws a map as SVG for the web app. Pure: takes a (live) map and returns markup.
import { amountText, jitter, shapeEdges, shortWhen, spotPos, spotState } from "./maps.js";
import { SUIT } from "./model.js";

const SC = { body: "var(--s-body)", home: "var(--s-home)", mind: "var(--s-mind)", work: "var(--s-work)" };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function wrapWords(text, max = 10, lines = 3) {
  const out = [];
  for (const w of String(text).split(" ")) {
    const last = out[out.length - 1];
    if (last && (last + " " + w).length <= max) out[out.length - 1] = last + " " + w; else out.push(w);
  }
  if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].replace(/.{0,1}$/, "…"); }
  return out;
}
// Played cards sit on their spots like real cards: a little tilted, with a shadow.
function cardSvg(e, x, y, rot, opts = {}) {
  const col = SC[e.suit] || SC.body, w = 58, h = 80, lines = wrapWords(e.label || "");
  let g = `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)})"><g class="${opts.drop ? "drop" : ""}">`;
  g += `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="7" fill="var(--paper)" stroke="rgba(58,22,48,.12)" filter="url(#cardShadow)"/>`;
  g += `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="7" rx="3" fill="${col}"/>`;
  g += `<text x="${-w / 2 + 5}" y="${-h / 2 + 19}" style="font:800 10px var(--display);fill:${col}">${SUIT[e.suit] || "●"}</text>`;
  lines.forEach((ln, i) => (g += `<text class="pc-lbl" x="0" y="${2 + (i - (lines.length - 1) / 2) * 11}" text-anchor="middle">${esc(ln)}</text>`));
  if (opts.meta) g += `<text class="pc-meta" x="0" y="${h / 2 - 7}" text-anchor="middle">${esc(opts.meta)}</text>`;
  if (opts.badge) g += `<g transform="translate(${w / 2 - 4} ${-h / 2 + 4})"><circle r="11" fill="var(--ink)"/><text y="3.5" text-anchor="middle" style="font:800 10px var(--display);fill:var(--bg)">${esc(opts.badge)}</text></g>`;
  return g + `</g></g>`;
}

/** cards: your card docs (for suits). hl: Set of spot ids to light up. sel: selected spot id. justPlayed: spot id. */
export function boardSvg(map, { cards = [], hl = new Set(), sel = null, justPlayed = null, now = Date.now() } = {}) {
  const W = map.W || 1400, H = map.H || 1000;
  const suitOf = (sp) => sp.accepts.startsWith("suit:") ? sp.accepts.slice(5) : cards.find((c) => "card:" + c.id === sp.accepts)?.suit || "body";
  const nameOf = (sp) => {
    if (sp.label) return sp.label;
    if (sp.accepts === "any") return "any card";
    if (sp.accepts.startsWith("suit:")) return "any " + sp.accepts.slice(5);
    return (cards.find((c) => "card:" + c.id === sp.accepts)?.label || "?").replace("#", "").trim();
  };
  let g = `<defs><filter id="cardShadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#3a1630" flood-opacity=".22"/></filter>
    <pattern id="miss" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#cfc6cb"/><rect width="3" height="8" fill="#e6dde2"/></pattern></defs>`;
  g += `<rect width="${W}" height="${H}" rx="24" fill="var(--felt)"/>`;
  for (const sh of map.shapes) {
    const edges = shapeEdges(sh);
    if (sh.kind === "ring" && sh.spots.length > 2) g += `<path d="M${sh.spots.map((_, i) => spotPos(sh, i).map((v) => v.toFixed(1)).join(",")).join(" L")} Z" fill="rgba(255,253,247,.28)" stroke="none"/>`;
    for (const [a, b] of edges) g += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="var(--line)" stroke-width="${sh.kind === "path" ? 10 : 6}" stroke-linecap="round"/>`;
    if (sh.kind === "pool") continue;
    const vertical = sh.kind === "path" && Math.abs(Math.sin(((sh.rot || 0) * Math.PI) / 180)) > 0.7;
    const [lx, ly] = vertical ? [sh.cx - 50, sh.cy] : sh.kind === "path" ? [sh.cx, sh.cy - 56] : [sh.cx, sh.cy - 8];
    const anchor = vertical ? "end" : "middle";
    const big = sh.kind === "ring" && map.shapes.some((p) => p.kind === "pool" && Math.hypot(p.cx - sh.cx, p.cy - sh.cy) < 20);
    const ty = big ? sh.cy + sh.ry * 0.62 : ly;
    g += `<text class="t-lbl" x="${lx}" y="${ty}" text-anchor="${anchor}">${esc(sh.label)}</text>`;
    g += `<text class="t-sub" x="${lx}" y="${ty + 22}" text-anchor="${anchor}">${esc(sh.sub || "")}</text>`;
  }
  for (const sh of map.shapes) sh.spots.forEach((sid, i) => {
    const sp = map.spots[sid], [x, y] = spotPos(sh, i), st = spotState(map, sp, now);
    const col = SC[suitOf(sp)], isHl = hl.has(sid), isSel = sel === sid;
    if (sh.kind === "pool") {
      const r = sh.rx, frac = sp.target ? Math.min(1, (sp.total || 0) / sp.target) : 0, C = 2 * Math.PI * (r - 9);
      g += `<g class="spot" data-spot="${sid}">`;
      g += `<circle cx="${x}" cy="${y}" r="${r}" fill="var(--paper)" stroke="${isHl ? "var(--ink)" : "var(--line)"}" stroke-width="${isHl ? 5 : 2}" ${isHl ? 'class="hl"' : ""}/>`;
      g += `<circle cx="${x}" cy="${y}" r="${r - 9}" fill="none" stroke="var(--bg2)" stroke-width="12"/>`;
      g += `<circle cx="${x}" cy="${y}" r="${r - 9}" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(C * frac).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 ${x} ${y})"/>`;
      g += `<text class="t-lbl" x="${x}" y="${y - 10}" text-anchor="middle">${esc(sh.label)}</text>`;
      g += `<text class="t-pool" x="${x}" y="${y + 18}" text-anchor="middle">${esc(amountText(sp))}</text>`;
      g += `<text class="t-sub" x="${x}" y="${y + 40}" text-anchor="middle">${esc(sh.sub || "")}</text>`;
      if (isSel) g += `<circle cx="${x}" cy="${y}" r="${r + 7}" fill="none" stroke="var(--ink)" stroke-width="3" stroke-dasharray="6 5"/>`;
      const pile = sp.pile || [];
      pile.slice(-4).forEach((e, k, arr) => {
        const top = k === arr.length - 1;
        g += cardSvg(e, x + r * 0.95 + k * 5, y + r * 0.8 - k * 3, jitter(sid + k, 9), { badge: top && pile.length > 1 ? "×" + pile.length : "", drop: top && justPlayed === sid });
      });
      return (g += `</g>`);
    }
    const R = 30;
    g += `<g class="spot" data-spot="${sid}">`;
    g += `<circle cx="${x}" cy="${y}" r="${R + 14}" fill="transparent"/>`;
    if (isHl) g += `<circle class="hl" cx="${x}" cy="${y}" r="${R + 9}" fill="none" stroke="var(--ink)" stroke-width="4"/>`;
    if (isSel) g += `<circle cx="${x}" cy="${y}" r="${R + 8}" fill="none" stroke="var(--ink)" stroke-width="3" stroke-dasharray="5 4"/>`;
    if (st === "missed") {
      g += `<circle cx="${x}" cy="${y}" r="${R}" fill="url(#miss)" stroke="#a89ca3" stroke-width="2"/>`;
      g += `<path d="M${x - 11} ${y - 11}L${x + 11} ${y + 11}M${x + 11} ${y - 11}L${x - 11} ${y + 11}" stroke="#a89ca3" stroke-width="5" stroke-linecap="round"/>`;
    } else if (st === "filled") {
      g += `<circle cx="${x}" cy="${y}" r="${R}" fill="rgba(255,253,247,.35)" stroke="${col}" stroke-width="2.5"/>`;
    } else if (st === "open") {
      g += `<circle cx="${x}" cy="${y}" r="${R}" fill="var(--paper)" stroke="${col}" stroke-width="3.5"/>`;
      g += `<text x="${x}" y="${y + 6}" text-anchor="middle" style="font:800 17px var(--display);fill:${col}">${SUIT[suitOf(sp)]}</text>`;
    } else {
      g += `<circle cx="${x}" cy="${y}" r="${R}" fill="rgba(255,253,247,.35)" stroke="var(--line)" stroke-width="2.5" stroke-dasharray="5 4" opacity="${st === "skipped" ? 0.45 : 1}"/>`;
      g += `<text x="${x}" y="${y + 5}" text-anchor="middle" style="font:700 14px var(--display);fill:var(--line)">${SUIT[suitOf(sp)]}</text>`;
    }
    if (st === "filled") {
      g += cardSvg(sp.filled, x + 2, y + 6, jitter(sid), { meta: sp.label || shortWhen(sp) || "✓", drop: justPlayed === sid });
      return (g += `</g>`);
    }
    const name = nameOf(sp), short = sp.label ? "" : shortWhen(sp);
    g += `<text class="t-spot" x="${x}" y="${y + R + 19}" text-anchor="middle">${esc(name.length > 16 ? name.slice(0, 15) + "…" : name)}</text>`;
    if (short) g += `<text class="t-when" x="${x}" y="${y + R + 35}" text-anchor="middle">${esc(short)}</text>`;
    g += `</g>`;
  });
  return `<svg id="board" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}
