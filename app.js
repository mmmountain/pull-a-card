import * as S from "./store.js";
import { ORIGINAL, randomTheme } from "./theme.js";
import { bufferBlock, bufferMessage, BUFFER_STEPS, swipeIntent, swipeLabel } from "./model.js";
import { myChaos, myDeck, stackPlays, lastMove, drawable, activeLocks, canPlay, lockMessage, quotaLabel, PERIODS, PERIOD_NAMES, effectiveQuota, amountLabel } from "./model.js";
import { SUIT, SUITS, ago, fmtTime, heat, newId, parseLater } from "./model.js";

const $app = document.getElementById("app");

/* ---------- colors ---------- */
const THEME_KEY = "pac.theme.v1";
let theme = ORIGINAL;
function applyTheme(t, save = true) {
  theme = t;
  const r = document.documentElement.style;
  for (const k of ["bg", "bg2", "felt", "paper", "ink", "muted", "line", "accent", "hot", "warm"]) r.setProperty("--" + k, t[k]);
  for (const k of ["body", "home", "mind", "work"]) r.setProperty("--s-" + k, t.suit[k]);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.bg);
  if (save) try { localStorage.setItem(THEME_KEY, JSON.stringify(t)); } catch {}
}
try { const saved = JSON.parse(localStorage.getItem(THEME_KEY)); if (saved?.bg) applyTheme(saved, false); } catch {}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SUITC = { body: "var(--s-body)", home: "var(--s-home)", mind: "var(--s-mind)", work: "var(--s-work)" };
const pips = (n) => `<div class="pips">${[1, 2, 3, 4, 5].map((i) => `<span class="pip${i <= n ? " on" : ""}"></span>`).join("")}</div>`;

let profile = S.loadProfile();
let state = null, tab = new URLSearchParams(location.search).get("tab") || "card";
let sel = [], sheet = null, toastT = null, unsub = null, refreshT = null;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function toast(t) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div"); el.className = "toast"; el.textContent = t; document.body.append(el);
  clearTimeout(toastT); toastT = setTimeout(() => el.remove(), 3500);
}
async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); } catch (e) { toast("Couldn't save: " + (e.message || e)); }
  await refresh();
}
async function refresh() {
  if (!profile?.room) return;
  try { state = await S.fetchRoom(profile.room); } catch (e) { toast("Can't reach the table: " + (e.message || e)); }
  render();
}

/* ---------------- views ---------------- */
function joinView() {
  return `<div style="display:flex;flex-direction:column;gap:14px;padding-top:12vh">
    <h1>Pull a Card</h1>
    <p class="note left">Enter the same table name as your friend to share a table.</p>
    <label><span class="lbl">Your name</span><input type="text" id="jName" value="${esc(profile?.me?.name || "")}" placeholder="Sam" autocomplete="name"></label>
    <label><span class="lbl">Table name</span><input type="text" id="jRoom" value="${esc(profile?.room || "")}" placeholder="scott-and-sam" autocapitalize="none" autocorrect="off"></label>
    <button class="btn primary" data-act="join">Sit down</button>
  </div>`;
}

