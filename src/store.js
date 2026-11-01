import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "./config";
import { SEED_CARDS, bufferBlock, bufferMessage, activeLocks, canPlay, dealFrom, lockMessage, markDrawn, myChaos, myDeck, newId, nextTurn, pickCard } from "./model";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const configured = !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_KEY.includes("YOUR-");

/* ---------- local profile (who am I, which room) ---------- */
const PROFILE_KEY = "pac.profile.v1";
export const DEFAULT_PREFS = { everyMins: 120, startHour: 8, endHour: 21, notify: true };

export async function loadProfile() {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}
export async function saveProfile(p) {
  try {
    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  } catch {}
}

/* ---------- room documents: docs(room, coll, id, data) ---------- */
// A tiny document store on one Postgres table, mirroring the web page's collections:
// cards, players, tables (one per player), hands, plays, discards, config/main, game/main.

async function upsert(room, coll, id, data) {
  const { error } = await supabase.from("docs").upsert({ room, coll, id, data, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}
async function remove(room, coll, id) {
  const { error } = await supabase.from("docs").delete().match({ room, coll, id });
  if (error) throw new Error(error.message);
}
async function getDoc(room, coll, id) {
  const { data, error } = await supabase.from("docs").select("data").match({ room, coll, id }).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? data.data : null;
}
async function listColl(room, coll) {
  const { data, error } = await supabase.from("docs").select("id,data").match({ room, coll });
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({ id: r.id, ...r.data }));
}

export async function fetchRoom(room) {
  const { data, error } = await supabase.from("docs").select("coll,id,data").eq("room", room);
  if (error) throw new Error(error.message);
  return shape(data || []);
}

export function shape(rows) {
  const s = { cards: [], players: [], tables: {}, hands: [], plays: [], discards: [], config: { chaos: 30 }, game: { turn: 1, active: null } };
  for (const r of rows) {
    const d = { id: r.id, ...r.data };
    if (r.coll === "cards") s.cards.push(d);
    else if (r.coll === "players") s.players.push(d);
    else if (r.coll === "tables") s.tables[r.id] = r.data;
    else if (r.coll === "hands") s.hands.push(d);
    else if (r.coll === "plays") s.plays.push(d);
    else if (r.coll === "discards") s.discards.push(d);
    else if (r.coll === "config" && r.id === "main") s.config = { chaos: 30, ...r.data };
    else if (r.coll === "game" && r.id === "main") s.game = { turn: 1, active: null, ...r.data };
  }
  return s;
}

export function subscribeRoom(room, onChange) {
  const ch = supabase
    .channel("room-" + room)
    .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "room=eq." + room }, () => onChange())
    .subscribe();
  return () => {
    supabase.removeChannel(ch);
  };
}

/* ---------- joining ---------- */
export async function joinRoom(room, me) {
  const p = await getDoc(room, "players", me.id);
  await upsert(room, "players", me.id, { ...(p || {}), name: me.name, joined: p?.joined || new Date().toISOString() });
  // Everyone gets their own deck. A newcomer starts with the starter cards.
  const [cards, players] = await Promise.all([listColl(room, "cards"), listColl(room, "players")]);
  if (!myDeck(cards, players, me.id).length) {
    for (const c of SEED_CARDS) {
      const { id, ...data } = c;
      await upsert(room, "cards", me.id + "-" + id, { ...data, owner: me.id });
    }
  }
  const g = await getDoc(room, "game", "main");
  if (!g || !g.active) await upsert(room, "game", "main", { turn: g?.turn || 1, active: me.id });
}

/* ---------- moves ---------- */
async function advance(room, me) {
  const [players, game] = await Promise.all([listColl(room, "players"), getDoc(room, "game", "main")]);
  const g = game || { turn: 1, active: me.id };
  if (g.active !== me.id) return;
  await upsert(room, "game", "main", nextTurn(players, g, me.id));
}

export async function draw(room, me, win = {}) {
  const [cards, hands, tables, players, plays] = await Promise.all([listColl(room, "cards"), listColl(room, "hands"), listColl(room, "tables"), listColl(room, "players"), listColl(room, "plays")]);
  const up = tables.find((t) => t.id === me.id);
  const busy = up && !up.empty ? [up.cardId] : [];
  const k = pickCard(myDeck(cards, players, me.id), busy, myChaos(players, me.id), Date.now(), Math.random, { ...win, plays, meId: me.id });
  if (!k) return null;
  const t = dealFrom(k, Date.now(), Math.random, win);
  await upsert(room, "tables", me.id, t);
  const { id, ...cd } = k;
  await upsert(room, "cards", id, { ...cd, ...markDrawn(cd, t.drawnAt, t.amount) });
  return t;
}

/** Put a specific card (e.g. from a fired notification) face-up, if the table is empty. */
export async function placeOnTable(room, me, t) {
  const cur = await getDoc(room, "tables", me.id);
  if (cur && !cur.empty) return cur;
  await upsert(room, "tables", me.id, t);
  const card = await getDoc(room, "cards", t.cardId);
  if (card) await upsert(room, "cards", t.cardId, { ...card, ...markDrawn(card, t.drawnAt, t.amount) });
  return t;
}

