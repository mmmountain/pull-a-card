import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "./config";
import { MAP_LIBRARY, canPlayAt, fitsSpots, installMap, live, newlyMissed, placeCard } from "./maps";
import { DECK_LIBRARY, everydayId, myDecks, SEED_CARDS, BEDTIME_CARD, takeoverActive, nudgedTempo, holdReminder, bufferBlock, bufferMessage, activeLocks, canPlay, dealFrom, lockMessage, markDrawn, myChaos, myDeck, newId, nextTurn, pickCard } from "./model";

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
  const s = { maps: [], decks: [], cards: [], players: [], tables: {}, hands: [], plays: [], discards: [], config: { chaos: 30 }, game: { turn: 1, active: null } };
  for (const r of rows) {
    const d = { id: r.id, ...r.data };
    if (r.coll === "maps") s.maps.push(d);
    else if (r.coll === "decks") s.decks.push(d);
    else if (r.coll === "cards") s.cards.push(d);
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
  const [cards, hands, tables, players, plays, decks] = await Promise.all([listColl(room, "cards"), listColl(room, "hands"), listColl(room, "tables"), listColl(room, "players"), listColl(room, "plays"), listColl(room, "decks")]);
  const up = tables.find((t) => t.id === me.id);
  const busy = up && !up.empty ? [up.cardId] : [];
  const k = pickCard(myDeck(cards, players, me.id, decks), busy, myChaos(players, me.id), Date.now(), Math.random, { ...win, plays, meId: me.id });
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

async function logPlay(room, me, t, combo = null, at = null) {
  const now = new Date().toISOString();
  const game = (await getDoc(room, "game", "main")) || { turn: 1 };
  await upsert(room, "plays", newId(), {
    seat: me.id, cardId: t.cardId, label: t.label, base: t.base || t.label, amount: t.amount ?? null, variant: t.variant || "", suit: t.suit, imm: t.imm, turn: game.turn || 1, at: now, combo,
  });
  const card = await getDoc(room, "cards", t.cardId);
  if (card) await upsert(room, "cards", t.cardId, { ...card, lastPlayed: now, plays: (card.plays || 0) + 1 });
  try { await placeOnMaps(room, me, t, card, at); } catch {}
}

/* ---------- maps ---------- */
const libTonnage = (cardId) => { for (const d of DECK_LIBRARY) for (const c of d.cards) if (c.tonnage && cardId.endsWith("-" + d.key + "-" + c.key)) return c.tonnage; return null; };

/** A played card lands on a map: on the spot you chose, or the best open spot on your active maps. */
async function placeOnMaps(room, me, t, card, at = null) {
  const now = Date.now();
  const maps = (await listColl(room, "maps")).filter((m) => m.owner === me.id && m.active !== false);
  let hit = null;
  if (at) {
    const m = maps.find((x) => x.id === at.mapId), lm = m && live(m, now), sp = lm?.spots[at.spotId];
    if (sp && canPlayAt(lm, sp, t, now)) hit = { map: lm, spot: sp };
  }
  hit = hit || fitsSpots(maps, t, now)[0];
  if (!hit) return null;
  const { id, ...data } = placeCard(hit.map, hit.spot.id, t, { tonnage: card?.tonnage ?? libTonnage(t.cardId) }, now);
  await upsert(room, "maps", id, data);
  return id;
}

/** Play a held card onto a specific spot. */
export async function playToSpot(room, me, handId, mapId, spotId) {
  const h = await getDoc(room, "hands", handId);
  if (!h) return false;
  await guardLock(room, me, [h.cardId]);
  const m = await getDoc(room, "maps", mapId);
  const lm = m && live(m), sp = lm?.spots?.[spotId];
  if (!sp || !canPlayAt(lm, sp, h)) throw new Error("That spot isn't open for this card right now.");
  await remove(room, "hands", handId);
  await logPlay(room, me, h, null, { mapId, spotId });
  await advance(room, me);
  return true;
}

export async function addLibraryMap(room, me, key) {
  const tpl = MAP_LIBRARY.find((m) => m.key === key);
  if (!tpl) throw new Error("That map isn't in the library.");
  const deckId = tpl.deckKey === "everyday" ? everydayId(me.id) : await addLibraryDeck(room, me, tpl.deckKey);
  const cards = (await listColl(room, "cards")).filter((c) => (c.owner || me.id) === me.id);
  const resolve = (k) => {
    if (tpl.deckKey === "everyday") return k === "bed" ? (cards.find((c) => c.id === me.id + "-bed") || cards.find((c) => /go to bed/i.test(c.label)))?.id || null : null;
    const id = me.id + "-" + tpl.deckKey + "-" + k;
    return cards.some((c) => c.id === id) ? id : null;
  };
  const id = me.id + ":" + tpl.key;
  await upsert(room, "maps", id, installMap(tpl, me.id, deckId, resolve));
  return id;
}
export async function setMapActive(room, me, mapId, active) {
  const m = await getDoc(room, "maps", mapId);
  if (m) await upsert(room, "maps", mapId, { ...m, active });
}
export async function deleteMap(room, me, mapId) { await remove(room, "maps", mapId); }

/** New round → empty the map. Missed spots hand you their card once, to play elsewhere or discard. Returns how many. */
export async function syncMaps(room, me) {
  const now = Date.now();
  const maps = (await listColl(room, "maps")).filter((m) => m.owner === me.id && m.active !== false);
  if (!maps.length) return 0;
  const cards = await listColl(room, "cards");
  let n = 0;
  for (const m0 of maps) {
    const m = live(m0, now), miss = newlyMissed(m, now);
    if (!miss.length && !m.fresh) continue;
    const spots = { ...m.spots };
    for (const sp of miss) {
      const card = cards.find((c) => "card:" + c.id === sp.accepts);
      if (card) {
        const t = dealFrom(card, now, Math.random, {});
        await upsert(room, "hands", newId(), { ...t, seat: me.id, heldAt: new Date(now).toISOString(), remindAt: null, fromMap: m.name });
        n++;
      }
      spots[sp.id] = { ...sp, dealtMiss: true };
    }
    const { id, fresh, ...data } = m;
    await upsert(room, "maps", m0.id, { ...data, spots });
  }
  return n;
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
  const meP = players.find((p) => p.id === me.id);
  if (!meP) return false;
  const mine = myDeck(cards, players, me.id);
  // One-time: everyone gets a Go to bed card (delete it if you don't want it; it won't come back).
  if (mine.length && !meP.bedSeeded) {
    if (!mine.some((c) => /go to bed/i.test(c.label))) { const { id, ...data } = BEDTIME_CARD; await upsert(room, "cards", me.id + "-bed", { ...data, owner: me.id }); }
    const { id: _pid, ...pd } = meP;
    await upsert(room, "players", me.id, { ...pd, bedSeeded: true });
  }
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

/** Act on a swipe of the top card. Returns { handId, remindAt } for holds so the app can set a reminder. */
export async function swipeTop(room, me, t, it) {
  const card = await getDoc(room, "cards", t.cardId);
  const saveCard = async (patch) => { if (card) await upsert(room, "cards", t.cardId, { ...card, ...patch }); };
  // Undo the deal in the card's count, so "not now" doesn't eat into today's target.
  const unDeal = () => {
    const log = [...(card?.drawLog || [])];
    const i = log.map((e) => (typeof e === "string" ? e : e.at)).lastIndexOf(t.drawnAt);
    if (i >= 0) log.splice(i, 1);
    return { drawLog: log };
  };
  if (it.kind === "play") {
    await playCard(room, me, t);
    if (it.tilt) { const fresh = await getDoc(room, "cards", t.cardId); if (fresh) await upsert(room, "cards", t.cardId, { ...fresh, tempo: nudgedTempo(fresh.tempo, it) }); }
    return {};
  }
  if (it.kind === "hold") {
    const remindAt = holdReminder(it);
    const handId = await holdCard(room, me, t, remindAt);
    return { handId, remindAt };
  }
  await upsert(room, "tables", me.id, { empty: true });
  if (it.kind === "soon") await saveCard({ ...unDeal(), dueAt: new Date(Date.now() + 30 * 6e4).toISOString() });
  if (it.kind === "later") await saveCard({ ...unDeal(), tempo: nudgedTempo(card?.tempo, it), dueAt: null });
  return {};
}

/** If a takeover card is due and nothing is face up, put it on the table. */
export async function claimTakeover(room, me, win = {}) {
  const [cards, players, table, decks] = await Promise.all([listColl(room, "cards"), listColl(room, "players"), getDoc(room, "tables", me.id), listColl(room, "decks")]);
  if (table && !table.empty) return null;
  if (!myDeck(cards, players, me.id, decks).some((c) => takeoverActive(c, Date.now(), win))) return null;
  return draw(room, me, win);
}

/* ---------- decks ---------- */
export async function addLibraryDeck(room, me, key) {
  const tpl = DECK_LIBRARY.find((d) => d.key === key);
  if (!tpl) throw new Error("That deck isn't in the library.");
  const deckId = me.id + ":" + key;
  await upsert(room, "decks", deckId, { owner: me.id, name: tpl.name, key, active: true });
  const existing = new Set((await listColl(room, "cards")).map((c) => c.id));
  for (const c of tpl.cards) {
    const { key: ck, ...data } = c;
    const id = me.id + "-" + key + "-" + ck;
    if (!existing.has(id)) await upsert(room, "cards", id, { ...data, owner: me.id, deck: deckId, active: true, plays: 0 });
  }
  return deckId;
}
export async function setDeckActive(room, me, deck, active) {
  const { id, ...data } = deck;
  await upsert(room, "decks", id, { ...data, owner: me.id, name: deck.name, active });
}
export async function renameDeck(room, me, deck, name) {
  const { id, ...data } = deck;
  await upsert(room, "decks", id, { ...data, owner: me.id, name });
}
export async function newDeck(room, me, name) {
  const id = me.id + ":" + newId();
  await upsert(room, "decks", id, { owner: me.id, name, active: true });
  return id;
}
/** Deletes the deck and its cards. Your Everyday deck can't be deleted. */
export async function deleteDeck(room, me, deck) {
  if (deck.id === everydayId(me.id)) throw new Error("The Everyday deck can't be deleted.");
  for (const c of await listColl(room, "cards")) if (c.deck === deck.id) await remove(room, "cards", c.id);
  await remove(room, "decks", deck.id);
}
