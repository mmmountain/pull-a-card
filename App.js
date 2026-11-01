import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions, ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Switch, Text, TextInput, View,
  Animated, PanResponder, Vibration,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";
import * as S from "./src/store";
import * as N from "./src/notify";
import * as M from "./src/multi";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ORIGINAL, randomTheme } from "./src/theme";
import { bufferBlock, bufferMessage, BUFFER_STEPS, swipeIntent, swipeLabel, hmDate, toHM } from "./src/model";
import { myChaos, myDeck, stackPlays, lastMove, drawable, activeLocks, canPlay, lockMessage, quotaLabel, PERIODS, PERIOD_NAMES, effectiveQuota, amountLabel } from "./src/model";
import { SUIT, SUITS, ago, cardLine, fmtTime, heat, newId, parseLater } from "./src/model";
import { DECK_LIBRARY, deckOf, everydayId, myDecks, deckEmoji, cardEmojis } from "./src/model";
import { SUIT_NAMES, MAP_LIBRARY, PER_NAMES, amountText, canPlayAt, describeAccepts, fitsSpots, jitter, live, parseWhen, shapeEdges, shortWhen, spotPos, spotState } from "./src/maps";

// Live color palette. applyTheme() swaps it in place and redraws the app.
const C = { ...ORIGINAL, suit: { ...ORIGINAL.suit } };
const THEME_KEY = "pac.theme.v1";
const TRAY_KEY = "pac.cardTray.v1";
let redraw = null;
function applyTheme(t, save = true) {
  Object.assign(C, t, { suit: { ...t.suit } });
  st = makeStyles();
  if (save) AsyncStorage.setItem(THEME_KEY, JSON.stringify(t)).catch(() => {});
  redraw?.();
}

/* ---------------- rooms hook ---------------- */
// Every table you sit at stays loaded and live, so switching is instant and one pull can count at several.
function useRooms(rooms) {
  const [states, setStates] = useState({});
  const [error, setError] = useState("");
  const timers = useRef({});
  const key = rooms.join("|");
  const fetchOne = useCallback(async (r) => {
    try { const st1 = await S.fetchRoom(r); setStates((x) => ({ ...x, [r]: st1 })); setError(""); }
    catch (e) { setError(String(e.message || e)); }
  }, []);
  const refresh = useCallback(() => Promise.all(rooms.map(fetchOne)), [key]);
  useEffect(() => {
    refresh();
    const offs = rooms.map((r) => S.subscribeRoom(r, () => {
      clearTimeout(timers.current[r]);
      timers.current[r] = setTimeout(() => fetchOne(r), 250);
    }));
    return () => { offs.forEach((off) => off()); Object.values(timers.current).forEach(clearTimeout); };
  }, [key]);
  return { states, error, refresh };
}

/* ---------------- app ---------------- */
// Pull new versions published from GitHub. Runs at launch and whenever the app comes back to the front.
async function applyUpdate() {
  if (__DEV__ || !Updates.isEnabled) return;
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return;
    const got = await Updates.fetchUpdateAsync();
    if (got.isNew) await Updates.reloadAsync();
  } catch {}
}

export default function App() {
  const [, setVer] = useState(0);
  useEffect(() => {
    redraw = () => setVer((v) => v + 1);
    AsyncStorage.getItem(THEME_KEY).then((raw) => { if (raw) applyTheme(JSON.parse(raw), false); }).catch(() => {});
    return () => { redraw = null; };
  }, []);
  useEffect(() => {
    applyUpdate();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") applyUpdate(); });
    return () => sub.remove();
  }, []);
  return <SafeAreaProvider><Root /></SafeAreaProvider>;
}

function Root() {
  const [profile, setProfile] = useState(undefined);
  useEffect(() => {
    S.loadProfile().then((p) => setProfile(p || null));
  }, []);
  if (profile === undefined) return <Centered><ActivityIndicator color={C.accent} /></Centered>;
  if (!S.configured) return <Centered><Text style={st.h2}>Almost there</Text><Text style={st.note}>This build is missing its Supabase settings (src/config.js).</Text></Centered>;
  if (!profile?.room) return <Join onDone={setProfile} initial={profile} />;
  return <Game profile={profile} setProfile={setProfile} />;
}

function Centered({ children }) {
  return <SafeAreaView style={[st.screen, { justifyContent: "center", alignItems: "center", padding: 24, gap: 10 }]}>{children}</SafeAreaView>;
}

/* ---------------- join ---------------- */
function Join({ onDone, initial }) {
  const [name, setName] = useState(initial?.me?.name || "");
  const [room, setRoom] = useState(initial?.room || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    const r = room.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!name.trim() || r.length < 3) { setErr("Enter your name and a table name of at least 3 letters."); return; }
    setBusy(true); setErr("");
    try {
      const me = { id: initial?.me?.id || newId(), name: name.trim() };
      await S.joinRoom(r, me);
      const rooms = [...new Set([...(initial?.rooms || []), r])];
      const p = { room: r, rooms, me, prefs: initial?.prefs || S.DEFAULT_PREFS };
      await S.saveProfile(p);
      onDone(p);
    } catch (e) {
      setErr("Couldn't reach the table: " + (e.message || e));
    } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={st.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, padding: 24, justifyContent: "center", gap: 14 }}>
        <Text style={st.h1}>Prompt</Text>
        <Text style={st.note}>Pick a table name. Give the same name to a friend and you'll share a table.</Text>
        <Field label="Your name" value={name} onChangeText={setName} placeholder="Scott" />
        <Field label="Table name" value={room} onChangeText={setRoom} placeholder="scott-and-sam" autoCapitalize="none" />
        {!!err && <Text style={[st.note, { color: C.hot }]}>{err}</Text>}
        <Btn primary label={busy ? "Joining…" : "Sit down"} onPress={go} disabled={busy} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ---------------- game shell ---------------- */
function Game({ profile, setProfile }) {
  const { room, me } = profile;
  const rooms = useMemo(() => [...new Set([...(profile.rooms || []), room])], [profile.rooms, room]);
  const prefs = { ...S.DEFAULT_PREFS, ...(profile.prefs || {}) };
  const lib = M.libRoom(me.id);
  const allRooms = useMemo(() => [...rooms, lib], [rooms, lib]);
  const { states, error, refresh } = useRooms(allRooms);
  const state = states[room];
  const paused = profile.paused || [];
  const ctx = { rooms, live: rooms.filter((r) => !paused.includes(r)), paused, states, room, me };
  const togglePause = async (r) => {
    const on = !paused.includes(r);
    const p = { ...profile, paused: on ? [...paused, r] : paused.filter((x) => x !== r) };
    await S.saveProfile(p);
    setProfile(p);
    say((on ? "Disabled " : "Enabled ") + r);
  };
  const [switcher, setSwitcher] = useState(false);
  const [tab, setTab0] = useState("card");          // play views: table · card · hand
  const [section, setSection] = useState("play");   // drawer: play · decks · me · settings
  const setTab = (t) => { setSection("play"); setTab0(t); };
  const [drawer, setDrawer] = useState(false);
  const [editReq, setEditReq] = useState(null);     // card id to open in My decks
  const [focusHand, setFocusHand] = useState(null);
  const [msg, setMsg] = useState("");
  const [boardTouch, setBoardTouch] = useState(false);
  const say = (t) => { setMsg(t); setTimeout(() => setMsg((m) => (m === t ? "" : m)), 4000); };

  // Your decks are one library shared by every table; keep the tables' copies in step with it.
  useEffect(() => {
    (async () => { try { await M.ensureLibrary(me); await M.syncLibrary(rooms, me.id); refresh(); } catch {} })();
  }, [rooms.join("|")]);
  const libAct = (fn, ok) => act(async () => {
    const mine = (st1) => ({ cards: st1.cards.map((c) => c.id), decks: (st1.decks || []).map((d) => d.id) });
    const before = mine(await S.fetchRoom(lib));
    await fn();
    const after = mine(await S.fetchRoom(lib));
    await M.syncLibrary(rooms, me.id, { cards: before.cards.filter((id) => !after.cards.includes(id)), decks: before.decks.filter((id) => !after.decks.includes(id)) });
  }, ok);

  // Notifications: channels, permission, and button presses while the app is open.
  useEffect(() => {
    (async () => {
      await N.setupNotifications();
      const ok = await N.ensurePermission();
      if (!ok) say("Notifications are off. Turn them on in Android settings to get cards.");
      const last = Notifications.getLastNotificationResponse();
      if (last) await onResponse(last);
      await S.ensureDeck(room, me).catch(() => {});
      await N.claimDeliveredDeal(room, me).catch(() => {});
      await S.claimTakeover(room, me, prefs).catch(() => {});
      if (N.consumeShowCard()) setTab("card");
      await syncMaps();
      refresh();
    })();
    const sub = Notifications.addNotificationResponseReceivedListener(onResponse);
    const app = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        if (N.consumeShowCard()) setTab("card");
        N.claimDeliveredDeal(room, me).catch(() => {}).then(() => S.claimTakeover(room, me, prefs)).catch(() => {}).then(syncMaps).finally(refresh);
      }
    });
    return () => { sub.remove(); app.remove(); };
  }, [room]);

  async function syncMaps() {
    try { const n = await S.syncMaps(room, me); if (n) say(n === 1 ? "You missed a map spot. Its card is in your hand." : `You missed ${n} map spots. Their cards are in your hand.`); } catch {}
  }

  async function onResponse(r) {
    try {
      const focus = await N.handleResponse(r);
      if (focus?.handId) { setTab("hand"); setFocusHand(focus.handId); }
      else if (focus?.tab) setTab("card");
      Notifications.clearLastNotificationResponse?.();
    } catch (e) { say("Couldn't save that: " + (e.message || e)); }
    refresh();
  }

  // Keep this phone's upcoming deals in step with the deck, randomness and your settings.
  const planKey = useMemo(() => state && JSON.stringify([
    myDeck(state.cards, state.players, me.id).map((c) => [c.id, c.label, c.every, c.imm, c.active, c.quota, c.amounts, (c.drawLog || []).length, c.deck]),
    (state.decks || []).map((d) => [d.id, d.active]),
    myChaos(state.players, me.id, state.config.chaos), prefs, state.hands.length, state.plays.length, paused.includes(room),
  ]), [state, profile.prefs, profile.paused]);
  useEffect(() => {
    if (!state) return;
    // A paused table deals nothing to this phone.
    const t = setTimeout(() => { (paused.includes(room) ? N.cancelKind("deal") : N.rescheduleDeals(room, me, prefs, state)).catch(() => {}); }, 1500);
    return () => clearTimeout(t);
  }, [planKey]);

  // A card that landed here some other way (a notification, a takeover) still counts at every table it applies to.
  const mirrorKey = state && JSON.stringify([room, state.tables[me.id]?.drawnAt, state.tables[me.id]?.link, rooms.map((r) => !!states[r])]);
  useEffect(() => {
    const t = state?.tables[me.id];
    if (!t || t.empty || t.link || paused.includes(room) || rooms.some((r) => !states[r])) return;
    if (rooms.some((r) => r !== room && states[r].tables[me.id] && !states[r].tables[me.id].empty)) return;
    M.mirrorTop(ctx, room).then(refresh).catch(() => {});
  }, [mirrorKey]);

  const switchTo = async (r) => {
    setSwitcher(false);
    if (r === room) return;
    const p = { ...profile, room: r, rooms };
    await S.saveProfile(p);
    setProfile(p);
  };
  const leaveTable = async (r) => {
    const left = rooms.filter((x) => x !== r);
    if (r === room) await N.cancelKind("deal");
    const p = { ...profile, room: r === room ? left[0] || null : room, rooms: left };
    await S.saveProfile(p);
    if (!left.length) setSwitcher(false);
    setProfile(p);
    say("Left " + r);
  };
  const addTable = async (raw) => {
    const r = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (r.length < 3) throw new Error("Table names need at least 3 letters.");
    await S.joinRoom(r, me);
    await S.ensureDeck(r, me).catch(() => {});
    await M.syncLibrary([r], me.id).catch(() => {});
    const p = { ...profile, room: r, rooms: [...new Set([...rooms, r])] };
    await S.saveProfile(p);
    setSwitcher(false);
    setProfile(p);
  };

  // Every move can be undone: the last 10 are kept. Undo restores only the docs that move changed.
  const [undos, setUndos] = useState([]);
  const [undoing, setUndoing] = useState(false);
  const act = async (fn, ok) => {
    let before = null;
    try { before = await S.snapshot(allRooms); } catch {}
    try {
      await fn();
      if (before) {
        try {
          const changes = S.diffSnap(before, await S.snapshot(allRooms));
          if (changes.length) setUndos((u) => [...u.slice(-9), { label: ok || "last move", changes }]);
        } catch {}
      }
      if (ok) say(ok);
    } catch (e) { say("Couldn't save: " + (e.message || e)); }
    refresh();
  };
  const undo = async () => {
    const last = undos[undos.length - 1];
    if (!last || undoing) return;
    setUndoing(true);
    try { await S.restore(last.changes); setUndos((u) => u.slice(0, -1)); say("Undid: " + last.label); }
    catch (e) { say("Couldn't undo: " + (e.message || e)); }
    finally { setUndoing(false); refresh(); }
  };

  if (!state) {
    return <Centered>{error ? <><Text style={st.h2}>Can't reach the table</Text><Text style={st.note}>{error}</Text><Btn label="Try again" onPress={refresh} /></> : <ActivityIndicator color={C.accent} />}</Centered>;
  }
  const groups = M.handGroups(ctx);
  const hereN = groups.filter((g) => g.here).length;

  const cardMode = section === "play" && tab === "card";
  return (
    <SafeAreaView style={st.screen} edges={["top", "left", "right"]}>
      <StatusBar style="dark" />
      {cardMode && <CardView onEdit={(id, label) => { setEditReq({ id, label }); setSection("decks"); }} onTogglePause={togglePause} ctx={ctx} state={state} room={room} me={me} act={act} goTo={(t) => (t === "deck" ? setSection("decks") : setTab(t))} prefs={prefs} say={say} />}
      <View style={st.topRow} pointerEvents="box-none">
        <Pressable onPress={() => setDrawer(true)} style={st.menuBtn} hitSlop={8} accessibilityRole="button" accessibilityLabel="Open menu">
          <View style={st.menuLine} /><View style={st.menuLine} /><View style={st.menuLine} />
        </Pressable>
        {!!undos.length && (
          <Pressable onPress={undo} disabled={undoing} style={st.undoBtn} hitSlop={6} accessibilityRole="button" accessibilityLabel={"Undo " + undos[undos.length - 1].label}>
            <Text style={st.undoIcon}>↶</Text>
          </Pressable>
        )}
      </View>
      {section !== "play" && <View style={st.header}><Text style={st.h2}>{SECTIONS.find((x) => x[0] === section)[1]}</Text></View>}
      {!cardMode && (
      <ScrollView scrollEnabled={!boardTouch} contentContainerStyle={{ padding: 16, paddingBottom: section === "play" ? 48 + WHEEL_H + 24 : 48, gap: 18 }}>
        {section === "play" && tab === "hand" && <HandView ctx={ctx} state={state} room={room} me={me} act={act} focusHand={focusHand} />}
        {section === "play" && tab === "table" && <TableTab ctx={ctx} onPickTable={switchTo} openTables={() => setSwitcher(true)} state={state} room={room} me={me} act={act} say={say} setBoardTouch={setBoardTouch} />}
        {section === "decks" && (states[lib] ? <DeckView state={M.libraryView(states[lib], state)} room={lib} me={me} act={libAct} editReq={editReq} clearEditReq={() => setEditReq(null)} /> : <ActivityIndicator color={C.accent} />)}
        {section === "me" && <MeView part="me" profile={profile} rooms={rooms} prefs={prefs} setProfile={setProfile} act={act} state={state} openSwitcher={() => setSwitcher(true)} onLeave={() => leaveTable(room)} />}
        {section === "settings" && <MeView part="settings" profile={profile} rooms={rooms} prefs={prefs} setProfile={setProfile} act={act} state={state} />}
      </ScrollView>)}
      {section === "play" && <ModeWheel mode={tab} onPick={setTab} handN={hereN} handMore={groups.length - hereN} />}
      {!!msg && (
        <View style={[st.toast, st.row, { alignItems: "center" }]}>
          <Text style={[st.toastTxt, { flex: 1 }]}>{msg}</Text>
          {!!undos.length && !msg.startsWith("Undid") && !msg.startsWith("Couldn't") && (
            <Pressable onPress={undo} disabled={undoing} hitSlop={10} accessibilityRole="button"><Text style={st.toastUndo}>UNDO</Text></Pressable>
          )}
        </View>
      )}
      <TableSwitcher open={switcher} ctx={ctx} onClose={() => setSwitcher(false)} onPick={switchTo} onAdd={addTable} onLeave={leaveTable} onPause={togglePause} />
      <Drawer open={drawer} setOpen={setDrawer} section={section} name={me.name} room={room}
        onPick={(k) => { setDrawer(false); setSection(k); }} />
    </SafeAreaView>
  );
}

