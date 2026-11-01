// Pure game logic. No React, no network — tested with node.

export const SUIT = { body: "●", home: "■", mind: "▲", work: "◆" };
export const SUITS = ["body", "home", "mind", "work"];

export const SEED_CARDS = [
  { id: "water", label: "Drink water", variants: [], suit: "body", every: 1.5, imm: 5, active: true, plays: 0, lockAt: 3 },
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
export function pickCard(cards, excludeIds, chaos, now = Date.now(), rand = Math.random, win = {}) {
  const ex = new Set(excludeIds);
  const pool = cards.filter((c) => c.active !== false && !ex.has(c.id) && quotaState(c, now, win).open);
  if (!pool.length) return null;
  const c = chaos / 100;
  const scored = pool.map((k) => ({ k, d: dueScore(k, now, win) * (1 + ((k.imm || 3) - 1) * 0.2) }));
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

/* ---------- quotas: exactly N per hour / day / week ---------- */
// card.quota = { n, per: "hour" | "day" | "week" }. Counts how many times the card was dealt.
export const PERIODS = { hour: "this hour", day: "today", week: "this week" };

// Period math runs on the player's clock. Phones use their own time zone;
// the server dealer passes win.tz (e.g. "America/Chicago").
function tzOffsetMs(now, tz) {
  if (!tz) return -new Date(now).getTimezoneOffset() * 6e4;
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(now / 1000) * 1000;
  } catch { return -new Date(now).getTimezoneOffset() * 6e4; }
}

export function periodStart(per, now = Date.now(), win = {}) {
  const off = tzOffsetMs(now, win.tz);
  const d = new Date(now + off); // UTC fields of d = local wall clock
  if (per === "hour") d.setUTCMinutes(0, 0, 0);
  else {
    d.setUTCHours(0, 0, 0, 0);
    if (per === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // weeks start Monday
  }
  return new Date(d.getTime() - off);
}

/** How far through the period we are, 0..1. Days and weeks only count waking hours. */
function periodProgress(per, now, win) {
  const t = new Date(now + tzOffsetMs(now, win.tz));
  if (per === "hour") return t.getUTCMinutes() / 60;
  const start = win.startHour ?? 8, end = win.endHour ?? 21;
  const h = t.getUTCHours() + t.getUTCMinutes() / 60;
  const dayFrac = Math.min(1, Math.max(0, (h - start) / Math.max(1, end - start)));
  if (per === "day") return dayFrac;
  return (((t.getUTCDay() + 6) % 7) + dayFrac) / 7;
}

export function quotaState(card, now = Date.now(), win = {}) {
  const q = card.quota;
  if (!q || !(q.n > 0) || !PERIODS[q.per]) return { open: true, on: false };
  const since = periodStart(q.per, now, win).getTime();
  const drawn = (card.drawLog || []).filter((ts) => { const x = Date.parse(ts); return x >= since && x <= now; }).length;
  const expected = q.n * periodProgress(q.per, now, win);
  return { on: true, n: q.n, per: q.per, drawn, remaining: Math.max(0, q.n - drawn), expected, open: drawn < q.n };
}

/** How overdue a card is. Quota cards are paced to land exactly N in the period. */
function dueScore(k, now, win) {
  const q = quotaState(k, now, win);
  if (q.on) {
    const behind = q.expected - q.drawn; // > 0 means behind pace
    return Math.max(0.05, Math.min(20, behind >= 0 ? 1 + behind * 3 : Math.exp(behind * 2)));
  }
  return Math.max(0.05, hoursSince(k.lastDrawn, now) / (k.every || 4));
}

/** Fields to save on a card when it's dealt. Keeps about a week of history. */
export function markDrawn(card, at = new Date().toISOString()) {
  const cutoff = Date.parse(at) - 8 * 864e5;
  const log = [...(card.drawLog || []).filter((ts) => Date.parse(ts) >= cutoff), at].slice(-300);
  return { lastDrawn: at, drawLog: log };
}

export function quotaLabel(card, now = Date.now(), win = {}) {
  const q = quotaState(card, now, win);
  return q.on ? `${q.drawn}/${q.n} ${PERIODS[q.per]}` : "";
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

/* ---------- personal decks ---------- */
// A card belongs to card.owner. Cards from before decks were personal have no owner;
// they belong to whoever sat at the table first.
const firstPlayer = (players) => [...(players || [])].sort((a, b) => (a.joined || "").localeCompare(b.joined || ""))[0]?.id;
export function deckOwner(card, players) {
  return card.owner || firstPlayer(players);
}
export function myDeck(cards, players, meId) {
  const first = firstPlayer(players);
  return cards.filter((c) => (c.owner || first) === meId);
}
export function myChaos(players, meId, fallback = 30) {
  const p = (players || []).find((x) => x.id === meId);
  return typeof p?.chaos === "number" ? p.chaos : fallback;
}

/* ---------- table stacks ---------- */
// Plays of the same card (any variation) stack together, Solitaire-style.
// Stacks are grouped by suit, then ordered by label.
export function stackPlays(plays) {
  const by = new Map();
  for (const p of [...plays].sort((a, b) => (a.at || "").localeCompare(b.at || ""))) {
    const key = p.cardId || (p.label || "").toLowerCase();
    if (!by.has(key)) by.set(key, { key, label: p.label, suit: p.suit || "body", cards: [] });
    const s = by.get(key);
    s.cards.push(p);
    s.label = p.label;
    s.imm = p.imm;
  }
  return [...by.values()].sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || a.label.localeCompare(b.label));
}

/** The most recent move: one play, or every card played together with it. */
export function lastMove(plays) {
  const last = plays.reduce((a, p) => (!a || p.at > a.at ? p : a), null);
  if (!last) return [];
  return last.combo ? plays.filter((p) => p.combo === last.combo) : [last];
}

/** Cards you could pull right now: your active cards not already in a hand or face up. */
export function drawable(cards, players, hands, tables, meId) {
  // Repeats are allowed: a card you're holding can be pulled again. Only the face-up card is out.
  const up = tables?.[meId];
  return myDeck(cards, players, meId).filter((c) => c.active !== false && !(up && !up.empty && up.cardId === c.id));
}

/* ---------- lock rule ---------- */
// A card with lockAt = N: while you hold N or more copies of it, it's the only card you can play.
export function activeLocks(cards, hands, meId) {
  const counts = {};
  for (const h of hands) if (h.seat === meId) counts[h.cardId] = (counts[h.cardId] || 0) + 1;
  return cards.filter((c) => c.lockAt > 0 && (counts[c.id] || 0) >= c.lockAt)
    .map((c) => ({ cardId: c.id, label: c.label, count: counts[c.id], lockAt: c.lockAt }));
}
export function canPlay(locks, cardIds) {
  if (!locks.length) return true;
  const ok = new Set(locks.map((l) => l.cardId));
  return cardIds.length > 0 && cardIds.every((id) => ok.has(id));
}
export function lockMessage(locks) {
  if (!locks.length) return "";
  const names = locks.map((l) => `${l.count} × ${l.label}`).join(" and ");
  return `Locked: you're holding ${names}. Play ${locks.map((l) => l.label).join(" or ")} first.`;
}
