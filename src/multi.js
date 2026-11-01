// Prompt — several tables at once.
// A paused table (ctx.live leaves it out) gets no copies of your top card and its plays don't count.
// Every table is its own track: its own turns, plays, maps and hand. You have one top card across
// all of them. A card "applies" at a table when you have a card with the same name there that's
// switched on and either sits in an active deck or is required by one of your active maps.
// Copies of one pull share a `link` id, so playing, holding or discarding one acts on every copy.
import * as S from "./store";
import { deckOf, myDeck, myDecks, newId } from "./model";

const norm = (s) => String(s || "").trim().toLowerCase();
const baseOf = (t) => norm(t.base || t.label);

/** The card at this table that a pulled card counts as, or null. */
export function applies(state, meId, t) {
  if (!state || !t) return null;
  const want = baseOf(t);
  const decks = myDecks(state.decks, meId);
  const deckOn = (c) => decks.find((d) => d.id === deckOf(c, meId))?.active !== false;
  const onMap = (c) => (state.maps || []).some((m) => m.owner === meId && m.active !== false &&
    Object.values(m.spots || {}).some((sp) => sp.accepts === "card:" + c.id));
  return myDeck(state.cards, state.players, meId)
    .find((c) => norm(c.label) === want && c.active !== false && (deckOn(c) || onMap(c))) || null;
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

export const playTop = (ctx, origin, t) => each(copiesOfTop(ctx, origin, t), (r, tr) => S.playCard(r, ctx.me, tr));

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
