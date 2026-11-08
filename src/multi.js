// Prompt — several tables at once.
// A paused table (ctx.live leaves it out) gets no copies of your top card and its plays don't count.
// Every table is its own track: its own turns, plays, maps and hand. You have one top card across
// all of them. A card "applies" at a table when you have a card with the same name there that's
// switched on and either sits in an active deck or is required by one of your active maps.
// Copies of one pull share a `link` id, so playing, holding or discarding one acts on every copy.
import * as S from "./store";
import { cardAllowed, deckOf, filtersFor, myDeck, myDecks, newId } from "./model";

const norm = (s) => String(s || "").trim().toLowerCase();
const baseOf = (t) => norm(t.base || t.label);

/** The card at this table that a pulled card counts as, or null. */
export function applies(state, meId, t) {
  if (!state || !t) return null;
  const want = baseOf(t);
  const fl = filtersFor(state.players, meId);
  return myDeck(state.cards, state.players, meId, state.decks || [], state.maps || [])
    .find((c) => norm(c.label) === want && c.active !== false && cardAllowed(c, fl, Date.now(), { meId })) || null;
}

const topAt = (state, meId) => { const t = state?.tables?.[meId]; return t && !t.empty ? t : null; };

/** Your one top card: the one at this table, else the first one at another table. */
export function findTop(ctx) {
  const { rooms, states, room, me } = ctx;
  const here = topAt(states[room], me.id);
  if (here) return { t: here, room };
  for (const r of rooms) { const t = topAt(states[r], me.id); if (t) return { t, room: r }; }
  return null;
}

/** Every table holding a copy of this top card, starting with `origin`. */
function copiesOfTop(ctx, origin, t) {
  const out = [];
  for (const r of [origin, ...(ctx.live || ctx.rooms).filter((x) => x !== origin)]) {
    const tr = topAt(ctx.states[r], ctx.me.id);
    if (!tr) continue;
    if (r === origin || (t.link && tr.link === t.link)) out.push([r, tr]);
  }
  return out;
}

/** Tables where this top card counts (for the label under the card). */
export const topTables = (ctx, origin, t) => copiesOfTop(ctx, origin, t).map(([r]) => r);

/** Give a fresh top card a link and deal a copy to every other table it applies to. */
export async function mirrorTop(ctx, origin) {
  const t = topAt(ctx.states[origin], ctx.me.id);
  if (!t) return 0;
  const link = t.link || newId();
  if (!t.link) await S.setTop(origin, ctx.me, { ...t, link });
  let n = 0;
  for (const r of ctx.live || ctx.rooms) {
    if (r === origin || topAt(ctx.states[r], ctx.me.id)) continue;
    const match = applies(ctx.states[r], ctx.me.id, t);
    if (!match) continue;
    await S.placeOnTable(r, ctx.me, { ...t, cardId: match.id, link });
    n++;
  }
  return n;
}

/** Pull at this table, then copy the card to the other tables it applies to. */
export async function drawAll(ctx, prefs) {
  if (findTop(ctx)) throw new Error("Play or hold your top card first.");
  const t = await S.draw(ctx.room, ctx.me, prefs);
  if (!t) return null;
  const fresh = { ...ctx, states: { ...ctx.states, [ctx.room]: { ...ctx.states[ctx.room], tables: { ...ctx.states[ctx.room].tables, [ctx.me.id]: t } } } };
  await mirrorTop(fresh, ctx.room);
  return t;
}

// The table you act from goes first so its errors (locks, waits) stop the move; the copies follow.
async function each(list, fn) {
  const [first, ...rest] = list;
  const out = first ? await fn(...first) : undefined;
  for (const x of rest) { try { await fn(...x); } catch {} }
  return out;
}

export const playTop = (ctx, origin, t, meta = {}) => each(copiesOfTop(ctx, origin, t), (r, tr) => S.playCard(r, ctx.me, tr, meta));
export const returnTopAll = (ctx, origin, t) => each(copiesOfTop(ctx, origin, t), (r, tr) => S.returnTop(r, ctx.me, tr));
export const dropTopAll = (ctx, origin, t) => each(copiesOfTop(ctx, origin, t), (r, tr) => S.dropTop(r, ctx.me, tr));

export async function holdTop(ctx, origin, t, remindAt = null) {
  const handId = newId();
  await each(copiesOfTop(ctx, origin, t), (r, tr) => S.holdCard(r, ctx.me, tr, remindAt, handId));
  return handId;
}

