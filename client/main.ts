import { BoardRenderer } from "./board";
import {
  DEFAULT_CONFIG, GameState, incomeFor, newGame, Orders, orderTotal, Player, resolveTurn, score, targetable, TurnResult,
} from "../shared/game";
import { h, clear, toast, timeAgo, fmtCoins, api, post, icon } from "./ui";
import { markTutorialDone, Tutorial, TutorialCtx, tutorialDone } from "./tutorial";

// ------------------------------------------------------------------ types

interface User {
  id: string; name: string; guest: boolean; elo?: number; games?: number; wins?: number; losses?: number; draws?: number;
  coinsWon?: number; coinsLost?: number;
}
interface Me { user: User | null; signIn: boolean; economy: boolean; chat: boolean; rakePercent: number; maxStake: number; version: string }
interface SeatView { id: string; name: string; elo: number; bot: string | null }
interface MatchView {
  id: string; mode: string; stake: number; seats: [SeatView, SeatView]; you: Player | null; state: GameState;
  deadline: number; serverNow: number; submitted: [boolean, boolean]; lastResult: TurnResult | null; eloChange: number | null;
  turnSeconds: number;
  tutorial?: boolean;
}
interface ChallengeView {
  code: string; creator: { id: string; name: string }; acceptor: { id: string; name: string } | null; stake: number;
  public: boolean; status: string; matchId: string | null; paid: { creator: boolean; acceptor: boolean };
  yourPayment: { status: string; consentUrl: string | null } | null; creatorOnline: boolean; payout: number; rakePercent: number;
}

// ------------------------------------------------------------------ state

let me: Me = { user: null, signIn: false, economy: false, chat: false, rakePercent: 5, maxStake: 0, version: "" };
let ws: WebSocket | null = null;
let wsReady = false;
let wsBackoff = 500;
const outbox: object[] = [];
let clockSkew = 0;

let match: MatchView | null = null;
let orders: Orders = {};
let brush = 1;
let eraser = false;
let revealUntil = 0;
let renderer: BoardRenderer | null = null;
let challenge: ChallengeView | null = null;
let queueing = false;
let queueInfo = { waitingMs: 0, inQueue: 0 };
let hudTimer: number | null = null;
let tutorial: Tutorial | null = null;

const app = document.getElementById("app")!;

// ------------------------------------------------------------------ socket

function connect() {
  if (!me.user) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    wsReady = true;
    wsBackoff = 500;
    setConn(true);
    while (outbox.length) ws!.send(JSON.stringify(outbox.shift()));
    // re-subscribe to whatever page we're on
    const r = route();
    if (r.name === "match") send({ t: "watch", matchId: r.arg });
    if (r.name === "challenge") send({ t: "challenge.join", code: r.arg });
    send({ t: "ping" });
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    wsReady = false;
    setConn(false);
    setTimeout(connect, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 10_000);
  };
}

function send(msg: object) {
  if (ws && wsReady) ws.send(JSON.stringify(msg));
  else outbox.push(msg);
}

function setConn(ok: boolean) {
  document.body.classList.toggle("offline", !ok);
}

function onMessage(msg: any) {
  switch (msg.t) {
    case "pong":
      clockSkew = msg.serverNow - Date.now();
      break;
    case "welcome":
      break;
    case "error":
      toast(msg.msg, "error");
      if (msg.ref === "queue") setQueueing(false);
      break;
    case "toast":
      toast(msg.text);
      break;
    case "queue":
      if (msg.left) setQueueing(false);
      else {
        queueInfo = { waitingMs: msg.waitingMs, inQueue: msg.inQueue };
        if (!queueing) setQueueing(true);
        updateQueueUi();
      }
      break;
    case "match": {
      const fresh = !match || match.id !== msg.id;
      match = msg as MatchView;
      clockSkew = msg.serverNow - Date.now();
      if (fresh) {
        orders = {};
        setQueueing(false);
      }
      if (route().name !== "match" || route().arg !== msg.id) navigate(`/m/${msg.id}`, true);
      else renderMatchHud();
      break;
    }
    case "submitted":
      if (match && msg.matchId === match.id) {
        match.submitted = msg.submitted;
        renderMatchHud();
      }
      break;
    case "turn":
    case "end":
      if (match && msg.matchId === match.id) {
        const prevTurn = match.state.turn;
        match = msg as MatchView;
        clockSkew = msg.serverNow - Date.now();
        orders = {};
        if (msg.result && msg.result.turn >= prevTurn - 1) revealUntil = Date.now() + 1600;
        if (msg.t === "end") onMatchEnd();
        renderMatchHud();
        setTimeout(renderMatchHud, 1650);
      }
      break;
    case "challenge":
      challenge = msg.challenge;
      if (msg.note) toast(msg.note);
      if (route().name === "challenge" && route().arg === challenge!.code) renderChallenge();
      else if (route().name !== "match" && challenge!.status === "open" && challenge!.creator.id === me.user?.id) navigate(`/c/${challenge!.code}`);
      break;
  }
}

// ------------------------------------------------------------------ routing

function route(): { name: string; arg?: string } {
  const p = location.pathname;
  let m: RegExpMatchArray | null;
  if ((m = p.match(/^\/m\/([\w-]+)/))) return { name: "match", arg: m[1] };
  if ((m = p.match(/^\/c\/([A-Za-z0-9]+)/))) return { name: "challenge", arg: m[1].toUpperCase() };
  if ((m = p.match(/^\/u\/([\w-]+)/))) return { name: "user", arg: m[1] };
  const name = p.replace(/^\//, "").replace(/\/$/, "") || "home";
  return { name };
}

function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  render();
}

window.addEventListener("popstate", () => render());
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a || a.target || a.origin !== location.origin || a.hasAttribute("data-external")) return;
  if (a.pathname.startsWith("/auth/") || a.pathname.startsWith("/api/") || a.pathname.startsWith("/wallet/return")) return;
  e.preventDefault();
  navigate(a.pathname + a.search);
});

let lastRoute = "";
function render() {
  const r = route();
  const key = `${r.name}:${r.arg ?? ""}`;
  if (lastRoute.startsWith("match:") && key !== lastRoute && match) {
    if (match.you === null) send({ t: "unwatch", matchId: match.id });
  }
  lastRoute = key;
  if (hudTimer) {
    clearInterval(hudTimer);
    hudTimer = null;
  }
  renderer = null;
  document.body.dataset.page = r.name;
  window.scrollTo(0, 0);
  void track("ui_page", { page: r.name });
  switch (r.name) {
    case "home":
    case "play":
      return renderHome();
    case "match":
      return renderMatchPage(r.arg!);
    case "challenge":
      return renderChallengePage(r.arg!);
    case "lobby":
      return renderLobby();
    case "leaderboard":
      return renderLeaderboard();
    case "user":
      return renderUser(r.arg!);
    case "friends":
      return renderFriends();
    case "rules":
      return renderRules();
    case "wallet":
      return renderWallet();
    default:
      return renderHome();
  }
}