function header() {
  const n = state ? state.hands.filter((h) => h.seat === profile.me.id).length : 0;
  return `<header><nav class="tabs" role="tablist">${[["card", "Card"], ["hand", "Hand"], ["table", "Table"], ["deck", "Deck"], ["me", "Me"]]
    .map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-tab="${k}">${l}</button>`).join("")}</nav>
    <div class="handcount">HAND<b>${n}</b></div></header>`;
}

function bigCard(t, quota = "") {
  const s = `<span style="color:${SUITC[t.suit]}">${SUIT[t.suit] || "●"}</span>`;
  return `<div class="card"><div class="idx tl"><span class="r">${t.imm}</span>${s}</div><h2>${esc(t.label)}</h2>${t.variant ? `<div class="var">${esc(t.variant)}</div>` : ""}${quota ? `<div class="var" style="font-size:13px">${esc(quota)}</div>` : ""}${pips(t.imm)}<div class="idx br"><span class="r">${t.imm}</span>${s}</div></div>`;
}

// Home: just the card in front of you.
const lockBanner = (locks) => (locks.length ? `<div class="lock">🔒 ${esc(lockMessage(locks))}</div>` : "");
function cardView() {
  const me = profile.me, t = state.tables[me.id], top = t && !t.empty ? t : null;
  const locks = activeLocks(state.cards, state.hands, me.id);
  const wait = top && bufferBlock(state.cards.find((c) => c.id === top.cardId), state.plays, me.id);
  const blocked = top && (!canPlay(locks, [top.cardId]) || !!wait);
  return `<section class="stage home">${lockBanner(locks)}${top
      ? `<div class="swipe" data-blocked="${blocked ? esc(wait ? "Not yet. " + bufferMessage(wait) : lockMessage(locks)) : ""}">${bigCard(top, quotaLabel(state.cards.find((c) => c.id === top.cardId) || {}, Date.now(), profile.prefs || {}))}<span class="swipetag" hidden></span></div>
        <p class="note">↑ play · ↓ hold · ← too soon · → not now · lean to adjust</p><div class="row actions"><button class="btn primary" data-act="play" ${blocked ? "disabled" : ""}>${wait ? "Wait" : blocked ? "Locked" : "Play"}</button><button class="btn" data-act="hold">Hold</button></div>${wait ? `<p class="note" style="max-width:300px">⏳ ${esc(bufferMessage(wait))}</p>` : ""}<button class="link" data-act="later-top">Remind me later</button>`
      : !drawable(state.cards, state.players, state.hands, state.tables, me.id).length
      ? `<h2 style="text-align:center">Nothing left to pull</h2><p class="note" style="max-width:300px">${state.hands.some((h) => h.seat === me.id) ? "Every card in your deck is in your hand. Play or discard some to put them back in the deck." : "Your deck is empty or switched off. Add a card in the Deck tab."}</p><div class="row actions"><button class="btn primary" data-tab="hand">Open hand</button><button class="btn" data-tab="deck">Add a card</button></div>`
      : `<button class="deck" data-act="draw" aria-label="Tap to pull a card"><span class="back"></span><span class="back"></span><span class="back"></span><span class="pull">Tap to pull a card</span></button>`}
    </section>`;
}

// Hand: select one card to play, remind or discard; several to play together.
function handView() {
  const me = profile.me;
  const hand = state.hands.filter((h) => h.seat === me.id).sort((a, b) => (a.heldAt || "").localeCompare(b.heldAt || ""));
  sel = sel.filter((id) => hand.some((h) => h.id === id));
  if (!hand.length) return `<section style="padding-top:60px;display:flex;flex-direction:column;gap:8px"><h2>Empty hand.</h2><p class="note left">Cards you hold show up here.</p></section>`;
  const picked = hand.filter((h) => sel.includes(h.id));
  const mine = state.game.active === me.id;
  const locks = activeLocks(state.cards, state.hands, me.id);
  const waitOf = (h) => bufferBlock(state.cards.find((c) => c.id === h.cardId), state.plays, me.id);
  const waiting = picked.map(waitOf).find(Boolean);
  const blocked = picked.length > 0 && (!canPlay(locks, picked.map((h) => h.cardId)) || !!waiting);
  const dis = blocked ? "disabled" : "";
  return `${lockBanner(locks)}<h3>${hand.length} held · tap to select${picked.length > 1 ? " · " + picked.length + " selected" : ""}</h3>
    <div class="grid">${hand.map((h) => {
      const r = h.remindAt && Date.parse(h.remindAt) > Date.now(), on = sel.includes(h.id);
      return `<button class="mini ${heat(h)}" aria-pressed="${on}" data-sel="${h.id}"><span class="a"><span style="color:${SUITC[h.suit]}">${SUIT[h.suit]}</span> ${h.imm}${on ? '<span class="ck">✓</span>' : ""}</span><span class="l">${esc(h.label)}</span>${h.variant ? `<span class="a">${esc(h.variant)}</span>` : ""}<span class="a">${waitOf(h) ? "⏳ " + fmtTime(new Date(waitOf(h).until)) : r ? "⏰ " + fmtTime(h.remindAt) : "held " + ago(h.heldAt)}</span></button>`;
    }).join("")}</div>
    ${waiting ? `<p class="note left">⏳ ${esc(bufferMessage(waiting))}</p>` : ""}
    ${picked.length === 1 ? `<div class="row"><button class="btn primary" data-act="hplay" ${dis}>${blocked ? "Locked" : "Play it"}</button><button class="btn" data-act="later-hand">Remind</button><button class="btn" data-act="hdiscard">Discard</button></div>` : ""}
    ${picked.length > 1 ? `<p class="note left">${picked.map((h) => esc(h.label)).join(" + ")}</p><div class="row"><button class="btn primary" data-act="hcombo" ${dis}>${blocked ? "Locked" : "Play " + picked.length + " together"}</button><button class="btn" data-act="hclear">Clear</button></div>${mine ? "" : `<p class="note left">It's not your turn, but you can still play.</p>`}` : ""}`;
}