/* ---------------- card (home) ---------------- */
// Just the card in front of you. Tap to pull one, then play it or hold it.
// The card is the whole screen. Everything else sits on top of it.
function CardView({ ctx, state, room, me, act, goTo, prefs, say, onTogglePause: togglePauseRef, onEdit }) {
  const ins = useSafeAreaInsets();
  const found = M.findTop(ctx);
  const top = found?.t || null, from = found?.room || room;
  const fromState = ctx.states[from] || state;
  const counts = top ? M.topTables(ctx, from, top) : [];
  const countsHere = counts.includes(room);
  const card = top && fromState.cards.find((c) => c.id === top.cardId);
  const beef = top ? (top.beef ?? card?.beef ?? null) : null;
  // Where it lands: each table it counts at, and the maps there with an open spot for it.
  const where = counts.map((r) => {
    const s1 = ctx.states[r], tr = s1?.tables[me.id];
    const maps = tr ? [...new Set(fitsSpots((s1.maps || []).filter((m) => m.owner === me.id && m.active !== false), tr).map((f) => f.map.name))] : [];
    const others = (s1?.players || []).filter((p) => p.id !== me.id);
    return { room: r, maps, with: others.length === 1 ? others[0].name || "1 player" : others.length ? String(others.length) : "" };
  });
  const emojis = top ? cardEmojis(ctx.states[M.libRoom(me.id)] || fromState, me.id, top.base || top.label) : [];
  const sc = top ? C.suit[top.suit] : C.accent;
  const tint = mix(C.paper, sc, 0.3), ink2 = mix(sc, C.ink, 0.45);
  const [later, setLater] = useState(false);
  // The tray can be closed (the card still swipes); "?" brings it back. Remembered on this phone.
  const [tray, setTray] = useState(true);
  useEffect(() => { AsyncStorage.getItem(TRAY_KEY).then((v) => { if (v === "0") setTray(false); }).catch(() => {}); }, []);
  const showTray = (v) => { setTray(v); AsyncStorage.setItem(TRAY_KEY, v ? "1" : "0").catch(() => {}); };
  const setReminder = async (at) => {
    setLater(false);
    await act(async () => {
      const handId = await M.holdTop(ctx, from, top, at);
      await N.scheduleReminder(from, handId, top, at);
    }, "Held. Reminder at " + fmtTime(at));
  };
  const locks = activeLocks(fromState.cards, fromState.hands, me.id);
  const wait = top && bufferBlock(card, fromState.plays, me.id);
  const blocked = top && (!canPlay(locks, [top.cardId]) || !!wait);
  const padTop = 64, padBottom = ins.bottom + WHEEL_H + 44;
  const canPull = drawable(state.cards, state.players, state.hands, state.tables, me.id, state.decks).length > 0;
  return (
    <View style={StyleSheet.absoluteFill}>
      {top ? (
        <>
          <SwipeCard key={top.drawnAt} t={top} tint={tint} say={say} blockedMsg={wait ? "Not yet. " + bufferMessage(wait) : blocked ? lockMessage(locks) : ""}
            onSwipe={(it) => act(async () => {
              const r = await M.swipeAll(ctx, from, top, it);
              if (r?.handId && r.remindAt) await N.scheduleReminder(from, r.handId, top, r.remindAt);
            }, swipeLabel(it) + ": " + top.label)}>
            {/* Suit color does the talking: a solid band up top, a tinted face, double rules and frame in a darker shade. */}
            <View pointerEvents="none" style={[st.cardBand, { height: ins.top + padTop + 58, backgroundColor: sc }]}>
              <View style={[st.bandRule, { backgroundColor: ink2, bottom: 0 }]} />
              <View style={[st.bandRule, { backgroundColor: ink2, bottom: 5, height: 1 }]} />
            </View>
            <View pointerEvents="none" style={[st.cardFrame, { top: ins.top + padTop + 70, bottom: padBottom + 130, borderColor: ink2 }]} />
            <View pointerEvents="none" style={[st.cardFrame, { top: ins.top + padTop + 75, bottom: padBottom + 135, left: 17, right: 17, borderWidth: 1, borderColor: ink2, opacity: 0.6 }]} />
            <View pointerEvents="none" style={[st.cardFoot, { height: padBottom + 118, backgroundColor: sc }]}>
              <View style={[st.bandRule, { backgroundColor: ink2, top: 0 }]} />
              <View style={[st.bandRule, { backgroundColor: ink2, top: 5, height: 1 }]} />
            </View>
            <View style={[st.fullCardBody, { paddingTop: ins.top + padTop, paddingBottom: padBottom + 140 }]}>
              <View style={st.cardHead}>
                <View style={st.fullCorner}>
                  <Text style={[st.fullSuit, { color: C.ink }]}>{SUIT[top.suit]}</Text>
                  {!!beef && <Text style={[st.fullBeef, { color: C.ink }]}>{beef}</Text>}
                </View>
                <View style={[st.row, { gap: 12 }]}>
                  <Text style={[st.cardKicker, { color: C.ink }]}>{(SUIT_NAMES[top.suit] || "").toUpperCase()}</Text>
                  {!!card && (
                    <Pressable onPress={() => onEdit(card.id, card.label)} hitSlop={10} style={[st.editBtn, { borderColor: C.ink }]} accessibilityRole="button" accessibilityLabel={"Edit " + top.label}>
                      <Text style={[st.editIcon, { color: C.ink }]}>✎</Text>
                    </Pressable>
                  )}
                </View>
              </View>
              <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 14, paddingHorizontal: 14 }}>
                <Text style={st.fullTitle}>{top.label}</Text>
                <View style={[st.titleRule, { backgroundColor: ink2 }]}><View style={[st.titleDot, { backgroundColor: sc, borderColor: ink2 }]} /></View>
                {!!top.variant && <Text style={[st.fullVar, { color: ink2 }]}>{top.variant}</Text>}
                {!!card && !!quotaLabel(card, Date.now(), prefs) && <Text style={[st.fullVar, { fontSize: 14, color: ink2 }]}>{quotaLabel(card, Date.now(), prefs)}</Text>}
                {!!locks.length && <Text style={[st.fullVar, { color: C.hot }]}>🔒 {lockMessage(locks)}</Text>}
                {!!wait && <Text style={[st.fullVar, { color: C.hot }]}>⏳ {bufferMessage(wait)}</Text>}
              </View>
              {!!emojis.length && (
                <View style={[st.deckLogo, { left: 28, bottom: padBottom + 148, borderColor: ink2 }]} accessibilityLabel={"Deck " + emojis.join(" ")}>
                  {emojis.map((e) => <Text key={e} style={st.deckLogoTxt}>{e}</Text>)}
                </View>
              )}
              <View style={[st.fullCorner, { position: "absolute", right: 28, bottom: padBottom + 150, transform: [{ rotate: "180deg" }] }]}>
                <Text style={[st.fullSuit, { fontSize: 24, color: sc }]}>{SUIT[top.suit]}</Text>
                {!!beef && <Text style={[st.fullBeef, { fontSize: 30, lineHeight: 34, color: ink2 }]}>{beef}</Text>}
              </View>
            </View>
          </SwipeCard>
          {!tray && (
            <Pressable onPress={() => showTray(true)} hitSlop={10} style={[st.helpBtn, { bottom: padBottom - 2 }]} accessibilityRole="button" accessibilityLabel="Show card controls and help">
              <Text style={st.helpTxt}>?</Text>
            </Pressable>
          )}
          {tray && <View pointerEvents="box-none" style={[st.cardControls, { bottom: padBottom - 6 }]}>
            <Pressable onPress={() => showTray(false)} hitSlop={10} style={st.trayClose} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={st.trayCloseTxt}>✕</Text>
            </Pressable>
            <View style={{ alignSelf: "stretch", gap: 2, paddingHorizontal: 26 }}>
              {!countsHere && ctx.rooms.length > 1 && <Text style={[st.whereLine, { color: C.warm }]}>Pulled at {from} · doesn't count here</Text>}
              {where.map((w) => (
                <Text key={w.room} style={st.whereLine} numberOfLines={1}>
                  {w.maps.length ? <><Text style={st.whereDim}>on </Text>{w.maps.join(" & ")} </> : null}
                  <Text style={st.whereDim}>at </Text>{w.room}
                  {w.with ? <><Text style={st.whereDim}> with </Text>{w.with}</> : null}
                </Text>
              ))}
            </View>
            <View style={[st.row, { width: "100%" }]}>
              <Btn primary flex label={wait ? "Wait" : blocked ? "Locked" : "Play"} disabled={blocked} onPress={() => act(() => M.playTop(ctx, from, top), "Played: " + top.label)} />
              <Btn flex label="Hold" onPress={() => act(() => M.holdTop(ctx, from, top), "Held: " + top.label)} />
            </View>
            <Pressable onPress={() => setLater(true)} hitSlop={10}><Text style={st.link}>Snooze…</Text></Pressable>
            <Text style={st.swipeHint}>↑ play · ↓ hold · ← less often · → snooze 30 min</Text>
          </View>}
        </>
      ) : ctx.paused.includes(room) ? (
        <View style={[st.home, { paddingTop: ins.top + padTop }]}>
          <Text style={[st.h2, { textAlign: "center" }]}>{room} is disabled</Text>
          <Text style={[st.note, { maxWidth: 300 }]}>Nothing is dealt here and your plays don't count here until you enable it.</Text>
          <Btn primary label="Enable this table" onPress={() => togglePauseRef(room)} />
        </View>
      ) : canPull ? (
        <Pressable onPress={() => act(() => M.drawAll(ctx, prefs))} style={[st.fullBack, { top: ins.top + 6 }]} accessibilityRole="button" accessibilityLabel="Tap to pull a card">
          <View style={st.fullBackInner}><View style={st.drawBtn}><Text style={st.drawTxt}>Tap to pull a card</Text></View></View>
        </Pressable>
      ) : (
        <View style={[st.home, { paddingTop: ins.top + padTop }]}>
          <Text style={[st.h2, { textAlign: "center" }]}>Nothing left to pull</Text>
          <Text style={[st.note, { maxWidth: 300 }]}>{state.hands.some((h) => h.seat === me.id) ? "Every card in your deck is in your hand. Play or discard some to put them back in the deck." : "Your deck at this table is empty or switched off. Add a card in My decks."}</Text>
          <View style={[st.row, { width: 300, maxWidth: "90%" }]}>
            <Btn flex primary label="Open hand" onPress={() => goTo("hand")} />
            <Btn flex label="Add a card" onPress={() => goTo("deck")} />
          </View>
        </View>
      )}
      <LaterSheet open={later} label={top?.label} onClose={() => setLater(false)} onPick={setReminder} />
    </View>
  );
}

