// Pull a Card dealer — Supabase Edge Function.
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

const hoursSince = (ts?: string, now = Date.now()) => (ts ? (now - Date.parse(ts)) / 36e5 : 999);

function pickCard(cards: any[], exclude: string[], chaos: number, now = Date.now()) {
  const ex = new Set(exclude);
  const pool = cards.filter((c) => c.active !== false && !ex.has(c.id));
  if (!pool.length) return null;
  const c = chaos / 100;
  const scored = pool.map((k) => ({ k, d: Math.max(0.05, hoursSince(k.lastDrawn, now) / (k.every || 4)) * (1 + ((k.imm || 3) - 1) * 0.2) }));
  if (c < 0.05) return scored.sort((a, b) => b.d - a.d)[0].k;
  const exp = (1 - c) * 4;
  const w = scored.map((s) => Math.pow(Math.min(s.d, 20), exp));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return scored[i].k; }
  return scored[scored.length - 1].k;
}

const line = (t: any) => `${SUIT[t.suit] || "●"} ${t.label}${t.variant ? " — " + t.variant : ""}`;

function localHour(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(d);
  const h = +(parts.find((p) => p.type === "hour")?.value || 0) % 24;
  const m = +(parts.find((p) => p.type === "minute")?.value || 0);
  return h + m / 60;
}

/** Next deal time: about everyMins from now, jittered by chaos, moved into the waking window. */
function nextDealAt(now: Date, prefs: any, chaos: number, tz: string) {
  const every = prefs?.everyMins || 120, start = prefs?.startHour ?? 8, end = prefs?.endHour ?? 21;
  const jitter = (chaos / 100) * 0.75;
  let t = new Date(now.getTime() + Math.max(10, every * (1 + (Math.random() * 2 - 1) * jitter)) * 6e4);
  for (let i = 0; i < 24 * 6; i++) {
    const h = localHour(t, tz);
    if (h >= start && h < end) return t;
    t = new Date(t.getTime() + 10 * 6e4);
  }
  return t;
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
    const cards = get("cards"), hands = get("hands");
    const tables = Object.fromEntries(all.filter((r) => r.coll === "tables").map((r) => [r.id, r.data]));
    const chaos = all.find((r) => r.coll === "config" && r.id === "main")?.data?.chaos ?? 30;
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

    // Deals.
    if (p.prefs?.notify === false) continue;
    if (p.nextAt && Date.parse(p.nextAt) > now.getTime()) continue;
    const h = localHour(now, tz);
    if (h < (p.prefs?.startHour ?? 8) || h >= (p.prefs?.endHour ?? 21)) {
      await upsert(room, "push", player, { ...p, nextAt: nextDealAt(now, { ...p.prefs, everyMins: 10 }, 0, tz).toISOString() });
      continue;
    }
    const top = tables[player];
    if (top && !top.empty) {
      await send("Still up: " + line(top), `Turn ${game.turn || 1} · Play, hold, or later`, "deal");
    } else {
      const busy = [...hands.map((x: any) => x.cardId), ...Object.values(tables).filter((t: any) => !t.empty).map((t: any) => t.cardId)];
      const k = pickCard(cards, busy, chaos, now.getTime());
      if (k) {
        const vs = (k.variants || []).filter(Boolean);
        const t = { cardId: k.id, label: k.label, variant: vs.length ? vs[Math.floor(Math.random() * vs.length)] : "", suit: k.suit || "body", imm: k.imm || 3, every: k.every || 4, drawnAt: now.toISOString() };
        await upsert(room, "tables", player, t);
        const { id, ...cd } = k;
        await upsert(room, "cards", id, { ...cd, lastDrawn: t.drawnAt });
        await send(line(t), `Turn ${game.turn || 1} · Play, hold, or later`, "deal");
      }
    }
    await upsert(room, "push", player, { ...p, nextAt: nextDealAt(now, p.prefs, chaos, tz).toISOString() });
  }

  return new Response(JSON.stringify({ ok: true, log }), { headers: { "content-type": "application/json" } });
});