/** Swipe on the top card. Returns { handId, remindAt } for holds. */
export function swipeAll(ctx, origin, t, it) {
  const handId = newId();
  return each(copiesOfTop(ctx, origin, t), (r, tr) => S.swipeTop(r, ctx.me, tr, it, handId));
}

/* ---------- hand ---------- */

/** Your hand across tables. Linked copies show once; `here` says whether it's held at this table. */
export function handGroups(ctx) {
  const { rooms, states, room, me } = ctx;
  const groups = new Map();
  for (const r of [room, ...rooms.filter((x) => x !== room)]) {
    for (const h of states[r]?.hands || []) {
      if (h.seat !== me.id) continue;
      const key = h.link ? "L:" + h.link : r + ":" + h.id;
      const g = groups.get(key) || { key, h, room: r, places: [] };
      g.places.push({ room: r, h });
      groups.set(key, g);
    }
  }
  return [...groups.values()].map((g) => ({ ...g, here: g.places.some((p) => p.room === room) }))
    .sort((a, b) => (a.h.heldAt || "").localeCompare(b.h.heldAt || ""));
}

const placesFrom = (ctx, g) => [...g.places.filter((p) => p.room === ctx.room), ...g.places.filter((p) => p.room !== ctx.room)].map((p) => [p.room, p.h]);

export const playGroup = (ctx, g) => each(placesFrom(ctx, g), (r, h) => S.playFromHand(r, ctx.me, h.id));
export const discardGroup = (ctx, g) => each(placesFrom(ctx, g), (r, h) => S.discardFromHand(r, ctx.me, h.id));

/** Play several held cards together at this table; their copies elsewhere are played singly. */
export async function playGroupsTogether(ctx, groups) {
  const here = groups.map((g) => g.places.find((p) => p.room === ctx.room)).filter(Boolean);
  await S.playCombo(ctx.room, ctx.me, here.map((p) => p.h.id));
  for (const g of groups) for (const p of g.places) if (p.room !== ctx.room) { try { await S.playFromHand(p.room, ctx.me, p.h.id); } catch {} }
}

/** After a held card is played on a map spot here, play its copies at the other tables. */
export async function playCopiesElsewhere(ctx, h) {
  if (!h?.link) return;
  for (const r of ctx.rooms) {
    if (r === ctx.room) continue;
    for (const x of ctx.states[r]?.hands || []) if (x.seat === ctx.me.id && x.link === h.link) { try { await S.playFromHand(r, ctx.me, x.id); } catch {} }
  }
}

