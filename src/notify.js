import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { cardLine, fmtTime, parseLater, pickCard, planDealTimes, dealFrom, hoursSince, myChaos, myDeck } from "./model";
import * as S from "./store";

export const DEAL_CAT = "deal";
export const REMIND_CAT = "reminder";
const DEFAULT_ACTION = Notifications.DEFAULT_ACTION_IDENTIFIER;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function setupNotifications() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("deals", {
      name: "Dealt cards",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 180, 120, 180],
      lightColor: "#ff7eb6",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    await Notifications.setNotificationChannelAsync("urgent", {
      name: "Urgent cards (immediacy 4–5)",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 300, 150, 300, 150, 300],
      lightColor: "#ff4f86",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    await Notifications.setNotificationChannelAsync("reminders", {
      name: "Reminders you set",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 300, 150, 300],
      lightColor: "#ffb020",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
  const later = { identifier: "later", buttonTitle: "Later", textInput: { submitButtonTitle: "Set", placeholder: "3pm, 5:30, in 2h" }, options: { opensAppToForeground: false } };
  await Notifications.setNotificationCategoryAsync(DEAL_CAT, [
    { identifier: "play", buttonTitle: "Play", options: { opensAppToForeground: false } },
    { identifier: "hold", buttonTitle: "Hold", options: { opensAppToForeground: false } },
    later,
  ]);
  await Notifications.setNotificationCategoryAsync(REMIND_CAT, [
    { identifier: "play", buttonTitle: "Play", options: { opensAppToForeground: false } },
    { identifier: "discard", buttonTitle: "Discard", options: { opensAppToForeground: false } },
    later,
  ]);
}

export async function ensurePermission() {
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  const req = await Notifications.requestPermissionsAsync();
  return req.granted;
}

/* ---------- scheduling ---------- */

export async function cancelKind(kind, match) {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  for (const n of all) {
    const d = n.content?.data || {};
    if (d.kind === kind && (!match || match(d))) await Notifications.cancelScheduledNotificationAsync(n.identifier);
  }
}

/** Replace this device's upcoming deals with a fresh plan from the current room state. */
export async function rescheduleDeals(room, me, prefs, state) {
  await cancelKind("deal");
  if (!prefs.notify || !state) return [];
  const chaos = myChaos(state.players, me.id, state.config?.chaos ?? 30);
  const times = planDealTimes({ everyMins: prefs.everyMins, chaos, startHour: prefs.startHour, endHour: prefs.endHour });
  const cards = myDeck(state.cards, state.players, me.id).map((c) => ({ ...c }));
  const up = state.tables[me.id];
  const busy = up && !up.empty ? [up.cardId] : [];
  const out = [];
  for (const when of times) {
    const k = pickCard(cards, busy, chaos, when.getTime());
    if (!k) break;
    k.lastDrawn = when.toISOString();
    const t = dealFrom(k, when.getTime());
    const urgent = (t.imm || 3) >= 4;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: cardLine(t),
        body: `Turn ${state.game?.turn || 1} · Play, Hold, or Later`,
        categoryIdentifier: DEAL_CAT,
        data: { kind: "deal", room, card: t },
        color: "#ff7eb6",
        priority: urgent ? Notifications.AndroidNotificationPriority.MAX : Notifications.AndroidNotificationPriority.HIGH,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when, channelId: urgent ? "urgent" : "deals" },
    });
    out.push({ when, label: t.label });
  }
  return out;
}

export async function scheduleReminder(room, handId, card, at) {
  await cancelKind("reminder", (d) => d.handId === handId);
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "⏰ " + cardLine(card),
      body: `You asked to be reminded at ${fmtTime(at)}. Play, Discard, or Later`,
      categoryIdentifier: REMIND_CAT,
      data: { kind: "reminder", room, handId, card },
      color: "#ffb020",
      priority: Notifications.AndroidNotificationPriority.MAX,
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: "reminders", delivery: "alarmClock" },
  });
}