// Solitaire-style stack: one edge per card underneath, newest face up.
function stackHtml(sk, fresh) {
  const n = sk.cards.length, edges = Math.min(n - 1, 11), top = sk.cards[n - 1], c = SUITC[sk.suit];
  return `<div class="stack" style="height:${100 + edges * 6}px">${Array.from({ length: edges }, (_, i) => `<span class="edge" style="top:${i * 6}px;border-top-color:${c}"></span>`).join("")}
    <div class="pc top${fresh ? " fresh" : ""}" style="top:${edges * 6}px;border-top-color:${c}"><div class="t"><span style="color:${c}">${SUIT[sk.suit]}</span>${n > 1 ? `<b class="n">×${n}</b>` : ""}</div><div class="l">${esc(sk.total ? amountLabel(sk.label, sk.total) : sk.label)}</div><div class="t"><span>${ago(top.at)}</span></div></div></div>`;
}

function tableView() {
  const me = profile.me;
  const players = [...state.players].sort((a, b) => (a.joined || "").localeCompare(b.joined || ""));
  const lastPlay = state.plays.reduce((a, p) => (!a || p.at > a.at ? p : a), null);
  const topDis = state.discards.reduce((a, d) => (!a || d.at > a.at ? d : a), null);
  const active = players.find((p) => p.id === state.game.active);
  const side = (p) => {
    if (!p) return `<div class="side"><span class="nm" style="color:var(--muted)">Open seat</span><p class="note left">Share your table name so a friend can sit here.</p></div>`;
    const plays = state.plays.filter((x) => x.seat === p.id).sort((a, b) => a.at.localeCompare(b.at));
    const held = state.hands.filter((h) => h.seat === p.id).length;
    const turn = state.game.active === p.id;
    return `<div class="side"><div class="row" style="justify-content:space-between"><div class="who"><span class="av">${esc((p.name || "?")[0].toUpperCase())}</span><span class="nm">${esc(p.name)}${p.id === me.id ? " (you)" : ""}</span></div>
      <div class="row" style="gap:6px"><span class="note">${held} held</span>${turn ? `<span class="tag">TO PLAY</span>` : ""}</div></div>
      ${(() => { const mv = lastMove(plays); return mv.length > 1 ? `<p class="note left">Last: ${mv.map((x) => esc(x.label)).join(" + ")} · played together</p>` : ""; })()}
      <div class="zone"><div class="played">${plays.length ? stackPlays(plays).map((sk) => stackHtml(sk, sk.cards.some((c) => c.id === lastPlay?.id))).join("")
        : `<p class="note" style="margin:auto">${turn ? "Fresh. Ready for turn " + state.game.turn : "Nothing played yet"}</p>`}</div>
      <div class="cubes"><span class="lbl">Cubes · ${plays.length}</span><div class="g">${plays.slice(-24).map((x) => `<span class="cube" style="background:${SUITC[x.suit]}"></span>`).join("")}</div></div></div></div>`;
  };
  const others = players.filter((p) => p.id !== me.id);
  const drawN = Math.max(0, myDeck(state.cards, state.players, me.id).filter((c) => c.active !== false).length - state.hands.filter((h) => h.seat === me.id).length);
  return `<div class="board">${others.length ? others.map(side).join("") : side(null)}
    <div class="mid"><div class="pile"><span class="s b"></span>DRAW ${drawN}</div>
      <div class="turn">TURN<b>${state.game.turn}</b>${active ? (active.id === me.id ? "YOU PLAY" : esc(active.name.toUpperCase()) + " TO PLAY") : ""}</div>
      <div class="pile"><span class="s d${topDis ? " has" : ""}">${esc(topDis?.label || "")}</span>DISCARD ${state.discards.length}</div></div>
    ${side(players.find((p) => p.id === me.id))}</div>`;
}

