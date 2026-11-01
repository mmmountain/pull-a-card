import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Switch, Text, TextInput, View,
  Animated, PanResponder, Vibration,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";
import * as S from "./src/store";
import * as N from "./src/notify";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ORIGINAL, randomTheme } from "./src/theme";
import { bufferBlock, bufferMessage, BUFFER_STEPS, swipeIntent, swipeLabel, hmDate, toHM } from "./src/model";
import { myChaos, myDeck, stackPlays, lastMove, drawable, activeLocks, canPlay, lockMessage, quotaLabel, PERIODS, PERIOD_NAMES, effectiveQuota, amountLabel } from "./src/model";
import { SUIT, SUITS, ago, cardLine, fmtTime, heat, newId, parseLater } from "./src/model";
import { DECK_LIBRARY, deckOf, everydayId, myDecks } from "./src/model";

// Live color palette. applyTheme() swaps it in place and redraws the app.
const C = { ...ORIGINAL, suit: { ...ORIGINAL.suit } };
const THEME_KEY = "pac.theme.v1";
let redraw = null;
function applyTheme(t, save = true) {
  Object.assign(C, t, { suit: { ...t.suit } });
  st = makeStyles();
  if (save) AsyncStorage.setItem(THEME_KEY, JSON.stringify(t)).catch(() => {});
  redraw?.();
}