/* ---------------- hand ---------------- */
// Select one card to play, remind or discard; select several to play them together.
// Cards held at this table are full size; cards held only at your other tables shrink and fade,
// tagged with where they're parked. Switch tables and different cards grow.
function HandView({ ctx, state, room, me, act, focusHand }) {
  const groups = M.handGroups(ctx);
  const here = groups.filter((g) => g.here), away = groups.filter((g) => !g.here);
  const keyOfHand = (id) => groups.find((g) => g.places.some((p) => p.room === room && p.h.id === id))?.key;
  const [sel, setSel] = useState(focusHand ? [keyOfHand(focusHand)].filter(Boolean) : []);
  const [later, setLater] = useState(null);
  useEffect(() => { const k = focusHand && keyOfHand(focusHand); if (k) setSel([k]); }, [focusHand]);
  useEffect(() => { setSel([]); }, [room]);
  const picked = groups.filter((g) => sel.includes(g.key));
  const toggle = (k) => setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const myTurn = state.game.active === me.id;
  const locks = activeLocks(state.cards, state.hands, me.id);
  const waitOf = (g) => { const st1 = ctx.states[g.places[0].room]; return st1 && bufferBlock(st1.cards.find((c) => c.id === g.places[0].h.cardId), st1.plays, me.id); };
  const waiting = picked.map(waitOf).find(Boolean);
  const hereCardIds = picked.map((g) => g.places.find((p) => p.room === room)?.h.cardId).filter(Boolean);
  const blocked = picked.length > 0 && (!canPlay(locks, hereCardIds) || !!waiting);
  const mixed = picked.length > 1 && picked.some((g) => !g.here);
  const setReminder = async (at) => {
    const g = later; setLater(null);
    const p = g.places.find((x) => x.room === room) || g.places[0];
    await act(async () => { await S.setRemind(p.room, p.h.id, at); await N.scheduleReminder(p.room, p.h.id, p.h, at); }, "Reminder at " + fmtTime(at));
  };
  if (!groups.length) return <View style={{ paddingTop: 60, gap: 8 }}><Text style={st.h2}>Empty hand.</Text><Text style={[st.note, { textAlign: "left" }]}>Cards you hold show up here.</Text></View>;
  const cardOf = (g) => ctx.states[g.places[0].room]?.cards.find((c) => c.id === g.places[0].h.cardId);
  const tile = (g) => {
    const h = g.h, hot = heat(h), on = sel.includes(g.key), w = waitOf(g);
    const remind = h.remindAt && Date.parse(h.remindAt) > Date.now();
    const elsewhere = g.places.map((p) => p.room).filter((r) => r !== room);
    return (
      <Pressable key={g.key} onPress={() => toggle(g.key)} accessibilityState={{ selected: on }}
        accessibilityLabel={h.label + (g.here ? "" : ", held at " + elsewhere.join(" and "))}
        style={[st.mini, { backgroundColor: mix(C.paper, C.suit[h.suit] || C.accent, 0.28), borderTopColor: C.suit[h.suit], borderTopWidth: 6 }, g.here ? st.miniGrid : st.miniAway, hot === "warm" && { borderColor: C.warm }, hot === "hot" && { borderColor: C.hot }, on && st.miniSel]}>
        <View style={[st.row, { justifyContent: "space-between" }]}>
          <Text style={[st.miniMeta, { color: C.suit[h.suit], fontSize: 15 }]}>{SUIT[h.suit]}{(h.beef ?? cardOf(g)?.beef) ? <Text style={st.miniBeef}> {h.beef ?? cardOf(g)?.beef}</Text> : null}</Text>
          {on ? <View style={st.check}><Text style={st.checkTxt}>✓</Text></View> : <Text style={{ fontSize: g.here ? 15 : 11 }}>{cardEmojis(ctx.states[M.libRoom(me.id)] || ctx.states[g.places[0].room], me.id, h.base || h.label).join("")}</Text>}
        </View>
        <Text style={g.here ? st.miniLabel : st.miniLabelAway} numberOfLines={g.here ? 3 : 2}>{h.label}</Text>
        {g.here && !!h.variant && <Text style={st.miniMeta} numberOfLines={2}>{h.variant}</Text>}
        {g.here ? (
          <Text style={st.miniMeta}>{w ? "⏳ " + fmtTime(new Date(w.until)) : remind ? "⏰ " + fmtTime(h.remindAt) : "held " + ago(h.heldAt)}{elsewhere.length ? "  ⇄ " + elsewhere.length : ""}</Text>
        ) : (
          <View style={st.awayTag}><Text style={st.awayTagTxt} numberOfLines={1}>↗ {elsewhere.join(", ")}</Text></View>
        )}
      </Pressable>
    );
  };
  return (
    <>
      {!!locks.length && <LockBanner locks={locks} />}
      <Text style={st.label}>{here.length} AT THIS TABLE · TAP TO SELECT{picked.length > 1 ? " · " + picked.length + " SELECTED" : ""}</Text>
      {here.length ? <View style={st.handGrid}>{here.map(tile)}</View> : <Text style={[st.note, { textAlign: "left" }]}>Nothing held at this table.</Text>}
      {!!away.length && (
        <>
          <Text style={st.label}>{away.length} AT YOUR OTHER TABLES</Text>
          <View style={st.handGrid}>{away.map(tile)}</View>
        </>
      )}
      {!!waiting && <Text style={[st.note, { textAlign: "left" }]}>⏳ {bufferMessage(waiting)}</Text>}
      {picked.length === 1 && (
        <View style={{ gap: 8 }}>
          {!picked[0].here && <Text style={[st.note, { textAlign: "left" }]}>Doesn't count at this table. Playing it counts at {picked[0].places.map((p) => p.room).join(" · ")}.</Text>}
          <View style={st.row}>
            <Btn primary flex label={blocked ? "Locked" : "Play it"} disabled={blocked} onPress={() => { const g = picked[0]; setSel([]); act(() => M.playGroup(ctx, g), "Played: " + g.h.label); }} />
            <Btn flex label="Remind" onPress={() => setLater(picked[0])} />
            <Btn flex label="Discard" onPress={() => { const g = picked[0]; setSel([]); act(() => M.discardGroup(ctx, g), "Discarded: " + g.h.label); }} />
          </View>
        </View>
      )}
      {picked.length > 1 && (
        <View style={{ gap: 8 }}>
          <Text style={[st.note, { textAlign: "left" }]}>{picked.map((g) => g.h.label).join(" + ")}</Text>
          {mixed ? <Text style={[st.note, { textAlign: "left" }]}>Only cards held at this table can be played together here.</Text> : (
            <View style={st.row}>
              <Btn primary flex label={blocked ? "Locked" : "Play " + picked.length + " together"} disabled={blocked} onPress={() => { const gs = picked; setSel([]); act(() => M.playGroupsTogether(ctx, gs), "Played together"); }} />
              <Btn flex label="Clear" onPress={() => setSel([])} />
            </View>
          )}
          {mixed && <Btn label="Clear" onPress={() => setSel([])} />}
          {!myTurn && !mixed && <Text style={[st.note, { textAlign: "left" }]}>It's not your turn, but you can still play.</Text>}
        </View>
      )}
      <LaterSheet open={!!later} label={later?.h.label} onClose={() => setLater(null)} onPick={setReminder} />
    </>
  );
}

function LockBanner({ locks }) {
  return <View style={st.lock}><Text style={st.lockTxt}>🔒 {lockMessage(locks)}</Text></View>;
}

/* Solitaire-style stack: one edge per card underneath, the newest card face up on top. */
function Stack({ s, fresh }) {
  const n = s.cards.length, edges = Math.min(n - 1, 11), top = s.cards[n - 1];
  return (
    <View style={{ width: 72, height: 100 + edges * 6 }}>
      {Array.from({ length: edges }).map((_, i) => (
        <View key={i} style={[st.stackEdge, { top: i * 6, borderTopColor: C.suit[s.suit] }]} />
      ))}
      <View style={[st.pc, st.stackTop, { top: edges * 6, borderTopColor: C.suit[s.suit] }, fresh && st.fresh]}>
        <View style={[st.row, { justifyContent: "space-between" }]}><Text style={[st.pcMeta, { color: C.suit[s.suit] }]}>{SUIT[s.suit]}</Text>{n > 1 && <Text style={st.stackN}>×{n}</Text>}</View>
        <Text style={st.pcLabel} numberOfLines={3}>{s.total ? amountLabel(s.label, s.total) : s.label}</Text>
        <Text style={st.pcMeta}>{ago(top.at)}</Text>
      </View>
    </View>
  );
}

/* The top card, swipeable: up play · down hold · lean right "sooner/more" · lean left "later/less". */
function SwipeCard({ t, tint, blockedMsg, onSwipe, say, children }) {
  const ins = useSafeAreaInsets();
  const pos = useRef(new Animated.ValueXY()).current;
  const [intent, setIntent] = useState(null);
  const live = useRef({});
  live.current = { blockedMsg, onSwipe, say };
  const lastKind = useRef(null);
  const pr = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 6,
    onPanResponderMove: (_, g) => {
      pos.setValue({ x: g.dx, y: g.dy });
      const it = swipeIntent(g.dx, g.dy);
      const key = it ? it.kind + Math.sign(it.tilt) + (Math.abs(it.tilt) > 0.55 ? "!" : "") : null;
      if (key !== lastKind.current) { lastKind.current = key; if (it) Vibration.vibrate(8); }
      setIntent(it);
    },
    onPanResponderRelease: (_, g) => {
      const it = swipeIntent(g.dx, g.dy);
      lastKind.current = null;
      const back = () => { Animated.spring(pos, { toValue: { x: 0, y: 0 }, friction: 6, useNativeDriver: false }).start(); setIntent(null); };
      if (!it) return back();
      if (it.kind === "play" && live.current.blockedMsg) { back(); return live.current.say(live.current.blockedMsg); }
      const d = Math.hypot(g.dx, g.dy) || 1;
      Animated.timing(pos, { toValue: { x: (g.dx / d) * 900, y: (g.dy / d) * 1200 }, duration: 230, useNativeDriver: false }).start(() => live.current.onSwipe(it));
    },
    onPanResponderTerminate: () => { Animated.spring(pos, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start(); setIntent(null); },
  }), []);
  const rotate = pos.x.interpolate({ inputRange: [-300, 0, 300], outputRange: ["-8deg", "0deg", "8deg"] });
  const tone = !intent ? null : intent.kind === "play" ? C.accent : intent.kind === "hold" ? C.suit.home : intent.kind === "soon" ? C.warm : C.muted;
  return (
    <Animated.View {...pr.panHandlers} style={[st.fullCard, tint && { backgroundColor: tint }, { transform: [{ translateX: pos.x }, { translateY: pos.y }, { rotate }] }]}>
      {children}
      {!!intent && (
        <View pointerEvents="none" style={[st.swipeTag, { top: ins.top + 100, borderColor: tone }]}>
          <Text style={[st.swipeTagTxt, { color: C.ink }]}>{swipeLabel(intent)}</Text>
        </View>
      )}
    </Animated.View>
  );
}

/* ---------------- play-mode wheel ---------------- */
// Table, Card and Hand sit 120° apart on one wheel, seen tilted so its rim is a wide, shallow ellipse.
// Changing view turns the wheel a third of a turn. It loops: no first view, no last.
const MODES = [["table", "Table"], ["card", "Card"], ["hand", "Hand"]];
const WHEEL_H = 96;
const mod3 = (n) => ((n % 3) + 3) % 3;
/** Blend two "#rrggbb" colors: t=0 → a, t=1 → b. */
const mix = (a, b, t) => { const p = (h) => { const x = String(h).replace("#", ""); const n = parseInt(x.length === 3 ? x.replace(/./g, "$&$&") : x, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const A = p(a), B = p(b); return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join(""); };
/** "#rrggbb" + alpha → rgba() */
const fade = (hex, a) => { const h = String(hex).replace("#", ""); const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
function ModeWheel({ mode, onPick, handN, handMore }) {
  const ins = useSafeAreaInsets();
  const W = Dimensions.get("window").width;
  const RX = W * 0.29, RY = 26;             // the rim: wide and shallow
  const want = Math.max(0, MODES.findIndex((m) => m[0] === mode));
  const [cur, setCur] = useState(want);     // unbounded, so the wheel always turns the short way
  const [pos, setPos] = useState(want);     // animated position, in thirds of a turn
  const p = useRef(new Animated.Value(want)).current;
  useEffect(() => { const id = p.addListener(({ value }) => setPos(value)); return () => p.removeListener(id); }, []);
  useEffect(() => {
    if (mod3(cur) === want) return;
    const d = mod3(want - cur);
    setCur(cur + (d === 2 ? -1 : d));
  }, [want]);
  useEffect(() => { Animated.spring(p, { toValue: cur, useNativeDriver: false, bounciness: 3, speed: 9 }).start(); }, [cur]);
  const go = (n) => { const next = cur + n; setCur(next); onPick(MODES[mod3(next)][0]); };
  const live = useRef(go); live.current = go;
  const swipe = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderRelease: (_, g) => { if (Math.abs(g.dx) > 40) live.current(g.dx < 0 ? 1 : -1); },
  })).current;
  return (
    <View style={[st.wheel, { height: WHEEL_H + ins.bottom + 40, paddingBottom: ins.bottom + 8 }]} {...swipe.panHandlers}>
      {/* Fog: the screen behind the menu fades out toward the bottom. */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {Array.from({ length: 14 }, (_, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: fade(C.bg, Math.min(0.96, Math.pow((i + 1) / 14, 1.6))) }} />
        ))}
      </View>
      <View style={[st.row, { flex: 1, alignItems: "flex-end", paddingHorizontal: 10 }]}>
        <Pressable onPress={() => go(-1)} hitSlop={12} style={st.wheelArrow} accessibilityRole="button" accessibilityLabel={"Previous: " + MODES[mod3(cur - 1)][1]}>
          <Text style={st.wheelArrowTxt}>‹</Text>
        </Pressable>
        <View style={{ flex: 1, height: WHEEL_H }} pointerEvents="box-none">
          {MODES.map(([k, l], i) => {
            let d = i - pos; d = d - 3 * Math.round(d / 3);   // −1.5…1.5 thirds from the top of the wheel
            const th = d * (2 * Math.PI / 3);
            const front = (1 + Math.cos(th)) / 2;              // 1 at the top, 0 at the far side
            const on = i === mod3(cur);
            return (
              <View key={k} style={[st.wheelSlot, { opacity: Math.max(0, front * 1.25 - 0.15), zIndex: Math.round(front * 10),
                transform: [{ translateX: RX * Math.sin(th) }, { translateY: RY * (1 - Math.cos(th)) }, { rotate: (Math.sin(th) * 14) + "deg" }, { scale: 0.7 + 0.3 * front }] }]}>
                <Pressable onPress={() => !on && go(mod3(i - cur) === 1 ? 1 : -1)} hitSlop={10} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={l}>
                  <Text style={[st.wheelTxt, on && st.wheelTxtOn]}>
                    {l}{k === "hand" ? <Text style={st.wheelCount}> {handN}{handMore > 0 ? "+" + handMore : ""}</Text> : null}
                  </Text>
                </Pressable>
              </View>
            );
          })}
          <View pointerEvents="none" style={[st.wheelDot, { left: "50%" }]} />
        </View>
        <Pressable onPress={() => go(1)} hitSlop={12} style={st.wheelArrow} accessibilityRole="button" accessibilityLabel={"Next: " + MODES[mod3(cur + 1)][1]}>
          <Text style={st.wheelArrowTxt}>›</Text>
        </Pressable>
      </View>
    </View>
  );
}