/* ---------- your deck library ---------- */
// My decks lives in one place (room "lib:<you>"), apart from every table. Each table keeps a copy of
// your cards so it can track its own deals and plays; edits in the library are copied out to all of them.
export const libRoom = (meId) => "lib:" + meId;
const STATS = ["lastDrawn", "drawLog", "plays", "lastPlayed", "dueAt", "tempo"];
const strip = (o, keys) => { const x = { ...o }; for (const k of keys) delete x[k]; return x; };
const defOf = (c) => strip(c, ["id", ...STATS]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const mineIn = (st1, meId) => ({
  cards: myDeck(st1.cards, st1.players, meId),
  decks: (st1.decks || []).filter((d) => d.owner === meId),
});

/**
 * Bring the library and your tables in line. Cards or decks a table has that the library doesn't
 * (say, added with a map) join the library; then every library card and deck is copied to every table,
 * keeping each table's own deal and play counts. `removed` ids are deleted everywhere.
 */
export async function syncLibrary(rooms, meId, removed = { cards: [], decks: [] }) {
  const lib = libRoom(meId);
  const libSt = await S.fetchRoom(lib);
  const L = mineIn(libSt, meId);
  const have = { cards: new Set(L.cards.map((c) => c.id)), decks: new Set(L.decks.map((d) => d.id)) };
  const gone = { cards: new Set(removed.cards || []), decks: new Set(removed.decks || []) };
  const states = {};
  for (const r of rooms) { try { states[r] = await S.fetchRoom(r); } catch {} }
  // Absorb anything new from the tables.
  for (const r of rooms) {
    const T = states[r]; if (!T) continue;
    const m = mineIn(T, meId);
    for (const c of m.cards) if (!have.cards.has(c.id) && !gone.cards.has(c.id)) { await S.putDoc(lib, "cards", c.id, { ...defOf(c), owner: meId }); have.cards.add(c.id); L.cards.push({ ...c }); }
    for (const d of m.decks) if (!have.decks.has(d.id) && !gone.decks.has(d.id)) { const { id, ...dd } = d; await S.putDoc(lib, "decks", id, dd); have.decks.add(id); L.decks.push(d); }
  }
  const myLib = libSt.players.find((p) => p.id === meId);
  // Copy out.
  for (const r of rooms) {
    const T = states[r]; if (!T) continue;
    for (const c of L.cards) {
      const cur = T.cards.find((x) => x.id === c.id);
      const def = { ...defOf(c), owner: meId };
      if (cur && same(defOf(cur), def)) continue;
      const keep = {}; if (cur) for (const k of STATS) if (cur[k] !== undefined) keep[k] = cur[k];
      await S.putDoc(r, "cards", c.id, { ...def, ...keep });
    }
    for (const d of L.decks) {
      const cur = (T.decks || []).find((x) => x.id === d.id);
      const { id, ...dd } = d;
      if (cur && same(strip(cur, ["id"]), dd)) continue;
      await S.putDoc(r, "decks", id, dd);
    }
    for (const id of gone.cards) if (T.cards.some((x) => x.id === id)) await S.delDoc(r, "cards", id);
    for (const id of gone.decks) if ((T.decks || []).some((x) => x.id === id)) await S.delDoc(r, "decks", id);
    {
      // Your randomness and your filters follow you to every table.
      const p = T.players.find((x) => x.id === meId);
      const want = { ...(typeof myLib?.chaos === "number" ? { chaos: myLib.chaos } : {}), myFilters: myLib?.filters || [] };
      if (p && (want.chaos !== undefined && p.chaos !== want.chaos || JSON.stringify(p.myFilters || []) !== JSON.stringify(want.myFilters))) {
        const { id, ...pd } = p; await S.putDoc(r, "players", id, { ...pd, ...want });
      }
    }
  }
}

/** The library room needs your player doc (for randomness) before anything else. */
export async function ensureLibrary(me) {
  const lib = libRoom(me.id);
  const st1 = await S.fetchRoom(lib);
  if (!st1.players.some((p) => p.id === me.id)) await S.putDoc(lib, "players", me.id, { name: me.name, joined: new Date().toISOString() });
}

/** Library cards shown with this table's counts, so "2 of 3 today" stays true. */
export function libraryView(libSt, tableSt) {
  if (!libSt) return null;
  const byId = new Map((tableSt?.cards || []).map((c) => [c.id, c]));
  return { ...libSt, cards: libSt.cards.map((c) => { const t = byId.get(c.id); if (!t) return c; const k = {}; for (const f of STATS) if (t[f] !== undefined) k[f] = t[f]; return { ...c, ...k }; }) };
}

/** One-time: Drink water becomes 24 a day at 125 ml each (3 L), locking at 5 held. */
export async function waterPlan(meId, rooms) {
  const lib = libRoom(meId);
  const st1 = await S.fetchRoom(lib);
  const p = st1.players.find((x) => x.id === meId);
  if (!p || p.water24) return false;
  const c = st1.cards.find((x) => x.id === meId + "-water") || st1.cards.find((x) => /^drink water$/i.test(String(x.label).trim()));
  if (c) { const { id, ...d } = c; await S.putDoc(lib, "cards", id, { ...d, quota: { n: 24, per: "day" }, each: 125, eachUnit: "ml", lockAt: 5, tempo: 1 }); }
  const { id: pid, ...pd } = p;
  await S.putDoc(lib, "players", pid, { ...pd, water24: true });
  if (c) await syncLibrary(rooms, meId);
  return !!c;
}

/** One-time: Morning pages only in the morning (5 to 11 AM). */
export async function pagesPlan(meId, rooms) {
  const lib = libRoom(meId);
  const st1 = await S.fetchRoom(lib);
  const c = st1.cards.find((x) => /^morning pages$/i.test(String(x.label).trim()) && !x.closesAt);
  if (!c) return false;
  const { id, ...d } = c;
  await S.putDoc(lib, "cards", id, { ...d, opensAt: d.opensAt || "05:00", closesAt: "11:00" });
  await syncLibrary(rooms, meId);
  return true;
}
