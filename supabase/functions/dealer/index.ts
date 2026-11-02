// Prompt dealer — Supabase Edge Function.
// Runs every 10 minutes (see supabase/dealer-cron.sql). For each phone that turned on
// web notifications, it deals a card when one is due and sends reminders that are due.
// Android app players are not touched: their phones deal to themselves.
//
// Secrets to set (Edge Functions → Secrets): VAPID_PUBLIC, VAPID_PRIVATE, CRON_SECRET.
// Turn OFF "Verify JWT" for this function; it checks CRON_SECRET instead.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUIT: Record<string, string> = { body: "●", home: "■", mind: "▲", work: "◆" };
const APP_URL = "https://mmmountain.github.io/pull-a-card/";

type Doc = { room: string; coll: string; id: string; data: Record<string, any> };

// Same picking and quota rules as the apps (CI copies src/model.js next to this file).
import { dealFrom, filtersFor, hoursSince, markDrawn, myDeck, pickCard, takeoverActive } from "./model.js";

const line = (t: any) => `${SUIT[t.suit] || "●"} ${t.label}${t.variant ? " — " + t.variant : ""}`;

function localHour(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(d);
  const h = +(parts.find((p) => p.type === "hour")?.value || 0) % 24;
  const m = +(parts.find((p) => p.type === "minute")?.value || 0);
  return h + m / 60;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return new Response("forbidden", { status: 403 });

  webpush.setVapidDetails("mailto:pull-a-card@example.com", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!);
  const upsert = (room: string, coll: string, id: string, data: any) =>
    db.from("docs").upsert({ room, coll, id, data, updated_at: new Date().toISOString() });

  const { data: subs } = await db.from("docs").select("room,coll,id,data").eq("coll", "push");
  const now = new Date();
  const log: string[] = [];

  for (const s of (subs || []) as Doc[]) {
    const { room, id: player } = s;
    const p = s.data;
    const tz = p.tz || "America/Chicago";
    const { data: rows } = await db.from("docs").select("coll,id,data").eq("room", room);
    const all = (rows || []) as Doc[];
    const get = (coll: string) => all.filter((r) => r.coll === coll).map((r) => ({ id: r.id, ...r.data }));
    const players = get("players").sort((x: any, y: any) => (x.joined || "").localeCompare(y.joined || ""));
    const first = players[0]?.id;
    // Personal decks: only this player's cards (old ownerless cards belong to the first player).
    // Same rule as the app: this table's decks, cards its map needs, minus cards another deck covers.
    const cards = myDeck(get("cards"), players, player, get("decks"), get("maps")), hands = get("hands");
    const tables = Object.fromEntries(all.filter((r) => r.coll === "tables").map((r) => [r.id, r.data]));
    const me = players.find((x: any) => x.id === player) as any;
    const chaos = typeof me?.chaos === "number" ? me.chaos : (all.find((r) => r.coll === "config" && r.id === "main")?.data?.chaos ?? 30);
    const game = all.find((r) => r.coll === "game" && r.id === "main")?.data || { turn: 1 };

    const send = async (title: string, body: string, tag: string) => {
      try {
        await webpush.sendNotification(p.sub, JSON.stringify({ title, body, tag, url: APP_URL }), { TTL: 3600, urgency: "high" });
        log.push(`${room}/${player}: ${title}`);
        return true;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("docs").delete().match({ room, coll: "push", id: player });
        log.push(`${room}/${player}: push failed ${e?.statusCode || e}`);
        return false;
      }
    };

    // Reminders the player asked for.
    for (const h of hands.filter((h: any) => h.seat === player && h.remindAt && !h.reminded && Date.parse(h.remindAt) <= now.getTime())) {
      const { id, ...rest } = h as any;
      await send("⏰ " + line(h), `Held ${Math.round(hoursSince(h.heldAt))}h. Open to play or discard.`, "remind-" + id);
      await upsert(room, "hands", id, { ...rest, reminded: true });
    }

    // Deals: check every run, deal only when a card is behind its target.
    if (p.prefs?.notify === false) continue;
    const win = { ...(p.prefs || {}), tz, onlyDue: true, plays: get("plays"), meId: player, filters: filtersFor(players, player) };
    // Takeover cards (Go to bed): past their time and still unplayed → nag every run (every 10 minutes).
    const urgent = cards.find((c: any) => takeoverActive(c, now.getTime(), win));
    if (urgent) {
      const top0 = tables[player];
      if (!top0 || top0.empty) {
        const t = dealFrom(urgent, now.getTime(), Math.random, win);
        await upsert(room, "tables", player, t);
        const { id, covers: _c1, ...cd } = urgent as any;
        await upsert(room, "cards", id, { ...cd, ...markDrawn(cd, t.drawnAt, t.amount) });
      }
      await send(urgent.label.toUpperCase(), "Play this card to make it stop.", "takeover");
      continue;
    }
    const h = localHour(now, tz);
    const late = Math.max(...cards.map((c: any) => (c.opensAt ? (+c.opensAt.slice(0, 2) + 1) : 0)));
    if (h < (p.prefs?.startHour ?? 8) || h >= Math.max(p.prefs?.endHour ?? 21, late)) continue;
    const top = tables[player];
    if (top && !top.empty) {
      // Something is already face up: nudge at most every 2 hours.
      if (!p.nextAt || Date.parse(p.nextAt) <= now.getTime()) {
        await send("Still up: " + line(top), `Turn ${game.turn || 1} · Play, hold, or later`, "deal");
        await upsert(room, "push", player, { ...p, nextAt: new Date(now.getTime() + 2 * 36e5).toISOString() });
      }
      continue;
    }
    const k = pickCard(cards, [], chaos, now.getTime(), Math.random, win);
    if (!k) continue;
    const t = dealFrom(k, now.getTime(), Math.random, win);
    await upsert(room, "tables", player, t);
    const { id, covers: _c2, ...cd } = k as any;
    await upsert(room, "cards", id, { ...cd, ...markDrawn(cd, t.drawnAt, t.amount) });
    await send(line(t), `Turn ${game.turn || 1} · Play, hold, or later`, "deal");
    await upsert(room, "push", player, { ...p, nextAt: new Date(now.getTime() + 2 * 36e5).toISOString() });
  }

  return new Response(JSON.stringify({ ok: true, log }), { headers: { "content-type": "application/json" } });
});