async function logPlay(room, me, t, combo = null) {
  const now = new Date().toISOString();
  const game = (await getDoc(room, "game", "main")) || { turn: 1 };
  await upsert(room, "plays", newId(), {
    seat: me.id, cardId: t.cardId, label: t.label, base: t.base || t.label, amount: t.amount ?? null, variant: t.variant || "", suit: t.suit, imm: t.imm, turn: game.turn || 1, at: now, combo,
  });
  const card = await getDoc(room, "cards", t.cardId);
  if (card) await upsert(room, "cards", t.cardId, { ...card, lastPlayed: now, plays: (card.plays || 0) + 1 });
}

/** Throws if a lock card in your hand blocks playing these cards. */
async function guardLock(room, me, cardIds) {
  const [cards, hands, plays] = await Promise.all([listColl(room, "cards"), listColl(room, "hands"), listColl(room, "plays")]);
  const locks = activeLocks(cards, hands, me.id);
  if (!canPlay(locks, cardIds)) throw new Error(lockMessage(locks));
  for (const id of cardIds) {
    const card = cards.find((c) => c.id === id);
    const block = card && bufferBlock(card, plays, me.id);
    if (block) throw new Error(`Not yet: ${card.label}. ${bufferMessage(block)}`);
  }
}

async function clearTableIf(room, me, cardId) {
  const cur = await getDoc(room, "tables", me.id);
  if (cur && !cur.empty && (!cardId || cur.cardId === cardId)) await upsert(room, "tables", me.id, { empty: true });
}

export async function playCard(room, me, t) { await guardLock(room, me, [t.cardId]);
  await logPlay(room, me, t);
  await clearTableIf(room, me, t.cardId);
  await advance(room, me);
}

export async function holdCard(room, me, t, remindAt = null, handId = newId()) {
  const { empty, id, ...card } = t;
  await upsert(room, "hands", handId, { ...card, seat: me.id, heldAt: new Date().toISOString(), remindAt: remindAt ? remindAt.toISOString() : null });
  await clearTableIf(room, me, t.cardId);
  await advance(room, me);
  return handId;
}

export async function playFromHand(room, me, handId) {
  const h = await getDoc(room, "hands", handId);
  if (h) await guardLock(room, me, [h.cardId]);
  if (!h) return false;
  await remove(room, "hands", handId);
  await logPlay(room, me, h);
  await advance(room, me);
  return true;
}

export async function discardFromHand(room, me, handId) {
  const h = await getDoc(room, "hands", handId);
  if (!h) return false;
  await remove(room, "hands", handId);
  await upsert(room, "discards", newId(), { seat: me.id, label: h.label, suit: h.suit, at: new Date().toISOString() });
  return true;
}

export async function setRemind(room, handId, at) {
  const h = await getDoc(room, "hands", handId);
  if (!h) return false;
  await upsert(room, "hands", handId, { ...h, remindAt: at ? at.toISOString() : null });
  return true;
}

export const getHand = (room, handId) => getDoc(room, "hands", handId);

/* ---------- deck editing ---------- */
export const deleteCard = (room, id) => remove(room, "cards", id);
export async function saveCard(room, me, card) {
  const { id, ...data } = card;
  await upsert(room, "cards", id || me.id + "-" + newId(), { ...data, owner: data.owner || me.id });
}
export async function setChaos(room, me, chaos) {
  const p = (await getDoc(room, "players", me.id)) || { name: me.name, joined: new Date().toISOString() };
  await upsert(room, "players", me.id, { ...p, chaos });
}

/** Play several held cards at once, as one move. */
export async function playCombo(room, me, handIds) {
  const held = (await listColl(room, "hands")).filter((h) => handIds.includes(h.id));
  await guardLock(room, me, held.map((h) => h.cardId));
  const combo = handIds.length > 1 ? newId() : null;
  for (const id of handIds) {
    const h = await getDoc(room, "hands", id);
    if (!h) continue;
    await remove(room, "hands", id);
    await logPlay(room, me, h, combo);
  }
  await advance(room, me);
}

/** Give a player starter cards if they have no deck of their own yet. */
export async function ensureDeck(room, me) {
  const [cards, players] = await Promise.all([listColl(room, "cards"), listColl(room, "players")]);
  if (!players.some((p) => p.id === me.id)) return false;
  const mine = myDeck(cards, players, me.id);
  if (mine.length) {
    // One-time: Drink water locks at 3 unless you've set something else.
    for (const c of mine) if (c.lockAt === undefined && /drink water/i.test(c.label)) { const { id, ...d } = c; await upsert(room, "cards", id, { ...d, owner: d.owner || me.id, lockAt: 3 }); }
    return false;
  }
  for (const c of SEED_CARDS) {
    const { id, ...data } = c;
    await upsert(room, "cards", me.id + "-" + id, { ...data, owner: me.id });
  }
  return true;
}
