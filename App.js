import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Switch, Text, TextInput, View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";
import * as S from "./src/store";
import * as N from "./src/notify";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ORIGINAL, randomTheme } from "./src/theme";
import { myChaos, myDeck, stackPlays, lastMove } from "./src/model";
import { SUIT, SUITS, ago, cardLine, fmtTime, heat, newId, parseLater } from "./src/model";

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
      await N.claimDeliveredDeal(room, me).catch(() => {});
      refresh();
    })();
    const sub = Notifications.addNotificationResponseReceivedListener(onResponse);
    const app = AppState.addEventListener("change", (s) => {
      if (s === "active") N.claimDeliveredDeal(room, me).catch(() => {}).finally(refresh);
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
    myDeck(state.cards, state.players, me.id).map((c) => [c.id, c.label, c.every, c.imm, c.active, c.variants]),
    myChaos(state.players, me.id, state.config.chaos), prefs, state.hands.length,
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
      {tab === "card" ? <CardView state={state} room={room} me={me} act={act} /> : (
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
function CardView({ state, room, me, act }) {
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
  return (
    <View style={st.home}>
      {top ? (
        <>
          <BigCard t={top} />
          <View style={[st.row, { width: 280, maxWidth: "80%" }]}>
            <Btn primary flex label="Play" onPress={() => act(() => S.playCard(room, me, top), "Played: " + top.label)} />
            <Btn flex label="Hold" onPress={() => act(() => S.holdCard(room, me, top), "Held: " + top.label)} />
          </View>
          <Pressable onPress={() => setLater(true)} hitSlop={10}><Text style={st.link}>Remind me later</Text></Pressable>
        </>
      ) : (
        <Pressable onPress={() => act(() => S.draw(room, me))} style={st.deckStack} accessibilityRole="button" accessibilityLabel="Tap to pull a card">
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
  const setReminder = async (at) => {
    const h = later; setLater(null);
    await act(async () => { await S.setRemind(room, h.id, at); await N.scheduleReminder(room, h.id, h, at); }, "Reminder at " + fmtTime(at));
  };
  if (!hand.length) return <View style={{ paddingTop: 60, gap: 8 }}><Text style={st.h2}>Empty hand.</Text><Text style={[st.note, { textAlign: "left" }]}>Cards you hold show up here.</Text></View>;
  return (
    <>
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
              <Text style={st.miniMeta}>{remind ? "⏰ " + fmtTime(h.remindAt) : "held " + ago(h.heldAt)}</Text>
            </Pressable>
          );
        })}
      </View>
      {picked.length === 1 && (
        <View style={st.row}>
          <Btn primary flex label="Play it" onPress={() => { setSel([]); act(() => S.playCombo(room, me, [picked[0].id]), "Played: " + picked[0].label); }} />
          <Btn flex label="Remind" onPress={() => setLater(picked[0])} />
          <Btn flex label="Discard" onPress={() => { setSel([]); act(() => S.discardFromHand(room, me, picked[0].id), "Discarded: " + picked[0].label); }} />
        </View>
      )}
      {picked.length > 1 && (
        <View style={{ gap: 8 }}>
          <Text style={[st.note, { textAlign: "left" }]}>{picked.map((h) => h.label).join(" + ")}</Text>
          <View style={st.row}>
            <Btn primary flex label={"Play " + picked.length + " together"} onPress={() => { const ids = picked.map((h) => h.id); setSel([]); act(() => S.playCombo(room, me, ids), "Played together"); }} />
            <Btn flex label="Clear" onPress={() => setSel([])} />
          </View>
          {!myTurn && <Text style={[st.note, { textAlign: "left" }]}>It's not your turn, but you can still play.</Text>}
        </View>
      )}
      <LaterSheet open={!!later} label={later?.label} onClose={() => setLater(null)} onPick={setReminder} />
    </>
  );
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
        <Text style={st.pcLabel} numberOfLines={3}>{s.label}</Text>
        <Text style={st.pcMeta}>{ago(top.at)}</Text>
      </View>
    </View>
  );
}

function BigCard({ t }) {
  return (
    <View style={st.card}>
      <View style={[st.idx, { top: 12, left: 12 }]}><Text style={st.idxR}>{t.imm}</Text><Text style={[st.idxS, { color: C.suit[t.suit] }]}>{SUIT[t.suit]}</Text></View>
      <Text style={st.cardTitle}>{t.label}</Text>
      {!!t.variant && <Text style={st.cardVar}>{t.variant}</Text>}
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
  const drawN = Math.max(0, myDeck(state.cards, state.players, me.id).filter((c) => c.active !== false).length - state.hands.filter((h) => h.seat === me.id).length);
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
  const cards = myDeck(state.cards, state.players, me.id).sort((a, b) => a.label.localeCompare(b.label));
  const chaos = myChaos(state.players, me.id, state.config.chaos);
  return (
    <>
      <View style={st.panel}>
        <Text style={st.label}>YOUR RANDOMNESS · {chaos}%</Text>
        <View style={st.chips}>{[0, 15, 30, 50, 75, 100].map((v) => <Chip key={v} label={v === 0 ? "Steady" : v === 100 ? "Wild" : v + "%"} on={chaos === v} onPress={() => act(() => S.setChaos(room, me, v))} />)}</View>
        <Text style={[st.note, { textAlign: "left" }]}>Steady deals whatever is most overdue, on a regular clock. Wild picks any card at uneven times.</Text>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={st.label}>YOUR DECK · ONLY YOU SEE IT</Text>
        {cards.map((c) => (
          <Pressable key={c.id} onPress={() => setEdit(c)} style={[st.deckRow, c.active === false && { opacity: 0.5 }]}>
            <Text style={{ color: C.suit[c.suit], fontSize: 18, width: 22 }}>{SUIT[c.suit]}</Text>
            <Text style={[st.h3, { flex: 1 }]} numberOfLines={1}>{c.label}</Text>
            <Text style={st.miniMeta}>every {c.every}h · {"●".repeat(c.imm || 3)}</Text>
          </Pressable>
        ))}
        <Btn primary label="New card" onPress={() => setEdit({ label: "", variants: [], suit: "body", every: 4, imm: 3, active: true, plays: 0 })} />
      </View>
      <CardEditor card={edit} onClose={() => setEdit(null)} onSave={(c) => { setEdit(null); act(() => S.saveCard(room, me, c), "Saved " + c.label); }}
        onDelete={(c) => { setEdit(null); act(() => S.deleteCard(room, c.id), "Deleted " + c.label); }} />
    </>
  );
}

function CardEditor({ card, onClose, onSave, onDelete }) {
  const [c, setC] = useState(card);
  const [vars, setVars] = useState("");
  const [arm, setArm] = useState(false);
  useEffect(() => { setC(card); setVars((card?.variants || []).join("\n")); setArm(false); }, [card]);
  if (!card || !c) return null;
  const save = () => {
    if (!c.label.trim()) return;
    onSave({ ...c, label: c.label.trim(), every: Math.max(0.25, parseFloat(c.every) || 4), variants: vars.split("\n").map((s) => s.trim()).filter(Boolean) });
  };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={st.scrim} onPress={onClose} />
      <ScrollView style={st.sheetScroll} contentContainerStyle={[st.sheet, { position: "relative" }]} keyboardShouldPersistTaps="handled">
        <Text style={st.h2}>{card.id ? "Edit card" : "New card"}</Text>
        <Field label="Label" value={c.label} onChangeText={(v) => setC({ ...c, label: v })} placeholder="Drink water" />
        <Field label="Variations, one per line" value={vars} onChangeText={setVars} multiline placeholder={"a full glass\na whole bottle"} />
        <Text style={st.label}>SUIT</Text>
        <View style={st.chips}>{SUITS.map((s) => <Chip key={s} label={SUIT[s] + " " + s} on={c.suit === s} onPress={() => setC({ ...c, suit: s })} />)}</View>
        <Field label="Comes up every (hours)" value={String(c.every)} onChangeText={(v) => setC({ ...c, every: v })} keyboardType="decimal-pad" />
        <Text style={st.label}>IMMEDIACY</Text>
        <View style={st.chips}>{[1, 2, 3, 4, 5].map((i) => <Chip key={i} label={String(i)} on={c.imm === i} onPress={() => setC({ ...c, imm: i })} />)}</View>
        <Text style={[st.note, { textAlign: "left" }]}>4 and 5 ring louder and show over the lock screen.</Text>
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
        <Text style={st.label}>ABOUT EVERY</Text>
        <View style={st.chips}>{[[45, "45 min"], [60, "1 h"], [90, "1.5 h"], [120, "2 h"], [180, "3 h"], [240, "4 h"]].map(([m, l]) => <Chip key={m} label={l} on={prefs.everyMins === m} onPress={() => update({ everyMins: m })} />)}</View>
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
      <Btn label="Leave this table" onPress={leave} />
      <Text style={st.note}>Version {Updates.createdAt ? Updates.createdAt.toLocaleString() : "built-in"}{Updates.isEmbeddedLaunch ? "" : " · updated"}</Text>
    </>
  );
}

/* ---------------- small parts ---------------- */
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
  toast: { position: "absolute", left: 16, right: 16, bottom: 24, backgroundColor: C.ink, borderRadius: 12, padding: 12 },
  toastTxt: { color: C.bg, textAlign: "center", fontWeight: "600" },
}); }
let st = makeStyles();
