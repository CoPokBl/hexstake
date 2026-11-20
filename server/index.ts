import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { BotLevel } from "../shared/bot";
import { adminAnalytics, initAnalytics, publicStats, track } from "./analytics";
import { Auth, Session } from "./auth";
import { Chat, ChatNeedsConnect } from "./chat";
import { config } from "./config";
import { randomId } from "./crypto";
import { openDb, now } from "./db";
import { Economy } from "./economy";
import { log } from "./log";
import { Client, LiveMatch, MatchManager, Seat } from "./matches";
import { economyReady, saveSecrets, secrets, signInReady } from "./secrets";
import * as serble from "./serble";

const startedAt = now();
const db = openDb();
initAnalytics(db);
const auth = new Auth(db);
const chat = new Chat(db, auth);
const mm = new MatchManager(db);

// ------------------------------------------------------------------ socket registry

const byUser = new Map<string, Set<Client>>();
function notify(userId: string, msg: object) {
  for (const c of byUser.get(userId) ?? []) c.send(msg);
}

function seatFor(userId: string, name: string): Seat {
  const row = db.prepare("SELECT elo FROM users WHERE id = ?").get(userId) as { elo: number } | undefined;
  return { id: userId, name, elo: row?.elo ?? 1000 };
}

function attachPlayers(m: LiveMatch) {
  for (const seat of m.seats) {
    for (const c of byUser.get(seat.id) ?? []) {
      m.subscribers.add(c);
      c.send({ t: "match", ...m.view(c.userId) });
    }
  }
}

const economy = new Economy(db, mm, notify, attachPlayers, seatFor);
mm.hooks.onFinish = (m) => economy.settle(m);

// ------------------------------------------------------------------ matchmaking

interface QueueEntry {
  client: Client;
  elo: number;
  since: number;
}
const rankedQueue: QueueEntry[] = [];

function dequeue(userId: string) {
  for (let i = rankedQueue.length - 1; i >= 0; i--) if (rankedQueue[i].client.userId === userId) rankedQueue.splice(i, 1);
}

function matchmake() {
  const t = now();
  rankedQueue.sort((a, b) => a.since - b.since);
  for (let i = 0; i < rankedQueue.length; i++) {
    const a = rankedQueue[i];
    const windowA = 100 + 15 * ((t - a.since) / 1000);
    let best = -1;
    let bestDiff = Infinity;
    for (let j = i + 1; j < rankedQueue.length; j++) {
      const b = rankedQueue[j];
      if (b.client.userId === a.client.userId) continue;
      const diff = Math.abs(a.elo - b.elo);
      const windowB = 100 + 15 * ((t - b.since) / 1000);
      if (diff <= Math.max(windowA, windowB) && diff < bestDiff) {
        best = j;
        bestDiff = diff;
      }
    }
    if (best >= 0) {
      const b = rankedQueue[best];
      rankedQueue.splice(best, 1);
      rankedQueue.splice(i, 1);
      i--;
      const m = mm.create("ranked", [seatFor(a.client.userId, a.client.name), seatFor(b.client.userId, b.client.name)]);
      track("matchmade", a.client.userId, { waited: t - a.since, diff: bestDiff });
      attachPlayers(m);
    }
  }
  for (const e of rankedQueue) e.client.send({ t: "queue", waitingMs: t - e.since, inQueue: rankedQueue.length });
}

// ------------------------------------------------------------------ http helpers

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".map": "application/json", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
const SPA_ROUTES = /^\/(play|c\/[A-Za-z0-9]+|m\/[\w-]+|u\/[\w-]+|leaderboard|friends|lobby|rules|wallet)?\/?$/;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

function redirect(res: ServerResponse, to: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(302, { Location: to, "Cache-Control": "no-store", ...headers });
  res.end();
}

async function readJson(req: IncomingMessage, limit = 16_384): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid json");
  }
}

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  let file = SPA_ROUTES.test(path) ? "/index.html" : path;
  file = normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !existsSync(full) || !statSync(full).isFile()) return false;
  const ext = extname(full);
  const immutable = /\.(js|css|svg|png)$/.test(ext) && req.url?.includes("?v=");
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
    ...(ext === ".html" ? { "Content-Security-Policy": "default-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" } : {}),
  });
  res.end(ext === ".html" ? renderIndex(readFileSync(full, "utf8")) : readFileSync(full));
  return true;
}

