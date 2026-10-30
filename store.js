// Same document store the Android app uses: one Supabase table, docs(room, coll, id, data).
import { createClient } from "./supabase.js";
import { SEED_CARDS, dealFrom, newId, nextTurn, pickCard } from "./model.js";

export const SUPABASE_URL = "https://znhbphohxomvldyvewyj.supabase.co";
export const SUPABASE_KEY = "sb_publishable_B9UMRmmdVo9HSRwVuUEEhw_hEOyGToB";
export const VAPID_PUBLIC = "BJWGV-aeIqbeXI7RIeYN6qMuTfEA_K8PhF-mv1lFHOyo9LN6Rw9m8g7B1lbO7aArsBj0fP-VAhg6WE8rswafL6E";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const PROFILE_KEY = "pac.profile.v1";
export const DEFAULT_PREFS = { everyMins: 120, startHour: 8, endHour: 21, notify: true };
export function loadProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null; } catch { return null; }
}
export function saveProfile(p) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {}
}

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
  const s = { cards: [], players: [], tables: {}, hands: [], plays: [], discards: [], config: { chaos: 30 }, game: { turn: 1, active: null } };
  for (const r of data || []) {
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
  const ch = supabase.channel("room-" + room)
    .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "room=eq." + room }, () => onChange())
    .subscribe();
  return () => supabase.removeChannel(ch);
}

export async function joinRoom(room, me) {
  const existing = await listColl(room, "cards");
  if (!existing.length) {
    for (const c of SEED_CARDS) { const { id, ...data } = c; await upsert(room, "cards", id, data); }
    await upsert(room, "config", "main", { chaos: 30 });
  }
  const p = await getDoc(room, "players", me.id);
  await upsert(room, "players", me.id, { name: me.name, joined: p?.joined || new Date().toISOString() });
  const g = await getDoc(room, "game", "main");
  if (!g || !g.active) await upsert(room, "game", "main", { turn: g?.turn || 1, active: me.id });
}

async function advance(room, me) {
  const [players, game] = await Promise.all([listColl(room, "players"), getDoc(room, "game", "main")]);
  const g = game || { turn: 1, active: me.id };
  if (g.active !== me.id) return;
  await upsert(room, "game", "main", nextTurn(players, g, me.id));
}

export async function draw(room, me) {
  const [cards, hands, tables, config] = await Promise.all([listColl(room, "cards"), listColl(room, "hands"), listColl(room, "tables"), getDoc(room, "config", "main")]);
  const busy = [...hands.map((h) => h.cardId), ...tables.filter((t) => !t.empty).map((t) => t.cardId)];
  const k = pickCard(cards, busy, config?.chaos ?? 30);
  if (!k) return null;
  const t = dealFrom(k);
  await upsert(room, "tables", me.id, t);
  const { id, ...cd } = k;
  await upsert(room, "cards", id, { ...cd, lastDrawn: t.drawnAt });
  return t;
}

async function logPlay(room, me, t) {
  const now = new Date().toISOString();
  const game = (await getDoc(room, "game", "main")) || { turn: 1 };
  await upsert(room, "plays", newId(), { seat: me.id, cardId: t.cardId, label: t.label, variant: t.variant || "", suit: t.suit, imm: t.imm, turn: game.turn || 1, at: now });
  const card = await getDoc(room, "cards", t.cardId);
  if (card) await upsert(room, "cards", t.cardId, { ...card, lastPlayed: now, plays: (card.plays || 0) + 1 });
}
async function clearTable(room, me) { await upsert(room, "tables", me.id, { empty: true }); }

export async function playCard(room, me, t) { await logPlay(room, me, t); await clearTable(room, me); await advance(room, me); }
export async function holdCard(room, me, t, remindAt = null) {
  const { empty, id, ...card } = t;
  await upsert(room, "hands", newId(), { ...card, seat: me.id, heldAt: new Date().toISOString(), remindAt: remindAt ? remindAt.toISOString() : null });
  await clearTable(room, me);
  await advance(room, me);
}
export async function playFromHand(room, me, handId) {
  const h = await getDoc(room, "hands", handId);
  if (!h) return;
  await remove(room, "hands", handId);
  await logPlay(room, me, h);
  await advance(room, me);
}
export async function discardFromHand(room, me, handId) {
  const h = await getDoc(room, "hands", handId);
  if (!h) return;
  await remove(room, "hands", handId);
  await upsert(room, "discards", newId(), { seat: me.id, label: h.label, suit: h.suit, at: new Date().toISOString() });
}
export async function setRemind(room, handId, at) {
  const h = await getDoc(room, "hands", handId);
  if (!h) return;
  await upsert(room, "hands", handId, { ...h, remindAt: at ? at.toISOString() : null, reminded: false });
}
export async function saveCard(room, card) { const { id, ...data } = card; await upsert(room, "cards", id || newId(), data); }
export const deleteCard = (room, id) => remove(room, "cards", id);
export const setChaos = (room, chaos) => upsert(room, "config", "main", { chaos });

/* ---------- web push: the Supabase dealer reads this to know when to deal to you ---------- */
export async function savePush(room, me, sub, prefs) {
  const prev = await getDoc(room, "push", me.id);
  await upsert(room, "push", me.id, {
    sub, prefs, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago",
    nextAt: prev?.nextAt || new Date(Date.now() + 5 * 60e3).toISOString(),
  });
}
export const removePush = (room, me) => remove(room, "push", me.id);
export const getPush = (room, me) => getDoc(room, "push", me.id);