// ------------------------------------------------------------------ chrome

function shell(...children: (Node | string | null)[]): HTMLElement {
  clear(app);
  const u = me.user;
  const header = h("header", { class: "top" },
    h("a", { href: "/", class: "brand" }, icon("logo"), h("span", {}, "Hexstake")),
    h("nav", {},
      h("a", { href: "/lobby" }, "Lobby"),
      h("a", { href: "/leaderboard" }, "Ranks"),
      h("a", { href: "/rules" }, "Rules"),
    ),
    h("div", { class: "who" },
      u && !u.guest
        ? h("a", { href: `/u/${u.id}`, class: "chip" }, h("span", { class: "dot mine" }), u.name, u.elo !== undefined ? h("span", { class: "muted" }, ` ${u.elo}`) : null)
        : me.signIn
          ? h("a", { href: `/auth/login?return=${encodeURIComponent(location.pathname)}`, class: "btn small primary", "data-external": "" }, "Sign in with Serble")
          : u ? h("span", { class: "chip" }, u.name) : null,
    ),
  );
  const main = h("main", {}, ...children);
  const footer = h("footer", {},
    h("span", {}, "Hexstake · an unofficial ", h("a", { href: "https://serble.net", "data-external": "", target: "_blank" }, "Serble"), " game"),
    h("a", { href: "https://github.com/CoPokBl/hexstake", target: "_blank", "data-external": "" }, "Source & issues"),
    h("button", { class: "link", onclick: openFeedback }, "Send feedback"),
  );
  app.append(header, main, footer);
  return main;
}

async function ensureSession(): Promise<boolean> {
  if (me.user) return true;
  const r = await post("/api/guest", {});
  if (r?.user) {
    me.user = r.user;
    connect();
    return true;
  }
  return false;
}

function requireSignIn(why: string) {
  if (me.user && !me.user.guest) return true;
  const dlg = h("dialog", { class: "modal" },
    h("h3", {}, "Sign in with Serble"),
    h("p", {}, why),
    h("div", { class: "row" },
      h("a", { class: "btn primary", href: `/auth/login?return=${encodeURIComponent(location.pathname)}`, "data-external": "" }, "Sign in"),
      h("button", { class: "btn", onclick: () => dlg.close() }, "Not now"),
    ),
  ) as HTMLDialogElement;
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return false;
}

// ------------------------------------------------------------------ home

function renderHome() {
  const signedIn = me.user && !me.user.guest;
  const preview = h("canvas", { class: "hero-board", "aria-hidden": "true" }) as HTMLCanvasElement;
  const main = shell(
    h("section", { class: "hero" },
      h("div", { class: "hero-text" },
        h("h1", {}, "Out-think. Out-bid. ", h("span", { class: "accent" }, "Out-hex.")),
        h("p", { class: "lead" }, "A fast duel of hidden bids on a hex map. Both players plan at the same time, then everything resolves at once. Claim wells, cut off supply lines and storm the enemy home."),
        h("div", { class: "cta" },
          h("button", { class: "btn primary big", onclick: () => (tutorialDone() ? playBot("normal") : playBot("easy", true)) }, "Play now"),
          h("button", { class: "btn big", onclick: () => navigate("/rules") }, "How to play"),
        ),
        h("p", { class: "muted small" }, "Matches take about 3 minutes. No sign-in needed to play the bots."),
      ),
      preview,
    ),
    h("section", { class: "daily", id: "daily" },
      h("div", { class: "daily-text" },
        h("h2", {}, "Daily challenge"),
        h("p", {}, "Everyone gets the same map today, against the Hard bot. Win in as few turns as you can to top the board."),
        h("button", { class: "btn primary", onclick: () => playDaily() }, "Play today's map"),
      ),
      h("div", { class: "daily-board", id: "daily-board" }, h("p", { class: "muted small" }, "Loading today's board…")),
    ),
    h("section", { class: "cards" },
      card("Practice", "Play against the bot. Pick your poison.",
        h("div", { class: "row" },
          h("button", { class: "btn", onclick: () => playBot("easy", true) }, "Tutorial"),
          h("button", { class: "btn", onclick: () => playBot("easy") }, "Easy"),
          h("button", { class: "btn", onclick: () => playBot("normal") }, "Normal"),
          h("button", { class: "btn", onclick: () => playBot("hard") }, "Hard"),
        )),
      card("Ranked", "Get matched with a player near your rating. Climb the ladder.",
        h("div", { class: "queue-ui" }, h("button", { class: "btn primary", id: "queue-btn", onclick: toggleQueue }, queueing ? "Cancel search" : "Find a match"))),
      card("Challenge", "Send a link to a friend, or open a public lobby. Optionally stake Serble coins: the winner takes the pot.",
        h("div", { class: "row" },
          h("button", { class: "btn", onclick: () => openChallengeDialog() }, "Create challenge"),
          signedIn ? h("a", { class: "btn", href: "/friends" }, "Friends") : null,
          h("a", { class: "btn", href: "/lobby" }, "Open lobbies"),
        )),
    ),
    h("section", { class: "split" },
      h("div", {}, h("h2", {}, "Live & recent"), h("div", { id: "recent" }, h("p", { class: "muted" }, "Loading…"))),
      h("div", {}, h("h2", {}, "Hexstake so far"), h("div", { id: "stats", class: "stats" })),
    ),
  );
  void main;
  // Decorative demo board
  const demo = newGame(Math.floor(Math.random() * 1e6));
  let st = demo;
  for (let i = 0; i < 6; i++) {
    const t0 = [...targetable(st, 0)];
    const t1 = [...targetable(st, 1)];
    const o0: Orders = {};
    const o1: Orders = {};
    for (let k = 0; k < 3; k++) {
      const a = t0[Math.floor(Math.random() * t0.length)];
      const b = t1[Math.floor(Math.random() * t1.length)];
      o0[a] = (o0[a] ?? 0) + 2;
      o1[b] = (o1[b] ?? 0) + 2;
    }
    st = resolveTurn(st, o0, o1).state;
  }
  requestAnimationFrame(() => {
    const r = new BoardRenderer(preview, st.config.radius);
    r.view = { state: st, me: 0, orders: {}, interactive: false };
    r.resize();
    window.addEventListener("resize", () => r.resize(), { once: true });
  });

  api("/api/matches").then((d) => {
    const el = document.getElementById("recent");
    if (!el || !d) return;
    clear(el);
    if (!d.live.length && !d.recent.length) el.append(h("p", { class: "muted" }, "No player-vs-player matches yet. Be the first!"));
    for (const m of d.live) {
      el.append(h("a", { class: "match-row live", href: `/m/${m.id}` },
        h("span", { class: "tag live" }, "LIVE"), ` ${m.seats[0].name} vs ${m.seats[1].name}`,
        h("span", { class: "muted" }, ` · turn ${m.turn}${m.stake ? ` · ${m.stake}⬡` : ""}`)));
    }
    for (const m of d.recent) {
      const w = m.winner === 0 ? m.p0_name : m.winner === 1 ? m.p1_name : null;
      el.append(h("a", { class: "match-row", href: `/m/${m.id}` },
        h("span", { class: `tag ${m.mode}` }, m.mode), ` ${m.p0_name} vs ${m.p1_name}`,
        h("span", { class: "muted" }, ` · ${w ? `${w} won` : "draw"}${m.stake ? ` · ${m.stake}⬡` : ""} · ${timeAgo(m.ended_at)}`)));
    }
  });
  api("/api/daily").then((d) => {
    const el = document.getElementById("daily-board");
    if (!el || !d) return;
    clear(el);
    const hours = Math.max(0, Math.ceil((d.resetsAt - Date.now()) / 3600_000));
    el.append(h("div", { class: "muted small" }, `${d.day} · ${d.players} player${d.players === 1 ? "" : "s"} · new map in ${hours}h`));
    if (!d.leaderboard.length) el.append(h("p", { class: "muted" }, "Nobody has beaten today's map yet. Be the first!"));
    for (const r of d.leaderboard.slice(0, 5)) {
      el.append(h("div", { class: `daily-row ${r.you ? "me" : ""}` }, h("b", {}, `#${r.rank}`), ` ${r.name}`, h("span", { class: "muted" }, ` · won in ${r.turns} turns`)));
    }
  });
  api("/api/stats").then((s) => {
    const el = document.getElementById("stats");
    if (!el || !s) return;
    el.append(
      stat(s.players, "players"), stat(s.matchesPlayed, "matches played"), stat(s.matches24h, "matches today"),
      stat(s.coinsStaked, "coins staked"),
    );
  });
}