function deckView() {
  const me = profile.me;
  const cards = myDeck(state.cards, state.players, me.id).sort((a, b) => a.label.localeCompare(b.label));
  const chaos = myChaos(state.players, me.id, state.config.chaos);
  return `<div class="panel"><h3>Your randomness · ${chaos}%</h3>
      <div class="chips">${[0, 15, 30, 50, 75, 100].map((v) => `<button class="chip" aria-pressed="${chaos === v}" data-chaos="${v}">${v === 0 ? "Steady" : v === 100 ? "Wild" : v + "%"}</button>`).join("")}</div>
      <p class="note left">Steady deals whatever is most overdue on a regular clock. Wild picks any card at uneven times.</p></div>
    <section style="display:flex;flex-direction:column;gap:8px"><h3>Your deck · only you see it</h3>
      ${cards.map((c) => `<button class="deckrow${c.active === false ? " off" : ""}" data-edit="${c.id}"><span style="color:${SUITC[c.suit]};width:20px">${SUIT[c.suit]}</span><span class="n">${esc(c.label)}</span><span class="f">${esc(quotaLabel(c, Date.now(), profile.prefs || {}))} · ${"●".repeat(c.imm || 3)}</span></button>`).join("")}
      <button class="btn primary" data-act="newcard">New card</button></section>`;
}

let pushInfo = null;
function meView() {
  const p = { ...S.DEFAULT_PREFS, ...(profile.prefs || {}) };
  const canPush = "serviceWorker" in navigator && "PushManager" in window;
  let notif;
  if (isIOS && !standalone) {
    notif = `<p class="note left">To get cards as notifications on iPhone, install this first:</p>
      <ol class="steps note left"><li>Tap the Share button in Safari.</li><li>Tap <b>Add to Home Screen</b>, then Add.</li><li>Open Pull a Card from your home screen and come back to this tab.</li></ol>`;
  } else if (!canPush) {
    notif = `<p class="note left">This browser can't receive notifications.</p>`;
  } else if (pushInfo) {
    notif = `<p class="note left">On. Next card around <b>${pushInfo.nextAt ? fmtTime(pushInfo.nextAt) : "soon"}</b>.</p>
      <div class="row"><button class="btn" data-act="pushtest">Send a test</button><button class="btn" data-act="pushoff">Turn off</button></div>`;
  } else {
    notif = `<button class="btn primary" data-act="pushon">Turn on notifications</button>`;
  }
  const chips = (key, list) => list.map(([v, l]) => `<button class="chip" aria-pressed="${p[key] === v}" data-pref="${key}" data-val="${v}">${l}</button>`).join("");
  return `<div class="panel"><h3>You</h3><span class="nm">${esc(profile.me.name)} · table “${esc(profile.room)}”</span></div>
    <div class="panel"><h3>Notifications</h3>${notif}</div>
    <div class="panel"><p class="note left">Cards are dealt when they fall behind their targets, checked every few minutes while you're awake.</p>
      <h3>Awake from</h3><div class="chips">${chips("startHour", [6, 7, 8, 9, 10].map((h) => [h, h + " AM"]))}</div>
      <h3>Until</h3><div class="chips">${chips("endHour", [19, 20, 21, 22, 23].map((h) => [h, h - 12 + " PM"]))}</div></div>
    <div class="panel"><h3>Colors</h3>
      <div class="chips">${[theme.bg, theme.bg2, theme.felt, theme.accent, theme.ink, ...Object.values(theme.suit)].map((c) => `<span style="width:22px;height:22px;border-radius:6px;background:${c};border:1px solid var(--line)"></span>`).join("")}</div>
      <p class="note left">${esc(theme.name || ORIGINAL.name)}</p>
      <div class="row"><button class="btn primary" data-act="shuffle">Shuffle colors</button><button class="btn" data-act="original">Original</button></div></div>
    <button class="btn" data-act="leave">Leave this table</button>`;
}