function LaterSheet({ open, label, onClose, onPick }) {
  const [txt, setTxt] = useState("");
  const [err, setErr] = useState("");
  const quick = useMemo(() => {
    const now = new Date();
    const plus = (m) => new Date(now.getTime() + m * 6e4);
    const at = (h) => { const d = new Date(now); d.setHours(h, 0, 0, 0); return d; };
    return [["30 min", plus(30)], ["1 hour", plus(60)], ["2 hours", plus(120)], ["5 PM", at(17)], ["8 PM", at(20)]].filter(([, d]) => d.getTime() > now.getTime() + 60e3);
  }, [open]);
  const submit = () => {
    const d = parseLater(txt);
    if (!d || d.getTime() <= Date.now() + 60e3) { setErr("Try a time later today, like 3pm, 5:30, or in 2h."); return; }
    setTxt(""); setErr(""); onPick(d);
  };
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={st.scrim} onPress={onClose} />
      <View style={st.sheet}>
        <Text style={st.label}>REMIND ME ABOUT</Text>
        <Text style={st.h2}>{label}</Text>
        <View style={st.chips}>{quick.map(([l, d]) => <Chip key={l} label={l} onPress={() => onPick(d)} />)}</View>
        <View style={st.row}>
          <TextInput value={txt} onChangeText={setTxt} placeholder="3pm, 5:30, in 2h" placeholderTextColor={C.muted} style={[st.input, { flex: 1 }]} onSubmitEditing={submit} returnKeyType="done" />
          <Btn primary label="Set" onPress={submit} />
        </View>
        {!!err && <Text style={[st.note, { color: C.hot, textAlign: "left" }]}>{err}</Text>}
      </View>
    </Modal>
  );
}

/* ---------------- table ---------------- */
/* ---------------- table: players + maps ---------------- */
function TableTab({ ctx, onPickTable, openTables, state, room, me, act, say, setBoardTouch }) {
  const maps = (state.maps || []).filter((m) => m.owner === me.id);
  const [selId, setSel] = useState(null);
  const [lib, setLib] = useState(false);
  const cur = selId === "players" ? null : maps.find((m) => m.id === selId) || (selId == null ? maps.find((m) => m.active !== false) || null : null);
  const have = new Set(maps.map((m) => m.key));
  return (
    <>
      <View style={st.tablePick}>
        <Text style={st.label}>TABLE</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, alignItems: "center" }}>
          {ctx.rooms.map((r) => (
            <Pressable key={r} onPress={() => onPickTable(r)} style={[st.tableChip, r === room && st.tableChipOn]} accessibilityRole="tab" accessibilityState={{ selected: r === room }}>
              <Text style={[st.tableChipTxt, r === room && { color: C.ink }]}>{ctx.paused.includes(r) ? "○ " : ""}{r}</Text>
            </Pressable>
          ))}
          <Pressable onPress={openTables} style={st.tableChip} accessibilityRole="button" accessibilityLabel="Join or leave tables">
            <Text style={st.tableChipTxt}>+ Join · Leave</Text>
          </Pressable>
        </ScrollView>
      </View>
      <View style={st.chips}>
        <Chip label="Players" on={!cur} onPress={() => setSel("players")} />
        {maps.map((m) => <Chip key={m.id} label={(m.active === false ? "○ " : "") + m.name} on={cur?.id === m.id} onPress={() => setSel(m.id)} />)}
        <Chip label="+ Map" on={false} onPress={() => setLib(true)} />
      </View>
      {cur ? <MapTable key={cur.id} ctx={ctx} m0={cur} state={state} room={room} me={me} act={act} say={say} setBoardTouch={setBoardTouch} onRemoved={() => setSel(null)} /> : <TableView state={state} me={me} />}
      <Modal visible={lib} transparent animationType="slide" onRequestClose={() => setLib(false)}>
        <Pressable style={st.scrim} onPress={() => setLib(false)} />
        <ScrollView style={st.sheetScroll} contentContainerStyle={[st.sheet, { position: "relative" }]}>
          <Text style={st.h2}>Add a map</Text>
          <Text style={[st.note, { textAlign: "left" }]}>Maps run side by side. Cards you play land on the right spot by themselves; a missed spot gets an X and sends its card to your hand.</Text>
          {MAP_LIBRARY.map((t) => (
            <View key={t.key} style={st.panel}>
              <Text style={st.h3}>{t.name} · {PER_NAMES[t.per].toLowerCase()}</Text>
              <Text style={[st.note, { textAlign: "left" }]}>{t.about}</Text>
              {t.deckKey !== "everyday" && <Text style={[st.note, { textAlign: "left" }]}>Adds the {DECK_LIBRARY.find((d) => d.key === t.deckKey)?.name} deck if you don't have it.</Text>}
              <Btn primary={!have.has(t.key)} disabled={have.has(t.key)} label={have.has(t.key) ? "Added" : "Add " + t.name} onPress={() => {
                setLib(false); setSel(me.id + ":" + t.key);
                act(() => S.addLibraryMap(room, me, t.key), "Added " + t.name);
              }} />
            </View>
          ))}
        </ScrollView>
      </Modal>
    </>
  );
}

function MapTable({ ctx, m0, state, room, me, act, setBoardTouch, onRemoved }) {
  const [selCard, setSelCard] = useState(null);
  const [selSpot, setSelSpot] = useState(null);
  const [arm, setArm] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 60000); return () => clearInterval(t); }, []);
  const now = Date.now(), m = live({ ...m0, active: true }, now), paused = m0.active === false;
  const cards = myDeck(state.cards, state.players, me.id);
  const hand = state.hands.filter((h) => h.seat === me.id).sort((a, b) => (a.heldAt || "").localeCompare(b.heldAt || ""));
  const selH = hand.find((h) => h.id === selCard), selS = selSpot && m.spots[selSpot];
  const hl = new Set(selH && !paused ? fitsSpots([m], selH, now).map((f) => f.spot.id) : []);
  const open = Object.values(m.spots).filter((sp) => !sp.auto && spotState(m, sp, now) === "open").length;
  const play = (h, sid) => {
    const sh = m.shapes.find((x) => x.spots.includes(sid));
    setSelCard(null); setSelSpot(null);
    act(async () => { if (await S.playToSpot(room, me, h.id, m0.id, sid)) await M.playCopiesElsewhere(ctx, h); }, `Played ${h.label} on ${sh?.label || m.name}`);
  };
  const tapSpot = (sid) => {
    if (selH) {
      if (!paused && canPlayAt(m, m.spots[sid], selH, now)) return play(selH, sid);
      setSelCard(null);
    }
    setSelSpot(selSpot === sid ? null : sid);
  };
  const tapCard = (h) => {
    if (selS && !paused && canPlayAt(m, selS, h, now)) return play(h, selSpot);
    setSelCard(selCard === h.id ? null : h.id); setSelSpot(null);
  };
  let info;
  if (paused) info = "This map is paused. Cards you play won't land on it.";
  else if (selH) info = hl.size ? `${hl.size} spot${hl.size === 1 ? "" : "s"} lit up for ${selH.label}. Tap one to play it there.` : `No open spot on this map for ${selH.label} right now. Hold it, play it from the Hand tab, or discard it.`;
  else if (selS) {
    const stt = spotState(m, selS, now), n = hand.filter((h) => canPlayAt(m, selS, h, now)).length;
    const what = { missed: "Missed.", filled: "Played" + (selS.filled ? ": " + selS.filled.label : "") + ".", full: "Full.", skipped: "This was before you added the map.", waiting: "Waiting for the spots before it.", future: "Not open yet." }[stt]
      || (n ? `${n} card${n === 1 ? "" : "s"} in your hand fit. Tap one to play it here.` : "Open. Nothing in your hand fits.");
    info = `${describeAccepts(selS, cards)} · ${parseWhen(selS.when).label} · ${what}`;
  } else info = `${PER_NAMES[m.per]} map · ${open} spot${open === 1 ? "" : "s"} open now. Tap a card to light up its spots, or tap a spot.`;
  const best = selH && fitsSpots([m], selH, now)[0];
  return (
    <View style={{ gap: 10 }}>
      <MapBoard m={m} cards={cards} hl={hl} sel={selSpot} now={now} onSpot={tapSpot} onBlank={() => { setSelCard(null); setSelSpot(null); }} setBoardTouch={setBoardTouch} />
      <Text style={[st.note, { textAlign: "left" }]}>{info}</Text>
      {!!selH && (
        <View style={st.row}>
          <Btn primary flex disabled={!best || paused} label={hl.size === 1 ? "Play to its spot" : "Play to the best spot"} onPress={() => best && play(selH, best.spot.id)} />
          <Btn label="Cancel" onPress={() => setSelCard(null)} />
        </View>
      )}
      <Text style={st.label}>YOUR HAND · {hand.length}</Text>
      <ScrollView horizontal contentContainerStyle={{ gap: 10, paddingVertical: 4 }}>
        {hand.length ? hand.map((h) => {
          const fits = selS ? canPlayAt(m, selS, h, now) : null;
          return (
            <Pressable key={h.id} onPress={() => tapCard(h)} style={[st.mini, selCard === h.id && st.miniSel, fits === true && { borderColor: C.ink }, fits === false && { opacity: 0.38 }]}>
              <Text style={[st.miniMeta, { color: C.suit[h.suit] }]}>{SUIT[h.suit] || "●"}{h.fromMap ? " missed" : ""}</Text>
              <Text style={st.miniLabel}>{h.label}</Text>
              <Text style={st.miniMeta}> </Text>
            </Pressable>
          );
        }) : <Text style={[st.note, { textAlign: "left" }]}>Your hand is empty. Cards you hold, and cards from missed spots, show up here.</Text>}
      </ScrollView>
      <View style={st.row}>
        <Btn flex label={paused ? "Turn this map on" : "Pause map"} onPress={() => act(() => S.setMapActive(room, me, m0.id, paused), paused ? "Map on" : "Map paused")} />
        <Btn flex danger={arm} label={arm ? "Tap again to remove" : "Remove map"} onPress={() => {
          if (!arm) return setArm(true);
          onRemoved(); act(() => S.deleteMap(room, me, m0.id), "Removed " + m0.name);
        }} />
      </View>
    </View>
  );
}

