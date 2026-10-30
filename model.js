// Pure game logic. No React, no network — tested with node.

export const SUIT = { body: "●", home: "■", mind: "▲", work: "◆" };
export const SUITS = ["body", "home", "mind", "work"];

export const SEED_CARDS = [
  { id: "water", label: "Drink water", variants: [], suit: "body", every: 1.5, imm: 5, active: true, plays: 0 },
  { id: "squats", label: "10 squats", variants: [], suit: "body", every: 4, imm: 3, active: true, plays: 0 },
  { id: "clean", label: "Clean for an hour", variants: [], suit: "home", every: 48, imm: 1, active: true, plays: 0 },
];

export const hoursSince = (ts, now = Date.now()) => (ts ? (now - Date.parse(ts)) / 36e5 : 999);

export function ago(ts, now = Date.now()) {
  const h = hoursSince(ts, now);
  if (h < 1) return Math.max(1, Math.round(h * 60)) + "m";
  if (h < 48) return Math.round(h) + "h";
  return Math.round(h / 24) + "d";
}

/** Same weighting as the web page: overdue × immediacy, flattened by chaos. */
export function pickCard(cards, excludeIds, chaos, now = Date.now(), rand = Math.random) {
  const ex = new Set(excludeIds);
  const pool = cards.filter((c) => c.active !== false && !ex.has(c.id));
  if (!pool.length) return null;
  const c = chaos / 100;
  const scored = pool.map((k) => ({
    k,
    d: Math.max(0.05, hoursSince(k.lastDrawn, now) / (k.every || 4)) * (1 + ((k.imm || 3) - 1) * 0.2),
  }));
  if (c < 0.05) return scored.sort((a, b) => b.d - a.d)[0].k;
  const exp = (1 - c) * 4;
  const w = scored.map((s) => Math.pow(Math.min(s.d, 20), exp));
  let r = rand() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r <= 0) return scored[i].k;
  }
  return scored[scored.length - 1].k;
}

export function dealFrom(card, now = Date.now(), rand = Math.random) {
  const vs = (card.variants || []).filter(Boolean);
  return {
    cardId: card.id,
    label: card.label,
    variant: vs.length ? vs[Math.floor(rand() * vs.length)] : "",
    suit: card.suit || "body",
    imm: card.imm || 3,
    every: card.every || 4,
    drawnAt: new Date(now).toISOString(),
  };
}

export function cardLine(t) {
  return `${SUIT[t.suit] || "●"} ${t.label}${t.variant ? " — " + t.variant : ""}`;
}

/** How "hot" a held card is, from how long it has sat versus its immediacy. */
export function heat(h, now = Date.now()) {
  const a = hoursSince(h.heldAt, now);
  const lim = ((h.every || 4) * (6 - (h.imm || 3))) / 2;
  return a > lim ? "hot" : a > lim / 2 ? "warm" : "";
}

/** Seat order = join order. Returns {turn, active} after `who` moves. */
export function nextTurn(players, game, who) {
  const order = [...players].sort((a, b) => (a.joined || "").localeCompare(b.joined || "")).map((p) => p.id);
  if (!order.length) return game;
  const i = order.indexOf(who);
  if (i < 0) return game;
  const next = order[(i + 1) % order.length];
  const turn = i + 1 >= order.length ? (game.turn || 1) + 1 : game.turn || 1;
  return { turn, active: next };
}

/**
 * Parse "3pm", "3:30 pm", "15:30", "830", "in 2h", "in 45m", "+1h" into a Date today.
 * Returns null if unparseable. Bare hours 1-7 without am/pm are read as pm.
 */
export function parseLater(text, now = new Date()) {
  if (!text) return null;
  let s = String(text).trim().toLowerCase().replace(/\s+/g, " ");
  if (s === "noon") s = "12pm";
  const rel = s.match(/^(?:in |\+)?(\d+(?:\.\d+)?) ?(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/);
  if (rel && (s.startsWith("in") || s.startsWith("+") || /[a-z]/.test(s))) {
    const n = parseFloat(rel[1]);
    const ms = rel[2].startsWith("h") ? n * 36e5 : n * 6e4;
    return new Date(now.getTime() + ms);
  }
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))? ?(am|pm|a|p)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3];
  if (min > 59 || h > 23) return null;
  if (ap) {
    if (h > 12) return null;
    if (ap.startsWith("p") && h < 12) h += 12;
    if (ap.startsWith("a") && h === 12) h = 0;
  } else if (h >= 1 && h <= 7) {
    h += 12;
  }
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  return d;
}

export function fmtTime(d) {
  const dt = d instanceof Date ? d : new Date(d);
  let h = dt.getHours();
  const m = dt.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

/**
 * Plan the next deal times. Base gap = everyMins; chaos widens the jitter
 * (0 = clockwork, 100 = anywhere from 25% to 175% of the gap).
 * Deals only land inside the waking window [startHour, endHour).
 */
export function planDealTimes({ now = new Date(), everyMins = 120, chaos = 30, startHour = 8, endHour = 21, count = 8, rand = Math.random }) {
  const out = [];
  let t = new Date(now);
  const jitter = (chaos / 100) * 0.75;
  let guard = 0;
  while (out.length < count && guard++ < 200) {
    const gap = everyMins * (1 + (rand() * 2 - 1) * jitter);
    t = new Date(t.getTime() + Math.max(10, gap) * 6e4);
    const h = t.getHours() + t.getMinutes() / 60;
    if (h < startHour) {
      t.setHours(startHour, Math.floor(rand() * 20), 0, 0);
    } else if (h >= endHour) {
      t.setDate(t.getDate() + 1);
      t.setHours(startHour, Math.floor(rand() * 20), 0, 0);
    }
    out.push(new Date(t));
  }
  return out;
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