function card(title: string, text: string, actions: Node) {
  return h("div", { class: "card" }, h("h3", {}, title), h("p", {}, text), actions);
}
function stat(n: number, label: string) {
  return h("div", { class: "stat" }, h("b", {}, String(n ?? 0)), h("span", {}, label));
}

async function playDaily() {
  if (!(await ensureSession())) return toast("Couldn't start a session", "error");
  send({ t: "daily" });
  void track("ui_daily_start", {});
}

async function playBot(level: string, asTutorial = false) {
  if (!(await ensureSession())) return toast("Couldn't start a session", "error");
  send({ t: "bot", level, tutorial: asTutorial });
  void track(asTutorial ? "ui_tutorial_start" : "ui_play_bot", { level, w: window.innerWidth });
}

async function toggleQueue() {
  if (!requireSignIn("Ranked matches are tied to your Serble account so your rating follows you.")) return;
  if (queueing) send({ t: "unqueue" });
  else send({ t: "queue" });
  setQueueing(!queueing);
}

function setQueueing(v: boolean) {
  queueing = v;
  if (!v) queueInfo = { waitingMs: 0, inQueue: 0 };
  updateQueueUi();
}

function updateQueueUi() {
  const btn = document.getElementById("queue-btn");
  if (!btn) return;
  btn.textContent = queueing ? `Searching… ${Math.round(queueInfo.waitingMs / 1000)}s (cancel)` : "Find a match";
  const parent = btn.parentElement!;
  parent.querySelector(".queue-hint")?.remove();
  if (queueing && queueInfo.waitingMs > 20_000) {
    parent.append(h("p", { class: "queue-hint muted small" }, "Quiet right now. Keep waiting, or ",
      h("button", { class: "link", onclick: () => { send({ t: "unqueue" }); setQueueing(false); playBot("hard"); } }, "warm up against the hard bot"), "."));
  }
}

// ------------------------------------------------------------------ challenge creation

function openChallengeDialog(friend?: { id: string; username: string }) {
  void ensureSession();
  const canStake = me.economy && me.user && !me.user.guest;
  const stakeInput = h("input", { type: "number", min: "0", max: String(me.maxStake), step: "1", value: "0", inputmode: "numeric" }) as HTMLInputElement;
  const pub = h("input", { type: "checkbox", checked: !friend }) as HTMLInputElement;
  const payoutText = h("p", { class: "muted small" });
  const upd = () => {
    const s = Math.max(0, Math.floor(Number(stakeInput.value) || 0));
    const pot = 2 * s;
    payoutText.textContent = s > 0 ? `Both players pay ${s} coins. The winner gets ${pot - Math.floor((pot * me.rakePercent) / 100)} coins (${me.rakePercent}% house cut, rounded down). A draw refunds both.` : "Just for glory.";
  };
  stakeInput.oninput = upd;
  upd();
  const dlg = h("dialog", { class: "modal" },
    h("h3", {}, friend ? `Challenge ${friend.username}` : "Create a challenge"),
    canStake
      ? h("label", { class: "field" }, "Stake (Serble coins)", stakeInput)
      : h("p", { class: "muted small" }, me.user?.guest || !me.user ? "Sign in with Serble to play for coins." : "Coin stakes are unavailable right now."),
    canStake ? payoutText : null,
    friend ? null : h("label", { class: "check" }, pub, " List in the public lobby"),
    h("div", { class: "row" },
      h("button", {
        class: "btn primary",
        onclick: () => {
          const stake = canStake ? Math.max(0, Math.floor(Number(stakeInput.value) || 0)) : 0;
          send({ t: "challenge.create", stake, public: pub.checked, friendId: friend?.id });
          void track("ui_challenge_create", { stake, friend: Boolean(friend) });
          dlg.close();
        },
      }, friend ? "Send challenge" : "Create"),
      h("button", { class: "btn", onclick: () => dlg.close() }, "Cancel"),
    ),
  ) as HTMLDialogElement;
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
}

// ------------------------------------------------------------------ challenge page

async function renderChallengePage(code: string) {
  shell(h("section", { class: "lobby", id: "lobby" }, h("p", { class: "muted" }, "Loading challenge…")));
  if (!challenge || challenge.code !== code) {
    challenge = await api(`/api/challenges/${code}`);
  }
  if (me.user) send({ t: "challenge.join", code });
  renderChallenge();
}