/** The map drawn with plain views. Pinch to zoom, drag to move, or use the buttons. */
function MapBoard({ m, cards, hl, sel, now, onSpot, onBlank, setBoardTouch }) {
  const W = m.W || 1400, H = m.H || 1000;
  const vw = Dimensions.get("window").width - 32;
  const fit = vw / W;
  const vh = Math.min(H * fit, Dimensions.get("window").height * 0.6);
  const s = useRef(new Animated.Value(fit)).current, tx = useRef(new Animated.Value(0)).current, ty = useRef(new Animated.Value(0)).current;
  const cur = useRef({ s: fit, x: 0, y: 0 });
  const g0 = useRef(null);
  const box = useRef(null), off = useRef({ x: 0, y: 0 });
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([Animated.timing(pulse, { toValue: 0.3, duration: 550, useNativeDriver: true }), Animated.timing(pulse, { toValue: 1, duration: 550, useNativeDriver: true })]));
    a.start(); return () => a.stop();
  }, []);
  const set = (ns, nx, ny) => {
    ns = Math.max(fit * 0.9, Math.min(2.5, ns));
    const minX = Math.min(0, vw - W * ns), minY = Math.min(0, vh - H * ns);
    nx = Math.max(minX, Math.min(0, nx)); ny = Math.max(minY, Math.min(0, ny));
    if (W * ns < vw) nx = (vw - W * ns) / 2;
    if (H * ns < vh) ny = (vh - H * ns) / 2;
    cur.current = { s: ns, x: nx, y: ny };
    s.setValue(ns); tx.setValue(nx); ty.setValue(ny);
  };
  useEffect(() => { set(fit, 0, 0); }, [m.id]);
  const zoomBy = (k) => { const { s: s0, x, y } = cur.current, ns = Math.max(fit * 0.9, Math.min(2.5, s0 * k)); set(ns, vw / 2 - (vw / 2 - x) * (ns / s0), vh / 2 - (vh / 2 - y) * (ns / s0)); };
  const dist = (t) => Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
  const pr = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (e, g) => e.nativeEvent.touches.length > 1 || Math.abs(g.dx) + Math.abs(g.dy) > 8,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { g0.current = null; },
    onPanResponderMove: (e, g) => {
      const t = e.nativeEvent.touches;
      if (t.length > 1) {
        const cmx = (t[0].pageX + t[1].pageX) / 2, cmy = (t[0].pageY + t[1].pageY) / 2;
        if (!g0.current || !g0.current.pinch) g0.current = { pinch: true, d: dist(t), ...cur.current, mx: cmx, my: cmy };
        const g1 = g0.current, ns = Math.max(fit * 0.9, Math.min(2.5, g1.s * (dist(t) / g1.d))), r = ns / g1.s;
        // Keep the point under your fingers in place while zooming, and follow the fingers as they move.
        const fx = g1.mx - off.current.x, fy = g1.my - off.current.y;
        set(ns, fx - (fx - g1.x) * r + (cmx - g1.mx), fy - (fy - g1.y) * r + (cmy - g1.my));
        return;
      }
      if (!g0.current || g0.current.pinch) g0.current = { ...cur.current, dx: g.dx, dy: g.dy };
      set(cur.current.s, g0.current.x + g.dx - g0.current.dx, g0.current.y + g.dy - g0.current.dy);
    },
    onPanResponderRelease: () => { g0.current = null; setBoardTouch(false); },
    onPanResponderTerminate: () => { g0.current = null; setBoardTouch(false); },
  }), [fit, vw, vh]);

  const suitOf = (sp) => sp.accepts.startsWith("suit:") ? sp.accepts.slice(5) : cards.find((c) => "card:" + c.id === sp.accepts)?.suit || "body";
  const nameOf = (sp) => sp.label || (sp.accepts === "any" ? "any card" : sp.accepts.startsWith("suit:") ? "any " + sp.accepts.slice(5) : (cards.find((c) => "card:" + c.id === sp.accepts)?.label || "?").replace("#", "").trim());
  const els = [];
  for (const sh of m.shapes) {
    shapeEdges(sh).forEach(([a, b], k) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]), th = sh.kind === "path" ? 10 : 6, ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      els.push(<View key={sh.id + "e" + k} style={{ position: "absolute", left: (a[0] + b[0]) / 2 - len / 2, top: (a[1] + b[1]) / 2 - th / 2, width: len, height: th, borderRadius: th / 2, backgroundColor: C.line, transform: [{ rotate: ang + "rad" }] }} />);
    });
    if (sh.kind === "pool") continue;
    const vertical = sh.kind === "path" && Math.abs(Math.sin(((sh.rot || 0) * Math.PI) / 180)) > 0.7;
    const big = sh.kind === "ring" && m.shapes.some((p) => p.kind === "pool" && Math.hypot(p.cx - sh.cx, p.cy - sh.cy) < 20);
    const lx = vertical ? sh.cx - 50 : sh.cx, ly = big ? sh.cy + sh.ry * 0.62 : sh.kind === "path" && !vertical ? sh.cy - 56 : sh.cy - 8;
    els.push(
      <View key={sh.id + "l"} pointerEvents="none" style={{ position: "absolute", width: 320, left: vertical ? lx - 320 : lx - 160, top: ly - 26 }}>
        <Text style={{ fontSize: 28, fontWeight: "800", color: C.ink, textAlign: vertical ? "right" : "center" }}>{sh.label}</Text>
        {!!sh.sub && <Text style={{ fontSize: 16, color: C.muted, textAlign: vertical ? "right" : "center" }}>{sh.sub}</Text>}
      </View>
    );
  }
  for (const sh of m.shapes) sh.spots.forEach((sid, i) => {
    const sp = m.spots[sid], [x, y] = spotPos(sh, i), stt = spotState(m, sp, now), col = C.suit[suitOf(sp)] || C.accent, isHl = hl.has(sid), isSel = sel === sid;
    if (sh.kind === "pool") {
      const r = sh.rx, frac = sp.target ? Math.min(1, (sp.total || 0) / sp.target) : 0, pile = sp.pile || [];
      els.push(
        <Pressable key={sid} onPress={() => onSpot(sid)} style={{ position: "absolute", left: x - r, top: y - r, width: r * 2, height: r * 2 }}>
          <View style={{ width: r * 2, height: r * 2, borderRadius: r, backgroundColor: C.paper, borderWidth: isHl ? 5 : 2, borderColor: isHl ? C.ink : C.line, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
            <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: r * 2 * frac, backgroundColor: col, opacity: 0.35 }} />
            <Text style={{ fontSize: 26, fontWeight: "800", color: C.ink }}>{sh.label}</Text>
            <Text style={{ fontSize: 21, fontWeight: "800", color: C.ink }}>{amountText(sp)}</Text>
            {!!sh.sub && <Text style={{ fontSize: 15, color: C.muted }}>{sh.sub}</Text>}
          </View>
          {isHl && <Animated.View pointerEvents="none" style={{ position: "absolute", left: -8, top: -8, width: r * 2 + 16, height: r * 2 + 16, borderRadius: r + 8, borderWidth: 4, borderColor: C.ink, opacity: pulse }} />}
          {isSel && <View pointerEvents="none" style={{ position: "absolute", left: -8, top: -8, width: r * 2 + 16, height: r * 2 + 16, borderRadius: r + 8, borderWidth: 3, borderStyle: "dashed", borderColor: C.ink }} />}
          {pile.slice(-4).map((e, k, arr) => (
            <PlacedCard key={k} e={e} x={r + r * 0.95 + k * 5} y={r + r * 0.8 - k * 3} rot={jitter(sid + k, 9)} badge={k === arr.length - 1 && pile.length > 1 ? "×" + pile.length : ""} />
          ))}
        </Pressable>
      );
      return;
    }
    const R = 30, name = nameOf(sp), short = sp.label ? "" : shortWhen(sp);
    const ring = stt === "missed" ? { backgroundColor: "#d9d0d5", borderColor: "#a89ca3", borderWidth: 2 }
      : stt === "filled" ? { backgroundColor: "rgba(255,253,247,.35)", borderColor: col, borderWidth: 2.5 }
      : stt === "open" ? { backgroundColor: C.paper, borderColor: col, borderWidth: 3.5 }
      : { backgroundColor: "rgba(255,253,247,.35)", borderColor: C.line, borderWidth: 2.5, borderStyle: "dashed", opacity: stt === "skipped" ? 0.45 : 1 };
    els.push(
      <Pressable key={sid} onPress={() => onSpot(sid)} style={{ position: "absolute", left: x - 80, top: y - R - 14, width: 160, alignItems: "center" }}>
        <View style={{ width: R * 2 + 28, height: R * 2 + 28, alignItems: "center", justifyContent: "center" }}>
          {isHl && <Animated.View style={{ position: "absolute", width: R * 2 + 18, height: R * 2 + 18, borderRadius: R + 9, borderWidth: 4, borderColor: C.ink, opacity: pulse }} />}
          {isSel && <View style={{ position: "absolute", width: R * 2 + 16, height: R * 2 + 16, borderRadius: R + 8, borderWidth: 3, borderStyle: "dashed", borderColor: C.ink }} />}
          <View style={[{ width: R * 2, height: R * 2, borderRadius: R, alignItems: "center", justifyContent: "center" }, ring]}>
            {stt === "missed" ? <Text style={{ fontSize: 30, fontWeight: "800", color: "#a89ca3" }}>✕</Text>
              : stt === "filled" ? null
              : <Text style={{ fontSize: stt === "open" ? 18 : 14, fontWeight: "800", color: stt === "open" ? col : C.line }}>{SUIT[suitOf(sp)]}</Text>}
          </View>
          {stt === "filled" && <PlacedCard e={sp.filled} x={R + 14 + 2} y={R + 14 + 6} rot={jitter(sid)} meta={sp.label || shortWhen(sp) || "✓"} />}
        </View>
        {stt !== "filled" && <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: C.ink, marginTop: -8 }}>{name.length > 16 ? name.slice(0, 15) + "…" : name}</Text>}
        {stt !== "filled" && !!short && <Text style={{ fontSize: 13, color: C.muted }}>{short}</Text>}
      </Pressable>
    );
  });
  return (
    <View style={{ width: vw, height: vh, borderRadius: 18, overflow: "hidden", backgroundColor: C.felt }}
      ref={box} onTouchStart={() => { setBoardTouch(true); box.current?.measureInWindow((x, y) => { off.current = { x, y }; }); }} onTouchEnd={() => setBoardTouch(false)} onTouchCancel={() => setBoardTouch(false)} {...pr.panHandlers}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onBlank} />
      <Animated.View style={{ position: "absolute", left: 0, top: 0, width: W, height: H, transformOrigin: "0 0", transform: [{ translateX: tx }, { translateY: ty }, { scale: s }] }}>
        {els}
      </Animated.View>
      <View style={{ position: "absolute", right: 8, top: 8, gap: 6 }}>
        {[["+", () => zoomBy(1.35)], ["−", () => zoomBy(1 / 1.35)], ["⤢", () => set(fit, 0, 0)]].map(([l, f]) => (
          <Pressable key={l} onPress={f} style={{ width: 38, height: 38, borderRadius: 10, borderWidth: 1.5, borderColor: C.line, backgroundColor: C.paper, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 18, fontWeight: "700", color: C.ink }}>{l}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** A played card sitting on a spot: a little tilted, with a shadow. x,y is its center. */
function PlacedCard({ e, x, y, rot, meta, badge }) {
  if (!e) return null;
  const col = C.suit[e.suit] || C.accent;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: x - 29, top: y - 40, width: 58, height: 80, borderRadius: 7, backgroundColor: C.paper, elevation: 4, borderWidth: 1, borderColor: "rgba(58,22,48,.12)", transform: [{ rotate: rot.toFixed(1) + "deg" }], overflow: "visible" }}>
      <View style={{ height: 7, backgroundColor: col, borderTopLeftRadius: 7, borderTopRightRadius: 7 }} />
      <Text style={{ fontSize: 10, fontWeight: "800", color: col, marginLeft: 5 }}>{SUIT[e.suit] || "●"}</Text>
      <Text numberOfLines={3} style={{ fontSize: 10, fontWeight: "700", color: C.ink, textAlign: "center", paddingHorizontal: 3 }}>{e.label}</Text>
      {!!meta && <Text numberOfLines={1} style={{ position: "absolute", bottom: 4, left: 0, right: 0, fontSize: 8.5, color: C.muted, textAlign: "center" }}>{meta}</Text>}
      {!!badge && <View style={{ position: "absolute", right: -7, top: -7, width: 22, height: 22, borderRadius: 11, backgroundColor: C.ink, alignItems: "center", justifyContent: "center" }}><Text style={{ fontSize: 10, fontWeight: "800", color: C.bg }}>{badge}</Text></View>}
    </View>
  );
}

function TableView({ state, me }) {
  const players = [...state.players].sort((a, b) => (a.joined || "").localeCompare(b.joined || ""));
  const others = players.filter((p) => p.id !== me.id);
  const mine = players.find((p) => p.id === me.id);
  const lastPlay = state.plays.reduce((a, p) => (!a || p.at > a.at ? p : a), null);
  const topDis = state.discards.reduce((a, d) => (!a || d.at > a.at ? d : a), null);
  const drawN = Math.max(0, myDeck(state.cards, state.players, me.id, state.decks).filter((c) => c.active !== false).length - state.hands.filter((h) => h.seat === me.id).length);
  const active = players.find((p) => p.id === state.game.active);
  const Side = ({ p }) => {
    if (!p) return <View style={st.side}><Text style={[st.h3, { color: C.muted }]}>Open seat</Text><Text style={st.note}>Give a friend your table name so they can sit here.</Text></View>;
    const plays = state.plays.filter((x) => x.seat === p.id).sort((a, b) => a.at.localeCompare(b.at));
    const held = state.hands.filter((h) => h.seat === p.id).length;
    const isTurn = state.game.active === p.id;
    return (
      <View style={st.side}>
        <View style={[st.row, { justifyContent: "space-between" }]}>
          <View style={[st.row, { gap: 8 }]}>
            <View style={st.avatar}><Text style={st.avatarTxt}>{(p.name || "?")[0].toUpperCase()}</Text></View>
            <Text style={st.h3}>{p.name}{p.id === me.id ? " (you)" : ""}</Text>
          </View>
          <View style={[st.row, { gap: 6 }]}>
            <Text style={st.miniMeta}>{held} held</Text>
            {isTurn && <View style={st.turnTag}><Text style={st.turnTagTxt}>TO PLAY</Text></View>}
          </View>
        </View>
        {(() => { const mv = lastMove(plays); return mv.length > 1 ? <Text style={[st.note, { textAlign: "left" }]}>Last: {mv.map((x) => x.label).join(" + ")} · played together</Text> : null; })()}
        <View style={[st.row, { alignItems: "stretch", gap: 10 }]}>
          <ScrollView horizontal style={st.played} contentContainerStyle={{ alignItems: "flex-start", padding: 10, gap: 8 }}>
            {plays.length ? stackPlays(plays).map((sk) => <Stack key={sk.key} s={sk} fresh={sk.cards.some((c) => c.id === lastPlay?.id)} />)
              : <Text style={[st.note, { alignSelf: "center" }]}>{isTurn ? "Fresh. Ready for turn " + state.game.turn : "Nothing played yet"}</Text>}
          </ScrollView>
          <View style={st.cubes}>
            <Text style={st.pcMeta}>CUBES · {plays.length}</Text>
            <View style={st.cubeGrid}>{plays.slice(-24).map((x) => <View key={x.id} style={[st.cube, { backgroundColor: C.suit[x.suit] || C.accent }]} />)}</View>
          </View>
        </View>
      </View>
    );
  };
  return (
    <View style={st.board}>
      {others.length ? others.map((p) => <Side key={p.id} p={p} />) : <Side p={null} />}
      <View style={st.mid}>
        <View style={st.pile}><View style={st.pileBack} /><Text style={st.pcMeta}>DRAW {drawN}</Text></View>
        <View style={{ alignItems: "center" }}><Text style={st.pcMeta}>TURN</Text><Text style={st.turnBig}>{state.game.turn}</Text><Text style={st.pcMeta}>{active ? (active.id === me.id ? "YOU PLAY" : active.name.toUpperCase() + " TO PLAY") : ""}</Text></View>
        <View style={st.pile}><View style={[st.pileDis, topDis && st.pileDisHas]}><Text style={st.pcLabel} numberOfLines={3}>{topDis?.label || ""}</Text></View><Text style={st.pcMeta}>DISCARD {state.discards.length}</Text></View>
      </View>
      <Side p={mine} />
    </View>
  );
}