let indexCache: string | null = null;
function renderIndex(html: string) {
  indexCache ??= html.replaceAll("__VERSION__", encodeURIComponent(config.version));
  return indexCache;
}

function userView(s: Session | null) {
  if (!s) return null;
  if (s.guest) return { id: s.userId, name: s.username, guest: true };
  const u = db.prepare("SELECT id, username, elo, games, wins, losses, draws, coins_won, coins_lost FROM users WHERE id = ?").get(s.userId) as Record<string, unknown> | undefined;
  return u ? { id: u.id, name: u.username, guest: false, elo: u.elo, games: u.games, wins: u.wins, losses: u.losses, draws: u.draws, coinsWon: u.coins_won, coinsLost: u.coins_lost } : null;
}

// ------------------------------------------------------------------ routes

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const session = auth.sessionFrom(req);

  if (path === "/healthz") {
    return send(res, 200, {
      ok: true, version: config.version, uptimeSec: Math.round((now() - startedAt) / 1000),
      liveMatches: mm.live.size, queue: rankedQueue.length, signIn: signInReady(), economy: economyReady(),
    });
  }

  // ---- auth
  if (path === "/auth/login") {
    if (!signInReady()) return send(res, 503, "Serble sign-in is not configured yet");
    track("login_start", session?.userId ?? null);
    return redirect(res, auth.beginLogin(url.searchParams.get("return") ?? "/"));
  }
  if (path === "/auth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    if (!code) return redirect(res, "/?login=cancelled");
    try {
      const r = await auth.completeLogin(code, state, session);
      track("login", r.session.userId, { returning: Boolean(session && !session.guest) });
      return redirect(res, r.returnTo, { "Set-Cookie": r.cookie });
    } catch (e) {
      log.warn("login failed", { err: String(e) });
      return redirect(res, "/?login=failed");
    }
  }
  if (path === "/auth/logout" && method === "POST") {
    return send(res, 200, { ok: true }, { "Set-Cookie": auth.destroy(req) });
  }
  if (path === "/api/guest" && method === "POST") {
    if (session) return send(res, 200, { user: userView(session) });
    const g = auth.guestSession();
    track("guest_start", g.session.userId);
    return send(res, 200, { user: userView(g.session) }, { "Set-Cookie": g.cookie });
  }

  // ---- serble chat
  if (path === "/auth/chat/callback") {
    const r = await chat.consentReturn(url.searchParams.get("state") ?? "", url.searchParams.get("error"));
    if (r) track(r.result.ok ? "chat_connected" : "chat_connect_failed", r.userId);
    return redirect(res, r?.result.ok ? "/friends?connected=1" : "/friends?connected=0");
  }

  // ---- wallet return from the Serble consent page
  if (path === "/wallet/return") {
    const proposal = url.searchParams.get("proposal");
    let code: string | null = null;
    if (proposal) {
      try {
        const p = await economy.checkProposal(proposal);
        code = p?.challenge_code ?? null;
      } catch (e) {
        log.warn("wallet return check failed", { err: String(e) });
      }
    }
    return redirect(res, code ? `/c/${code}` : "/wallet");
  }

  if (path.startsWith("/api/")) return api(req, res, url, session);

  if (method === "GET" && serveStatic(req, res, path)) return;
  return send(res, 404, "not found");
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, session: Session | null) {
  const path = url.pathname;
  const method = req.method ?? "GET";
  const need = () => {
    if (!session) throw new HttpError(401, "not signed in");
    return session;
  };
  const needUser = () => {
    const s = need();
    if (s.guest) throw new HttpError(403, "sign in with Serble first");
    return s;
  };
  let m: RegExpMatchArray | null;

  if (path === "/api/me") {
    return send(res, 200, {
      user: userView(session),
      signIn: signInReady(),
      economy: economyReady(),
      chat: session && !session.guest ? chat.connected(session.userId) : false,
      rakePercent: config.rakePercent,
      maxStake: config.maxStake,
      version: config.version,
    });
  }
  if (path === "/api/stats") return send(res, 200, publicStats(db));
  if (path === "/api/leaderboard") {
    const rows = db
      .prepare("SELECT id, username, elo, games, wins, losses, draws FROM users WHERE games > 0 ORDER BY elo DESC, wins DESC LIMIT 100")
      .all();
    return send(res, 200, rows);
  }
  if ((m = path.match(/^\/api\/users\/([\w-]+)$/))) {
    const u = db.prepare("SELECT id, username, elo, games, wins, losses, draws, coins_won, created_at FROM users WHERE id = ? OR username = ? COLLATE NOCASE").get(m[1], m[1]) as Record<string, unknown> | undefined;
    if (!u) return send(res, 404, { error: "no such player" });
    const rank = (db.prepare("SELECT COUNT(*) + 1 r FROM users WHERE games > 0 AND elo > ?").get(u.elo as number) as { r: number }).r;
    const matches = db
      .prepare(`SELECT id, mode, p0, p1, p0_name, p1_name, stake, winner, end_reason, turns, elo_change, created_at, ended_at
                FROM matches WHERE (p0 = ? OR p1 = ?) AND status = 'finished' ORDER BY created_at DESC LIMIT 25`)
      .all(u.id as string, u.id as string);
    return send(res, 200, { ...u, rank, matches });
  }
  if ((m = path.match(/^\/api\/matches\/([\w-]+)$/))) {
    const live = mm.get(m[1]);
    // Finished matches stay in memory for a while; serve the stored record (replay) for those.
    if (live && !live.state.over) return send(res, 200, { live: true, ...live.view(session?.userId ?? null) });
    const row = db.prepare("SELECT id, mode, p0, p1, p0_name, p1_name, seed, stake, status, winner, end_reason, turns, elo_change, history, created_at, ended_at FROM matches WHERE id = ?").get(m[1]) as Record<string, any> | undefined;
    if (!row) return send(res, 404, { error: "no such match" });
    return send(res, 200, { live: false, record: { ...row, p0: anon(row.p0), p1: anon(row.p1), history: row.history ? JSON.parse(row.history) : [] } });
  }
  if (path === "/api/matches" && method === "GET") {
    const live = [...mm.live.values()].filter((x) => !x.state.over && x.mode !== "bot").slice(0, 20).map((x) => ({
      id: x.id, mode: x.mode, stake: x.stake, turn: x.state.turn, seats: x.seats.map((s) => ({ name: s.name, elo: s.elo })),
    }));
    const recent = db.prepare(`SELECT id, mode, p0_name, p1_name, stake, winner, end_reason, turns, ended_at FROM matches
                               WHERE status = 'finished' AND mode != 'bot' ORDER BY ended_at DESC LIMIT 20`).all();
    return send(res, 200, { live, recent });
  }
  if (path === "/api/challenges") return send(res, 200, economy.openPublic());
  if ((m = path.match(/^\/api\/challenges\/([A-Za-z0-9]+)$/))) {
    const c = economy.get(m[1]);
    if (!c) return send(res, 404, { error: "challenge not found" });
    return send(res, 200, economy.view(c, session?.userId ?? null));
  }
  if (path === "/api/payments") return send(res, 200, economy.paymentsFor(needUser().userId));

  if (path === "/api/friends") {
    const s = needUser();
    try {
      const friends = await chat.friends(s.userId);
      return send(res, 200, { connected: true, friends });
    } catch (e) {
      if (e instanceof ChatNeedsConnect) {
        const r = e.result;
        return send(res, 200, { connected: false, consentUrl: "consentUrl" in r ? r.consentUrl : null, error: "error" in r ? r.error : null });
      }
      log.warn("friends failed", { err: String(e) });
      return send(res, 502, { error: "couldn't reach Serble Chat" });
    }
  }
  if (path === "/api/friends/disconnect" && method === "POST") {
    chat.disconnect(needUser().userId);
    return send(res, 200, { ok: true });
  }

  if (path === "/api/feedback" && method === "POST") {
    const body = await readJson(req);
    const text = String(body.text ?? "").slice(0, 2000).trim();
    if (!text) return send(res, 400, { error: "empty" });
    track("feedback", session?.userId ?? null, { text, page: String(body.page ?? "").slice(0, 100) });
    return send(res, 200, { ok: true });
  }
  if (path === "/api/client-error" && method === "POST") {
    const body = await readJson(req);
    track("client_error", session?.userId ?? null, { msg: String(body.msg ?? "").slice(0, 500), stack: String(body.stack ?? "").slice(0, 1500), ua: String(req.headers["user-agent"] ?? "").slice(0, 200) });
    return send(res, 200, { ok: true });
  }
  if (path === "/api/event" && method === "POST") {
    const body = await readJson(req);
    const type = String(body.type ?? "");
    if (!/^ui_[a-z_]{1,40}$/.test(type)) return send(res, 400, { error: "bad type" });
    track(type, session?.userId ?? null, typeof body.data === "object" && body.data ? body.data : undefined);
    return send(res, 200, { ok: true });
  }

  // ---- operator endpoints
  if (path.startsWith("/api/admin/")) {
    if (path === "/api/admin/bootstrap" && method === "POST") {
      const token = await auth.ownerToken(req);
      if (!token) return send(res, 401, { error: "owner credentials required" });
      const app = await serble.ownerGetApp(token);
      const update: Record<string, string> = { clientSecret: app.ClientSecret };
      const body = await readJson(req).catch(() => ({}));
      if (body.rotateKey || !secrets().appKey) update.appKey = await serble.ownerCreateKey(token, `hexstake-${new Date().toISOString().slice(0, 10)}`);
      saveSecrets(update);
      log.info("bootstrap complete", { rotatedKey: Boolean(update.appKey) });
      track("admin_bootstrap", null, { rotatedKey: Boolean(update.appKey) });
      economy.processPayouts();
      return send(res, 200, { ok: true, signIn: signInReady(), economy: economyReady() });
    }
    if (!(await auth.isOwner(req))) return send(res, 401, { error: "owner credentials required" }, { "WWW-Authenticate": 'Basic realm="hexstake-admin"' });
    if (path === "/api/admin/analytics") {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? "7")));
      return send(res, 200, adminAnalytics(db, days));
    }
    if (path === "/api/admin/economy") {
      let balance: number | string = "unavailable";
      try {
        balance = serble.rawToCoins(await serble.appBalanceRaw());
      } catch (e) {
        balance = String(e);
      }
      return send(res, 200, {
        appBalanceCoins: balance,
        writeBudget: serble.writeBudgetRemaining(),
        open: db.prepare("SELECT * FROM payments WHERE status IN ('pending','failed') ORDER BY created_at DESC LIMIT 100").all(),
        recent: db.prepare("SELECT * FROM payments ORDER BY created_at DESC LIMIT 50").all(),
      });
    }
    if ((m = path.match(/^\/api\/admin\/payments\/([\w-]+)\/retry$/)) && method === "POST") {
      const r = db.prepare("UPDATE payments SET status = 'pending', note = COALESCE(note,'') || ' [manual retry]' WHERE id = ? AND status = 'failed' AND kind IN ('payout','refund')").run(m[1]);
      void economy.processPayouts();
      return send(res, 200, { ok: r.changes > 0 });
    }
    if (path === "/api/admin/sql" && method === "POST") {
      // read-only queries for investigation
      const body = await readJson(req);
      const sql = String(body.sql ?? "");
      if (!/^\s*(select|with)\b/i.test(sql) || /;\s*\S/.test(sql)) return send(res, 400, { error: "single SELECT only" });
      return send(res, 200, db.prepare(sql).all());
    }
    return send(res, 404, { error: "unknown admin route" });
  }
  return send(res, 404, { error: "not found" });
}