function renderChallenge() {
  const el = document.getElementById("lobby");
  if (!el) return;
  clear(el);
  const c = challenge;
  if (!c || (c as any).error) {
    el.append(h("h2", {}, "Challenge not found"), h("p", {}, "It may have expired. ", h("a", { href: "/lobby" }, "Browse open lobbies")));
    return;
  }
  const mine = me.user?.id === c.creator.id;
  const iAccepted = c.acceptor && me.user && (c.acceptor.id === me.user.id || (c.acceptor.id === "guest" && me.user.guest));
  const link = `${location.origin}/c/${c.code}`;
  el.append(
    h("div", { class: "lobby-head" },
      h("span", { class: "code" }, c.code),
      h("h2", {}, `${c.creator.name}'s challenge`),
      h("p", { class: "lead" }, c.stake > 0 ? `Stake: ${c.stake} coins each · winner takes ${c.payout}` : "Friendly match (no stakes)"),
    ),
  );
  if (c.status === "started" && c.matchId) {
    el.append(h("a", { class: "btn primary", href: `/m/${c.matchId}` }, "Go to the match"));
    return;
  }
  if (c.status === "cancelled" || c.status === "expired") {
    el.append(h("p", {}, `This challenge was ${c.status}. Any stakes paid were refunded.`), h("a", { class: "btn", href: "/" }, "Home"));
    return;
  }
  const players = h("div", { class: "players" },
    playerSlot(c.creator.name, c.stake > 0 ? c.paid.creator : null, true),
    h("span", { class: "vs" }, "vs"),
    c.acceptor ? playerSlot(c.acceptor.name, c.stake > 0 ? c.paid.acceptor : null, false) : h("div", { class: "slot empty" }, "Waiting for an opponent…"),
  );
  el.append(players);

  if (c.status === "open") {
    if (mine) {
      el.append(
        h("p", {}, "Share this link. The match starts as soon as someone accepts", c.stake > 0 ? " and both stakes are paid." : "."),
        h("div", { class: "share" },
          h("input", { value: link, readonly: true, onclick: (e: Event) => (e.target as HTMLInputElement).select() }),
          h("button", { class: "btn", onclick: () => { void navigator.clipboard?.writeText(link); toast("Link copied"); } }, "Copy"),
          (navigator as any).share ? h("button", { class: "btn", onclick: () => (navigator as any).share({ title: "Hexstake challenge", url: link }) }, "Share") : null,
        ),
        h("p", { class: "muted small" }, "Keep this page open. The lobby closes if you leave for more than a minute or so."),
        h("button", { class: "btn danger", onclick: () => send({ t: "challenge.cancel", code: c.code }) }, "Cancel challenge"),
      );
    } else {
      el.append(
        ...(c.creatorOnline ? [] : [h("p", { class: "warn" }, `${c.creator.name} isn't in the lobby right now.`)]),
        h("button", {
          class: "btn primary big",
          onclick: async () => {
            if (c.stake > 0 && !requireSignIn("Coin matches pay out to your Serble account.")) return;
            if (!(await ensureSession())) return;
            send({ t: "challenge.accept", code: c.code });
          },
        }, c.stake > 0 ? `Accept & stake ${c.stake} coins` : "Accept challenge"),
      );
    }
  }
  if (c.status === "funding") {
    const pay = c.yourPayment;
    if (mine || iAccepted) {
      if (pay?.status === "pending" && pay.consentUrl) {
        el.append(
          h("p", {}, `Approve your ${c.stake}-coin stake on Serble. The match starts when both players have paid. Proposals expire after 15 minutes.`),
          h("div", { class: "row" },
            h("a", { class: "btn primary big", href: pay.consentUrl, "data-external": "" }, `Pay ${c.stake} coins on Serble`),
            h("button", { class: "btn", onclick: () => send({ t: "challenge.check", code: c.code }) }, "I've paid, check now"),
          ),
        );
      } else if (pay?.status === "paid") {
        el.append(h("p", {}, "Your stake is in. Waiting for your opponent to pay…"));
      } else {
        el.append(h("p", { class: "muted" }, "Setting up payment…"));
      }
    } else {
      el.append(h("p", { class: "muted" }, "Someone is accepting this challenge right now."));
    }
  }
}

function playerSlot(name: string, paid: boolean | null, creator: boolean) {
  return h("div", { class: `slot ${creator ? "mine" : "theirs"}` },
    h("b", {}, name),
    paid === null ? null : h("span", { class: `pay ${paid ? "ok" : ""}` }, paid ? "stake paid" : "awaiting stake"));
}

// ------------------------------------------------------------------ lobby list

async function renderLobby() {
  const list = h("div", { class: "list" }, h("p", { class: "muted" }, "Loading…"));
  shell(
    h("section", {},
      h("div", { class: "row spread" }, h("h2", {}, "Open lobbies"), h("button", { class: "btn primary", onclick: () => openChallengeDialog() }, "Create challenge")),
      list,
    ),
  );
  const rows: ChallengeView[] = (await api("/api/challenges")) ?? [];
  clear(list);
  if (!rows.length) list.append(h("p", { class: "muted" }, "No open lobbies right now. Create one and share the link!"));
  for (const c of rows) {
    list.append(h("a", { class: "match-row", href: `/c/${c.code}` },
      h("b", {}, c.creator.name), h("span", { class: "muted" }, c.stake ? ` · ${c.stake} coins (winner gets ${c.payout})` : " · friendly"),
      h("span", { class: "go" }, "Join →")));
  }
}

// ------------------------------------------------------------------ match page

async function renderMatchPage(id: string) {
  const main = shell();
  main.classList.add("game-main");
  if (match && match.id === id) {
    buildGameUi(main);
    send({ t: "watch", matchId: id });
    return;
  }
  main.append(h("p", { class: "muted" }, "Loading match…"));
  const d = await api(`/api/matches/${id}`);
  if (!d || d.error) {
    clear(main);
    main.append(h("h2", {}, "Match not found"), h("a", { href: "/", class: "btn" }, "Home"));
    return;
  }
  if (d.record) return renderReplay(main, d.record);
  match = d as MatchView;
  orders = {};
  clear(main);
  buildGameUi(main);
  if (me.user) send({ t: "watch", matchId: id });
}

function buildGameUi(main: HTMLElement) {
  const canvas = h("canvas", { class: "board", id: "board" }) as HTMLCanvasElement;
  const hud = h("div", { class: "hud", id: "hud" });
  const controls = h("div", { class: "controls", id: "controls" });
  const coach = h("div", { class: "coach", id: "coach" });
  main.append(h("div", { class: "game" }, h("div", { class: "board-col" }, coach, h("div", { class: "board-wrap" }, canvas)), h("aside", { class: "side" }, hud, controls)));
  renderer = new BoardRenderer(canvas, match!.state.config.radius);
  const r = renderer;
  const resize = () => {
    if (renderer === r) r.resize();
    else window.removeEventListener("resize", resize);
  };
  window.addEventListener("resize", resize);
  requestAnimationFrame(() => r.resize());

  let hover: number | null = null;
  canvas.addEventListener("pointermove", (e) => {
    const idx = r.hitTest(e.clientX, e.clientY);
    if (idx !== hover) {
      hover = idx;
      if (r.view) {
        r.view.hover = hover;
        r.draw();
      }
    }
  });
  canvas.addEventListener("pointerleave", () => {
    hover = null;
    if (r.view) {
      r.view.hover = null;
      r.draw();
    }
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerup", (e) => {
    if (Date.now() < revealUntil) {
      revealUntil = 0; // skip the reveal animation
      renderMatchHud();
    }
    const idx = r.hitTest(e.clientX, e.clientY);
    if (idx === null) return;
    allocate(idx, e.button === 2 || eraser ? -brush : brush);
  });
  document.onkeydown = (e) => {
    if (route().name !== "match" || !match || match.you === null) return;
    if (e.key === "Enter") lockIn();
    if (["1", "2", "3", "5"].includes(e.key)) setBrush(Number(e.key));
    if (e.key === "e") toggleEraser();
  };
  renderMatchHud();
  hudTimer = window.setInterval(updateTimer, 250);
}