export async function testNotification() {
  await Notifications.scheduleNotificationAsync({
    content: { title: "● Test card — tap Play", body: "If you can read this, notifications work.", categoryIdentifier: DEAL_CAT, data: { kind: "test" } },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 5, channelId: "urgent" },
  });
}

/* ---------- responses (buttons on the notification) ---------- */

const HANDLED_KEY = "pac.handled.v1";
async function alreadyHandled(key) {
  try {
    const raw = await AsyncStorage.getItem(HANDLED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (list.includes(key)) return true;
    list.push(key);
    await AsyncStorage.setItem(HANDLED_KEY, JSON.stringify(list.slice(-100)));
  } catch {}
  return false;
}

function laterTime(text) {
  const at = parseLater(text);
  if (at && at.getTime() > Date.now() + 60e3) return at;
  return new Date(Date.now() + 60 * 60e3); // unreadable or past → one hour from now
}

async function confirm(title, body) {
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data: { kind: "confirm" } },
    trigger: null,
  });
}

/**
 * Handle a tap or button press. Works with the app open, in the background,
 * or (on Android) after it was closed. Returns what the UI should focus, if anything.
 */
export async function handleResponse(resp) {
  if (!resp) return null;
  const n = resp.notification;
  const data = n?.request?.content?.data || {};
  const action = resp.actionIdentifier;
  const profile = await S.loadProfile();
  if (!profile?.room || !profile?.me) return null;
  const { room, me } = profile;
  if (data.room && data.room !== room) return null;
  // The background task and the in-app listener can both see the same press; act once.
  const key = n.request.identifier + "|" + action + "|" + (resp.userText || "");
  if (action !== DEFAULT_ACTION) {
    if (await alreadyHandled(key)) return null;
  }
  const dismiss = () => Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {});

  if (data.kind === "deal") {
    const t = data.card;
    if (action === "play") {
      try { await S.playCard(room, me, t); } catch (e) { await confirm("Can't play " + t.label, String(e.message || e)); return null; }
      await dismiss();
    } else if (action === "hold") {
      await S.holdCard(room, me, t);
      await dismiss();
    } else if (action === "later") {
      const at = laterTime(resp.userText);
      const handId = await S.holdCard(room, me, t, at);
      await scheduleReminder(room, handId, t, at);
      await dismiss();
      await confirm("Held: " + t.label, "I'll ping you at " + fmtTime(at) + ".");
    } else if (action === DEFAULT_ACTION) {
      await S.placeOnTable(room, me, t);
      return { tab: "play" };
    }
    return null;
  }

  if (data.kind === "reminder") {
    const { handId, card } = data;
    if (action === "play") {
      try { await S.playFromHand(room, me, handId); } catch (e) { await confirm("Can't play " + card.label, String(e.message || e)); return null; }
      await dismiss();
    } else if (action === "discard") {
      await S.discardFromHand(room, me, handId);
      await dismiss();
    } else if (action === "later") {
      const at = laterTime(resp.userText);
      if (await S.setRemind(room, handId, at)) {
        await scheduleReminder(room, handId, card, at);
        await confirm("Still holding: " + card.label, "I'll ping you at " + fmtTime(at) + ".");
      }
      await dismiss();
    } else if (action === DEFAULT_ACTION) {
      return { tab: "play", handId };
    }
    return null;
  }
  return null;
}

/** On launch: if a deal notification fired and is still in the shade, put the newest on the table. */
export async function claimDeliveredDeal(room, me) {
  const shown = await Notifications.getPresentedNotificationsAsync();
  const deals = shown.filter((n) => n.request.content.data?.kind === "deal").sort((a, b) => b.date - a.date);
  if (!deals.length) return null;
  const t = deals[0].request.content.data.card;
  if (hoursSince(t.drawnAt) > 24) return null;
  return S.placeOnTable(room, me, t);
}