const anon = (id: string) => (id.startsWith("guest:") ? "guest" : id);

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    log.error("request failed", { url: req.url, err: String(e), stack: (e as Error).stack });
    track("error", null, { where: "http", url: req.url, err: String(e).slice(0, 300) });
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  });
});

// ------------------------------------------------------------------ websocket

const wss = new WebSocketServer({ noServer: true, maxPayload: 32_768 });

server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/ws")) return socket.destroy();
  const session = auth.sessionFrom(req);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, session));
});

const BOT_LEVELS: BotLevel[] = ["easy", "normal", "hard"];

function onSocket(ws: WebSocket, session: Session) {
  const client: Client = {
    connId: randomId(6),
    userId: session.userId,
    name: session.username,
    guest: session.guest,
    send: (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  let set = byUser.get(client.userId);
  if (!set) byUser.set(client.userId, (set = new Set()));
  set.add(client);
  economy.creatorConnected(client.userId, true);
  if (!session.guest) db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(now(), client.userId);

  let alive = true;
  ws.on("pong", () => (alive = true));
  const hb = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 25_000);

  client.send({ t: "welcome", user: userView(session) });
  const active = mm.activeFor(client.userId);
  if (active) {
    active.subscribers.add(client);
    client.send({ t: "match", ...active.view(client.userId) });
  }

  const watching = new Set<LiveMatch>();
  let msgCount = 0;
  const rate = setInterval(() => (msgCount = 0), 10_000);

  ws.on("message", (raw) => {
    if (++msgCount > 60) return client.send({ t: "error", msg: "slow down" });
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    void onMessage(msg).catch((e) => {
      log.error("ws handler failed", { t: msg?.t, err: String(e) });
      client.send({ t: "error", msg: "something went wrong" });
    });
  });

  async function onMessage(msg: any) {
    const err = (m: string) => client.send({ t: "error", msg: m, ref: msg.t });
    switch (msg.t) {
      case "ping":
        return client.send({ t: "pong", serverNow: now() });
      case "bot": {
        const level: BotLevel = BOT_LEVELS.includes(msg.level) ? msg.level : "normal";
        if (mm.activeFor(client.userId)) return err("finish your current match first");
        dequeue(client.userId);
        const tutorial = msg.tutorial === true;
        const lvl: BotLevel = tutorial ? "easy" : level;
        const m = mm.create(
          "bot",
          [seatFor(client.userId, client.name), { id: `bot:${lvl}`, name: tutorial ? "Tutorial bot" : `Bot (${lvl})`, elo: { easy: 800, normal: 1000, hard: 1200 }[lvl], bot: lvl }],
          0,
          { tutorial },
        );
        if (tutorial) track("tutorial_start", client.userId);
        return attachPlayers(m);
      }
      case "queue": {
        if (client.guest) return err("sign in with Serble to play ranked");
        if (mm.activeFor(client.userId)) return err("finish your current match first");
        dequeue(client.userId);
        rankedQueue.push({ client, elo: seatFor(client.userId, client.name).elo, since: now() });
        track("queue_join", client.userId);
        client.send({ t: "queue", waitingMs: 0, inQueue: rankedQueue.length });
        return matchmake();
      }
      case "unqueue":
        dequeue(client.userId);
        return client.send({ t: "queue", left: true });
      case "watch": {
        const m = mm.get(String(msg.matchId));
        if (!m) return err("match not found");
        m.subscribers.add(client);
        watching.add(m);
        return client.send({ t: "match", ...m.view(client.userId) });
      }
      case "unwatch": {
        const m = mm.get(String(msg.matchId));
        if (m && m.seatOf(client.userId) === null) {
          m.subscribers.delete(client);
          watching.delete(m);
        }
        return;
      }
      case "orders": {
        const m = mm.get(String(msg.matchId));
        if (!m) return err("match not found");
        const p = m.seatOf(client.userId);
        if (p === null) return err("you're not playing in this match");
        if (msg.turn !== undefined && msg.turn !== m.state.turn) return err("that turn already ended");
        const e = m.submit(p, msg.orders ?? {});
        if (e) return err(e);
        return;
      }
      case "draft": {
        const m = mm.get(String(msg.matchId));
        const p = m?.seatOf(client.userId);
        if (!m || p === null || p === undefined) return;
        if (msg.turn !== undefined && msg.turn !== m.state.turn) return;
        m.setDraft(p, msg.orders ?? {});
        return;
      }
      case "resign": {
        const m = mm.get(String(msg.matchId));
        const p = m?.seatOf(client.userId);
        if (m && p !== null && p !== undefined) m.resign(p);
        return;
      }
      case "challenge.create": {
        const stake = Math.floor(Number(msg.stake ?? 0));
        const friendId = typeof msg.friendId === "string" ? msg.friendId : undefined;
        if (friendId && client.guest) return err("sign in with Serble first");
        const c = economy.create(client, stake, Boolean(msg.public) && !friendId, friendId);
        if (typeof c === "string") return err(c);
        client.send({ t: "challenge", challenge: economy.view(c, client.userId) });
        if (friendId) {
          const link = `${config.publicUrl}/c/${c.code}`;
          const stakeText = stake > 0 ? ` for **${stake} coins**` : "";
          chat
            .sendDm(client.userId, friendId, `⬡ I challenge you to a game of Hexstake${stakeText}! Join here: ${link}`)
            .then(() => {
              client.send({ t: "toast", text: "Challenge sent on Serble Chat" });
              track("friend_challenge_sent", client.userId, { stake });
            })
            .catch((e) => {
              client.send({ t: "toast", text: `Couldn't send the DM (${e instanceof ChatNeedsConnect ? "connect Serble Chat first" : String(e.message ?? e)}). Share the link instead.` });
            });
        }
        return;
      }
      case "challenge.join": {
        const c = economy.get(String(msg.code ?? ""));
        if (!c) return err("challenge not found");
        if (c.creator === client.userId) economy.creatorConnected(client.userId, true);
        return client.send({ t: "challenge", challenge: economy.view(c, client.userId) });
      }
      case "challenge.accept": {
        const r = await economy.accept(String(msg.code ?? ""), client);
        if (typeof r === "string") return err(r);
        return client.send({ t: "challenge", challenge: economy.view(r, client.userId) });
      }
      case "challenge.cancel": {
        const c = economy.get(String(msg.code ?? ""));
        if (c && c.creator === client.userId) economy.cancelChallenge(c.code, "cancelled by challenger");
        return;
      }
      case "challenge.check": {
        // user clicked "I've paid" — poll right away
        const ps = db.prepare("SELECT proposal_id FROM payments WHERE user_id = ? AND challenge_code = ? AND status = 'pending' AND kind = 'stake'").all(client.userId, String(msg.code ?? "")) as { proposal_id: string }[];
        for (const p of ps) await economy.checkProposal(p.proposal_id);
        const c = economy.get(String(msg.code ?? ""));
        if (c) client.send({ t: "challenge", challenge: economy.view(c, client.userId) });
        return;
      }
      default:
        return err("unknown message");
    }
  }

  ws.on("close", () => {
    clearInterval(hb);
    clearInterval(rate);
    set!.delete(client);
    if (set!.size === 0) {
      byUser.delete(client.userId);
      dequeue(client.userId);
      economy.creatorConnected(client.userId, false);
    }
    for (const m of watching) m.subscribers.delete(client);
    for (const m of mm.live.values()) m.subscribers.delete(client);
  });
}

// ------------------------------------------------------------------ lifecycle

mm.resumeAll();
economy.start();
const timers = [
  setInterval(matchmake, 1000),
  setInterval(() => economy.sweepLobbies(), 10_000),
  setInterval(() => auth.pruneSessions(), 3600_000),
  setInterval(() => db.prepare("DELETE FROM events WHERE ts < ?").run(now() - 180 * 86400_000), 86400_000),
];

server.listen(config.port, () => {
  log.info("hexstake listening", { port: config.port, version: config.version, signIn: signInReady(), economy: economyReady() });
});

function shutdown(sig: string) {
  log.info("shutting down", { sig });
  for (const t of timers) clearInterval(t);
  economy.stop();
  mm.shutdown();
  for (const c of wss.clients) c.close(1012, "server restarting");
  server.close();
  setTimeout(() => {
    db.close();
    process.exit(0);
  }, 500).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log.error("unhandled rejection", { err: String(e) }));