function myTurnOpen(): boolean {
  return Boolean(match && match.you !== null && !match.state.over && !match.submitted[match.you]);
}

function allocate(idx: number, delta: number) {
  if (!match || !myTurnOpen()) return;
  const p = match.you!;
  const reach = targetable(match.state, p);
  if (!reach.has(idx)) return;
  const spent = orderTotal(orders);
  const left = match.state.energy[p] - spent;
  const cur = orders[idx] ?? 0;
  const next = Math.max(0, cur + (delta > 0 ? Math.min(delta, left) : delta));
  if (next === cur) {
    if (delta > 0 && left === 0) toast("Out of energy");
    return;
  }
  if (next === 0) delete orders[idx];
  else orders[idx] = next;
  navigator.vibrate?.(8);
  queueDraft();
  renderMatchHud();
}

let draftTimer: number | null = null;
/** Send placed-but-unlocked orders so the server can use them if the timer runs out. */
function queueDraft() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    draftTimer = null;
    if (match && myTurnOpen()) send({ t: "draft", matchId: match.id, orders, turn: match.state.turn });
  }, 250);
}

function setBrush(n: number) {
  brush = n;
  renderMatchHud();
}
function toggleEraser() {
  eraser = !eraser;
  renderMatchHud();
}

function lockIn() {
  if (!match || !myTurnOpen()) return;
  if (match.tutorial && tutorial && !tutorial.finished && tutorial.blocksLockIn) return toast("Tap the pulsing hex first");
  send({ t: "orders", matchId: match.id, orders, turn: match.state.turn });
  match.submitted[match.you!] = true;
  void track("ui_lock_in", { spent: orderTotal(orders), turn: match.state.turn });
  renderMatchHud();
}

function updateTimer() {
  const el = document.getElementById("timer");
  if (!el || !match) return;
  if (match.state.over) {
    el.textContent = "";
    return;
  }
  const left = Math.max(0, match.deadline - (Date.now() + clockSkew));
  el.textContent = `${Math.ceil(left / 1000)}s`;
  el.classList.toggle("urgent", left < 5000);
  const bar = document.getElementById("timebar");
  if (bar) bar.style.width = `${Math.min(100, (left / (match.turnSeconds * 1000)) * 100)}%`;
}

function renderMatchHud() {
  if (!match) return;
  const hud = document.getElementById("hud");
  const controls = document.getElementById("controls");
  if (!hud || !controls) return;
  const s = match.state;
  const me_: Player = match.you ?? 0;
  const them: Player = me_ === 0 ? 1 : 0;
  const revealing = Date.now() < revealUntil && match.lastResult;
  let tutCtx: TutorialCtx | null = null;
  if (match.tutorial && match.you !== null && !s.over) {
    tutCtx = { state: s, me: match.you, orders, submitted: match.submitted[match.you] };
    if (!tutorial || tutorial.matchId !== match.id) tutorial = new Tutorial(match.id, tutCtx);
    if (tutorial.update(tutCtx)) void track("ui_tutorial_step", { step: tutorial.current?.id ?? "done" });
  }
  const activeTutorial = tutCtx && tutorial && !tutorial.finished ? tutorial : null;
  if (renderer) {
    renderer.view = {
      state: s, me: match.you, orders, interactive: myTurnOpen() && !revealing,
      reveal: revealing ? { changes: match.lastResult!.changes, orders: match.lastResult!.orders } : null,
      hover: renderer.view?.hover ?? null,
      focus: activeTutorial && tutCtx ? activeTutorial.focus(tutCtx) : null,
    };
    renderer.draw();
  }
  const sc = [score(s, 0), score(s, 1)];
  const seatLine = (p: Player, cls: string) => {
    const seat = match!.seats[p];
    return h("div", { class: `seat ${cls}` },
      h("div", { class: "name" }, h("span", { class: `dot ${cls}` }), seat.name, h("span", { class: "muted" }, seat.bot ? "" : ` ${seat.elo}`),
        match!.submitted[p] && !s.over ? h("span", { class: "ready" }, "✓ ready") : null),
      h("div", { class: "nums" },
        h("span", { title: "Energy banked" }, icon("bolt"), String(s.energy[p])),
        h("span", { title: "Energy gained next turn" }, `+${incomeFor(s, p)}/turn`),
        h("span", { title: "Hexes held" }, icon("hex"), String(sc[p].hexes)),
      ));
  };
  clear(hud);
  hud.append(
    h("div", { class: "turnline" },
      h("span", {}, s.over ? "Match over" : `Turn ${s.turn} / ${s.config.maxTurns}`),
      match.stake ? h("span", { class: "tag staked" }, `${match.stake * 2}⬡ pot`) : h("span", { class: `tag ${match.mode}` }, match.mode),
      h("span", { id: "timer", class: "timer" })),
    h("div", { class: "timebar-wrap" }, h("div", { id: "timebar", class: "timebar" })),
    seatLine(me_, "mine"),
    seatLine(them, "theirs"),
  );
  updateTimer();

  clear(controls);
  if (s.over) {
    controls.append(endPanel());
    return;
  }
  if (match.you === null) {
    controls.append(h("p", { class: "muted" }, "Spectating. Orders are revealed when each turn resolves."));
    return;
  }
  const spent = orderTotal(orders);
  const left = s.energy[me_] - spent;
  // Tutorial coach sits above the board so it's visible on phones too.
  const coach = document.getElementById("coach");
  if (coach) {
    clear(coach);
    if (activeTutorial && tutCtx) coach.append(tutorialPanel(activeTutorial, tutCtx));
  }
  // In the tutorial, the first action must be a tap on the board, not Pass turn.
  const lockBlocked = Boolean(activeTutorial?.blocksLockIn);
  if (match.submitted[me_]) {
    controls.append(h("p", { class: "locked" }, "Orders locked in. Waiting for your opponent…"));
  } else {
    // Phones: a fixed bar keeps the key actions on screen (hidden on wide screens via CSS).
    controls.append(h("div", { class: "mobile-bar" },
      h("span", { class: "mb-energy" }, h("b", {}, String(left)), " energy left"),
      h("button", { class: "btn", onclick: () => { orders = {}; queueDraft(); renderMatchHud(); } }, "Clear"),
      lockBlocked
        ? h("button", { class: "btn", disabled: true }, "Tap the hex first")
        : h("button", { class: "btn primary", onclick: lockIn }, spent ? `Lock in (${spent})` : "Pass turn"),
    ));
    controls.append(
      h("div", { class: "energy" }, h("b", {}, String(left)), h("span", {}, ` of ${s.energy[me_]} energy left`)),
      h("div", { class: "brushes" },
        ...[1, 2, 3, 5].map((n) => h("button", { class: `btn small ${brush === n && !eraser ? "on" : ""}`, onclick: () => { eraser = false; setBrush(n); } }, `+${n}`)),
        h("button", { class: `btn small ${eraser ? "on" : ""}`, onclick: toggleEraser, title: "Remove energy (or right-click)" }, "−"),
      ),
      incomeLine(s, me_),
      h("p", { class: "muted small" }, "Tap highlighted hexes to place energy: on your own hexes to fortify, on neighbours to claim or attack. Placed energy locks in automatically when time runs out."),
      h("div", { class: "row" },
        lockBlocked
          ? h("button", { class: "btn big grow", disabled: true }, "Tap the pulsing hex first")
          : h("button", { class: "btn primary big grow", onclick: lockIn }, spent ? `Lock in (${spent})` : "Pass turn"),
        h("button", { class: "btn", onclick: () => { orders = {}; queueDraft(); renderMatchHud(); } }, "Clear"),
      ),
    );
  }
  controls.append(h("button", {
    class: "link danger small", onclick: () => {
      if (confirm(match!.stake ? "Resign and forfeit your stake?" : "Resign this match?")) send({ t: "resign", matchId: match!.id });
    },
  }, "Resign"));
}

