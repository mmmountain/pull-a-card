import * as S from "./store.js";
import { SUIT, SUITS, ago, fmtTime, heat, newId, parseLater } from "./model.js";

const $app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SUITC = { body: "var(--s-body)", home: "var(--s-home)", mind: "var(--s-mind)", work: "var(--s-work)" };
const pips = (n) => `<div class="pips">${[1, 2, 3, 4, 5].map((i) => `<span class="pip${i <= n ? " on" : ""}"></span>`).join("")}</div>`;

let profile = S.loadProfile();
let state = null, tab = new URLSearchParams(location.search).get("tab") || "play";
let sel = null, sheet = null, toastT = null, unsub = null, refreshT = null;
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
  return `<header><nav class="tabs" role="tablist">${[["play", "Play"], ["table", "Table"], ["deck", "Deck"], ["me", "Me"]]
    .map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-tab="${k}">${l}</button>`).join("")}</nav>
    <div class="handcount">HAND<b>${n}</b></div></header>`;
}

function bigCard(t) {
  const s = `<span style="color:${SUITC[t.suit]}">${SUIT[t.suit] || "●"}</span>`;
  return `<div class="card"><div class="idx tl"><span class="r">${t.imm}</span>${s}</div><h2>${esc(t.label)}</h2>${t.variant ? `<div class="var">${esc(t.variant)}</div>` : ""}${pips(t.imm)}<div class="idx br"><span class="r">${t.imm}</span>${s}</div></div>`;
}

function playView() {
  const me = profile.me, t = state.tables[me.id], top = t && !t.empty ? t : null;
  const hand = state.hands.filter((h) => h.seat === me.id).sort((a, b) => (a.heldAt || "").localeCompare(b.heldAt || ""));
  const left = Math.max(0, state.cards.filter((c) => c.active !== false).length - state.hands.length);
  const mine = state.game.active === me.id;
  const selH = hand.find((h) => h.id === sel);
  return `<section class="stage">${top
      ? `${bigCard(top)}<div class="row actions"><button class="btn primary" data-act="play">Play</button><button class="btn" data-act="hold">Hold</button><button class="btn" data-act="later-top">Later</button></div>`
      : `<button class="deck" data-act="draw" aria-label="Pull a card"><span class="back"></span><span class="back"></span><span class="back"></span><span class="pull">Pull a card</span></button><p class="note">${left} in the deck · ${mine ? "your turn" : "not your turn, but you can still pull"}</p>`}
    </section>
    <section style="display:flex;flex-direction:column;gap:8px"><h3>Your hand</h3>
      ${hand.length ? `<div class="hand">${hand.map((h) => {
        const r = h.remindAt && Date.parse(h.remindAt) > Date.now();
        return `<button class="mini ${heat(h)}" aria-pressed="${sel === h.id}" data-sel="${h.id}"><span class="a">${SUIT[h.suit]} ${h.imm}</span><span class="l">${esc(h.label)}</span><span class="a">${r ? "⏰ " + fmtTime(h.remindAt) : "held " + ago(h.heldAt)}</span></button>`;
      }).join("")}</div>` : `<p class="note left">Empty hand. Nice.</p>`}
      ${selH ? `<div class="row"><button class="btn primary" data-act="hplay">Play it</button><button class="btn" data-act="later-hand">Remind</button><button class="btn" data-act="hdiscard">Discard</button></div>` : ""}
    </section>`;
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
      <div class="zone"><div class="played">${plays.length ? plays.slice(-8).map((x) => `<div class="pc${lastPlay?.id === x.id ? " fresh" : ""}"><div class="t"><span>${SUIT[x.suit]} ${x.imm}</span><span>T${x.turn}</span></div><div class="l">${esc(x.label)}</div><div class="t"><span>${ago(x.at)}</span></div></div>`).join("")
        : `<p class="note" style="margin:auto">${turn ? "Fresh. Ready for turn " + state.game.turn : "Nothing played yet"}</p>`}</div>
      <div class="cubes"><span class="lbl">Cubes · ${plays.length}</span><div class="g">${plays.slice(-24).map((x) => `<span class="cube" style="background:${SUITC[x.suit]}"></span>`).join("")}</div></div></div></div>`;
  };
  const others = players.filter((p) => p.id !== me.id);
  const drawN = Math.max(0, state.cards.filter((c) => c.active !== false).length - state.hands.length);
  return `<div class="board">${others.length ? others.map(side).join("") : side(null)}
    <div class="mid"><div class="pile"><span class="s b"></span>DRAW ${drawN}</div>
      <div class="turn">TURN<b>${state.game.turn}</b>${active ? (active.id === me.id ? "YOU PLAY" : esc(active.name.toUpperCase()) + " TO PLAY") : ""}</div>
      <div class="pile"><span class="s d${topDis ? " has" : ""}">${esc(topDis?.label || "")}</span>DISCARD ${state.discards.length}</div></div>
    ${side(players.find((p) => p.id === me.id))}</div>`;
}

