// Prompt — maps. Shared by the Android app and the web app (CI copies this file into web/).
// A map is a free-form board of shapes (rings, paths, pools) with spots. Each spot takes a kind of card
// during a time window. Maps repeat every day, week or month ("rounds"); a new round starts empty.
//
// Map doc (collection "maps"): { owner, name, key, deck, per, active, since, round, W, H, shapes: [...], spots: { id: spot } }
// Shape: { id, kind: "ring"|"path"|"pool", label, sub, cx, cy, rx, ry, rot, ordered, spots: [spotId] }
// Spot:  { id, shape, i, label, accepts: "any"|"suit:x"|"card:<cardId>", when, auto, target, unit,
//          filled: { card, label, at }, total, pile: [{ card, label }], dealtMiss }

export const SUIT_NAMES = { body: "Body", home: "Home", mind: "Mind", work: "Work" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYRX = [/\bsun(day)?s?\b/, /\bmon(day)?s?\b/, /\btue?s?(day)?s?\b/, /\bwed(nesday)?s?\b/, /\bthu(rs?)?(day)?s?\b/, /\bfri(day)?s?\b/, /\bsat(urday)?s?\b/];
export const DAYNAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY = 864e5;

/* ---------- time windows typed in plain words ---------- */
/** "8:30 to 10:30 pm", "10 to 1pm", "mon wed fri 5-8pm", "week 2 thu", "day 3 after 6pm", "nov 9", "always" */
export function parseWhen(raw) {
  const s = String(raw || "").toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  const w = { text: raw || "", always: false, days: null, date: null, week: null, day: null, from: null, to: null };
  if (!s || /^(always|any ?time|all (day|week|month)|whole (time|day|week|month))$/.test(s)) { w.always = true; return finish(w); }
  let rest = s;
  const dm = rest.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(st|nd|rd|th)?\b/);
  if (dm) { w.date = { m: MONTHS.indexOf(dm[1]), d: +dm[2] }; rest = rest.replace(dm[0], " "); }
  const wk = rest.match(/\bweek (\d)\b/);
  if (wk) { w.week = +wk[1]; rest = rest.replace(wk[0], " "); }
  const dn = rest.match(/\bday (\d{1,2})\b/);
  if (dn) { w.day = +dn[1]; rest = rest.replace(dn[0], " "); }
  if (/\bweekdays?\b/.test(rest)) { w.days = [1, 2, 3, 4, 5]; rest = rest.replace(/\bweekdays?\b/, " "); }
  else if (/\bweekends?\b/.test(rest)) { w.days = [6, 0]; rest = rest.replace(/\bweekends?\b/, " "); }
  else {
    const ds = DAYRX.map((rx, i) => (rx.test(rest) ? i : -1)).filter((i) => i >= 0);
    if (ds.length) { w.days = ds.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); DAYRX.forEach((rx) => { rest = rest.replace(rx, " "); }); }
  }
  rest = rest.replace(/\b(daily|every ?day|each day|on|at|from|and|&)\b/g, " ").replace(/,/g, " ");
  const T = "(\\d{1,4})(?::(\\d{2}))?\\s*(a|p)?\\.?m?\\.?";
  const range = rest.match(new RegExp(`${T}\\s*(?:-|to|until|till|through)\\s*${T}`));
  const pick = (h, m) => { h = +h; if (h >= 100 && m == null) { m = h % 100; h = Math.floor(h / 100); } return [h, +(m || 0)]; };
  if (range) {
    const [h1, m1] = pick(range[1], range[2]), [h2, m2] = pick(range[4], range[5]);
    const r = inferRange(h1, m1, range[3], h2, m2, range[6]);
    if (!r) return finish({ ...w, bad: "That range has to end after it starts, on the same day." });
    [w.from, w.to] = r;
    rest = rest.replace(range[0], " ");
  } else {
    const one = rest.match(new RegExp(`\\b(after|before|by)?\\s*${T}`));
    if (one && /\d/.test(one[0])) {
      const [h, m] = pick(one[2], one[3]);
      const t = to24(h, m, one[4]) ?? guess(h, m);
      if (t == null) return finish({ ...w, bad: "I couldn't read that time." });
      if (one[1] === "after") { w.from = t; w.to = 24 * 60; }
      else if (one[1] === "before" || one[1] === "by") { w.from = 0; w.to = t; }
      else { w.from = t; w.to = Math.min(24 * 60, t + 60); }
      rest = rest.replace(one[0], " ");
    }
  }
  if (rest.replace(/[^a-z0-9]/g, "")) return finish({ ...w, bad: `I didn't understand “${rest.trim()}”.` });
  return finish(w);
}
function to24(h, m, ap) {
  if (h > 23 || m > 59) return null;
  if (!ap) return h > 12 ? h * 60 + m : null;
  if (h > 12) return null;
  return ((h % 12) + (ap === "p" ? 12 : 0)) * 60 + m;
}
const guess = (h, m) => (h > 23 ? null : (h <= 6 ? h + 12 : h) * 60 + m); // 1–6 without am/pm reads as pm
function inferRange(h1, m1, a1, h2, m2, a2) {
  let s = to24(h1, m1, a1), e = to24(h2, m2, a2);
  if (s == null && e != null) { s = to24(h1, m1, a2) ?? to24(h1, m1, null); if (s == null || s >= e) s = to24(h1, m1, a2 === "p" ? "a" : "p"); }
  else if (e == null && s != null) { e = to24(h2, m2, a1) ?? to24(h2, m2, null); if (e == null || e <= s) e = to24(h2, m2, a1 === "a" ? "p" : "a"); }
  else if (s == null && e == null) { s = guess(h1, m1); e = guess(h2, m2); if (e != null && s != null && e <= s) e += 12 * 60; }
  if (s == null || e == null || e <= s || e > 24 * 60) return null;
  return [s, e];
}
export const fmtMin = (t) => { const h = Math.floor(t / 60) % 24, m = t % 60; return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h >= 12 ? "PM" : "AM"}`; };
function finish(w) {
  if (w.bad) { w.label = w.bad; return w; }
  const parts = [];
  if (w.always) parts.push("Any time");
  if (w.date) parts.push(`${MONTHS[w.date.m][0].toUpperCase() + MONTHS[w.date.m].slice(1)} ${w.date.d}`);
  if (w.week) parts.push(`Week ${w.week}`);
  if (w.day) parts.push(`Day ${w.day}`);
  if (w.days) parts.push(w.days.join() === "1,2,3,4,5" ? "Weekdays" : w.days.join() === "6,0" ? "Weekends" : w.days.map((d) => DAYNAME[d]).join(", "));
  if (w.from != null) parts.push(`${fmtMin(w.from)} – ${fmtMin(w.to)}`);
  else if (!w.always && !parts.length) parts.push("All day");
  w.label = parts.join(" · ");
  return w;
}

/* ---------- rounds: a day, week (from Monday), month, or every N days ---------- */
// `per` is "day" | "week" | "month", or a map / { per, days, startAt, startHour }:
//   per "days" repeats every `days` days counted from `startAt`; `startHour` moves when a day begins (4 = 4 AM).
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const cyc = (p) => (p && typeof p === "object"
  ? { per: p.per || "week", days: Math.max(1, Math.round(+p.days || 1)), startAt: p.startAt || null, startHour: Math.max(0, Math.min(23, +p.startHour || 0)) }
  : { per: p || "week", days: 1, startAt: null, startHour: 0 });
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
export function roundStart(per, now = Date.now()) {
  const c = cyc(per);
  const t = new Date(now - c.startHour * 36e5);
  let d = midnight(t);
  if (c.per === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  else if (c.per === "month") d.setDate(1);
  else if (c.per === "days") {
    const ds = /^(\d{4})-(\d{2})-(\d{2})/.exec(c.startAt || "");
    const anchor = ds ? new Date(+ds[1], +ds[2] - 1, +ds[3]) : new Date(2026, 0, 5); // a local date, "YYYY-MM-DD"
    const gone = Math.round((d - anchor) / DAY);
    d = addDays(anchor, Math.floor(gone / c.days) * c.days);
  }
  d.setHours(c.startHour);
  return d;
}
export function roundEnd(per, now = Date.now()) {
  const c = cyc(per), d = roundStart(per, now);
  if (c.per === "day") return addDays(d, 1);
  if (c.per === "week") return addDays(d, 7);
  if (c.per === "days") return addDays(d, c.days);
  const e = new Date(d); e.setMonth(e.getMonth() + 1); return e;
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const roundKey = (per, now = Date.now()) => { const c = cyc(per); return ymd(roundStart(per, now)) + (c.per === "days" ? "+" + c.days : "") + (c.startHour ? "@" + c.startHour : ""); };
export const PER_NAMES = { day: "Daily", week: "Weekly", month: "Monthly", days: "Every few days" };
/** "Daily", "Every 10 days", "Weekly · from 4 AM" */
export function perLabel(m) {
  const c = cyc(m);
  const base = c.per === "days" ? (c.days === 1 ? "Daily" : `Every ${c.days} days`) : PER_NAMES[c.per] || "Weekly";
  return base + (c.startHour ? " · from " + fmtMin(c.startHour * 60) : "");
}

/** The map as it is this round: a new round starts with every spot empty. */
export function live(map, now = Date.now()) {
  if (map.round === roundKey(map, now)) return map;
  const spots = {};
  for (const [id, sp] of Object.entries(map.spots || {})) { const { filled, total, pile, dealtMiss, ...rest } = sp; spots[id] = rest; }
  return { ...map, round: roundKey(map, now), spots, fresh: true };
}

/** When this window is open inside the current round: a list of [startMs, endMs]. */
export function occurrences(w, per, now = Date.now()) {
  if (w.bad) return [];
  const start = roundStart(per, now), end = roundEnd(per, now), sh = cyc(per).startHour;
  if (w.always) return [[start.getTime(), end.getTime()]];
  const out = [];
  for (let d = midnight(start), i = 1; d < end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), i++) {
    if (w.date && !(d.getMonth() === w.date.m && d.getDate() === w.date.d)) continue;
    if (w.day && i !== w.day) continue;
    if (w.week && Math.ceil(i / 7) !== w.week) continue;
    if (w.days && !w.days.includes(d.getDay())) continue;
    // With a late day start (say 4 AM), times before it belong to the early hours after midnight.
    const from = w.from ?? sh * 60, to = w.to ?? (sh ? 1440 + sh * 60 : 1440);
    const shift = sh && w.from != null && w.from < sh * 60 ? 1 : 0;
    const at = (min) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + shift, 0, min).getTime(); // calendar math, safe across DST
    const a = Math.max(start.getTime(), at(from)), b = Math.min(end.getTime(), at(to));
    if (a < b) out.push([a, b]);
  }
  return out;
}

/* ---------- geometry ---------- */
export function spotPos(shape, i) {
  const n = shape.spots.length, r = ((shape.rot || 0) * Math.PI) / 180;
  let lx, ly;
  if (shape.kind === "path") { lx = n === 1 ? 0 : -shape.rx + (2 * shape.rx * i) / (n - 1); ly = 0; }
  else if (shape.kind === "pool") { lx = 0; ly = 0; }
  else { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; lx = shape.rx * Math.cos(a); ly = shape.ry * Math.sin(a); }
  return [shape.cx + lx * Math.cos(r) - ly * Math.sin(r), shape.cy + lx * Math.sin(r) + ly * Math.cos(r)];
}
/** Line segments of a shape's outline, for drawing. */
export function shapeEdges(shape) {
  if (shape.kind === "pool") return [];
  const pts = shape.spots.map((_, i) => spotPos(shape, i));
  const edges = [];
  for (let i = 0; i < pts.length - 1; i++) edges.push([pts[i], pts[i + 1]]);
  if (shape.kind === "ring" && pts.length > 2) edges.push([pts[pts.length - 1], pts[0]]);
  return edges;
}

/* ---------- rules: what can go where ---------- */
export function accepts(spot, card) {
  if (!card) return false;
  if (spot.accepts === "any") return true;
  if (spot.accepts.startsWith("suit:")) return card.suit === spot.accepts.slice(5);
  // A card standing in for another deck's copy (see coverage in model.js) also fills that card's spots.
  return spot.accepts === "card:" + (card.cardId || card.id) || (card.covers || []).includes(spot.accepts.slice(5));
}
/** open | future | waiting | missed | skipped (before you added the map) | filled | full */
export function spotState(map, spot, now = Date.now()) {
  const shape = map.shapes.find((s) => s.id === spot.shape);
  const occ = occurrences(parseWhen(spot.when), map, now);
  const isOpen = occ.some(([a, b]) => now >= a && now < b);
  if (shape?.kind === "pool") return spot.target && (spot.total || 0) >= spot.target ? "full" : isOpen ? "open" : "future";
  if (spot.filled) return "filled";
  if (!isOpen) {
    if (occ.some(([a]) => a > now)) return "future";
    const since = map.since ? Date.parse(map.since) : 0;
    return occ.length && occ.every(([, b]) => b <= since) ? "skipped" : "missed";
  }
  if (shape?.ordered) {
    for (let j = 0; j < spot.i; j++) {
      const st = spotState(map, map.spots[shape.spots[j]], now);
      if (st === "open" || st === "future" || st === "waiting") return "waiting";
    }
  }
  return "open";
}
export const canPlayAt = (map, spot, card, now = Date.now()) => !spot.auto && accepts(spot, card) && spotState(map, spot, now) === "open";
const rank = (sp) => (sp.accepts.startsWith("card:") ? 0 : sp.accepts.startsWith("suit:") ? 1 : 2);
/** Every open spot (across active maps) this card fits, best first: exact card, then suit, then any card. */
export function fitsSpots(maps, card, now = Date.now()) {
  const out = [];
  for (const m0 of maps) {
    if (m0.active === false) continue;
    const m = live(m0, now);
    for (const sh of m.shapes) for (const sid of sh.spots) {
      const sp = m.spots[sid];
      if (canPlayAt(m, sp, card, now)) out.push({ map: m, spot: sp, shape: sh });
    }
  }
  return out.sort((a, b) => rank(a.spot) - rank(b.spot) || (a.shape.kind === "pool") - (b.shape.kind === "pool"));
}

/** Put a played card on a spot. Returns the new map. Lifting cards with a `tonnage` also feed auto pools in lb. */
export function placeCard(map, spotId, t, card = {}, now = Date.now()) {
  const m = live(map, now);
  const spots = { ...m.spots };
  const sp = { ...spots[spotId] };
  const sh = m.shapes.find((s) => s.id === sp.shape);
  const entry = { card: t.cardId, label: t.label, suit: t.suit, at: new Date(now).toISOString() };
  if (sh.kind === "pool") {
    sp.total = (sp.total || 0) + (t.amount ?? t.each ?? 1);
    sp.pile = [...(sp.pile || []), entry];
  } else sp.filled = entry;
  spots[spotId] = sp;
  if (card.tonnage) for (const [id, s] of Object.entries(spots)) {
    if (s.auto && s.unit === "lb" && accepts(s, t)) spots[id] = { ...s, total: (s.total || 0) + card.tonnage, pile: [...(s.pile || []), entry] };
  }
  const { fresh, ...rest } = m;
  return { ...rest, spots };
}

/** Spots that were just missed and should hand you their card. */
export function newlyMissed(map, now = Date.now()) {
  const m = live(map, now);
  return Object.values(m.spots).filter((sp) => !sp.dealtMiss && sp.accepts.startsWith("card:") && spotState(m, sp, now) === "missed");
}

export const amountText = (spot) => {
  const t = spot.total || 0, u = spot.unit || "";
  if (u === "ml") return `${+(t / 1000).toFixed(2)} / ${spot.target / 1000} L`;
  if (u === "lb" && spot.target >= 10000) return `${Math.round(t / 100) / 10}k / ${spot.target / 1000}k lb`;
  return spot.target ? `${t} / ${spot.target}${u ? " " + u : ""}` : `${t}${u ? " " + u : ""}`;
};
export function describeAccepts(spot, cards) {
  if (spot.auto) return "Fills on its own";
  if (spot.accepts === "any") return "Any card";
  if (spot.accepts.startsWith("suit:")) return "Any " + SUIT_NAMES[spot.accepts.slice(5)].toLowerCase() + " card";
  const c = cards.find((x) => x.id === spot.accepts.slice(5));
  return c ? c.label.replace("#", "").trim() : "A card you no longer have";
}
/** Short text under a spot: "Mon", "week 2", "6 PM". */
export function shortWhen(spot) {
  const w = parseWhen(spot.when);
  if (w.date) return `${MONTHS[w.date.m][0].toUpperCase() + MONTHS[w.date.m].slice(1)} ${w.date.d}`;
  const bits = [];
  if (w.week) bits.push("wk " + w.week);
  if (w.day) bits.push("day " + w.day);
  if (w.days && w.days.length < 3) bits.push(w.days.map((d) => DAYNAME[d]).join("/"));
  if (w.from != null && !bits.length) bits.push(fmtMin(w.from));
  return bits.join(" ");
}
export const jitter = (id, span = 7) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0; return ((Math.abs(h) % 1000) / 1000 - 0.5) * 2 * span; };

/* ---------- the library ---------- */
// Spots say which card they take with "card:<key>"; adding the map swaps keys for your real card ids.
function build(tpl, list) {
  const shapes = [], spots = {};
  list.forEach(([shape, items], n) => {
    const id = "s" + n;
    const ids = items.map((sp, i) => { const sid = id + "-" + i; spots[sid] = { id: sid, shape: id, i, label: "", accepts: "any", when: "always", ...sp }; return sid; });
    shapes.push({ rot: 0, ry: shape.rx, ...shape, id, spots: ids });
  });
  return { ...tpl, shapes, spots };
}
const LIFTS = ["squat", "dead", "bench"], LIFT_DAYS = ["mon", "wed", "fri"];

export const MAP_LIBRARY = [
  build({ key: "lift-month", name: "Powerlifting month", per: "month", deckKey: "powerlifting", W: 1400, H: 1000,
    about: "Twelve lifting sessions in order around a ring, Monday, Wednesday and Friday evenings. Pounds lifted fill the Tonnage pool in the middle. Cardio, weigh-ins and test week sit around it." }, [
    [{ kind: "ring", label: "Training cycle", sub: "12 sessions · in order", cx: 700, cy: 470, rx: 250, ordered: true },
      [1, 2, 3, 4].flatMap((wk) => LIFTS.map((l, i) => ({ accepts: "card:" + l, when: `week ${wk} ${LIFT_DAYS[i]} 5 to 9pm` })))],
    [{ kind: "pool", label: "Tonnage", sub: "lb lifted", cx: 700, cy: 470, rx: 92 }, [{ accepts: "suit:body", auto: true, target: 50000, unit: "lb" }]],
    [{ kind: "ring", label: "Test week", sub: "1-rep maxes · week 4", cx: 700, cy: 105, rx: 110, ry: 62 },
      ["rm_s", "rm_b", "rm_d"].map((k) => ({ accepts: "card:" + k, when: "week 4" }))],
    [{ kind: "ring", label: "Accessories", sub: "any time this month", cx: 220, cy: 420, rx: 125, rot: 45 },
      ["pull", "row", "lunge", "core"].map((k) => ({ accepts: "card:" + k }))],
    [{ kind: "path", label: "Zone 2 cardio", sub: "Tue & Thu · in order", cx: 700, cy: 900, rx: 420, ordered: true },
      [1, 2, 3, 4].flatMap((wk) => ["tue", "thu"].map((d) => ({ accepts: "card:z2", when: `week ${wk} ${d}` })))],
    [{ kind: "path", label: "Weigh-ins", sub: "Sunday mornings", cx: 1230, cy: 470, rx: 150, rot: 90 },
      [1, 2, 3, 4].map((wk) => ({ accepts: "card:weigh", when: `week ${wk} sun 6 to 11am` }))],
    [{ kind: "ring", label: "Session log", sub: "after lifting", cx: 220, cy: 800, rx: 80 },
      [0, 1, 2, 3].map(() => ({ accepts: "card:log" }))],
  ]),
  build({ key: "lift-day", name: "Lifter's day", per: "day", deckKey: "powerlifting", W: 1000, H: 760,
    about: "Every day: fill the protein and water pools, and work around the recovery ring. Runs alongside Powerlifting month." }, [
    [{ kind: "pool", label: "Protein", sub: "every day", cx: 230, cy: 210, rx: 120 }, [{ accepts: "card:protein", target: 160, unit: "g" }]],
    [{ kind: "pool", label: "Water", sub: "every day", cx: 770, cy: 210, rx: 120 }, [{ accepts: "card:water", target: 3000, unit: "ml" }]],
    [{ kind: "ring", label: "Recovery", sub: "today", cx: 500, cy: 500, rx: 170 },
      [["creatine", "before 12pm"], ["stretch", "always"], ["breath", "always"], ["roll", "5 to 10pm"], ["heat", "6 to 11pm"]].map(([k, w]) => ({ accepts: "card:" + k, when: w }))],
  ]),
  build({ key: "bed-week", name: "Bed on time", per: "week", deckKey: "everyday", W: 900, H: 820,
    about: "Seven nights around a ring. Play Go to bed between 9:30 and midnight to land it on tonight's spot. A night you miss shows an X." }, [
    [{ kind: "ring", label: "Bed on time", sub: "this week", cx: 450, cy: 420, rx: 290 },
      [1, 2, 3, 4, 5, 6, 0].map((d) => ({ accepts: "card:bed", when: `${DAYNAME[d].toLowerCase()} 9:30pm to 11:59pm`, label: DAYNAME[d] }))],
  ]),
  build({ key: "mindful-day", name: "Mindful day", per: "day", deckKey: "mindful", W: 1100, H: 800,
    about: "A slow day: a morning path, a midday ring and an evening ring to wind down." }, [
    [{ kind: "path", label: "Morning", sub: "6 to 10 AM · in order", cx: 550, cy: 120, rx: 330, ordered: true },
      ["meditate", "journal", "tea"].map((k) => ({ accepts: "card:" + k, when: "6 to 10am" }))],
    [{ kind: "ring", label: "Midday", sub: "11 AM to 5 PM", cx: 300, cy: 470, rx: 170 },
      ["walk", "phone", "stretch", "anymind"].map((k) => (k === "anymind" ? { accepts: "suit:mind", when: "11am to 5pm" } : { accepts: "card:" + k, when: "11am to 5pm" }))],
    [{ kind: "ring", label: "Evening", sub: "7 to 10 PM", cx: 800, cy: 500, rx: 150 },
      ["read", "gratitude", "phone"].map((k) => ({ accepts: "card:" + k, when: "7 to 10pm" }))],
  ]),
];

/** A library map made yours: card keys become your card ids. `resolve(key)` returns a card id or null. */
export function installMap(tpl, ownerId, deckId, resolve, now = Date.now()) {
  const spots = {};
  for (const [id, sp] of Object.entries(tpl.spots)) {
    let a = sp.accepts;
    if (a.startsWith("card:")) { const cid = resolve(a.slice(5)); a = cid ? "card:" + cid : "any"; }
    spots[id] = { ...sp, accepts: a };
  }
  const { about, deckKey, ...rest } = tpl;
  return { ...rest, owner: ownerId, deck: deckId, active: true, since: new Date(now).toISOString(), round: roundKey(tpl, now), spots };
}

/* ---------- the editor's layout ---------- */
/** Size a shape for its spot count and place shapes that have no position yet below the rest. */
export function layoutMap(map) {
  const W = map.W || 1000;
  let H = 0;
  const placed = map.shapes.filter((sh) => sh.cx != null);
  for (const sh of placed) H = Math.max(H, sh.cy + (sh.ry || sh.rx) + 90);
  const shapes = map.shapes.map((sh) => ({ ...sh }));
  let col = 0, rowY = H + 220;
  for (const sh of shapes) {
    const n = sh.spots.length;
    if (sh.kind === "pool") { sh.rx = sh.ry = 110; }
    else if (sh.kind === "path") { sh.rx = Math.min(380, 70 + 70 * Math.max(1, n - 1) / 2); sh.ry = sh.rx; }
    else { sh.rx = Math.min(300, 90 + 18 * n); sh.ry = sh.rx; }
    if (sh.cx == null) {
      const wide = sh.kind === "path" || sh.rx > 200;
      if (wide && col) { col = 0; rowY += 470; }
      sh.cx = wide ? W / 2 : col ? W * 0.75 : W * 0.25; sh.cy = rowY; sh.rot = sh.rot || 0;
      if (wide || col) { col = 0; rowY += Math.max(470, sh.ry * 2 + 160); } else col = 1;
    }
  }
  for (const sh of shapes) H = Math.max(H, sh.cy + (sh.kind === "path" ? 80 : sh.ry) + 110);
  return { ...map, W, H: Math.max(600, H), shapes };
}