/** Spell out where energy comes from: only the home and connected wells produce it. */
function incomeLine(s: GameState, p: Player) {
  const wells = (incomeFor(s, p) - s.config.incomeBase) / s.config.wellIncome;
  return h("p", { class: "income small" },
    `Next turn: +${s.config.incomeBase} from your home`,
    wells > 0 ? ` +${wells * s.config.wellIncome} from ${wells} well${wells === 1 ? "" : "s"}` : "",
    `. Grab wells (+${s.config.wellIncome} each); other hexes give no energy.`);
}

/** The coach panel for the interactive tutorial. */
function tutorialPanel(t: Tutorial, c: TutorialCtx) {
  const step = t.current!;
  return h("div", { class: "guide" },
    h("div", { class: "row spread" }, h("b", {}, "Tutorial"), h("span", { class: "muted small" }, t.progress)),
    h("p", {}, step.text(c, t)),
    step.button
      ? h("button", {
          class: `btn small ${step.done ? "" : "primary"}`,
          onclick: () => {
            t.next();
            void track("ui_tutorial_step", { step: t.current?.id ?? "done" });
            if (t.finished) {
              markTutorialDone();
              void track("ui_tutorial_done", {});
              toast("Tutorial complete! Finish the match, then try the Normal bot or Ranked.");
            }
            renderMatchHud();
          },
        }, step.button)
      : null,
  );
}

function endPanel() {
  const m = match!;
  const s = m.state;
  const youWon = m.you !== null && s.winner === m.you;
  const draw = s.winner === null;
  const loserIsYou = m.you !== null && s.winner !== null && s.winner !== m.you;
  const reason = s.endReason === "abandon"
    ? (loserIsYou ? "missing three turns in a row" : "the other player leaving")
    : s.endReason === "forfeit"
      ? (loserIsYou ? "resignation" : "the other player resigning")
      : { home: "home captured", turns: "most territory" }[s.endReason ?? "turns"] ?? "";
  const title = m.you === null ? (draw ? "Draw" : `${m.seats[s.winner!].name} wins`) : draw ? "Draw" : youWon ? "Victory!" : "Defeat";
  const elo = m.eloChange !== null && m.you !== null ? (m.you === 0 ? m.eloChange : -m.eloChange) : null;
  return h("div", { class: `end ${youWon ? "won" : draw ? "draw" : "lost"}` },
    h("h2", {}, title),
    h("p", {}, `By ${reason} after ${m.lastResult?.turn ?? s.turn} turns.`),
    elo !== null ? h("p", { class: "elo" }, `Rating ${elo >= 0 ? "+" : ""}${elo}`) : null,
    m.stake && m.you !== null ? h("p", {}, draw ? `Stakes refunded (${m.stake} coins).` : youWon ? `${m.stake * 2 - Math.floor((m.stake * 2 * me.rakePercent) / 100)} coins are on their way to your Serble balance.` : `You lost your ${m.stake}-coin stake.`) : null,
    h("div", { class: "row" },
      m.tutorial ? h("button", { class: "btn primary", onclick: () => playBot("easy") }, "Play the Easy bot") : null,
      m.mode === "daily" ? h("button", { class: "btn primary", onclick: () => playDaily() }, "Try today's map again") : null,
      m.mode === "bot" && !m.tutorial ? h("button", { class: "btn primary", onclick: () => playBot(m.seats.find((x) => x.bot)?.bot ?? "normal") }, "Rematch") : null,
      m.mode === "ranked" ? h("button", { class: "btn primary", onclick: () => { navigate("/"); toggleQueue(); } }, "Play again") : null,
      h("a", { class: "btn", href: `/m/${m.id}?replay=1`, onclick: (e: Event) => { e.preventDefault(); match = null; navigate(`/m/${m.id}`); } }, "Replay"),
      h("a", { class: "btn", href: "/" }, "Home"),
    ),
    m.mode === "daily" && m.you !== null ? h("p", {}, youWon ? `You beat today's map in ${m.lastResult?.turn ?? s.turn} turns. Fewer is better, so check the board on the home page.` : "The daily boss won this time. Same map until midnight UTC, so try a different plan!") : null,
    me.user?.guest && m.mode === "bot" && youWon ? h("p", { class: "muted small" }, "Nice! ", h("a", { href: "/auth/login?return=/", "data-external": "" }, "Sign in with Serble"), " to play ranked and stake coins.") : null,
  );
}

function onMatchEnd() {
  if (!match) return;
  if (match.tutorial) markTutorialDone();
  const won = match.you !== null && match.state.winner === match.you;
  if (won) navigator.vibrate?.([30, 50, 30]);
  void refreshMe();
}

// ------------------------------------------------------------------ replay