/* ---------------- deck ---------------- */
function DeckView({ state, room, me, act, editReq, clearEditReq }) {
  const [edit, setEdit] = useState(null);
  const [lib, setLib] = useState(false);
  const [newName, setNewName] = useState("");
  const [arm, setArm] = useState(false);
  const decks = myDecks(state.decks, me.id);
  const [selId, setSel] = useState(everydayId(me.id));
  const deck = decks.find((d) => d.id === selId) || decks[0];
  const all = myDeck(state.cards, state.players, me.id);
  const count = (d) => all.filter((c) => deckOf(c, me.id) === d.id).length;
  const cards = all.filter((c) => deckOf(c, me.id) === deck.id).sort((a, b) => a.label.localeCompare(b.label));
  const pick = (id) => { setSel(id); setArm(false); };
  const chaos = myChaos(state.players, me.id, state.config.chaos);
  // Opened from the ✎ on a card: jump to its deck and open its editor.
  useEffect(() => {
    if (!editReq) return;
    const c = state.cards.find((x) => x.id === editReq.id) || state.cards.find((x) => x.label.trim().toLowerCase() === String(editReq.label || "").trim().toLowerCase());
    if (c) { setSel(deckOf(c, me.id)); setEdit(c); }
    clearEditReq();
  }, [editReq, state]);
  return (
    <>
      <View style={st.panel}>
        <Text style={st.label}>YOUR RANDOMNESS · {chaos}%</Text>
        <View style={st.chips}>{[0, 15, 30, 50, 75, 100].map((v) => <Chip key={v} label={v === 0 ? "Steady" : v === 100 ? "Wild" : v + "%"} on={chaos === v} onPress={() => act(() => S.setChaos(room, me, v))} />)}</View>
        <Text style={[st.note, { textAlign: "left" }]}>Steady deals whatever is most overdue, on a regular clock. Wild picks any card at uneven times.</Text>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={st.label}>YOUR DECKS · ONLY YOU SEE THEM</Text>
        <View style={st.chips}>
          {decks.map((d) => <Chip key={d.id} label={(d.active ? "" : "○ ") + (deckEmoji(d) ? deckEmoji(d) + " " : "") + d.name + " · " + count(d)} on={d.id === deck.id} onPress={() => pick(d.id)} />)}
          <Chip label="+ Add deck" on={false} onPress={() => setLib(true)} />
        </View>
        <View style={st.panel}>
          <View style={[st.row, { justifyContent: "space-between" }]}>
            <View style={{ flex: 1 }}>
              <Text style={st.h3}>{deckEmoji(deck) ? deckEmoji(deck) + "  " : ""}{deck.name}</Text>
              <Text style={[st.note, { textAlign: "left" }]}>{deck.active ? "Cards are dealt from this deck." : "Paused. Nothing is dealt from this deck."}</Text>
            </View>
            <Switch value={deck.active} onValueChange={(v) => act(() => S.setDeckActive(room, me, deck, v), (v ? "Dealing from " : "Paused ") + deck.name)} trackColor={{ true: C.accent }} />
          </View>
          <Text style={st.label}>DECK LOGO · SHOWS ON EVERY CARD FROM THIS DECK</Text>
          <EmojiPicker value={deckEmoji(deck)} onPick={(e) => act(() => S.setDeckEmoji(room, me, deck, e), e ? "Logo " + e : "Logo removed")} />
          {deck.id !== everydayId(me.id) && (
            <Btn danger={arm} label={arm ? "Tap again to delete " + deck.name + " and its cards" : "Delete deck"} onPress={() => {
              if (!arm) return setArm(true);
              setArm(false); setSel(everydayId(me.id));
              act(() => S.deleteDeck(room, me, deck), "Deleted " + deck.name);
            }} />
          )}
        </View>
        {cards.map((c) => (
          <Pressable key={c.id} onPress={() => setEdit(c)} style={[st.deckRow, c.active === false && { opacity: 0.5 }]}>
            <Text style={{ color: C.suit[c.suit], fontSize: 18, width: 22 }}>{SUIT[c.suit]}</Text>
            <Text style={[st.h3, { flex: 1 }]} numberOfLines={1}>{c.label}</Text>
            <Text style={st.miniMeta}>{quotaLabel(c)}{c.beef ? " · " + c.beef : ""}</Text>
          </Pressable>
        ))}
        <Btn primary label="New card" onPress={() => setEdit({ label: "", suit: "body", imm: 3, active: true, plays: 0, quota: { n: 1, per: "day" }, deck: deck.id })} />
      </View>
      <Modal visible={lib} transparent animationType="slide" onRequestClose={() => setLib(false)}>
        <Pressable style={st.scrim} onPress={() => setLib(false)} />
        <ScrollView style={st.sheetScroll} contentContainerStyle={[st.sheet, { position: "relative" }]} keyboardShouldPersistTaps="handled">
          <Text style={st.h2}>Add a deck</Text>
          {DECK_LIBRARY.map((t) => {
            const have = decks.some((d) => d.key === t.key);
            return (
              <View key={t.key} style={st.panel}>
                <Text style={st.h3}>{t.name} · {t.cards.length} cards</Text>
                <Text style={[st.note, { textAlign: "left" }]}>{t.about}</Text>
                <Btn primary={!have} disabled={have} label={have ? "Added" : "Add " + t.name} onPress={() => {
                  setLib(false); setSel(me.id + ":" + t.key);
                  act(() => S.addLibraryDeck(room, me, t.key), "Added " + t.name);
                }} />
              </View>
            );
          })}
          <View style={st.panel}>
            <Text style={st.h3}>Empty deck</Text>
            <Field label="Name" value={newName} onChangeText={setNewName} placeholder="Reading month" />
            <Btn label="Make it" disabled={!newName.trim()} onPress={() => {
              const name = newName.trim(); setNewName(""); setLib(false);
              act(async () => setSel(await S.newDeck(room, me, name)), "Made " + name);
            }} />
          </View>
        </ScrollView>
      </Modal>
      <CardEditor card={edit} onClose={() => setEdit(null)} onSave={(c) => { setEdit(null); act(() => S.saveCard(room, me, c), "Saved " + c.label); }}
        onDelete={(c) => { setEdit(null); act(() => S.deleteCard(room, c.id), "Deleted " + c.label); }} />
    </>
  );
}

function CardEditor({ card, onClose, onSave, onDelete }) {
  const [c, setC] = useState(card);
  const [amts, setAmts] = useState("");
  const [arm, setArm] = useState(false);
  useEffect(() => {
    setC(card && { ...card, quota: card.quota || effectiveQuota({ ...card, tempo: 1 }) });
    setAmts((card?.amounts || []).join(", "));
    setArm(false);
  }, [card]);
  if (!card || !c) return null;
  const amounts = amts.split(/[ ,]+/).map(Number).filter((x) => x > 0);
  const n = +c.quota.n || 0;
  const bump = (d) => setC({ ...c, quota: { ...c.quota, n: Math.max(1, n + d) } });
  const step = amounts.length ? Math.min(...amounts) : 1;
  const save = () => {
    if (!c.label.trim()) return;
    const { every, variants, ...rest } = c;
    onSave({ ...rest, label: c.label.trim(), amounts: amounts.length ? amounts : null, quota: { n: Math.max(1, n), per: c.quota.per } });
  };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={st.scrim} onPress={onClose} />
      <ScrollView style={st.sheetScroll} contentContainerStyle={[st.sheet, { position: "relative" }]} keyboardShouldPersistTaps="handled">
        <Text style={st.h2}>{card.id ? "Edit card" : "New card"}</Text>
        <Field label="Label" value={c.label} onChangeText={(v) => setC({ ...c, label: v })} placeholder="squats" />
        <Field label="Amounts (optional)" value={amts} onChangeText={setAmts} placeholder="5, 10, 20" keyboardType="numbers-and-punctuation" />
        <Text style={[st.note, { textAlign: "left" }]}>{amounts.length ? `Each deal is one of these: "${amountLabel(c.label || "squats", amounts[0])}". Put # in the label to place the number, like "Drink # glasses".` : "Leave empty to count whole cards."}</Text>
        <Text style={st.label}>HOW OFTEN</Text>
        <View style={st.chips}>{Object.entries(PERIOD_NAMES).map(([per, l]) => <Chip key={per} label={l} on={c.quota.per === per} onPress={() => setC({ ...c, quota: { ...c.quota, per } })} />)}</View>
        <Text style={st.label}>TARGET {PERIODS[c.quota.per].toUpperCase()}</Text>
        <View style={st.row}>
          <Btn label="−" onPress={() => bump(-step)} />
          <TextInput value={String(c.quota.n)} onChangeText={(v) => setC({ ...c, quota: { ...c.quota, n: v.replace(/[^0-9]/g, "") } })} keyboardType="number-pad" style={[st.input, { flex: 1, textAlign: "center", fontSize: 22, fontWeight: "800" }]} />
          <Btn label="+" onPress={() => bump(step)} />
        </View>
        {!!c.tempo && c.tempo !== 1 && (
          <View style={[st.row, { justifyContent: "space-between" }]}>
            <Text style={[st.note, { textAlign: "left", color: C.ink, flex: 1 }]}>Your swipes adjusted this to {Math.max(1, Math.round(n * c.tempo))} {PERIODS[c.quota.per]} ({c.tempo > 1 ? "+" : ""}{Math.round((c.tempo - 1) * 100)}%).</Text>
            <Btn label="Reset" onPress={() => setC({ ...c, tempo: 1 })} />
          </View>
        )}
        <Text style={[st.note, { textAlign: "left" }]}>{amounts.length ? `Deals add up to exactly ${n} ${c.label || ""} ${PERIODS[c.quota.per]}, spread out. Bigger amounts mean fewer deals.` : `Dealt exactly ${n} time${n === 1 ? "" : "s"} ${PERIODS[c.quota.per]}, spread out.`}</Text>
        <Text style={st.label}>SUIT</Text>
        <View style={st.chips}>{SUITS.map((s) => <Chip key={s} label={SUIT[s] + " " + s} on={c.suit === s} onPress={() => setC({ ...c, suit: s })} />)}</View>
        <Text style={st.label}>BEEFINESS</Text>
        <View style={st.chips}>{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Chip key={i} label={i ? String(i) : "None"} on={(c.beef || 0) === i} onPress={() => setC({ ...c, beef: i || null })} />)}</View>
        <Text style={[st.note, { textAlign: "left" }]}>How big a lift it is, 1–7. Shows as the big number on the card; leave it at None for no number.</Text>
        <Text style={st.label}>IMMEDIACY</Text>
        <View style={st.chips}>{[1, 2, 3, 4, 5].map((i) => <Chip key={i} label={String(i)} on={c.imm === i} onPress={() => setC({ ...c, imm: i })} />)}</View>
        <Text style={[st.note, { textAlign: "left" }]}>4 and 5 ring louder and show over the lock screen.</Text>
        <Text style={st.label}>TIMING (OPTIONAL)</Text>
        <TimeField label="Can be dealt from" value={c.opensAt} onChange={(v) => setC({ ...c, opensAt: v })} placeholder="9:30pm" />
        <TimeField label="Takes over the screen at" value={c.takeover} onChange={(v) => setC({ ...c, takeover: v })} placeholder="10:30pm" />
        <Text style={[st.note, { textAlign: "left" }]}>{c.takeover ? `From ${fmtTime(hmDate(c.takeover))} until you play it, it's the only card you can play and it rings full screen every few minutes.` : "Leave empty for a normal card."}</Text>
        <Text style={st.label}>WAIT BETWEEN PLAYS</Text>
        {[["self", "After this same card"], ["suit", "After any " + SUIT[c.suit] + " " + c.suit + " card"], ["any", "After any card"]].map(([k, l]) => (
          <View key={k} style={{ gap: 6 }}>
            <Text style={[st.note, { textAlign: "left", color: C.ink }]}>{l}</Text>
            <View style={st.chips}>{BUFFER_STEPS.map(([m, ml]) => <Chip key={m} label={ml} on={(c.buffer?.[k] || 0) === m} onPress={() => setC({ ...c, buffer: { ...(c.buffer || {}), [k]: m || null } })} />)}</View>
          </View>
        ))}
        <Text style={[st.note, { textAlign: "left" }]}>It can still be held, but it can't be played or dealt until the wait is over.</Text>
        <Text style={st.label}>LOCK WHEN HOLDING</Text>
        <View style={st.chips}>{[0, 2, 3, 4, 5].map((k) => <Chip key={k} label={k ? k + " held" : "Never"} on={(c.lockAt || 0) === k} onPress={() => setC({ ...c, lockAt: k || null })} />)}</View>
        <Text style={[st.note, { textAlign: "left" }]}>While you hold this many, it's the only card you can play.</Text>
        <View style={[st.row, { justifyContent: "space-between" }]}><Text style={st.h3}>In the deck</Text><Switch value={c.active !== false} onValueChange={(v) => setC({ ...c, active: v })} trackColor={{ true: C.accent }} /></View>
        <View style={st.row}>
          <Btn primary flex label="Save" onPress={save} />
          <Btn flex label="Cancel" onPress={onClose} />
          {!!card.id && <Btn flex danger label={arm ? "Tap again" : "Delete"} onPress={() => (arm ? onDelete(card) : setArm(true))} />}
        </View>
      </ScrollView>
    </Modal>
  );
}

/* ---------------- me / settings ---------------- */
function MeView({ part, profile, rooms, prefs, setProfile, act, state, openSwitcher, onLeave }) {
  const [plan, setPlan] = useState([]);
  useEffect(() => {
    Notifications.getAllScheduledNotificationsAsync().then((all) => {
      setPlan(all.filter((n) => n.content.data?.kind === "deal" || n.content.data?.kind === "reminder")
        .map((n) => ({ id: n.identifier, title: n.content.title, at: n.trigger?.value || n.trigger?.date }))
        .sort((a, b) => (a.at || 0) - (b.at || 0)).slice(0, 6));
    }).catch(() => {});
  }, [profile, state]);
  const update = async (patch) => {
    const p = { ...profile, prefs: { ...prefs, ...patch } };
    await S.saveProfile(p);
    setProfile(p);
  };
  if (part === "me") return (
    <>
      <View style={st.panel}>
        <Text style={st.label}>YOU</Text>
        <Text style={st.h2}>{profile.me.name}</Text>
        <Text style={[st.note, { textAlign: "left" }]}>Sitting at {rooms.length} {rooms.length === 1 ? "table" : "tables"}: {rooms.join(", ")}.</Text>
        <Text style={[st.note, { textAlign: "left" }]}>Friends join a table by entering the same table name.</Text>
        <Btn label="Switch or add tables" onPress={openSwitcher} />
      </View>
      <Btn label={"Leave “" + profile.room + "”"} onPress={onLeave} />
    </>
  );
  return (
    <>
      <View style={st.panel}>
        <View style={[st.row, { justifyContent: "space-between" }]}><Text style={st.h3}>Deal me cards</Text><Switch value={prefs.notify} onValueChange={(v) => update({ notify: v })} trackColor={{ true: C.accent }} /></View>
        <Text style={[st.note, { textAlign: "left" }]}>Cards are dealt when they fall behind their targets, checked every 20 minutes while you're awake.</Text>
        <Text style={st.label}>AWAKE FROM</Text>
        <View style={st.chips}>{[6, 7, 8, 9, 10].map((h) => <Chip key={h} label={h + " AM"} on={prefs.startHour === h} onPress={() => update({ startHour: h })} />)}</View>
        <Text style={st.label}>UNTIL</Text>
        <View style={st.chips}>{[19, 20, 21, 22, 23].map((h) => <Chip key={h} label={(h - 12) + " PM"} on={prefs.endHour === h} onPress={() => update({ endHour: h })} />)}</View>
        <Btn label="Send a test notification" onPress={() => act(() => N.testNotification(), "Test arrives in 5 seconds. Lock your phone to see it.")} />
      </View>
      <View style={st.panel}>
        <Text style={st.label}>COMING UP ON THIS PHONE</Text>
        {plan.length ? plan.map((p) => <Text key={p.id} style={st.planRow}>{p.at ? fmtTime(new Date(p.at)) : "—"}  {p.title}</Text>) : <Text style={[st.note, { textAlign: "left" }]}>Nothing scheduled.</Text>}
      </View>
      <View style={st.panel}>
        <Text style={st.label}>COLORS</Text>
        <View style={st.chips}>{[C.bg, C.bg2, C.felt, C.accent, C.ink, ...Object.values(C.suit)].map((c, i) => <View key={i} style={{ width: 22, height: 22, borderRadius: 6, backgroundColor: c, borderWidth: 1, borderColor: C.line }} />)}</View>
        <Text style={[st.note, { textAlign: "left" }]}>{C.name || ORIGINAL.name}</Text>
        <View style={st.row}>
          <Btn primary flex label="Shuffle colors" onPress={() => applyTheme(randomTheme())} />
          <Btn flex label="Original" onPress={() => applyTheme(ORIGINAL)} />
        </View>
      </View>
      <TakeoverPanel act={act} />
      <Text style={st.note}>Version {Updates.createdAt ? Updates.createdAt.toLocaleString() : "built-in"}{Updates.isEmbeddedLaunch ? "" : " · updated"}</Text>
    </>
  );
}

