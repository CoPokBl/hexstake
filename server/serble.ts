// Thin client for the Serble API (https://github.com/Serble/SerbleAPI).
import { createHash } from "node:crypto";
import { config } from "./config";
import { log } from "./log";
import { secrets } from "./secrets";

export const RAW_PER_COIN = 16777216n; // 2^24 fixed point
export const coinsToRaw = (coins: number | bigint) => BigInt(coins) * RAW_PER_COIN;
export const rawToCoins = (raw: bigint) => Number(raw) / Number(RAW_PER_COIN);

export class SerbleError extends Error {
  constructor(public status: number, public body: string, public code?: string) {
    super(`Serble ${status}: ${body.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------- write-tier limiter
// The whole app shares 60 write requests / minute. Keep a margin.
const WRITE_LIMIT = 50;
const writeLog: number[] = [];
async function writeSlot(): Promise<void> {
  for (;;) {
    const t = Date.now();
    while (writeLog.length && writeLog[0] < t - 60_000) writeLog.shift();
    if (writeLog.length < WRITE_LIMIT) {
      writeLog.push(t);
      return;
    }
    await new Promise((r) => setTimeout(r, writeLog[0] + 60_000 - t + 50));
  }
}
export const writeBudgetRemaining = () => {
  const t = Date.now();
  return WRITE_LIMIT - writeLog.filter((x) => x > t - 60_000).length;
};

interface Req {
  method?: string;
  path: string;
  auth?: string; // full Authorization header value
  json?: unknown;
  form?: Record<string, string>;
  write?: boolean;
  headers?: Record<string, string>;
}

async function call(r: Req): Promise<{ status: number; text: string }> {
  if (r.write) await writeSlot();
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Hexstake/1.0", ...r.headers };
  let body: string | undefined;
  if (r.auth) headers.Authorization = r.auth;
  if (r.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(r.json, (_k, v) => (typeof v === "bigint" ? `__BIG__${v}` : v)).replace(/"__BIG__(\d+)"/g, "$1");
  } else if (r.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(r.form).toString();
  }
  const method = r.method ?? (body !== undefined ? "POST" : "GET");
  // Serble rejects body-less POSTs without a Content-Length; send an explicit empty body.
  if (method === "POST" && body === undefined) body = "";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(config.serbleApi + r.path, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < 2) {
      const wait = Number(res.headers.get("retry-after") ?? "5");
      log.warn("serble rate limited", { path: r.path, wait });
      await new Promise((x) => setTimeout(x, Math.min(wait, 30) * 1000));
      continue;
    }
    return { status: res.status, text };
  }
}

function parse<T>(text: string): T {
  let v: unknown = JSON.parse(text, (_k, val) => val);
  if (typeof v === "string") v = JSON.parse(v); // some endpoints double-encode
  return v as T;
}

async function ok<T>(r: Req): Promise<T> {
  const { status, text } = await call(r);
  if (status < 200 || status >= 300) {
    let code: string | undefined;
    try {
      code = (JSON.parse(text) as { error?: string }).error;
    } catch {
      /* text body */
    }
    throw new SerbleError(status, text, code);
  }
  return (text ? parse<T>(text) : (undefined as T));
}

const basicClient = () =>
  "Basic " + Buffer.from(`${config.clientId}:${secrets().clientSecret}`).toString("base64");
const appKey = () => `Bearer ${secrets().appKey}`;

// ---------------------------------------------------------------- OIDC sign-in

export function pkcePair(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function authorizeUrl(state: string, verifier: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile offline_access",
    state,
    nonce: state,
    code_challenge: pkcePair(verifier),
    code_challenge_method: "S256",
  });
  return `${config.serbleApi}/api/v1/oauth/authorize?${q}`;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
}

export function exchangeCode(code: string, verifier: string, redirectUri: string) {
  return ok<TokenSet>({
    path: "/api/v1/oauth/token",
    auth: basicClient(),
    form: { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier },
  });
}

export function refreshTokens(refreshToken: string) {
  return ok<TokenSet>({
    path: "/api/v1/oauth/token",
    auth: basicClient(),
    form: { grant_type: "refresh_token", refresh_token: refreshToken },
  });
}

export function userInfo(accessToken: string) {
  return ok<{ sub: string; preferred_username?: string; name?: string }>({
    path: "/api/v1/oauth/userinfo",
    auth: `Bearer ${accessToken}`,
  });
}

/** Cross-app: obtain a single-use code that the target app's backend can redeem. */
export async function crossAppCode(subjectToken: string, audience: string):
  Promise<{ code: string } | { consentUrl: string } | { error: string }> {
  const { status, text } = await call({
    path: "/api/v1/oauth/token",
    auth: basicClient(),
    form: {
      grant_type: "urn:serble:params:oauth:grant-type:cross-app-code",
      subject_token: subjectToken,
      audience,
    },
  });
  let body: { code?: string; error?: string; consent_url?: string; error_description?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* ignore */
  }
  if (status === 200 && body.code) return { code: body.code };
  if (body.error === "consent_required" && body.consent_url) return { consentUrl: body.consent_url };
  return { error: body.error ?? `http_${status}` };
}

// ---------------------------------------------------------------- economy (app key)

export interface Proposal {
  proposalId: string;
  status: "Pending" | "InProgress" | "Approved" | "Denied" | "Expired" | "Cancelled" | "Failed";
  userId: string;
  amount: number;
  transactionId?: string | null;
  failureReason?: string | null;
  expiresAt: string;
}

export function createProposal(userId: string, amountRaw: bigint, description: string, redirectUri: string) {
  return ok<{ proposal: Proposal; consentUrl: string }>({
    path: "/api/v1/transactions/proposals",
    auth: appKey(),
    write: true,
    json: { user: userId, amount: amountRaw, description: description.slice(0, 256), redirectUri },
  });
}

export function getProposal(id: string) {
  return ok<Proposal>({ path: `/api/v1/transactions/proposals/${encodeURIComponent(id)}`, auth: appKey(), write: true });
}

export function cancelProposal(id: string) {
  return ok<Proposal>({
    method: "POST",
    path: `/api/v1/transactions/proposals/${encodeURIComponent(id)}/cancel`,
    auth: appKey(),
    write: true,
  });
}

export function transfer(recipient: string, amountRaw: bigint, description: string) {
  return ok<{ transaction: { id: string } }>({
    path: "/api/v1/balance/transfer",
    auth: appKey(),
    write: true,
    json: { recipient, amount: amountRaw, description: description.slice(0, 256) },
  });
}

export async function appBalanceRaw(): Promise<bigint> {
  const { status, text } = await call({ path: "/api/v1/balance", auth: appKey() });
  if (status !== 200) throw new SerbleError(status, text);
  const m = /"coins"\s*:\s*(\d+)/.exec(text);
  return m ? BigInt(m[1]) : 0n;
}

export async function recentAppTransactions(limit = 100) {
  const { status, text } = await call({ path: `/api/v1/balance/transactions?limit=${limit}`, auth: appKey() });
  if (status !== 200) throw new SerbleError(status, text);
  // keep amounts exact: quote big numbers before parsing
  return JSON.parse(text.replace(/"amount"\s*:\s*(\d+)/g, '"amount":"$1"')) as {
    id: string; amount: string; description: string; dateCreated: string; toBalanceId: string; fromBalanceId: string;
  }[];
}

// ---------------------------------------------------------------- owner / admin

/** Verify a Serble *user* token and return the user's id. */
export async function userTokenOwner(token: string): Promise<string | null> {
  const { status, text } = await call({ path: "/api/v1/account", auth: `Bearer ${token}` });
  if (status !== 200) return null;
  return (JSON.parse(text) as { id?: string }).id ?? null;
}

/** Log in with username + password (step-based flow). Returns a user token or null. */
export async function passwordLogin(username: string, password: string): Promise<string | null> {
  const start = await call({ path: "/api/v1/auth/login/start", json: { username } });
  if (start.status !== 200) return null;
  const { loginSession } = JSON.parse(start.text) as { loginSession: string };
  const fin = await call({ path: "/api/v1/auth/login/password", json: { loginSession, password } });
  if (fin.status !== 200) return null;
  const body = JSON.parse(fin.text) as { complete?: boolean; token?: string };
  return body.complete && body.token ? body.token : null;
}

/** Owner-only: read the app (includes ClientSecret). */
export async function ownerGetApp(userToken: string): Promise<{ OwnerId: string; ClientSecret: string; Id: string }> {
  return ok({ path: `/api/v1/app/${config.clientId}`, auth: `Bearer ${userToken}` });
}

export async function ownerCreateKey(userToken: string, name: string): Promise<string> {
  const r = await ok<{ key: string }>({
    path: `/api/v1/app/${config.clientId}/keys`,
    auth: `Bearer ${userToken}`,
    write: true,
    json: { name },
  });
  return r.key;
}

export async function publicUser(idOrName: string): Promise<{ id: string; username: string } | null> {
  const { status, text } = await call({ path: `/api/v1/user/${encodeURIComponent(idOrName)}/public` });
  return status === 200 ? JSON.parse(text) : null;
}

export async function publicUsers(ids: string[]): Promise<{ id: string; username: string }[]> {
  if (!ids.length) return [];
  return ok({ path: "/api/v1/user/public/batch", json: { ids: ids.slice(0, 200) } });
}