function laterSheet() {
  const label = sheet.kind === "top" ? state.tables[profile.me.id]?.label : state.hands.find((h) => h.id === sheet.id)?.label;
  const now = new Date(), plus = (m) => new Date(now.getTime() + m * 6e4), at = (h) => { const d = new Date(now); d.setHours(h, 0, 0, 0); return d; };
  const quick = [["30 min", plus(30)], ["1 hour", plus(60)], ["2 hours", plus(120)], ["5 PM", at(17)], ["8 PM", at(20)]].filter(([, d]) => d - now > 60e3);
  return `<div class="scrim" data-act="close"></div><div class="sheet" role="dialog" aria-label="Remind me later">
    <h3>Remind me about</h3><h2>${esc(label || "")}</h2>
    <div class="chips">${quick.map(([l, d]) => `<button class="chip" data-at="${d.toISOString()}">${l}</button>`).join("")}</div>
    <div class="row"><input type="text" id="laterTxt" placeholder="3pm, 5:30, in 2h"><button class="btn primary auto" data-act="laterset">Set</button></div>
    <p class="note left">${pushInfo ? "You'll get a notification then." : "Turn on notifications in the Me tab to get pinged."}</p></div>`;
}

function editSheet() {
  const c = sheet.card, q = c.quota, amts = c.amounts || [];
  const n = +q.n || 0;
  return `<div class="scrim" data-act="close"></div><div class="sheet" role="dialog" aria-label="Edit card">
    <h2>${c.id ? "Edit card" : "New card"}</h2>
    <label><span class="lbl">Label</span><input type="text" id="eLabel" value="${esc(c.label)}" placeholder="squats"></label>
    <label><span class="lbl">Amounts (optional)</span><input type="text" id="eAmts" value="${esc(amts.join(", "))}" placeholder="5, 10, 20" inputmode="numeric"></label>
    <p class="note left">${amts.length ? `Each deal is one of these: "${esc(amountLabel(c.label || "squats", amts[0]))}". Put # in the label to place the number, like "Drink # glasses".` : "Leave empty to count whole cards."}</p>
    <h3>How often</h3><div class="chips">${Object.entries(PERIOD_NAMES).map(([per, l]) => `<button class="chip" aria-pressed="${q.per === per}" data-eper="${per}">${l}</button>`).join("")}</div>
    <h3>Target ${PERIODS[q.per]}</h3>
    <div class="row"><button class="btn auto" data-qstep="-1" aria-label="Less">−</button><input type="number" id="eQn" min="1" step="1" value="${esc(q.n)}" style="text-align:center;font:800 22px var(--display)"><button class="btn auto" data-qstep="1" aria-label="More">+</button></div>
    ${c.tempo && c.tempo !== 1 ? `<div class="row"><p class="note left" style="color:var(--ink);flex:1">Your swipes adjusted this to ${Math.max(1, Math.round(n * c.tempo))} ${PERIODS[q.per]} (${c.tempo > 1 ? "+" : ""}${Math.round((c.tempo - 1) * 100)}%).</p><button class="btn auto" data-act="tempo-reset">Reset</button></div>` : ""}
    <p class="note left">${amts.length ? `Deals add up to exactly ${n} ${esc(c.label || "")} ${PERIODS[q.per]}, spread out. Bigger amounts mean fewer deals.` : `Dealt exactly ${n} time${n === 1 ? "" : "s"} ${PERIODS[q.per]}, spread out.`}</p>
    <h3>Suit</h3><div class="chips">${SUITS.map((s) => `<button class="chip" aria-pressed="${c.suit === s}" data-esuit="${s}">${SUIT[s]} ${s}</button>`).join("")}</div>
    <h3>Immediacy</h3><div class="chips">${[1, 2, 3, 4, 5].map((i) => `<button class="chip" aria-pressed="${c.imm === i}" data-eimm="${i}">${i}</button>`).join("")}</div>
    <h3>Wait between plays</h3>
    ${[["self", "After this same card"], ["suit", `After any ${SUIT[c.suit]} ${c.suit} card`], ["any", "After any card"]].map(([k, l]) => `<p class="note left" style="color:var(--ink)">${l}</p><div class="chips">${BUFFER_STEPS.map(([m, ml]) => `<button class="chip" aria-pressed="${(c.buffer?.[k] || 0) === m}" data-ebuf="${k}:${m}">${ml}</button>`).join("")}</div>`).join("")}
    <p class="note left">It can still be held, but it can't be played or dealt until the wait is over.</p>
    <h3>Lock when holding</h3><div class="chips">${[0, 2, 3, 4, 5].map((k) => `<button class="chip" aria-pressed="${(c.lockAt || 0) === k}" data-elock="${k}">${k ? k + " held" : "Never"}</button>`).join("")}</div>
    <p class="note left">While you hold this many, it's the only card you can play.</p>
    <label class="row" style="flex-direction:row"><input type="checkbox" id="eOn" ${c.active !== false ? "checked" : ""}> <span>In the deck</span></label>
    <div class="row"><button class="btn primary" data-act="esave">Save</button><button class="btn" data-act="close">Cancel</button>${c.id ? `<button class="btn danger" data-act="edel">${sheet.arm ? "Tap again" : "Delete"}</button>` : ""}</div></div>`;
}

function render() {
  if (sw) { pendingRender = true; return; }
  if (!profile?.room) { $app.innerHTML = joinView(); return; }
  if (!state) { $app.innerHTML = header() + `<p class="note">Loading the table…</p>`; return; }
  const scroll = scrollY;
  const body = { card: cardView, hand: handView, table: tableView, deck: deckView, me: meView }[tab] || cardView;
  $app.innerHTML = header() + body() + (sheet ? (sheet.type === "later" ? laterSheet() : editSheet()) : "");
  scrollTo(0, scroll);
}

/* ---------------- push ---------------- */
function urlB64(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function swReg() { return navigator.serviceWorker.register("sw.js"); }
async function pushOn() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Notifications are blocked. Allow them in Settings → Notifications → Pull a Card."); return; }
  const reg = await swReg();
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(S.VAPID_PUBLIC) }));
  await S.savePush(profile.room, profile.me, sub.toJSON(), { ...S.DEFAULT_PREFS, ...(profile.prefs || {}) });
  pushInfo = await S.getPush(profile.room, profile.me);
  toast("Notifications on.");
}
async function pushOff() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
  await S.removePush(profile.room, profile.me);
  pushInfo = null;
  toast("Notifications off.");
}
async function loadPush() {
  if (!profile?.room || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    pushInfo = sub ? await S.getPush(profile.room, profile.me) : null;
  } catch { pushInfo = null; }
}

/* ---------------- swiping the top card ---------------- */
let sw = null, pendingRender = false;
const TONE = { play: "var(--accent)", hold: "var(--s-home)", soon: "var(--warm)", later: "var(--muted)" };
$app.addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".swipe"); if (!el) return;
  sw = { el, tag: el.querySelector(".swipetag"), x: e.clientX, y: e.clientY };
  el.setPointerCapture(e.pointerId); el.style.transition = "none";
});
$app.addEventListener("pointermove", (e) => {
  if (!sw) return;
  const dx = e.clientX - sw.x, dy = e.clientY - sw.y, it = swipeIntent(dx, dy);
  sw.el.style.transform = `translate(${dx}px, ${dy}px) rotate(${Math.max(-16, Math.min(16, dx / 15))}deg)`;
  sw.tag.hidden = !it; if (it) { sw.tag.textContent = swipeLabel(it); sw.tag.style.borderColor = TONE[it.kind]; }
  sw.it = it; sw.dx = dx; sw.dy = dy;
});
const swipeEnd = () => {
  if (!sw) return;
  const { el, it, dx = 0, dy = 0 } = sw;
  const back = () => { el.style.transition = "transform .3s cubic-bezier(.2,1.4,.4,1)"; el.style.transform = ""; sw.tag.hidden = true; };
  if (!it) { back(); sw = null; if (pendingRender) { pendingRender = false; render(); } return; }
  if (it.kind === "play" && el.dataset.blocked) { back(); toast(el.dataset.blocked); sw = null; return; }
  const d = Math.hypot(dx, dy) || 1, top = state.tables[profile.me.id];
  el.style.transition = "transform .23s ease-in, opacity .23s";
  el.style.transform = `translate(${(dx / d) * 700}px, ${(dy / d) * 900}px) rotate(${dx / 8}deg)`; el.style.opacity = "0";
  setTimeout(() => { sw = null; pendingRender = false; act(() => S.swipeTop(profile.room, profile.me, top, it), swipeLabel(it) + ": " + top.label); }, 230);
};
$app.addEventListener("pointerup", swipeEnd);
$app.addEventListener("pointercancel", swipeEnd);

/* ---------------- events ---------------- */
async function setLater(at) {
  const s = sheet; sheet = null;
  if (s.kind === "top") await act(() => S.holdCard(profile.room, profile.me, state.tables[profile.me.id], at), "Held. Reminder at " + fmtTime(at));
  else await act(() => S.setRemind(profile.room, s.id, at), "Reminder at " + fmtTime(at));
}

$app.addEventListener("click", async (e) => {
  const b = e.target.closest("button, .scrim"); if (!b) return;
  const d = b.dataset, room = profile?.room, me = profile?.me;
  if (d.tab) { tab = d.tab; sheet = null; if (tab === "me") await loadPush(); render(); return; }
  if (d.sel) { sel = sel.includes(d.sel) ? sel.filter((x) => x !== d.sel) : [...sel, d.sel]; render(); return; }
  if (d.chaos) return act(() => S.setChaos(room, me, +d.chaos));
  if (d.edit) { const c0 = state.cards.find((c) => c.id === d.edit); sheet = { type: "edit", card: { ...c0, quota: { ...(c0.quota || effectiveQuota({ ...c0, tempo: 1 }, profile.prefs || {})) } } }; render(); return; }
  if (d.esuit) { readEdit(); sheet.card.suit = d.esuit; render(); return; }
  if (d.eper) { readEdit(); sheet.card.quota = { ...sheet.card.quota, per: d.eper }; render(); return; }
  if (d.qstep) { readEdit(); const st = sheet.card.amounts?.length ? Math.min(...sheet.card.amounts) : 1; sheet.card.quota.n = Math.max(1, sheet.card.quota.n + +d.qstep * st); render(); return; }
  if (d.ebuf) { readEdit(); const [k, m] = d.ebuf.split(":"); sheet.card.buffer = { ...(sheet.card.buffer || {}), [k]: +m || null }; render(); return; }
  if (d.elock !== undefined) { readEdit(); sheet.card.lockAt = +d.elock || null; render(); return; }
  if (d.eimm) { readEdit(); sheet.card.imm = +d.eimm; render(); return; }
  if (d.at) return setLater(new Date(d.at));
  if (d.pref) {
    profile.prefs = { ...S.DEFAULT_PREFS, ...(profile.prefs || {}), [d.pref]: +d.val };
    S.saveProfile(profile);
    if (pushInfo) { try { await S.savePush(room, me, pushInfo.sub, profile.prefs); pushInfo = await S.getPush(room, me); } catch {} }
    render(); return;
  }
  const top = state?.tables[me?.id];
  switch (d.act) {
    case "join": {
      const name = document.getElementById("jName").value.trim();
      const r = document.getElementById("jRoom").value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
      if (!name || r.length < 3) { toast("Enter your name and a table name of at least 3 letters."); return; }
      b.disabled = true; b.textContent = "Joining…";
      try {
        const meNew = { id: profile?.me?.id || newId(), name };
        await S.joinRoom(r, meNew);
        profile = { room: r, me: meNew, prefs: profile?.prefs || S.DEFAULT_PREFS };
        S.saveProfile(profile); start();
      } catch (err) { toast("Couldn't reach the table: " + err.message); b.disabled = false; b.textContent = "Sit down"; }
      return;
    }
    case "draw": return act(() => S.draw(room, me, profile.prefs || {}));
    case "play": return act(() => S.playCard(room, me, top), "Played: " + top.label);
    case "hold": return act(() => S.holdCard(room, me, top), "Held: " + top.label);
    case "later-top": sheet = { type: "later", kind: "top" }; return render();
    case "later-hand": sheet = { type: "later", kind: "hand", id: sel[0] }; return render();
    case "hplay": { const ids = [...sel]; sel = []; return act(() => S.playCombo(room, me, ids), "Played"); }
    case "hcombo": { const ids = [...sel]; sel = []; return act(() => S.playCombo(room, me, ids), "Played together"); }
    case "hclear": sel = []; return render();
    case "hdiscard": { const id = sel[0]; sel = []; return act(() => S.discardFromHand(room, me, id), "Discarded"); }
    case "laterset": {
      const at = parseLater(document.getElementById("laterTxt").value);
      if (!at || at - Date.now() < 60e3) { toast("Try a time later today, like 3pm, 5:30, or in 2h."); return; }
      return setLater(at);
    }
    case "close": sheet = null; return render();
    case "tempo-reset": readEdit(); sheet.card.tempo = 1; return render();
    case "newcard": sheet = { type: "edit", card: { label: "", suit: "body", imm: 3, active: true, plays: 0, quota: { n: 1, per: "day" } } }; return render();
    case "esave": {
      readEdit(); const c = sheet.card;
      if (!c.label.trim()) { toast("Give the card a label."); return; }
      sheet = null;
      const { every, variants, ...rest } = c;
      return act(() => S.saveCard(room, me, { ...rest, label: c.label.trim() }), "Saved " + c.label);
    }
    case "edel": {
      if (!sheet.arm) { readEdit(); sheet.arm = true; return render(); }
      const c = sheet.card; sheet = null;
      return act(() => S.deleteCard(room, c.id), "Deleted " + c.label);
    }
    case "pushon": try { await pushOn(); } catch (err) { toast("Couldn't turn on notifications: " + err.message); } return render();
    case "pushoff": try { await pushOff(); } catch (err) { toast(err.message); } return render();
    case "pushtest": {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.showNotification("● Test card", { body: "Notifications work on this phone.", icon: "icon-192.png" });
      toast("Sent. Real cards come when one falls behind its target.");
      return;
    }
    case "shuffle": applyTheme(randomTheme()); return render();
    case "original": applyTheme(ORIGINAL); return render();
    case "leave": unsub?.(); profile = { ...profile, room: null }; S.saveProfile(profile); state = null; render(); return;
  }
});

function readEdit() {
  if (sheet?.type !== "edit") return;
  const c = sheet.card;
  c.label = document.getElementById("eLabel").value;
  const amts = document.getElementById("eAmts").value.split(/[ ,]+/).map(Number).filter((x) => x > 0);
  c.amounts = amts.length ? amts : null;
  c.active = document.getElementById("eOn").checked;
  c.quota = { ...c.quota, n: Math.max(1, +document.getElementById("eQn").value || 1) };
}

function start() {
  unsub?.();
  render();
  S.ensureDeck(profile.room, profile.me).catch(() => {}).finally(refresh);
  loadPush().then(() => tab === "me" && render());
  unsub = S.subscribeRoom(profile.room, () => { clearTimeout(refreshT); refreshT = setTimeout(refresh, 250); });
}

if ("serviceWorker" in navigator) swReg().catch(() => {});
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
setInterval(() => { if (profile?.room && state && !sheet && !document.hidden && tab !== "me") render(); }, 60000);
if (profile?.room) start(); else render();
