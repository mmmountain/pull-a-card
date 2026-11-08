// Prompt — catching up after time away. Everything waiting (deal notifications still in the shade, plus your
// face-up card at each enabled table) is grouped by card. You say how many of each you did; the rest go
// back in the deck, into your hand, or are let go.
import * as Notifications from "expo-notifications";
import * as S from "./store";
import * as M from "./multi";

const keyOf = (t) => String(t.base || t.label || "").trim().toLowerCase();

/** Everything waiting, oldest first: [{ src: "note"|"top", room, t, at, nid? }]. */
export async function gather(ctx) {
  const out = [];
  const seenLinks = new Set();
  for (const r of ctx.live || ctx.rooms) {
    const t = ctx.states[r]?.tables?.[ctx.me.id];
    if (!t || t.empty) continue;
    if (t.link) { if (seenLinks.has(t.link)) continue; seenLinks.add(t.link); } // one card counting at several tables
    out.push({ src: "top", room: r, t, at: t.drawnAt || new Date().toISOString() });
  }
  let shown = [];
  try { shown = await Notifications.getPresentedNotificationsAsync(); } catch {}
  for (const n of shown) {
    const d = n.request.content.data || {};
    if (d.kind !== "deal" || !d.card || !(ctx.live || ctx.rooms).includes(d.room)) continue;
    // The newest one may already be face up (it's claimed when the app opens); don't count it twice.
    const top = ctx.states[d.room]?.tables?.[ctx.me.id];
    if (top && !top.empty && top.drawnAt === d.card.drawnAt && top.cardId === d.card.cardId) continue;
    out.push({ src: "note", room: d.room, t: d.card, at: new Date(n.date || Date.now()).toISOString(), nid: n.request.identifier });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Group by card: [{ key, label, suit, items }], biggest pile first. */
export function groups(items) {
  const m = new Map();
  for (const it of items) {
    const k = keyOf(it.t);
    if (!m.has(k)) m.set(k, { key: k, label: it.t.base || it.t.label, suit: it.t.suit, items: [] });
    m.get(k).items.push(it);
  }
  return [...m.values()].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}

/** How many of each group a percentage means: 50% of 5 → 3 (rounds half up). */
export const share = (n, pct) => Math.min(n, Math.round((n * pct) / 100 + 1e-9));

/**
 * decisions: Map(item → "did" | "deck" | "hold" | "drop"). Applies them; returns counts.
 * "did" is credited at the time the card came in, and marked as catch-up.
 */
export async function apply(ctx, decisions) {
  const tally = { did: 0, deck: 0, hold: 0, drop: 0 };
  for (const [it, what] of decisions) {
    try {
      if (it.src === "top") {
        if (what === "did") await M.playTop(ctx, it.room, it.t, { at: it.at, catchup: true });
        else if (what === "hold") await M.holdTop(ctx, it.room, it.t);
        else if (what === "deck") await M.returnTopAll(ctx, it.room, it.t);
        else await M.dropTopAll(ctx, it.room, it.t);
      } else {
        if (what === "did") await S.creditNote(it.room, ctx.me, it.t, it.at);
        else if (what === "hold") await S.holdNote(it.room, ctx.me, it.t, it.at);
        else if (what === "drop") await S.dropNote(it.room, it.t, it.at);
        // "deck": never counted, so dismissing it leaves it owed.
        if (it.nid) await Notifications.dismissNotificationAsync(it.nid).catch(() => {});
      }
      tally[what]++;
    } catch {}
  }
  return tally;
}
