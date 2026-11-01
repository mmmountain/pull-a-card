// Pure game logic. No React, no network — tested with node.

export const SUIT = { body: "●", home: "■", mind: "▲", work: "◆" };
export const SUITS = ["body", "home", "mind", "work"];

// Dealt from 9:30 PM, takes over the screen at 10:30 PM until you play it.
export const BEDTIME_CARD = { id: "bed", label: "Go to bed", suit: "mind", imm: 5, active: true, plays: 0, quota: { n: 1, per: "day" }, opensAt: "21:30", takeover: "22:30" };

export const SEED_CARDS = [
  { id: "water", label: "Drink water", suit: "body", imm: 5, active: true, plays: 0, lockAt: 3, quota: { n: 8, per: "day" } },
  { id: "squats", label: "squats", amounts: [5, 10, 20], suit: "body", imm: 3, active: true, plays: 0, quota: { n: 50, per: "day" } },
  { id: "clean", label: "Clean for an hour", suit: "home", imm: 1, active: true, plays: 0, quota: { n: 3, per: "week" } },
  BEDTIME_CARD,
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
  const pool = cards.filter((c) => c.active !== false && !ex.has(c.id) && quotaState(c, now, win).open && !notOpenYet(c, now, win) && !(win.plays && bufferBlock(c, win.plays, win.meId, now)));
  if (!pool.length) return null;
  const urgent = pool.find((c) => takeoverActive(c, now, win));
  if (urgent) return urgent;
  // Scheduled deals (win.onlyDue) only happen when some card has fallen at least half a deal behind its pace.
  if (win.onlyDue && !pool.some((k) => isDue(k, now, win))) return null;
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
export const PERIODS = { day: "today", week: "this week", month: "this month", hour: "this hour" };
export const PERIOD_NAMES = { day: "Daily", week: "Weekly", month: "Monthly" };

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
    if (per === "month") d.setUTCDate(1);
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
  if (per === "month") {
    const days = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    return (t.getUTCDate() - 1 + dayFrac) / days;
  }
  return (((t.getUTCDay() + 6) % 7) + dayFrac) / 7;
}

