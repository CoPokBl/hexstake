// Serble Chat integration via Serble cross-app sign-in: lets a signed-in player see their
// Serble Chat friends and send them a challenge link as a DM.
import { Auth } from "./auth";
import { config } from "./config";
import { decrypt, encrypt, randomId } from "./crypto";
import { DB, now } from "./db";
import { log } from "./log";
import * as serble from "./serble";

export type ChatConnect =
  | { ok: true }
  | { ok: false; consentUrl: string }
  | { ok: false; error: string };

interface Friend {
  id: string;
  username: string;
  status?: string;
}

export class Chat {
  private pendingConsent = new Map<string, { userId: string; created: number }>();
  private friendCache = new Map<string, { at: number; friends: Friend[] }>();

  constructor(private db: DB, private auth: Auth) {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_tokens (user_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
  }

  private stored(userId: string): string | null {
    const row = this.db.prepare("SELECT token, expires_at FROM chat_tokens WHERE user_id = ?").get(userId) as
      | { token: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at < now()) return null;
    return decrypt(row.token);
  }

  connected(userId: string): boolean {
    return this.stored(userId) !== null;
  }

  /** Try to obtain a chat session for the user. Returns a consent URL if Serble needs the user's OK. */
  async connect(userId: string): Promise<ChatConnect> {
    const access = await this.auth.accessToken(userId);
    if (!access) return { ok: false, error: "please sign in again" };
    const r = await serble.crossAppCode(access, config.chatClientId);
    if ("consentUrl" in r) {
      const state = randomId(16);
      this.pendingConsent.set(state, { userId, created: now() });
      const u = new URL(r.consentUrl);
      u.searchParams.set("redirect_uri", `${config.publicUrl}/auth/chat/callback`);
      u.searchParams.set("state", state);
      return { ok: false, consentUrl: u.toString() };
    }
    if ("error" in r) {
      log.warn("cross-app code failed", { userId, error: r.error });
      return { ok: false, error: r.error === "unauthorized_client" ? "Serble Chat doesn't allow Hexstake yet" : r.error };
    }
    const res = await fetch(`${config.chatApi}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: r.code }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      log.warn("chat auth failed", { status: res.status, text: text.slice(0, 200) });
      return { ok: false, error: "Serble Chat sign-in failed" };
    }
    const { accessToken } = (await res.json()) as { accessToken: string };
    let exp = now() + 12 * 3600_000;
    try {
      const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")) as { exp?: number };
      if (payload.exp) exp = payload.exp * 1000 - 60_000;
    } catch {
      /* opaque token */
    }
    this.db
      .prepare("INSERT INTO chat_tokens (user_id, token, expires_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at")
      .run(userId, encrypt(accessToken), exp);
    return { ok: true };
  }

  /** Handle the redirect back from the Serble cross-app consent page. */
  async consentReturn(state: string, error: string | null): Promise<{ userId: string; result: ChatConnect } | null> {
    const p = this.pendingConsent.get(state);
    if (!p) return null;
    this.pendingConsent.delete(state);
    if (error) return { userId: p.userId, result: { ok: false, error: "consent was declined" } };
    return { userId: p.userId, result: await this.connect(p.userId) };
  }

  private async call(userId: string, path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    let token = this.stored(userId);
    if (!token) {
      const c = await this.connect(userId);
      if (!c.ok) throw new ChatNeedsConnect(c);
      token = this.stored(userId);
    }
    const res = await fetch(`${config.chatApi}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 && retry) {
      this.db.prepare("DELETE FROM chat_tokens WHERE user_id = ?").run(userId);
      return this.call(userId, path, init, false);
    }
    return res;
  }

  async friends(userId: string): Promise<Friend[]> {
    const c = this.friendCache.get(userId);
    if (c && now() - c.at < 60_000) return c.friends;
    const res = await this.call(userId, "/friends");
    if (!res.ok) throw new Error(`friends ${res.status}`);
    const rows = (await res.json()) as { user1Id: string; user2Id: string; pending: boolean }[];
    const ids = rows.filter((r) => !r.pending).map((r) => (r.user1Id === userId ? r.user2Id : r.user1Id));
    let friends: Friend[] = [];
    if (ids.length) {
      const r2 = await this.call(userId, "/account/batch", { method: "POST", body: JSON.stringify({ ids: ids.slice(0, 500) }) });
      if (r2.ok) friends = ((await r2.json()) as Friend[]).map((f) => ({ id: f.id, username: f.username, status: f.status }));
    }
    this.friendCache.set(userId, { at: now(), friends });
    return friends;
  }

  async sendDm(userId: string, friendId: string, content: string): Promise<void> {
    const ch = await this.call(userId, `/channel/dm/${encodeURIComponent(friendId)}`);
    if (!ch.ok) throw new Error(`dm channel ${ch.status}: ${(await ch.text()).slice(0, 100)}`);
    const { id } = (await ch.json()) as { id: string };
    const res = await this.call(userId, `/channel/${id}`, { method: "POST", body: JSON.stringify({ content: content.slice(0, 4000) }) });
    if (!res.ok) throw new Error(res.status === 403 ? "you can't message this user" : `send ${res.status}`);
  }

  disconnect(userId: string) {
    this.db.prepare("DELETE FROM chat_tokens WHERE user_id = ?").run(userId);
    this.friendCache.delete(userId);
  }
}

export class ChatNeedsConnect extends Error {
  constructor(public result: ChatConnect) {
    super("chat not connected");
  }
}