/* ---------------- room hook ---------------- */
function useRoom(room) {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const timer = useRef(null);
  const refresh = useCallback(async () => {
    if (!room) return;
    try {
      setState(await S.fetchRoom(room));
      setError("");
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [room]);
  useEffect(() => {
    if (!room) return;
    refresh();
    const off = S.subscribeRoom(room, () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(refresh, 250);
    });
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, [room, refresh]);
  return { state, error, refresh };
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
      const p = { room: r, me, prefs: initial?.prefs || S.DEFAULT_PREFS };
      await S.saveProfile(p);
      onDone(p);
    } catch (e) {
      setErr("Couldn't reach the table: " + (e.message || e));
    } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={st.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, padding: 24, justifyContent: "center", gap: 14 }}>
        <Text style={st.h1}>Pull a Card</Text>
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
  const prefs = { ...S.DEFAULT_PREFS, ...(profile.prefs || {}) };
  const { state, error, refresh } = useRoom(room);
  const [tab, setTab] = useState("card");
  const [focusHand, setFocusHand] = useState(null);
  const [msg, setMsg] = useState("");
  const say = (t) => { setMsg(t); setTimeout(() => setMsg((m) => (m === t ? "" : m)), 4000); };

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
      refresh();
    })();
    const sub = Notifications.addNotificationResponseReceivedListener(onResponse);
    const app = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        if (N.consumeShowCard()) setTab("card");
        N.claimDeliveredDeal(room, me).catch(() => {}).then(() => S.claimTakeover(room, me, prefs)).catch(() => {}).finally(refresh);
      }
    });
    return () => { sub.remove(); app.remove(); };
  }, [room]);

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
    myChaos(state.players, me.id, state.config.chaos), prefs, state.hands.length, state.plays.length,
  ]), [state, profile.prefs]);
  useEffect(() => {
    if (!state) return;
    const t = setTimeout(() => { N.rescheduleDeals(room, me, prefs, state).catch(() => {}); }, 1500);
    return () => clearTimeout(t);
  }, [planKey]);

  const act = async (fn, ok) => {
    try { await fn(); if (ok) say(ok); } catch (e) { say("Couldn't save: " + (e.message || e)); }
    refresh();
  };

  if (!state) {
    return <Centered>{error ? <><Text style={st.h2}>Can't reach the table</Text><Text style={st.note}>{error}</Text><Btn label="Try again" onPress={refresh} /></> : <ActivityIndicator color={C.accent} />}</Centered>;
  }
  const myHand = state.hands.filter((h) => h.seat === me.id);

  return (
    <SafeAreaView style={st.screen} edges={["top", "left", "right"]}>
      <StatusBar style="dark" />
      <View style={st.header}>
        <View style={st.tabs}>
          {[["card", "Card"], ["hand", "Hand"], ["table", "Table"], ["deck", "Deck"], ["me", "Me"]].map(([k, l]) => (
            <Pressable key={k} onPress={() => setTab(k)} style={[st.tab, tab === k && st.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
              <Text style={[st.tabTxt, tab === k && st.tabTxtOn]}>{l}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={st.handCount}>HAND <Text style={st.handN}>{myHand.length}</Text></Text>
      </View>
      {tab === "card" ? <CardView state={state} room={room} me={me} act={act} goTo={setTab} prefs={prefs} say={say} /> : (
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 18 }}>
        {tab === "hand" && <HandView state={state} room={room} me={me} act={act} focusHand={focusHand} />}
        {tab === "table" && <TableView state={state} me={me} />}
        {tab === "deck" && <DeckView state={state} room={room} me={me} act={act} />}
        {tab === "me" && <MeView profile={profile} prefs={prefs} setProfile={setProfile} act={act} state={state} />}
      </ScrollView>)}
      {!!msg && <View style={st.toast}><Text style={st.toastTxt}>{msg}</Text></View>}
    </SafeAreaView>
  );
}

/* ---------------- card (home) ---------------- */
// Just the card in front of you. Tap to pull one, then play it or hold it.
function CardView({ state, room, me, act, goTo, prefs, say }) {
  const t = state.tables[me.id];
  const top = t && !t.empty ? t : null;
  const [later, setLater] = useState(false);
  const setReminder = async (at) => {
    setLater(false);
    await act(async () => {
      const handId = await S.holdCard(room, me, top, at);
      await N.scheduleReminder(room, handId, top, at);
    }, "Held. Reminder at " + fmtTime(at));
  };
  const locks = activeLocks(state.cards, state.hands, me.id);
  const wait = top && bufferBlock(state.cards.find((c) => c.id === top.cardId), state.plays, me.id);
  const blocked = top && (!canPlay(locks, [top.cardId]) || !!wait);
  return (
    <View style={st.home}>
      {!!locks.length && <LockBanner locks={locks} />}
      {top ? (
        <>
          <SwipeCard key={top.drawnAt} t={top} say={say} quota={quotaLabel(state.cards.find((c) => c.id === top.cardId) || {}, Date.now(), prefs)}
            blockedMsg={wait ? "Not yet. " + bufferMessage(wait) : blocked ? lockMessage(locks) : ""}
            onSwipe={(it) => act(async () => {
              const r = await S.swipeTop(room, me, top, it);
              if (r.handId && r.remindAt) await N.scheduleReminder(room, r.handId, top, r.remindAt);
            }, swipeLabel(it) + ": " + top.label)} />
          <View style={[st.row, { width: 280, maxWidth: "80%" }]}>
            <Btn primary flex label={wait ? "Wait" : blocked ? "Locked" : "Play"} disabled={blocked} onPress={() => act(() => S.playCard(room, me, top), "Played: " + top.label)} />
            <Btn flex label="Hold" onPress={() => act(() => S.holdCard(room, me, top), "Held: " + top.label)} />
          </View>
          {!!wait && <Text style={[st.note, { maxWidth: 300 }]}>⏳ {bufferMessage(wait)}</Text>}
          <Pressable onPress={() => setLater(true)} hitSlop={10}><Text style={st.link}>Remind me later</Text></Pressable>
        </>
      ) : !drawable(state.cards, state.players, state.hands, state.tables, me.id, state.decks).length ? (
        <View style={{ alignItems: "center", gap: 12, maxWidth: 300 }}>
          <Text style={[st.h2, { textAlign: "center" }]}>Nothing left to pull</Text>
          <Text style={st.note}>{state.hands.some((h) => h.seat === me.id) ? "Every card in your deck is in your hand. Play or discard some to put them back in the deck." : "Your deck is empty or switched off. Add a card in the Deck tab."}</Text>
          <View style={st.row}>
            <Btn flex primary label="Open hand" onPress={() => goTo("hand")} />
            <Btn flex label="Add a card" onPress={() => goTo("deck")} />
          </View>
        </View>
      ) : (
        <Pressable onPress={() => act(() => S.draw(room, me, prefs))} style={st.deckStack} accessibilityRole="button" accessibilityLabel="Tap to pull a card">
          <View style={[st.back, { transform: [{ rotate: "-4deg" }], opacity: 0.6 }]} />
          <View style={[st.back, { transform: [{ rotate: "3deg" }], opacity: 0.8 }]} />
          <View style={st.back} />
          <View style={st.drawBtn}><Text style={st.drawTxt}>Tap to pull a card</Text></View>
        </Pressable>
      )}
      <LaterSheet open={later} label={top?.label} onClose={() => setLater(false)} onPick={setReminder} />
    </View>
  );
}

/* ---------------- hand ---------------- */
// Select one card to play, remind or discard; select several to play them together.
function HandView({ state, room, me, act, focusHand }) {
  const hand = state.hands.filter((h) => h.seat === me.id).sort((a, b) => (a.heldAt || "").localeCompare(b.heldAt || ""));
  const [sel, setSel] = useState(focusHand ? [focusHand] : []);
  const [later, setLater] = useState(null);
  useEffect(() => { if (focusHand) setSel([focusHand]); }, [focusHand]);
  const picked = hand.filter((h) => sel.includes(h.id));
  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const myTurn = state.game.active === me.id;
  const locks = activeLocks(state.cards, state.hands, me.id);
  const waitOf = (h) => bufferBlock(state.cards.find((c) => c.id === h.cardId), state.plays, me.id);
  const waiting = picked.map(waitOf).find(Boolean);
  const blocked = picked.length > 0 && (!canPlay(locks, picked.map((h) => h.cardId)) || !!waiting);
  const setReminder = async (at) => {
    const h = later; setLater(null);
    await act(async () => { await S.setRemind(room, h.id, at); await N.scheduleReminder(room, h.id, h, at); }, "Reminder at " + fmtTime(at));
  };
  if (!hand.length) return <View style={{ paddingTop: 60, gap: 8 }}><Text style={st.h2}>Empty hand.</Text><Text style={[st.note, { textAlign: "left" }]}>Cards you hold show up here.</Text></View>;
  return (
    <>
      {!!locks.length && <LockBanner locks={locks} />}
      <Text style={st.label}>{hand.length} HELD · TAP TO SELECT{picked.length > 1 ? " · " + picked.length + " SELECTED" : ""}</Text>
      <View style={st.handGrid}>
        {hand.map((h) => {
          const hot = heat(h), on = sel.includes(h.id);
          const remind = h.remindAt && Date.parse(h.remindAt) > Date.now();
          return (
            <Pressable key={h.id} onPress={() => toggle(h.id)} accessibilityState={{ selected: on }}
              style={[st.mini, st.miniGrid, hot === "warm" && { borderColor: C.warm }, hot === "hot" && { borderColor: C.hot }, on && st.miniSel]}>
              <View style={[st.row, { justifyContent: "space-between" }]}>
                <Text style={[st.miniMeta, { color: C.suit[h.suit] }]}>{SUIT[h.suit]} <Text style={st.miniMeta}>{h.imm}</Text></Text>
                {on && <View style={st.check}><Text style={st.checkTxt}>✓</Text></View>}
              </View>
              <Text style={st.miniLabel}>{h.label}</Text>
              {!!h.variant && <Text style={st.miniMeta} numberOfLines={2}>{h.variant}</Text>}
              <Text style={st.miniMeta}>{waitOf(h) ? "⏳ " + fmtTime(new Date(waitOf(h).until)) : remind ? "⏰ " + fmtTime(h.remindAt) : "held " + ago(h.heldAt)}</Text>
            </Pressable>
          );
        })}
      </View>
      {!!waiting && <Text style={[st.note, { textAlign: "left" }]}>⏳ {bufferMessage(waiting)}</Text>}
      {picked.length === 1 && (
        <View style={st.row}>
          <Btn primary flex label={blocked ? "Locked" : "Play it"} disabled={blocked} onPress={() => { setSel([]); act(() => S.playCombo(room, me, [picked[0].id]), "Played: " + picked[0].label); }} />
          <Btn flex label="Remind" onPress={() => setLater(picked[0])} />
          <Btn flex label="Discard" onPress={() => { setSel([]); act(() => S.discardFromHand(room, me, picked[0].id), "Discarded: " + picked[0].label); }} />
        </View>
      )}
      {picked.length > 1 && (
        <View style={{ gap: 8 }}>
          <Text style={[st.note, { textAlign: "left" }]}>{picked.map((h) => h.label).join(" + ")}</Text>
          <View style={st.row}>
            <Btn primary flex label={blocked ? "Locked" : "Play " + picked.length + " together"} disabled={blocked} onPress={() => { const ids = picked.map((h) => h.id); setSel([]); act(() => S.playCombo(room, me, ids), "Played together"); }} />
            <Btn flex label="Clear" onPress={() => setSel([])} />
          </View>
          {!myTurn && <Text style={[st.note, { textAlign: "left" }]}>It's not your turn, but you can still play.</Text>}
        </View>
      )}
      <LaterSheet open={!!later} label={later?.label} onClose={() => setLater(null)} onPick={setReminder} />
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
function SwipeCard({ t, quota, blockedMsg, onSwipe, say }) {
  const pos = useRef(new Animated.ValueXY()).current;
  const [intent, setIntent] = useState(null);
  const live = useRef({});
  live.current = { blockedMsg, onSwipe, say };
  const lastKind = useRef(null);
  const pr = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
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
      Animated.timing(pos, { toValue: { x: (g.dx / d) * 700, y: (g.dy / d) * 900 }, duration: 230, useNativeDriver: false }).start(() => live.current.onSwipe(it));
    },
    onPanResponderTerminate: () => { Animated.spring(pos, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start(); setIntent(null); },
  }), []);
  const rotate = pos.x.interpolate({ inputRange: [-240, 0, 240], outputRange: ["-16deg", "0deg", "16deg"] });
  const tone = !intent ? null : intent.kind === "play" ? C.accent : intent.kind === "hold" ? C.suit.home : intent.kind === "soon" ? C.warm : C.muted;
  return (
    <View style={{ alignItems: "center", gap: 10 }}>
      <Animated.View {...pr.panHandlers} style={{ transform: [{ translateX: pos.x }, { translateY: pos.y }, { rotate }] }}>
        <BigCard t={t} quota={quota} />
        {!!intent && (
          <View pointerEvents="none" style={[st.swipeTag, { borderColor: tone }]}>
            <Text style={[st.swipeTagTxt, { color: C.ink }]}>{swipeLabel(intent)}</Text>
          </View>
        )}
      </Animated.View>
      <Text style={st.swipeHint}>↑ play · ↓ hold · ← too soon · → not now · lean to adjust</Text>
    </View>
  );
}

function BigCard({ t, quota }) {
  return (
    <View style={st.card}>
      <View style={[st.idx, { top: 12, left: 12 }]}><Text style={st.idxR}>{t.imm}</Text><Text style={[st.idxS, { color: C.suit[t.suit] }]}>{SUIT[t.suit]}</Text></View>
      <Text style={st.cardTitle}>{t.label}</Text>
      {!!t.variant && <Text style={st.cardVar}>{t.variant}</Text>}
      {!!quota && <Text style={[st.cardVar, { fontSize: 13 }]}>{quota}</Text>}
      <View style={st.pips}>{[1, 2, 3, 4, 5].map((i) => <View key={i} style={[st.pip, i <= t.imm && { backgroundColor: C.hot }]} />)}</View>
      <View style={[st.idx, { bottom: 12, right: 12, transform: [{ rotate: "180deg" }] }]}><Text style={st.idxR}>{t.imm}</Text><Text style={[st.idxS, { color: C.suit[t.suit] }]}>{SUIT[t.suit]}</Text></View>
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
function DeckView({ state, room, me, act }) {
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
          {decks.map((d) => <Chip key={d.id} label={(d.active ? "" : "○ ") + d.name + " · " + count(d)} on={d.id === deck.id} onPress={() => pick(d.id)} />)}
          <Chip label="+ Add deck" on={false} onPress={() => setLib(true)} />
        </View>
        <View style={st.panel}>
          <View style={[st.row, { justifyContent: "space-between" }]}>
            <View style={{ flex: 1 }}>
              <Text style={st.h3}>{deck.name}</Text>
              <Text style={[st.note, { textAlign: "left" }]}>{deck.active ? "Cards are dealt from this deck." : "Paused. Nothing is dealt from this deck."}</Text>
            </View>
            <Switch value={deck.active} onValueChange={(v) => act(() => S.setDeckActive(room, me, deck, v), (v ? "Dealing from " : "Paused ") + deck.name)} trackColor={{ true: C.accent }} />
          </View>
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
            <Text style={st.miniMeta}>{quotaLabel(c)} · {"●".repeat(c.imm || 3)}</Text>
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
function MeView({ profile, prefs, setProfile, act, state }) {
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
  const leave = async () => {
    await N.cancelKind("deal");
    const p = { ...profile, room: null };
    await S.saveProfile(p);
    setProfile(p);
  };
  return (
    <>
      <View style={st.panel}>
        <Text style={st.label}>YOU</Text>
        <Text style={st.h3}>{profile.me.name} · table “{profile.room}”</Text>
        <Text style={[st.note, { textAlign: "left" }]}>Friends join by entering the same table name.</Text>
      </View>
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
      <Btn label="Leave this table" onPress={leave} />
      <Text style={st.note}>Version {Updates.createdAt ? Updates.createdAt.toLocaleString() : "built-in"}{Updates.isEmbeddedLaunch ? "" : " · updated"}</Text>
    </>
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
  check: { width: 20, height: 20, borderRadius: 10, backgroundColor: C.accent, alignItems: "center", justifyContent: "center" },
  checkTxt: { fontSize: 12, fontWeight: "800", color: C.ink },
  stackEdge: { position: "absolute", left: 0, width: 72, height: 100, borderRadius: 8, backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderTopWidth: 3, elevation: 1 },
  stackTop: { position: "absolute", left: 0, marginLeft: 0, width: 72, height: 100, borderTopWidth: 3, borderWidth: 1, borderColor: C.line },
  stackN: { fontSize: 11, fontWeight: "800", color: C.ink },
  lock: { alignSelf: "stretch", backgroundColor: C.paper, borderRadius: 12, borderWidth: 2, borderColor: C.hot, padding: 12 },
  lockTxt: { color: C.ink, fontWeight: "600", fontSize: 14 },
  swipeTag: { position: "absolute", top: 18, alignSelf: "center", backgroundColor: C.paper, borderWidth: 3, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, elevation: 8 },
  swipeTagTxt: { fontSize: 16, fontWeight: "800" },
  swipeHint: { fontSize: 12, color: C.muted, textAlign: "center" },
  toast: { position: "absolute", left: 16, right: 16, bottom: 24, backgroundColor: C.ink, borderRadius: 12, padding: 12 },
  toastTxt: { color: C.bg, textAlign: "center", fontWeight: "600" },
}); }
let st = makeStyles();