function renderReplay(main: HTMLElement, rec: any) {
  clear(main);
  const states: GameState[] = [newGame(rec.seed, DEFAULT_CONFIG)];
  const results: TurnResult[] = [];
  for (const [a, b] of rec.history as [Orders, Orders][]) {
    const prev = states[states.length - 1];
    if (prev.over) break;
    const r = resolveTurn(prev, a, b);
    states.push(r.state);
    results.push(r.result);
  }
  const canvas = h("canvas", { class: "board" }) as HTMLCanvasElement;
  const slider = h("input", { type: "range", min: "0", max: String(states.length - 1), value: String(states.length - 1) }) as HTMLInputElement;
  const label = h("span", {});
  const winner = rec.winner === 0 ? rec.p0_name : rec.winner === 1 ? rec.p1_name : null;
  main.append(
    h("div", { class: "game" },
      h("div", { class: "board-wrap" }, canvas),
      h("aside", { class: "side" },
        h("div", { class: "hud" },
          h("div", { class: "turnline" }, h("span", {}, "Replay"), h("span", { class: `tag ${rec.mode}` }, rec.mode)),
          h("div", { class: "seat mine" }, h("div", { class: "name" }, h("span", { class: "dot mine" }), rec.p0_name)),
          h("div", { class: "seat theirs" }, h("div", { class: "name" }, h("span", { class: "dot theirs" }), rec.p1_name)),
          h("p", {}, winner ? `${winner} won` : rec.status === "finished" ? "Draw" : "Match did not finish", rec.end_reason ? ` (${rec.end_reason})` : "", rec.stake ? ` · stake ${rec.stake}⬡` : ""),
        ),
        h("div", { class: "controls" },
          h("div", { class: "row" }, label),
          slider,
          h("div", { class: "row" },
            h("button", { class: "btn small", onclick: () => step(-1) }, "◀"),
            h("button", { class: "btn small", onclick: () => play() }, "▶ Play"),
            h("button", { class: "btn small", onclick: () => step(1) }, "▶"),
          ),
          h("a", { class: "btn", href: "/" }, "Home"),
        ),
      ),
    ),
  );
  const r = new BoardRenderer(canvas, DEFAULT_CONFIG.radius);
  renderer = r;
  const show = (i: number) => {
    slider.value = String(i);
    label.textContent = i === 0 ? "Start" : `After turn ${i}`;
    const res = results[i - 1];
    r.view = { state: states[i], me: 0, orders: {}, interactive: false, reveal: res ? { changes: res.changes, orders: res.orders } : null };
    r.draw();
  };
  const step = (d: number) => show(Math.max(0, Math.min(states.length - 1, Number(slider.value) + d)));
  let playing: number | null = null;
  const play = () => {
    if (playing) {
      clearInterval(playing);
      playing = null;
      return;
    }
    if (Number(slider.value) >= states.length - 1) show(0);
    playing = window.setInterval(() => {
      if (renderer !== r || Number(slider.value) >= states.length - 1) {
        clearInterval(playing!);
        playing = null;
        return;
      }
      step(1);
    }, 900);
  };
  slider.oninput = () => show(Number(slider.value));
  requestAnimationFrame(() => {
    r.resize();
    show(states.length - 1);
  });
  window.addEventListener("resize", () => renderer === r && r.resize());
}

// ------------------------------------------------------------------ leaderboard / user / wallet

async function renderLeaderboard() {
  const table = h("table", { class: "table" }, h("tr", {}, h("th", {}, "#"), h("th", {}, "Player"), h("th", {}, "Rating"), h("th", {}, "W-L-D")));
  shell(h("section", {}, h("h2", {}, "Leaderboard"), h("p", { class: "muted small" }, "Ratings and W-L-D count ranked, challenge and coin matches against other players. Bot games and the daily challenge don't count."), table));
  const rows = (await api("/api/leaderboard")) ?? [];
  if (!rows.length) table.after(h("p", { class: "muted" }, "Nobody is ranked yet. Play a ranked or challenge match to get on the board."));
  rows.forEach((u: any, i: number) => {
    table.append(h("tr", { class: u.id === me.user?.id ? "me" : "" },
      h("td", {}, String(i + 1)), h("td", {}, h("a", { href: `/u/${u.id}` }, u.username)), h("td", {}, String(u.elo)),
      h("td", {}, `${u.wins}-${u.losses}-${u.draws}`)));
  });
}

async function renderUser(id: string) {
  const main = shell(h("p", { class: "muted" }, "Loading…"));
  const u = await api(`/api/users/${id}`);
  clear(main);
  if (!u || u.error) {
    main.append(h("h2", {}, "Player not found"));
    return;
  }
  const isMe = me.user?.id === u.id;
  main.append(
    h("section", { class: "profile" },
      h("h2", {}, u.username),
      h("div", { class: "stats" }, stat(u.elo, `rating (#${u.rank})`), stat(u.games, "games"), stat(u.wins, "wins"), stat(u.coins_won, "coins won")),
      isMe ? h("div", { class: "row" },
        h("a", { class: "btn", href: "/wallet" }, "Coin history"),
        h("button", { class: "btn", onclick: async () => { await post("/auth/logout", {}); location.href = "/"; } }, "Sign out")) : null,
      h("h3", {}, "Recent matches"),
      h("div", { class: "list" }, ...(u.matches.length ? u.matches.map((m: any) => {
        const seat = m.p0 === u.id ? 0 : 1;
        const opp = seat === 0 ? m.p1_name : m.p0_name;
        const res = m.winner === null ? "Draw" : m.winner === seat ? "Win" : "Loss";
        const elo = m.elo_change !== null ? (seat === 0 ? m.elo_change : -m.elo_change) : null;
        return h("a", { class: "match-row", href: `/m/${m.id}` },
          h("span", { class: `tag ${res.toLowerCase()}` }, res), ` vs ${opp}`,
          h("span", { class: "muted" }, ` · ${m.mode}${m.stake ? ` ${m.stake}⬡` : ""}${elo !== null ? ` · ${elo >= 0 ? "+" : ""}${elo}` : ""} · ${timeAgo(m.ended_at)}`));
      }) : [h("p", { class: "muted" }, "No matches yet.")])),
    ),
  );
}

async function renderWallet() {
  if (!me.user || me.user.guest) {
    shell(h("section", {}, h("h2", {}, "Coin history"), h("p", {}, "Sign in to see your stakes and winnings.")));
    return;
  }
  const list = h("div", { class: "list" }, h("p", { class: "muted" }, "Loading…"));
  shell(h("section", {}, h("h2", {}, "Coin history"),
    h("p", { class: "muted small" }, "Stakes are paid to Hexstake through Serble's consent page. Winnings and refunds go straight to your Serble balance."), list));
  const rows = (await api("/api/payments")) ?? [];
  clear(list);
  if (!rows.length) list.append(h("p", { class: "muted" }, "Nothing yet."));
  for (const p of rows) {
    const sign = p.kind === "stake" ? "−" : "+";
    list.append(h("div", { class: "match-row" },
      h("span", { class: `tag ${p.kind}` }, p.kind), ` ${sign}${fmtCoins(p.amount)} coins`,
      h("span", { class: "muted" }, ` · ${p.status} · ${timeAgo(p.created_at)}`),
      p.status === "pending" && p.consent_url ? h("a", { href: p.consent_url, class: "go", "data-external": "" }, "Pay →") : null,
      p.match_id ? h("a", { href: `/m/${p.match_id}`, class: "go" }, "Match →") : null));
  }
}

