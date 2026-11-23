import { createHash } from "node:crypto";
import { IncomingMessage } from "node:http";
import { config } from "./config";
import { decrypt, encrypt, randomId, safeEqual } from "./crypto";
import { DB, now } from "./db";
import { log } from "./log";
import * as serble from "./serble";

export interface Session {
  id: string;
  userId: string;
  username: string;
  guest: boolean;
}

const SESSION_DAYS = 60;
const COOKIE = "hx_session";

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(name: string, value: string, maxAgeSec: number): string {
  const secure = config.publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export class Auth {
  constructor(private db: DB) {}

  sessionFrom(req: IncomingMessage): Session | null {
    const id = parseCookies(req)[COOKIE];
    if (!id) return null;
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?").get(id, now()) as
      | { id: string; user_id: string; username: string }
      | undefined;
    if (!row) return null;
    return { id: row.id, userId: row.user_id, username: row.username, guest: row.user_id.startsWith("guest:") };
  }

  createSession(userId: string, username: string): { session: Session; cookie: string } {
    const id = randomId(24);
    this.db
      .prepare("INSERT INTO sessions (id, user_id, username, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, userId, username, now(), now() + SESSION_DAYS * 86400_000);
    return {
      session: { id, userId, username, guest: userId.startsWith("guest:") },
      cookie: cookieHeader(COOKIE, id, SESSION_DAYS * 86400),
    };
  }

  /** Synthetic guests (smoke tests, headless browsers) get a `guest:synth-` id so analytics can skip them. */
  guestSession(synthetic = false): { session: Session; cookie: string } {
    const n = Math.floor(1000 + Math.random() * 9000);
    return this.createSession(`guest:${synthetic ? "synth-" : ""}${randomId(8)}`, `Guest${n}`);
  }

  destroy(req: IncomingMessage): string {
    const id = parseCookies(req)[COOKIE];
    if (id) this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return cookieHeader(COOKIE, "", 0);
  }

  // ---------------------------------------------------------- Serble OIDC

  private pendingLogins = new Map<string, { verifier: string; returnTo: string; created: number }>();

  beginLogin(returnTo: string): string {
    const state = randomId(18);
    const verifier = randomId(32);
    for (const [k, v] of this.pendingLogins) if (now() - v.created > 15 * 60_000) this.pendingLogins.delete(k);
    this.pendingLogins.set(state, { verifier, returnTo: safeReturn(returnTo), created: now() });
    return serble.authorizeUrl(state, verifier, `${config.publicUrl}/auth/callback`);
  }

  async completeLogin(code: string, state: string, previousGuest: Session | null):
    Promise<{ session: Session; cookie: string; returnTo: string }> {
    const p = this.pendingLogins.get(state);
    if (!p) throw new Error("login expired, please try again");
    this.pendingLogins.delete(state);
    const tokens = await serble.exchangeCode(code, p.verifier, `${config.publicUrl}/auth/callback`);
    const info = await serble.userInfo(tokens.access_token);
    const userId = info.sub;
    const username = info.preferred_username ?? info.name ?? "player";
    const t = now();
    this.db
      .prepare(`INSERT INTO users (id, username, created_at, last_seen) VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET username = excluded.username, last_seen = excluded.last_seen`)
      .run(userId, username, t, t);
    this.storeTokens(userId, tokens);
    if (previousGuest?.guest) this.db.prepare("DELETE FROM sessions WHERE id = ?").run(previousGuest.id);
    const s = this.createSession(userId, username);
    return { ...s, returnTo: p.returnTo };
  }

  private storeTokens(userId: string, t: serble.TokenSet) {
    const blob = encrypt(JSON.stringify({ access: t.access_token, refresh: t.refresh_token ?? null, expires: now() + (t.expires_in - 60) * 1000 }));
    this.db.prepare("UPDATE users SET tokens = ? WHERE id = ?").run(blob, userId);
  }

  private refreshing = new Map<string, Promise<string | null>>();

  /** A currently valid Serble access token for the user (refreshing if needed), or null. */
  async accessToken(userId: string): Promise<string | null> {
    const row = this.db.prepare("SELECT tokens FROM users WHERE id = ?").get(userId) as { tokens: string | null } | undefined;
    if (!row?.tokens) return null;
    const raw = decrypt(row.tokens);
    if (!raw) return null;
    const tok = JSON.parse(raw) as { access: string; refresh: string | null; expires: number };
    if (tok.expires > now()) return tok.access;
    if (!tok.refresh) return null;
    // Refresh tokens rotate: serialize per user.
    const inflight = this.refreshing.get(userId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const t = await serble.refreshTokens(tok.refresh!);
        this.storeTokens(userId, t);
        return t.access_token;
      } catch (e) {
        log.warn("token refresh failed", { userId, err: String(e) });
        if (e instanceof serble.SerbleError && e.code === "invalid_grant") {
          this.db.prepare("UPDATE users SET tokens = NULL WHERE id = ?").run(userId);
        }
        return null;
      } finally {
        this.refreshing.delete(userId);
      }
    })();
    this.refreshing.set(userId, p);
    return p;
  }

  // ---------------------------------------------------------- operator auth

  private ownerCache = new Map<string, number>();

  /**
   * Operator authentication for /api/admin/*. Accepts either
   *   Authorization: Bearer <Serble user token of the app owner>, or
   *   Authorization: Basic <owner username:password>
   * Both are verified against Serble and cached briefly by hash.
   */
  async isOwner(req: IncomingMessage): Promise<boolean> {
    const h = req.headers.authorization ?? "";
    if (!h) return false;
    const hash = createHash("sha256").update(h).digest("hex");
    const cached = this.ownerCache.get(hash);
    if (cached && cached > now()) return true;
    let token: string | null = null;
    if (h.startsWith("Bearer ")) token = h.slice(7);
    else if (h.startsWith("Basic ")) {
      const dec = Buffer.from(h.slice(6), "base64").toString("utf8");
      const i = dec.indexOf(":");
      if (i > 0) token = await serble.passwordLogin(dec.slice(0, i), dec.slice(i + 1));
    }
    if (!token) return false;
    const id = await serble.userTokenOwner(token);
    const ok = id !== null && safeEqual(id, config.ownerUserId);
    if (ok) this.ownerCache.set(hash, now() + 30 * 60_000);
    return ok;
  }

  /** Extract a Serble user token for owner-only operations (bootstrap). */
  async ownerToken(req: IncomingMessage): Promise<string | null> {
    const h = req.headers.authorization ?? "";
    if (h.startsWith("Bearer ")) {
      const t = h.slice(7);
      return (await serble.userTokenOwner(t)) === config.ownerUserId ? t : null;
    }
    if (h.startsWith("Basic ")) {
      const dec = Buffer.from(h.slice(6), "base64").toString("utf8");
      const i = dec.indexOf(":");
      if (i <= 0) return null;
      const t = await serble.passwordLogin(dec.slice(0, i), dec.slice(i + 1));
      return t && (await serble.userTokenOwner(t)) === config.ownerUserId ? t : null;
    }
    return null;
  }

  pruneSessions() {
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
  }
}

function safeReturn(p: string): string {
  return p.startsWith("/") && !p.startsWith("//") ? p : "/";
}