/* ---------------- deck logo picker ---------------- */
const EMOJIS = ["☀️", "🌙", "🏋️", "🏃", "🧘", "💧", "🥗", "🧹", "🏠", "💼", "📚", "🎸", "🎨", "🌱", "🐕", "💤", "🧠", "❤️", "⭐", "🔥", "⚡", "🎯", "🛠️", "💰"];
function EmojiPicker({ value, onPick }) {
  const [txt, setTxt] = useState("");
  return (
    <View style={{ gap: 8 }}>
      <View style={st.chips}>
        {EMOJIS.map((e) => (
          <Pressable key={e} onPress={() => onPick(e === value ? null : e)} style={[st.emojiCell, e === value && st.emojiCellOn]} accessibilityRole="button" accessibilityState={{ selected: e === value }} accessibilityLabel={"Logo " + e}>
            <Text style={{ fontSize: 22 }}>{e}</Text>
          </Pressable>
        ))}
      </View>
      <View style={st.row}>
        <TextInput value={txt} onChangeText={setTxt} placeholder="Or type any emoji" placeholderTextColor={C.muted} style={[st.input, { flex: 1 }]} maxLength={8} />
        <Btn label="Use" disabled={!txt.trim()} onPress={() => { onPick(txt.trim()); setTxt(""); }} />
      </View>
    </View>
  );
}

/* ---------------- side menu ---------------- */
const SECTIONS = [["play", "Play", "♠"], ["decks", "My decks", "▤"], ["me", "Me", "●"], ["settings", "Settings", "⚙"]];
const DRAWER_W = Math.min(300, Dimensions.get("window").width * 0.8);
// Slides in from the left: tap the ☰ button, or drag from the left edge of the screen. Drag it back or tap outside to close.
function Drawer({ open, setOpen, section, name, room, onPick }) {
  const x = useRef(new Animated.Value(-DRAWER_W)).current;
  const [shown, setShown] = useState(false);
  const go = (to, after) => Animated.spring(x, { toValue: to, useNativeDriver: true, bounciness: 0, speed: 18 }).start(({ finished }) => finished && after?.());
  useEffect(() => {
    if (open) { setShown(true); go(0); }
    else go(-DRAWER_W, () => setShown(false));
  }, [open]);
  const settle = (dx, vx, from) => { const pos = from + dx; setOpen(pos > -DRAWER_W / 2 || vx > 0.5) ; if (!(pos > -DRAWER_W / 2 || vx > 0.5)) go(-DRAWER_W, () => setShown(false)); else go(0); };
  const edge = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dx > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderGrant: () => setShown(true),
    onPanResponderMove: (_, g) => x.setValue(Math.min(0, -DRAWER_W + Math.max(0, g.dx))),
    onPanResponderRelease: (_, g) => settle(g.dx, g.vx, -DRAWER_W),
    onPanResponderTerminate: (_, g) => settle(g.dx, g.vx, -DRAWER_W),
  })).current;
  const panel = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dx < -8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderMove: (_, g) => x.setValue(Math.min(0, g.dx)),
    onPanResponderRelease: (_, g) => settle(g.dx, g.vx, 0),
    onPanResponderTerminate: (_, g) => settle(g.dx, g.vx, 0),
  })).current;
  const scrim = x.interpolate({ inputRange: [-DRAWER_W, 0], outputRange: [0, 1] });
  // The panel stays mounted (just slid offscreen) so the native slide animation always has a view to move.
  return (
    <>
      <View pointerEvents="box-none" style={st.edgeZone}>
        <View style={st.edgeGrab} {...edge.panHandlers} />
        <View pointerEvents="none" style={st.edgeHandle}><View style={st.edgeTab} /></View>
      </View>
      <Animated.View pointerEvents={shown ? "auto" : "none"} style={[StyleSheet.absoluteFill, st.drawerScrim, { opacity: scrim }]}>
        <Pressable style={{ flex: 1 }} onPress={() => setOpen(false)} accessibilityLabel="Close menu" />
      </Animated.View>
      <Animated.View pointerEvents={shown ? "auto" : "none"} style={[st.drawer, { width: DRAWER_W, transform: [{ translateX: x }] }]} {...panel.panHandlers}>
        <SafeAreaView edges={["top", "bottom", "left"]} style={{ flex: 1, gap: 6 }}>
          <Text style={st.drawerBrand}>Prompt</Text>
          <Text style={[st.note, { textAlign: "left", marginBottom: 12 }]} numberOfLines={1}>{name} · {room}</Text>
          {SECTIONS.map(([k, l, icon]) => (
            <Pressable key={k} onPress={() => onPick(k)} style={[st.drawerItem, section === k && st.drawerItemOn]} accessibilityRole="menuitem" accessibilityState={{ selected: section === k }}>
              <Text style={st.drawerIcon}>{icon}</Text>
              <Text style={[st.drawerTxt, section === k && { fontWeight: "800" }]}>{l}</Text>
            </Pressable>
          ))}
        </SafeAreaView>
      </Animated.View>
    </>
  );
}

/* ---------------- table switcher ---------------- */
// Your tables, each with what's waiting there. Add another by name; a friend who types the same name sits with you.
function TableSwitcher({ open, ctx, onClose, onPick, onAdd, onLeave, onPause }) {
  const [arm, setArm] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const add = async () => {
    setBusy(true); setErr("");
    try { await onAdd(name); setName(""); } catch (e) { setErr(String(e.message || e)); } finally { setBusy(false); }
  };
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={st.scrim} onPress={onClose} />
      <ScrollView style={st.sheetScroll} contentContainerStyle={[st.sheet, { position: "relative" }]} keyboardShouldPersistTaps="handled">
        <Text style={st.h2}>Tables</Text>
        <Text style={[st.note, { textAlign: "left" }]}>You sit at all of these at once; each runs on its own. Your top card counts at every enabled table it applies to.</Text>
        {ctx.rooms.map((r) => {
          const s1 = ctx.states[r], on = r === ctx.room;
          const t = s1?.tables[ctx.me.id], held = (s1?.hands || []).filter((h) => h.seat === ctx.me.id).length;
          const maps = (s1?.maps || []).filter((m) => m.owner === ctx.me.id && m.active !== false).length;
          const others = (s1?.players || []).filter((p) => p.id !== ctx.me.id).length;
          return (
            <Pressable key={r} onPress={() => onPick(r)} style={[st.tableRow, on && st.tableRowOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[st.h3, ctx.paused.includes(r) && { color: C.muted }]} numberOfLines={1}>{ctx.paused.includes(r) ? "○ " : ""}{r}</Text>
                <Text style={[st.note, { textAlign: "left" }]} numberOfLines={1}>
                  {!s1 ? "Loading…" : [t && !t.empty ? "▶ " + t.label : null, held + " held", maps ? maps + (maps === 1 ? " map" : " maps") : null, others ? "+" + others + (others === 1 ? " player" : " players") : "solo"].filter(Boolean).join(" · ")}
                </Text>
              </View>
              {on && <View style={st.check}><Text style={st.checkTxt}>✓</Text></View>}
              <View style={{ alignItems: "center" }}>
                <Switch value={!ctx.paused.includes(r)} onValueChange={() => onPause(r)} trackColor={{ true: C.accent }} accessibilityLabel={(ctx.paused.includes(r) ? "Enable " : "Disable ") + r} />
                <Text style={[st.leaveTxt, { fontSize: 10 }]}>{ctx.paused.includes(r) ? "OFF" : "ON"}</Text>
              </View>
              <Pressable onPress={() => { if (arm === r) { setArm(null); onLeave(r); } else setArm(r); }} hitSlop={8} style={[st.leaveBtn, arm === r && { borderColor: C.hot }]} accessibilityRole="button" accessibilityLabel={"Leave " + r}>
                <Text style={[st.leaveTxt, arm === r && { color: C.hot }]}>{arm === r ? "Tap to leave" : "Leave"}</Text>
              </Pressable>
            </Pressable>
          );
        })}
        <Text style={st.label}>ADD A TABLE</Text>
        <Field label="Table name" value={name} onChangeText={setName} placeholder="morning-routine" autoCapitalize="none" />
        {!!err && <Text style={[st.note, { color: C.hot, textAlign: "left" }]}>{err}</Text>}
        <Btn primary label={busy ? "Joining…" : "Sit down at this table"} disabled={busy || !name.trim()} onPress={add} />
      </ScrollView>
    </Modal>
  );
}

/* ---------------- small parts ---------------- */
/** Type a time like "9:30pm" or "2130"; stores "HH:MM". Empty clears it. */
function TakeoverPanel({ act }) {
  const [ok, setOk] = useState(N.canFullScreen());
  const [over, setOver] = useState(N.canDrawOver());
  useEffect(() => { const sub = AppState.addEventListener("change", (s) => { if (s === "active") { setOk(N.canFullScreen()); setOver(N.canDrawOver()); } }); return () => sub.remove(); }, []);
  return (
    <View style={st.panel}>
      <Text style={st.label}>FULL-SCREEN ALARMS</Text>
      {!N.takeoverAvailable() ? (
        <Text style={[st.note, { textAlign: "left" }]}>This needs the newer app version. Install the latest APK from the GitHub releases page.</Text>
      ) : (
        <>
          <Text style={[st.note, { textAlign: "left" }]}>Cards with a takeover time, like Go to bed, ring full screen over other apps until you play them.</Text>
          {!ok && <Btn primary label="Allow full-screen alerts" onPress={() => N.openFullScreenSettings()} />}
          {!over && <><Text style={[st.note, { textAlign: "left" }]}>Right now it only takes over the screen when your phone is locked. To have it take over while you're using the phone, allow "Display over other apps".</Text>
            <Btn primary label="Allow over other apps" onPress={() => N.openOverlaySettings()} /></>}
          <Btn label="Test takeover (in 3 seconds)" onPress={() => act(async () => { N.testTakeover(); }, "Lock your phone or switch apps. It rings in 3 seconds.")} />
        </>
      )}
    </View>
  );
}

function TimeField({ label, value, onChange, placeholder }) {
  const [txt, setTxt] = useState(value ? fmtTime(hmDate(value)) : "");
  const [bad, setBad] = useState(false);
  const commit = () => {
    if (!txt.trim()) { setBad(false); return onChange(null); }
    const d = parseLater(txt, new Date(2026, 0, 1, 0, 0));
    if (!d) return setBad(true);
    setBad(false); setTxt(fmtTime(d)); onChange(toHM(d));
  };
  return (
    <View style={{ gap: 4 }}>
      <Text style={[st.note, { textAlign: "left", color: C.ink }]}>{label}</Text>
      <TextInput value={txt} onChangeText={setTxt} onBlur={commit} onSubmitEditing={commit} placeholder={placeholder} placeholderTextColor={C.muted} style={[st.input, bad && { borderColor: C.hot }]} />
      {bad && <Text style={[st.note, { textAlign: "left", color: C.hot }]}>Try a time like 9:30pm.</Text>}
    </View>
  );
}

function Btn({ label, onPress, primary, danger, flex, disabled }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button"
      style={({ pressed }) => [st.btn, primary && st.btnPrimary, danger && st.btnDanger, flex && { flex: 1 }, (pressed || disabled) && { opacity: 0.7 }]}>
      <Text style={[st.btnTxt, danger && { color: C.hot }]}>{label}</Text>
    </Pressable>
  );
}
function Chip({ label, on, onPress }) {
  return <Pressable onPress={onPress} style={[st.chip, on && st.chipOn]}><Text style={st.chipTxt}>{label}</Text></Pressable>;
}
function Field({ label, ...props }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={st.label}>{label.toUpperCase()}</Text>
      <TextInput {...props} placeholderTextColor={C.muted} style={[st.input, props.multiline && { minHeight: 70, textAlignVertical: "top" }]} />
    </View>
  );
}

