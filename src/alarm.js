// Prompt — acting on the full-screen alarm. The alarm screen (native) queues what you chose:
// play, hold, less (often), snooze (30 min). This applies the queue, across all your tables.
// Alarm ids: "card-<cardId>" (takeover time, e.g. Go to bed), "deal-<cardId>-<ms>" (a card that
// always takes over), "lock-<cardId>" (holding too many; play or discard one from your hand).
import * as Notifications from "expo-notifications";
import Takeover from "../modules/takeover";
import * as S from "./store";
import * as M from "./multi";
import { dealFrom } from "./model";

const cardOf = (id) => id.startsWith("lock-") || id.startsWith("card-") ? id.slice(5) : id.startsWith("deal-") ? id.slice(5).replace(/-\d+$/, "") : null;

async function makeCtx(me, rooms, paused, room) {
  const states = {};
  for (const r of rooms) states[r] = await S.fetchRoom(r);
  return { rooms, live: rooms.filter((r) => !paused.includes(r)), paused, states, room, me };
}

async function applyOne({ id, action }, me, rooms, paused) {
  const cardId = cardOf(id);
  if (!cardId) return;
  let ctx = await makeCtx(me, rooms, paused, rooms[0]);
  if (id.startsWith("lock-")) {
    const g = M.handGroups(ctx).find((x) => x.h.cardId === cardId);
    if (!g) return;
    if (action === "play") await M.playGroup(ctx, g);
    else if (action === "less") await M.discardGroup(ctx, g);
    return;
  }
  const up = (r) => { const t = ctx.states[r]?.tables[me.id]; return t && !t.empty ? t : null; };
  let room = ctx.live.find((r) => up(r)?.cardId === cardId);
  if (!room) {
    // The deal is still in the notification shade, or (Go to bed) deal it now.
    const shown = await Notifications.getPresentedNotificationsAsync().catch(() => []);
    const n = shown.find((x) => x.request.content.data?.kind === "deal" && x.request.content.data.card?.cardId === cardId);
    let t = n?.request.content.data.card, r = n?.request.content.data.room;
    if (!t) {
      r = ctx.live.find((x) => ctx.states[x].cards.some((c) => c.id === cardId));
      if (!r) return;
      t = dealFrom(ctx.states[r].cards.find((c) => c.id === cardId));
    }
    if (!ctx.live.includes(r) || up(r)) return; // something else is face up there; leave it for the app
    await S.placeOnTable(r, me, t);
    if (n) Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {});
    ctx = await makeCtx(me, rooms, paused, r);
    await M.mirrorTop(ctx, r);
    ctx = await makeCtx(me, rooms, paused, r);
    room = r;
  }
  const t = up(room);
  if (!t || t.cardId !== cardId) return;
  if (action === "play") await M.playTop(ctx, room, t);
  else if (action === "hold") await M.holdTop(ctx, room, t);
  else if (action === "less") await M.swipeAll(ctx, room, t, { kind: "later", tilt: 0 });
  else if (action === "snooze") await M.swipeAll(ctx, room, t, { kind: "soon", tilt: 0 });
}

let busy = null;
/** Apply what you chose on alarm screens. Returns how many actions were applied. */
export function applyAlarmActions() {
  if (busy) return busy;
  busy = (async () => {
    if (!Takeover?.takeActions) return 0;
    let q = [];
    try { q = JSON.parse(Takeover.takeActions() || "[]"); } catch {}
    if (!q.length) return 0;
    const profile = await S.loadProfile();
    if (!profile?.me) return 0;
    const rooms = [...new Set([...(profile.rooms || []), profile.room].filter(Boolean))];
    for (const a of q) { try { await applyOne(a, profile.me, rooms, profile.paused || []); } catch {} }
    return q.length;
  })().finally(() => { busy = null; });
  return busy;
}

/** Run `cb` whenever the alarm screen queues an action while the app is alive. */
export function onAlarmAction(cb) {
  if (!Takeover?.addListener) return () => {};
  const sub = Takeover.addListener("onAction", cb);
  return () => sub?.remove?.();
}
