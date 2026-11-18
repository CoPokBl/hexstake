import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config";

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,            -- serble user id
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    elo INTEGER NOT NULL DEFAULT 1000,
    games INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    coins_won INTEGER NOT NULL DEFAULT 0,
    coins_lost INTEGER NOT NULL DEFAULT 0,
    tokens TEXT                     -- encrypted json {access, refresh, expires}
  );
  CREATE INDEX users_elo ON users(elo DESC);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,          -- serble id or guest:xxxx
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE matches (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,             -- bot | ranked | casual | staked
    p0 TEXT NOT NULL,
    p1 TEXT NOT NULL,
    p0_name TEXT NOT NULL,
    p1_name TEXT NOT NULL,
    seed INTEGER NOT NULL,
    stake INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,           -- active | finished | cancelled
    winner INTEGER,                 -- 0 | 1 | null (draw)
    end_reason TEXT,
    turns INTEGER NOT NULL DEFAULT 0,
    elo_change INTEGER,
    history TEXT,                   -- json [[ordersA, ordersB], ...]
    snapshot TEXT,                  -- json live state for resuming after restart
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX matches_p0 ON matches(p0, created_at DESC);
  CREATE INDEX matches_p1 ON matches(p1, created_at DESC);
  CREATE INDEX matches_status ON matches(status);

  CREATE TABLE challenges (
    code TEXT PRIMARY KEY,
    creator TEXT NOT NULL,
    creator_name TEXT NOT NULL,
    stake INTEGER NOT NULL DEFAULT 0,
    public INTEGER NOT NULL DEFAULT 0,
    target_user TEXT,               -- optional invited user id
    status TEXT NOT NULL,           -- open | funding | started | cancelled | expired
    acceptor TEXT,
    acceptor_name TEXT,
    match_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX challenges_status ON challenges(status, public);

  CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    challenge_code TEXT,
    match_id TEXT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,             -- stake | payout | refund
    amount INTEGER NOT NULL,
    proposal_id TEXT,
    consent_url TEXT,
    status TEXT NOT NULL,           -- pending | paid | failed | expired | claimable | claimed
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX payments_user ON payments(user_id, created_at DESC);
  CREATE INDEX payments_status ON payments(status);
  CREATE INDEX payments_challenge ON payments(challenge_code);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user_id TEXT,
    type TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX events_ts ON events(ts);
  CREATE INDEX events_type ON events(type, ts);

  CREATE TABLE kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
  `,
];

export function openDb(path = join(config.dataDir, "hexstake.db")): DB {
  if (path !== ":memory:") mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
  const row = db.prepare("SELECT v FROM schema_version").get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (v) VALUES (0)").run();
  while (v < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      v++;
      db.prepare("UPDATE schema_version SET v = ?").run(v);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const now = () => Date.now();