function makeStyles() { return StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 8, gap: 10 },
  tabs: { flexDirection: "row", backgroundColor: C.bg2, borderRadius: 999, padding: 3, gap: 2 },
  tab: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  tabOn: { backgroundColor: C.accent },
  tabTxt: { color: C.muted, fontWeight: "600", fontSize: 13 },
  tabTxtOn: { color: C.ink },
  handCount: { color: C.muted, fontSize: 12, letterSpacing: 1 },
  handN: { color: C.ink, fontSize: 22, fontWeight: "800" },
  h1: { fontSize: 40, fontWeight: "800", color: C.ink },
  h2: { fontSize: 24, fontWeight: "800", color: C.ink },
  h3: { fontSize: 16, fontWeight: "700", color: C.ink },
  note: { fontSize: 13, color: C.muted, textAlign: "center" },
  label: { fontSize: 11, color: C.muted, letterSpacing: 1.2, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  card: { width: 280, maxWidth: "80%", aspectRatio: 5 / 7, backgroundColor: C.paper, borderRadius: 16, alignItems: "center", justifyContent: "center", padding: 24, elevation: 6, shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
  cardTitle: { fontSize: 34, fontWeight: "800", color: C.ink, textAlign: "center" },
  cardVar: { marginTop: 10, fontSize: 15, color: C.muted, textAlign: "center" },
  idx: { position: "absolute", alignItems: "center" },
  idxR: { fontSize: 20, fontWeight: "800", color: C.ink },
  idxS: { fontSize: 14 },
  pips: { position: "absolute", bottom: 18, flexDirection: "row", gap: 4 },
  pip: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#f6d6e4" },
  deckStack: { width: 280, maxWidth: "80%", aspectRatio: 5 / 7, alignItems: "center", justifyContent: "center" },
  back: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 16, backgroundColor: C.accent, borderWidth: 6, borderColor: C.paper, elevation: 4 },
  drawBtn: { backgroundColor: C.paper, paddingVertical: 18, paddingHorizontal: 22, borderRadius: 14, elevation: 8 },
  drawTxt: { fontSize: 22, fontWeight: "800", color: C.ink },
  mini: { width: 108, aspectRatio: 5 / 7, backgroundColor: C.paper, borderRadius: 10, padding: 9, justifyContent: "space-between", borderWidth: 3, borderColor: "transparent", elevation: 3 },
  miniSel: { borderColor: C.accent },
  miniMeta: { fontSize: 11, color: C.muted },
  miniLabel: { fontSize: 15, fontWeight: "700", color: C.ink },
  btn: { minHeight: 48, paddingHorizontal: 16, borderRadius: 12, borderWidth: 2, borderColor: C.accent, alignItems: "center", justifyContent: "center" },
  btnPrimary: { backgroundColor: C.accent },
  btnDanger: { borderColor: C.hot },
  btnTxt: { fontSize: 16, fontWeight: "700", color: C.ink },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1.5, borderColor: C.line, backgroundColor: C.bg },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  chipTxt: { color: C.ink, fontWeight: "600" },
  input: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: C.ink },
  panel: { backgroundColor: C.bg2, borderRadius: 14, padding: 14, gap: 10 },
  scrim: { flex: 1, backgroundColor: "rgba(58,22,48,0.35)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: C.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36, gap: 12 },
  sheetScroll: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "88%", backgroundColor: C.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  board: { backgroundColor: C.felt, borderRadius: 18, overflow: "hidden" },
  side: { padding: 14, gap: 10, minHeight: 190 },
  avatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.accent, alignItems: "center", justifyContent: "center" },
  avatarTxt: { fontWeight: "800", color: C.ink },
  turnTag: { backgroundColor: C.accent, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  turnTagTxt: { fontSize: 10, fontWeight: "700", color: C.ink, letterSpacing: 1 },
  played: { flex: 1, minHeight: 130, borderWidth: 1.5, borderStyle: "dashed", borderColor: C.line, borderRadius: 12 },
  pc: { width: 76, aspectRatio: 5 / 7, backgroundColor: C.paper, borderRadius: 8, padding: 6, marginLeft: -12, justifyContent: "space-between", elevation: 3 },
  fresh: { borderWidth: 2, borderColor: C.accent },
  pcMeta: { fontSize: 10, color: C.muted, letterSpacing: 0.5 },
  pcLabel: { fontSize: 12, fontWeight: "700", color: C.ink },
  cubes: { width: 90, borderWidth: 1.5, borderStyle: "dashed", borderColor: C.line, borderRadius: 12, padding: 8, gap: 6 },
  cubeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 3 },
  cube: { width: 14, height: 14, borderRadius: 3 },
  mid: { flexDirection: "row", alignItems: "center", justifyContent: "space-around", backgroundColor: C.bg2, paddingVertical: 14 },
  pile: { alignItems: "center", gap: 6 },
  pileBack: { width: 56, height: 78, borderRadius: 8, backgroundColor: C.accent, borderWidth: 3, borderColor: C.paper },
  pileDis: { width: 56, height: 78, borderRadius: 8, borderWidth: 1.5, borderStyle: "dashed", borderColor: C.line, alignItems: "center", justifyContent: "center", padding: 4 },
  pileDisHas: { backgroundColor: C.paper, borderStyle: "solid", transform: [{ rotate: "-4deg" }] },
  turnBig: { fontSize: 28, fontWeight: "800", color: C.ink },
  deckRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.bg2, borderRadius: 10, padding: 12 },
  planRow: { fontSize: 14, color: C.ink, fontVariant: ["tabular-nums"] },
  home: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18, padding: 16 },
  link: { color: C.muted, fontSize: 14, textDecorationLine: "underline" },
  handGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  miniGrid: { width: "31%", aspectRatio: undefined, minHeight: 150 },
  miniAway: { width: "22%", aspectRatio: undefined, minHeight: 92, padding: 7, opacity: 0.6, elevation: 0, borderStyle: "dashed", borderColor: C.line, borderWidth: 2 },
  miniLabelAway: { fontSize: 12, fontWeight: "700", color: C.ink },
  awayTag: { alignSelf: "flex-start", maxWidth: "100%", backgroundColor: C.bg2, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2 },
  awayTagTxt: { fontSize: 10, fontWeight: "700", color: C.muted },
  topRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 10, paddingRight: 8, paddingTop: 4, paddingBottom: 10 },
  menuBtn: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", gap: 4, backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.line, elevation: 4 },
  menuLine: { width: 18, height: 2.5, borderRadius: 2, backgroundColor: C.ink },
  edgeZone: { position: "absolute", left: 0, top: 0, bottom: 0, width: 22 },
  edgeGrab: { position: "absolute", left: 0, top: 0, bottom: 0, width: 18 },
  // A thin bar down the top half of the left edge, with a small tab, so you know the menu pulls out from there.
  edgeHandle: { position: "absolute", left: 0, top: "12%", height: "40%", width: 3, borderTopRightRadius: 3, borderBottomRightRadius: 3, backgroundColor: C.accent, opacity: 0.85, justifyContent: "center" },
  edgeTab: { width: 8, height: 44, borderTopRightRadius: 6, borderBottomRightRadius: 6, backgroundColor: C.accent },
  drawerScrim: { backgroundColor: "rgba(58,22,48,0.35)" },
  drawer: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: C.bg, paddingHorizontal: 16, paddingTop: 12, elevation: 16, borderTopRightRadius: 20, borderBottomRightRadius: 20 },
  drawerBrand: { fontSize: 30, fontWeight: "800", color: C.ink, marginTop: 8 },
  drawerItem: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 52, paddingHorizontal: 14, borderRadius: 12 },
  drawerItemOn: { backgroundColor: C.accent },
  drawerIcon: { fontSize: 18, width: 22, textAlign: "center", color: C.ink },
  drawerTxt: { fontSize: 17, fontWeight: "600", color: C.ink },
  tableBar: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, backgroundColor: C.bg2, minHeight: 44 },
  tableBarLbl: { fontSize: 11, color: C.muted, letterSpacing: 1.2, fontWeight: "600" },
  tableBarName: { flex: 1, fontSize: 16, fontWeight: "800", color: C.ink },
  tableBarCaret: { fontSize: 16, color: C.ink },
  tableRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 12, backgroundColor: C.bg2, borderWidth: 2, borderColor: "transparent", minHeight: 56 },
  tableRowOn: { borderColor: C.accent },
  leaveBtn: { minHeight: 36, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1.5, borderColor: C.line, justifyContent: "center" },
  leaveTxt: { fontSize: 13, fontWeight: "700", color: C.muted },
  tablePick: { gap: 6 },
  tableChip: { minHeight: 40, paddingHorizontal: 14, borderRadius: 999, backgroundColor: C.bg2, justifyContent: "center", borderWidth: 2, borderColor: "transparent" },
  tableChipOn: { backgroundColor: C.accent, borderColor: C.ink },
  tableChipTxt: { fontSize: 15, fontWeight: "700", color: C.muted },
  countsAt: { backgroundColor: C.bg2, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 12, maxWidth: "85%" },
  countsAtOff: { borderWidth: 1, borderColor: C.warm, borderStyle: "dashed" },
  countsAtTxt: { fontSize: 12, fontWeight: "600", color: C.muted, textAlign: "center" },
  check: { width: 20, height: 20, borderRadius: 10, backgroundColor: C.accent, alignItems: "center", justifyContent: "center" },
  checkTxt: { fontSize: 12, fontWeight: "800", color: C.ink },
  stackEdge: { position: "absolute", left: 0, width: 72, height: 100, borderRadius: 8, backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderTopWidth: 3, elevation: 1 },
  stackTop: { position: "absolute", left: 0, marginLeft: 0, width: 72, height: 100, borderTopWidth: 3, borderWidth: 1, borderColor: C.line },
  stackN: { fontSize: 11, fontWeight: "800", color: C.ink },
  lock: { alignSelf: "stretch", backgroundColor: C.paper, borderRadius: 12, borderWidth: 2, borderColor: C.hot, padding: 12 },
  lockTxt: { color: C.ink, fontWeight: "600", fontSize: 14 },
  swipeTag: { position: "absolute", top: 18, alignSelf: "center", backgroundColor: C.paper, borderWidth: 3, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, elevation: 8 },
  swipeTagTxt: { fontSize: 16, fontWeight: "800" },
  fullCard: { position: "absolute", left: 6, right: 6, top: 6, bottom: 6, backgroundColor: C.paper, borderRadius: 24, elevation: 6, overflow: "hidden" },
  fullCardBody: { flex: 1, paddingHorizontal: 22 },
  fullCorner: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  fullSuit: { fontSize: 34 },
  fullBeef: { fontSize: 64, fontWeight: "800", color: C.ink, lineHeight: 70 },
  fullTitle: { fontSize: 44, fontWeight: "800", color: C.ink, textAlign: "center" },
  fullVar: { fontSize: 18, color: C.muted, textAlign: "center", maxWidth: 320 },
  whereChip: { backgroundColor: C.bg2, borderRadius: 12, paddingVertical: 6, paddingHorizontal: 10, alignItems: "center" },
  whereChipHere: { borderWidth: 2, borderColor: C.accent },
  whereTable: { fontSize: 13, fontWeight: "800", color: C.ink },
  whereMap: { fontSize: 12, color: C.muted },
  cardControls: { position: "absolute", left: 16, right: 16, alignItems: "center", gap: 8, padding: 12, borderRadius: 20, backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.line, elevation: 10 },
  fullBack: { position: "absolute", left: 6, right: 6, bottom: 6, borderRadius: 24, backgroundColor: C.paper, padding: 8, elevation: 6 },
  fullBackInner: { flex: 1, borderRadius: 18, backgroundColor: C.accent, alignItems: "center", justifyContent: "center" },
  miniBeef: { fontSize: 18, fontWeight: "800", color: C.ink },
  wheel: { position: "absolute", left: 0, right: 0, bottom: 0 },
  wheelArrow: { width: 40, height: 40, marginBottom: 22, alignItems: "center", justifyContent: "center", borderRadius: 20, backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.line, elevation: 3 },
  wheelArrowTxt: { fontSize: 24, fontWeight: "800", color: C.ink, marginTop: -3 },
  wheelSlot: { position: "absolute", left: 0, right: 0, top: 18, alignItems: "center" },
  wheelTxt: { fontSize: 14, fontWeight: "700", color: C.muted, letterSpacing: 1.5, textTransform: "uppercase" },
  wheelTxtOn: { fontSize: 16, fontWeight: "800", color: C.ink },
  wheelCount: { fontSize: 12, fontWeight: "800", color: C.accent },
  wheelDot: { position: "absolute", top: 8, width: 6, height: 6, marginLeft: -3, borderRadius: 3, backgroundColor: C.accent },
  cardFrame: { position: "absolute", left: 12, right: 12, borderRadius: 14, borderWidth: 2, borderColor: C.line },
  cardBand: { position: "absolute", left: 0, right: 0, top: 0 },
  cardFoot: { position: "absolute", left: 0, right: 0, bottom: 0 },
  bandRule: { position: "absolute", left: 0, right: 0, height: 2 },
  whereLine: { fontSize: 14, fontWeight: "800", color: C.ink, textAlign: "center" },
  whereDim: { fontWeight: "500", color: C.muted },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 10 },
  trayClose: { position: "absolute", top: 6, right: 6, width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", zIndex: 2 },
  trayCloseTxt: { fontSize: 15, fontWeight: "800", color: C.muted },
  helpBtn: { position: "absolute", right: 18, width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.line, elevation: 6 },
  helpTxt: { fontSize: 20, fontWeight: "800", color: C.ink },
  deckLogo: { position: "absolute", flexDirection: "row", gap: 2, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1.5, backgroundColor: C.paper },
  deckLogoTxt: { fontSize: 22 },
  emojiCell: { width: 44, height: 44, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: C.paper, borderWidth: 2, borderColor: "transparent" },
  emojiCellOn: { borderColor: C.accent },
  editBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: C.line },
  editIcon: { fontSize: 18, color: C.ink },
  cardKicker: { fontSize: 11, fontWeight: "800", letterSpacing: 2.5, color: C.muted },
  cardRule: { height: 1.5, backgroundColor: C.line, marginHorizontal: -4 },
  titleRule: { width: 120, height: 1.5, backgroundColor: C.line, alignItems: "center", justifyContent: "center" },
  titleDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  swipeHint: { fontSize: 12, color: C.muted, textAlign: "center" },
  toast: { position: "absolute", left: 16, right: 16, bottom: 24, backgroundColor: C.ink, borderRadius: 12, padding: 12 },
  toastTxt: { color: C.bg, textAlign: "center", fontWeight: "600" },
  toastUndo: { color: C.accent, fontWeight: "800", letterSpacing: 1, paddingHorizontal: 8 },
  undoBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.line, elevation: 4, alignItems: "center", justifyContent: "center" },
  undoIcon: { fontSize: 24, fontWeight: "800", color: C.ink, marginTop: -2 },
}); }
let st = makeStyles();