function deckView() {
  const cards = [...state.cards].sort((a, b) => a.label.localeCompare(b.label));
  return `<div class="panel"><h3>Randomness · ${state.config.chaos}%</h3>
      <div class="chips">${[0, 15, 30, 50, 75, 100].map((v) => `<button class="chip" aria-pressed="${state.config.chaos === v}" data-chaos="${v}">${v === 0 ? "Steady" : v === 100 ? "Wild" : v + "%"}</button>`).join("")}</div>
      <p class="note left">Steady deals whatever is most overdue on a regular clock. Wild picks any card at uneven times.</p></div>
    <section style="display:flex;flex-direction:column;gap:8px"><h3>Cards in the deck</h3>
      ${cards.map((c) => `<button class="deckrow${c.active === false ? " off" : ""}" data-edit="${c.id}"><span style="color:${SUITC[c.suit]};width:20px">${SUIT[c.suit]}</span><span class="n">${esc(c.label)}</span><span class="f">every ${c.every}h · ${"●".repeat(c.imm || 3)}</span></button>`).join("")}
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
    <div class="panel"><h3>About every</h3><div class="chips">${chips("everyMins", [[45, "45 min"], [60, "1 h"], [90, "1.5 h"], [120, "2 h"], [180, "3 h"], [240, "4 h"]])}</div>
      <h3>Awake from</h3><div class="chips">${chips("startHour", [6, 7, 8, 9, 10].map((h) => [h, h + " AM"]))}</div>
      <h3>Until</h3><div class="chips">${chips("endHour", [19, 20, 21, 22, 23].map((h) => [h, h - 12 + " PM"]))}</div></div>
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
  const c = sheet.card;
  return `<div class="scrim" data-act="close"></div><div class="sheet" role="dialog" aria-label="Edit card">
    <h2>${c.id ? "Edit card" : "New card"}</h2>
    <label><span class="lbl">Label</span><input type="text" id="eLabel" value="${esc(c.label)}" placeholder="Drink water"></label>
    <label><span class="lbl">Variations, one per line</span><textarea id="eVars" placeholder="a full glass&#10;a whole bottle">${esc((c.variants || []).join("\n"))}</textarea></label>
    <h3>Suit</h3><div class="chips">${SUITS.map((s) => `<button class="chip" aria-pressed="${c.suit === s}" data-esuit="${s}">${SUIT[s]} ${s}</button>`).join("")}</div>
    <label><span class="lbl">Comes up every (hours)</span><input type="number" id="eEvery" min="0.25" step="0.25" value="${c.every}"></label>
    <h3>Immediacy</h3><div class="chips">${[1, 2, 3, 4, 5].map((i) => `<button class="chip" aria-pressed="${c.imm === i}" data-eimm="${i}">${i}</button>`).join("")}</div>
    <label class="row" style="flex-direction:row"><input type="checkbox" id="eOn" ${c.active !== false ? "checked" : ""}> <span>In the deck</span></label>
    <div class="row"><button class="btn primary" data-act="esave">Save</button><button class="btn" data-act="close">Cancel</button>${c.id ? `<button class="btn danger" data-act="edel">${sheet.arm ? "Tap again" : "Delete"}</button>` : ""}</div></div>`;
}

function render() {
  if (!profile?.room) { $app.innerHTML = joinView(); return; }
  if (!state) { $app.innerHTML = header() + `<p class="note">Loading the table…</p>`; return; }
  const scroll = scrollY;
  const body = { play: playView, table: tableView, deck: deckView, me: meView }[tab] || playView;
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
  if (d.sel) { sel = sel === d.sel ? null : d.sel; render(); return; }
  if (d.chaos) return act(() => S.setChaos(room, +d.chaos));
  if (d.edit) { sheet = { type: "edit", card: { ...state.cards.find((c) => c.id === d.edit) } }; render(); return; }
  if (d.esuit) { readEdit(); sheet.card.suit = d.esuit; render(); return; }
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
    case "draw": return act(() => S.draw(room, me));
    case "play": return act(() => S.playCard(room, me, top), "Played: " + top.label);
    case "hold": return act(() => S.holdCard(room, me, top), "Held: " + top.label);
    case "later-top": sheet = { type: "later", kind: "top" }; return render();
    case "later-hand": sheet = { type: "later", kind: "hand", id: sel }; return render();
    case "hplay": { const id = sel; sel = null; return act(() => S.playFromHand(room, me, id), "Played"); }
    case "hdiscard": { const id = sel; sel = null; return act(() => S.discardFromHand(room, me, id), "Discarded"); }
    case "laterset": {
      const at = parseLater(document.getElementById("laterTxt").value);
      if (!at || at - Date.now() < 60e3) { toast("Try a time later today, like 3pm, 5:30, or in 2h."); return; }
      return setLater(at);
    }
    case "close": sheet = null; return render();
    case "newcard": sheet = { type: "edit", card: { label: "", variants: [], suit: "body", every: 4, imm: 3, active: true, plays: 0 } }; return render();
    case "esave": {
      readEdit(); const c = sheet.card;
      if (!c.label.trim()) { toast("Give the card a label."); return; }
      sheet = null;
      return act(() => S.saveCard(room, { ...c, label: c.label.trim(), every: Math.max(0.25, parseFloat(c.every) || 4) }), "Saved " + c.label);
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
      toast("Sent. Real cards come from the dealer about every " + ((profile.prefs?.everyMins || 120) / 60) + " h.");
      return;
    }
    case "leave": unsub?.(); profile = { ...profile, room: null }; S.saveProfile(profile); state = null; render(); return;
  }
});

function readEdit() {
  if (sheet?.type !== "edit") return;
  const c = sheet.card;
  c.label = document.getElementById("eLabel").value;
  c.variants = document.getElementById("eVars").value.split("\n").map((s) => s.trim()).filter(Boolean);
  c.every = document.getElementById("eEvery").value;
  c.active = document.getElementById("eOn").checked;
}

function start() {
  unsub?.();
  render();
  refresh();
  loadPush().then(() => tab === "me" && render());
  unsub = S.subscribeRoom(profile.room, () => { clearTimeout(refreshT); refreshT = setTimeout(refresh, 250); });
}

if ("serviceWorker" in navigator) swReg().catch(() => {});
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
setInterval(() => { if (profile?.room && state && !sheet && !document.hidden && tab !== "me") render(); }, 60000);
if (profile?.room) start(); else render();