/** Every card has a target. Old cards with only "comes up every N hours" get one worked out from that. */
export function effectiveQuota(card, win = {}) {
  const q = card.quota;
  if (q && q.n > 0 && PERIODS[q.per]) return card.tempo && card.tempo !== 1 ? { ...q, n: Math.max(1, Math.round(q.n * card.tempo)), base: q.n } : q;
  const every = card.every || 4;
  const awake = Math.max(1, (win.endHour ?? 21) - (win.startHour ?? 8));
  const avg = mean(card.amounts) || 1;
  if (every <= awake) return { n: Math.max(1, Math.round(awake / every)) * avg, per: "day" };
  return { n: Math.max(1, Math.round((7 * 24) / every)) * avg, per: "week" };
}
const mean = (xs) => { const v = (xs || []).filter((x) => x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };

/** Rough hours between deals, used for how fast a held card "heats up". */
export function intervalHours(card, win = {}) {
  const q = effectiveQuota(card, win);
  const deals = Math.max(1, q.n / (mean(card.amounts) || 1));
  const awake = Math.max(1, (win.endHour ?? 21) - (win.startHour ?? 8));
  const hours = { hour: 1, day: awake, week: awake * 7, month: awake * 30 }[q.per] || awake;
  return Math.max(0.25, hours / deals);
}

const logAmount = (e) => (typeof e === "string" ? 1 : e?.n || 1);
const logTime = (e) => Date.parse(typeof e === "string" ? e : e?.at);

export function quotaState(card, now = Date.now(), win = {}) {
  const q = effectiveQuota(card, win);
  const since = periodStart(q.per, now, win).getTime();
  const dealt = (card.drawLog || []).filter((e) => { const x = logTime(e); return x >= since && x <= now; }).reduce((a, e) => a + logAmount(e), 0);
  const progress = periodProgress(q.per, now, win);
  const expected = q.n * progress;
  const unit = mean(card.amounts) || 1;
  return { on: true, n: q.n, per: q.per, drawn: dealt, remaining: Math.max(0, q.n - dealt), expected, progress, unit, open: dealt < q.n };
}

/** How many deals behind its pace a card is (negative = ahead). */
export function behindBy(k, now = Date.now(), win = {}) {
  const q = quotaState(k, now, win);
  return (q.expected - q.drawn) / q.unit;
}
export const DUE_AT = 0.5;
/** Due: half a deal behind pace, or anything still owed in the last stretch of the period. */
export function isDue(k, now = Date.now(), win = {}) {
  if (k.dueAt && now >= Date.parse(k.dueAt)) return true; // "not now, bring it back soon"
  if (k.opensAt && !notOpenYet(k, now, win) && quotaState(k, now, win).open) return true; // deal it as soon as it opens
  const q = quotaState(k, now, win);
  return q.open && ((q.expected - q.drawn) / q.unit >= DUE_AT || q.progress >= 0.9);
}

/** Weight for picking: cards further behind pace are much more likely. */
function dueScore(k, now, win) {
  const q = quotaState(k, now, win);
  const opened = k.opensAt && !notOpenYet(k, now, win) && q.open;
  const b = (q.expected - q.drawn) / q.unit + (q.progress >= 0.9 ? q.remaining / q.unit : 0) + (k.dueAt && now >= Date.parse(k.dueAt) ? 4 : 0) + (opened ? 6 : 0);
  return Math.max(0.02, Math.min(20, b >= 0 ? (b + 0.5) ** 2 : Math.exp(b * 3) * 0.25));
}

/** Fields to save on a card when it's dealt. Keeps about five weeks of history (enough for monthly targets). */
export function markDrawn(card, at = new Date().toISOString(), amount = null) {
  const cutoff = Date.parse(at) - 35 * 864e5;
  const log = [...(card.drawLog || []).filter((e) => logTime(e) >= cutoff), { at, n: amount || 1 }].slice(-500);
  return { lastDrawn: at, drawLog: log, dueAt: null };
}

export function quotaLabel(card, now = Date.now(), win = {}) {
  const q = quotaState(card, now, win);
  return `${q.drawn}/${q.n} ${PERIODS[q.per]}`;
}

/** Deal a card: pick an amount (if it has amounts) that moves toward its target without overshooting. */
export function dealFrom(card, now = Date.now(), rand = Math.random, win = {}) {
  const vs = (card.variants || []).filter(Boolean);
  const amounts = (card.amounts || []).filter((x) => x > 0);
  let amount = null;
  if (amounts.length) {
    const q = quotaState(card, now, win);
    const fits = q.on ? amounts.filter((x) => x <= q.remaining) : amounts;
    amount = fits.length ? fits[Math.floor(rand() * fits.length)] : Math.max(1, q.remaining || Math.min(...amounts));
  }
  return {
    cardId: card.id,
    base: card.label,
    label: amountLabel(card.label, amount),
    amount,
    variant: vs.length ? vs[Math.floor(rand() * vs.length)] : "",
    suit: card.suit || "body",
    imm: card.imm || 3,
    beef: card.beef || null,
    every: intervalHours(card, win),
    drawnAt: new Date(now).toISOString(),
  };
}

/** "squats" + 10 → "10 squats"; "Drink # glasses" + 2 → "Drink 2 glasses". */
export function amountLabel(label, amount) {
  if (amount == null) return label;
  return label.includes("#") ? label.replace("#", String(amount)) : `${amount} ${label}`;
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

/** Check times for the next stretch: every `stepMins` inside the waking window [startHour, endHour). */
export function planChecks({ now = new Date(), stepMins = 20, startHour = 8, endHour = 21, hours = 24 }) {
  const out = [];
  const end = now.getTime() + hours * 36e5;
  for (let t = Math.ceil(now.getTime() / (stepMins * 6e4)) * stepMins * 6e4 + 6e4; t < end; t += stepMins * 6e4) {
    const d = new Date(t), h = d.getHours() + d.getMinutes() / 60;
    if (h >= startHour && h < endHour) out.push(d);
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
/** Your cards. Pass `decks` to keep only cards from decks that are switched on (what gets dealt). */
export function myDeck(cards, players, meId, decks = null) {
  const first = firstPlayer(players);
  const mine = cards.filter((c) => (c.owner || first) === meId);
  if (!decks) return mine;
  const on = new Set(myDecks(decks, meId).filter((d) => d.active).map((d) => d.id));
  return mine.filter((c) => on.has(deckOf(c, meId)));
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
    if (!by.has(key)) by.set(key, { key, label: p.base || p.label, suit: p.suit || "body", cards: [], total: 0 });
    const s = by.get(key);
    s.cards.push(p);
    s.label = p.base || p.label;
    s.imm = p.imm;
    if (p.amount) s.total += p.amount;
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
export function drawable(cards, players, hands, tables, meId, decks = null) {
  // Repeats are allowed: a card you're holding can be pulled again. Only the face-up card is out.
  const up = tables?.[meId];
  return myDeck(cards, players, meId, decks || []).filter((c) => c.active !== false && !(up && !up.empty && up.cardId === c.id));
}

/* ---------- lock rule ---------- */
// A card with lockAt = N: while you hold N or more copies of it, it's the only card you can play.
export function activeLocks(cards, hands, meId, now = Date.now(), win = {}) {
  const counts = {};
  for (const h of hands) if (h.seat === meId) counts[h.cardId] = (counts[h.cardId] || 0) + 1;
  const held = cards.filter((c) => c.lockAt > 0 && (counts[c.id] || 0) >= c.lockAt)
    .map((c) => ({ cardId: c.id, label: c.label, count: counts[c.id], lockAt: c.lockAt }));
  const urgent = cards.filter((c) => (!c.owner || c.owner === meId) && takeoverActive(c, now, win))
    .map((c) => ({ cardId: c.id, label: c.label, takeover: c.takeover }));
  return [...urgent, ...held];
}
export function canPlay(locks, cardIds) {
  if (!locks.length) return true;
  const ok = new Set(locks.map((l) => l.cardId));
  return cardIds.length > 0 && cardIds.every((id) => ok.has(id));
}
export function lockMessage(locks) {
  if (!locks.length) return "";
  const t = locks.find((l) => l.takeover);
  if (t) return `It's past ${fmtTime(hmDate(t.takeover))}: ${t.label} is the only card you can play.`;
  const names = locks.map((l) => `${l.count} × ${l.label}`).join(" and ");
  return `Locked: you're holding ${names}. Play ${locks.map((l) => l.label).join(" or ")} first.`;
}

/* ---------- waits between plays ---------- */
// card.buffer = { self, suit, any } in minutes. A card can't be played (or dealt) until
// that long after your last play of: this same card, any card of its suit, or any card at all.
export const BUFFER_STEPS = [[0, "Off"], [15, "15m"], [30, "30m"], [60, "1h"], [120, "2h"], [180, "3h"], [240, "4h"]];
const SUIT_WORD = { body: "body", home: "home", mind: "mind", work: "work" };
export function bufferBlock(card, plays, meId, now = Date.now()) {
  const b = card?.buffer || {};
  if (!(b.self > 0 || b.suit > 0 || b.any > 0)) return null;
  const mine = (plays || []).filter((p) => p.seat === meId && p.at);
  const lastAt = (pred) => mine.reduce((a, p) => (pred(p) && (!a || p.at > a) ? p.at : a), null);
  let best = null;
  for (const [mins, pred, why] of [
    [b.self, (p) => p.cardId === card.id, `since your last ${card.label}`],
    [b.suit, (p) => p.suit === card.suit, `since your last ${SUIT[card.suit] || ""} ${SUIT_WORD[card.suit] || ""} card`],
    [b.any, () => true, "since your last card"],
  ]) {
    if (!(mins > 0)) continue;
    const at = lastAt(pred);
    if (!at) continue;
    const until = Date.parse(at) + mins * 6e4;
    if (until > now && (!best || until > best.until)) best = { until, mins, why };
  }
  return best;
}
export function bufferMessage(block) {
  if (!block) return "";
  const m = block.mins, span = m >= 60 ? `${+(m / 60).toFixed(1)} h` : `${m} min`;
  return `Ready at ${fmtTime(new Date(block.until))} (${span} ${block.why}).`;
}

/* ---------- swiping the top card ---------- */
// Up/down picks the action, leaning right means "sooner / more", leaning left "later / less".
//   up: play (lean = how often it should come)   down: hold (lean = when to remind you)
//   right: not now, back in 30 min               left: too soon, a bit less often
export function swipeIntent(dx, dy, min = 80) {
  if (Math.hypot(dx, dy) < min) return null;
  const a = (Math.atan2(dx, -dy) * 180) / Math.PI; // 0 = up, 90 = right, ±180 = down
  const lean = (x) => (Math.abs(x) < 0.12 ? 0 : Math.max(-1, Math.min(1, x)));
  if (Math.abs(a) <= 60) return { kind: "play", tilt: lean(a / 55) };
  if (Math.abs(a) >= 120) return { kind: "hold", tilt: lean((a > 0 ? 180 - a : -(180 + a)) / 55) };
  return a > 0 ? { kind: "soon", tilt: 0 } : { kind: "later", tilt: 0 };
}
export function swipeLabel(it) {
  if (!it) return "";
  const amt = Math.abs(it.tilt) > 0.55 ? "" : "a bit ";
  if (it.kind === "play") return it.tilt > 0 ? `Play · ${amt}more often` : it.tilt < 0 ? `Play · ${amt}less often` : "Play";
  if (it.kind === "hold") return it.tilt > 0 ? "Hold · remind me in 1 h" : it.tilt < 0 ? "Hold · remind me tonight" : "Hold";
  return it.kind === "soon" ? "Not now · back in 30 min" : "Too soon · less often";
}
/** How a swipe changes the card's pace: up to ±15% per play swipe, −10% for "too soon". Stays within ½× to 2×. */
export function nudgedTempo(tempo, it) {
  const d = it.kind === "play" ? it.tilt * 0.15 : it.kind === "later" ? -0.1 : 0;
  return Math.round(Math.max(0.5, Math.min(2, (tempo || 1) * (1 + d))) * 100) / 100;
}
export function holdReminder(it, now = new Date()) {
  if (it.kind !== "hold" || !it.tilt) return null;
  if (it.tilt > 0) return new Date(now.getTime() + 60 * 6e4);
  const t = new Date(now); t.setHours(20, 0, 0, 0);
  return t.getTime() - now.getTime() > 30 * 6e4 ? t : new Date(now.getTime() + 2 * 36e5);
}

/* ---------- card timing: when it can be dealt, when it takes over the screen ---------- */
// card.opensAt / card.takeover are "HH:MM" on the player's clock.
export const hmMinutes = (hm) => (hm ? +hm.slice(0, 2) * 60 + +hm.slice(3, 5) : null);
export const hmDate = (hm, now = new Date()) => { const d = new Date(now); d.setHours(+hm.slice(0, 2), +hm.slice(3, 5), 0, 0); return d; };
export const toHM = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
function localMinutes(now, win = {}) {
  const t = new Date(now + tzOffsetMs(now, win.tz));
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}
export function notOpenYet(card, now = Date.now(), win = {}) {
  return !!card.opensAt && localMinutes(now, win) < hmMinutes(card.opensAt);
}
/** Past its takeover time today and still owed: it's the only card you can play. */
export function takeoverActive(card, now = Date.now(), win = {}) {
  return !!card.takeover && card.active !== false && localMinutes(now, win) >= hmMinutes(card.takeover) && !playedToday(card, now, win);
}
/** Played since midnight (on the player's clock)? Dealing or holding it doesn't count. */
export function playedToday(card, now = Date.now(), win = {}) {
  return !!card.lastPlayed && Date.parse(card.lastPlayed) >= periodStart("day", now, win).getTime();
}

/* ---------- several decks ---------- */
// Deck docs live in the "decks" collection: { owner, name, active, key? }. Cards carry card.deck.
// Cards with no deck belong to your Everyday deck, which exists even before it has a doc.
export const everydayId = (meId) => meId + ":everyday";
export const deckOf = (card, meId) => card.deck || everydayId(meId);
export function myDecks(decks, meId) {
  const mine = (decks || []).filter((d) => d.owner === meId);
  const list = mine.some((d) => d.id === everydayId(meId)) ? [] : [{ id: everydayId(meId), owner: meId, name: "Everyday", active: true }];
  return [...list, ...mine].map((d) => ({ ...d, active: d.active !== false }));
}

/** Ready-made decks you can add from the library. Targets are per day or week; tweak them after adding. */
export const DECK_LIBRARY = [
  {
    key: "powerlifting",
    name: "Powerlifting sprint",
    about: "A month of squat, bench and deadlift with accessories, cardio, fuel and recovery. Body is training, home is fuel, mind is recovery, work is tracking.",
    cards: [
      { key: "squat", label: "Squat 5×5", suit: "body", imm: 3, quota: { n: 1, per: "week" }, tonnage: 5625 },
      { key: "bench", label: "Bench 5×5", suit: "body", imm: 3, quota: { n: 1, per: "week" }, tonnage: 4125 },
      { key: "dead", label: "Deadlift 3×5", suit: "body", imm: 3, quota: { n: 1, per: "week" }, tonnage: 4125 },
      { key: "pull", label: "Pull-ups", suit: "body", imm: 2, quota: { n: 1, per: "week" } },
      { key: "row", label: "Barbell rows 4×8", suit: "body", imm: 2, quota: { n: 1, per: "week" } },
      { key: "lunge", label: "Walking lunges", suit: "body", imm: 2, quota: { n: 1, per: "week" } },
      { key: "core", label: "Core circuit", suit: "body", imm: 2, quota: { n: 1, per: "week" } },
      { key: "z2", label: "Zone 2 cardio 30 min", suit: "body", imm: 2, quota: { n: 2, per: "week" } },
      { key: "protein", label: "g protein", amounts: [20, 30, 40], suit: "home", imm: 4, quota: { n: 160, per: "day" }, buffer: { self: 120 } },
      { key: "water", label: "ml water", amounts: [250, 500], suit: "home", imm: 4, quota: { n: 3000, per: "day" }, buffer: { self: 30 } },
      { key: "creatine", label: "Creatine 5 g", suit: "home", imm: 2, quota: { n: 1, per: "day" } },
      { key: "stretch", label: "Stretch 10 min", suit: "mind", imm: 2, quota: { n: 1, per: "day" } },
      { key: "roll", label: "Foam roll", suit: "mind", imm: 2, quota: { n: 3, per: "week" } },
      { key: "breath", label: "Breathing 5 min", suit: "mind", imm: 2, quota: { n: 1, per: "day" } },
      { key: "heat", label: "Hot shower or sauna", suit: "mind", imm: 1, quota: { n: 3, per: "week" }, opensAt: "17:00" },
      { key: "weigh", label: "Weigh in", suit: "work", imm: 3, quota: { n: 1, per: "week" } },
      { key: "log", label: "Log the session", suit: "work", imm: 2, quota: { n: 1, per: "week" } },
      { key: "rm_s", label: "Squat 1-rep max", suit: "body", imm: 3, quota: { n: 1, per: "month" } },
      { key: "rm_b", label: "Bench 1-rep max", suit: "body", imm: 3, quota: { n: 1, per: "month" } },
      { key: "rm_d", label: "Deadlift 1-rep max", suit: "body", imm: 3, quota: { n: 1, per: "month" } },
    ],
  },
  {
    key: "mindful",
    name: "Mindful day",
    about: "Slow, offline things: sitting, journaling, walking, reading. Goes with the Mindful day map.",
    cards: [
      { key: "meditate", label: "Meditate 10 min", suit: "mind", imm: 3, quota: { n: 1, per: "day" } },
      { key: "journal", label: "Journal one page", suit: "mind", imm: 2, quota: { n: 1, per: "day" } },
      { key: "tea", label: "Tea and nothing else", suit: "home", imm: 2, quota: { n: 1, per: "day" } },
      { key: "walk", label: "Walk outside 20 min", suit: "body", imm: 3, quota: { n: 1, per: "day" } },
      { key: "phone", label: "Phone in a drawer for an hour", suit: "mind", imm: 3, quota: { n: 2, per: "day" }, buffer: { self: 180 } },
      { key: "stretch", label: "Slow stretch", suit: "body", imm: 2, quota: { n: 1, per: "day" } },
      { key: "read", label: "Read 20 min", suit: "mind", imm: 2, quota: { n: 1, per: "day" } },
      { key: "gratitude", label: "Write three good things", suit: "mind", imm: 2, quota: { n: 1, per: "day" } },
    ],
  },
];