// ------------------------------------------------------------------ friends

async function renderFriends() {
  const body = h("div", {}, h("p", { class: "muted" }, "Loading…"));
  shell(h("section", {}, h("h2", {}, "Challenge a friend"), body));
  if (!me.user || me.user.guest) {
    clear(body);
    body.append(h("p", {}, "Sign in with Serble to see your Serble Chat friends."),
      h("a", { class: "btn primary", href: "/auth/login?return=/friends", "data-external": "" }, "Sign in"));
    return;
  }
  const params = new URLSearchParams(location.search);
  if (params.get("connected") === "0") toast("Serble Chat wasn't connected", "error");
  const d = await api("/api/friends");
  clear(body);
  if (!d) {
    body.append(h("p", { class: "warn" }, "Couldn't reach Serble Chat. Try again later."));
    return;
  }
  if (!d.connected) {
    body.append(
      h("p", {}, "Connect Serble Chat to see your friends and send them challenges as a direct message. Serble will ask you to allow Hexstake to sign you in to Serble Chat."),
      d.consentUrl ? h("a", { class: "btn primary", href: d.consentUrl, "data-external": "" }, "Connect Serble Chat") : h("p", { class: "warn" }, d.error ?? "Serble Chat isn't available right now."),
      h("p", { class: "muted small" }, "Or just ", h("button", { class: "link", onclick: () => openChallengeDialog() }, "create a challenge link"), " and paste it anywhere."),
    );
    return;
  }
  if (!d.friends.length) body.append(h("p", { class: "muted" }, "You don't have any Serble Chat friends yet."));
  for (const f of d.friends) {
    body.append(h("div", { class: "match-row" },
      h("span", { class: `dot ${f.status === "online" ? "online" : ""}` }), ` ${f.username}`,
      h("button", { class: "btn small go", onclick: () => openChallengeDialog(f) }, "Challenge")));
  }
  body.append(h("p", { class: "muted small" }, "Challenges are sent as a DM from your Serble Chat account. ",
    h("button", { class: "link", onclick: async () => { await post("/api/friends/disconnect", {}); renderFriends(); } }, "Disconnect Serble Chat")));
}

// ------------------------------------------------------------------ rules

function renderRules() {
  shell(h("section", { class: "rules prose" },
    h("h2", {}, "How to play"),
    h("p", {}, "Hexstake is a two-player duel on a hexagonal map. Each turn, both players secretly spend ", h("b", {}, "energy"), " on hexes. When the timer runs out (or both lock in), all orders resolve at once."),
    h("h3", {}, "Where you can spend"),
    h("ul", {},
      h("li", {}, h("b", {}, "Your own hexes"), ": energy adds to the hex's strength (fortify)."),
      h("li", {}, h("b", {}, "Hexes next to your territory"), ": energy is a bid to claim a neutral hex or attack an enemy one."),
    ),
    h("h3", {}, "How a hex resolves"),
    h("ul", {},
      h("li", {}, "If you own it: its strength plus your energy defends against the enemy's energy. If the attack is bigger, they take the hex with the difference as its strength. A tie leaves it neutral."),
      h("li", {}, "If it's neutral: the two bids cancel out, and the leftover from the bigger bid must beat the hex's guard (wells have 2)."),
    ),
    h("h3", {}, "Terrain"),
    h("ul", {},
      h("li", {}, h("b", {}, "Wells"), " (ringed hexes) give +2 energy every turn while connected to your home."),
      h("li", {}, h("b", {}, "Rocks"), " are impassable."),
      h("li", {}, "Your ", h("b", {}, "home"), " gives a base +4 energy a turn and regenerates +2 strength a turn (max 12)."),
    ),
    h("h3", {}, "Supply lines"),
    h("p", {}, "Hexes cut off from your home lose 1 strength every turn and stop giving income. Cutting your opponent's territory in half is often stronger than attacking head-on."),
    h("h3", {}, "Winning"),
    h("ul", {},
      h("li", {}, "Capture the enemy home for an instant win."),
      h("li", {}, "Otherwise, after 30 turns, the player holding the most hexes wins (ties go to total strength)."),
      h("li", {}, "Missing three turns in a row forfeits the match."),
    ),
    h("h3", {}, "Tips"),
    h("ul", {},
      h("li", {}, "Energy banks up to 24. Watch your opponent's bank: a big bank next to your home means an attack is coming."),
      h("li", {}, "Bidding exactly enough is risky, because your opponent may contest the same hex."),
      h("li", {}, "Keyboard: 1/2/3/5 picks the brush, E toggles remove, Enter locks in. Right-click removes energy."),
    ),
    h("h3", {}, "Coin matches"),
    h("p", {}, `Challenges can carry a stake in Serble coins. Both players approve their stake on Serble's consent page before the match starts. The winner receives the pot minus a ${me.rakePercent}% house cut (rounded down, so tiny pots are free). Draws, cancelled lobbies and unfinished matches are refunded.`),
    h("a", { class: "btn primary", href: "/", onclick: (e: Event) => { e.preventDefault(); playBot("easy", true); } }, "Play the interactive tutorial"),
  ));
}

// ------------------------------------------------------------------ feedback / telemetry

function openFeedback() {
  const ta = h("textarea", { rows: "5", placeholder: "Bug? Idea? Balance complaint? Tell me." }) as HTMLTextAreaElement;
  const dlg = h("dialog", { class: "modal" },
    h("h3", {}, "Feedback"),
    ta,
    h("p", { class: "muted small" }, "You can also open an issue on ", h("a", { href: "https://github.com/CoPokBl/hexstake/issues", target: "_blank", "data-external": "" }, "GitHub"), "."),
    h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: async () => {
        if (!ta.value.trim()) return;
        await post("/api/feedback", { text: ta.value, page: location.pathname });
        toast("Thanks!");
        dlg.close();
      } }, "Send"),
      h("button", { class: "btn", onclick: () => dlg.close() }, "Cancel")),
  ) as HTMLDialogElement;
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
}

async function track(type: string, data?: object) {
  try {
    await fetch("/api/event", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, data }), keepalive: true });
  } catch {
    /* ignore */
  }
}

let errorsSent = 0;
window.addEventListener("error", (e) => {
  if (errorsSent++ > 5) return;
  void post("/api/client-error", { msg: e.message, stack: e.error?.stack ?? `${e.filename}:${e.lineno}` });
});
window.addEventListener("unhandledrejection", (e) => {
  if (errorsSent++ > 5) return;
  void post("/api/client-error", { msg: String(e.reason), stack: e.reason?.stack ?? "" });
});

// ------------------------------------------------------------------ boot

async function refreshMe() {
  const r = await api("/api/me");
  if (r) me = r;
}

(async () => {
  await refreshMe();
  const params = new URLSearchParams(location.search);
  if (params.get("login") === "failed") toast("Sign-in failed, please try again", "error");
  if (me.user) connect();
  render();
})();
