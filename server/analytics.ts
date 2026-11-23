import { DB, now } from "./db";
import { log } from "./log";

let db: DB | null = null;
export function initAnalytics(d: DB) {
  db = d;
}

/** Record a usage event. Never throws. */
export function track(type: string, userId: string | null, data?: Record<string, unknown>) {
  if (!db) return;
  try {
    db.prepare("INSERT INTO events (ts, user_id, type, data) VALUES (?, ?, ?, ?)").run(
      now(), userId, type, data ? JSON.stringify(data) : null,
    );
  } catch (e) {
    log.warn("track failed", { type, err: String(e) });
  }
}

const DAY = 86400_000;

// Synthetic traffic (smoke tests, headless browsers) is tagged `guest:synth-…` and excluded from stats.
const REAL_EVENT = "(user_id IS NULL OR user_id NOT LIKE 'guest:synth-%')";
const REAL_MATCH = "(p0 NOT LIKE 'guest:synth-%' AND p1 NOT LIKE 'guest:synth-%')";

/** Public, aggregate-only stats. */
export function publicStats(d: DB) {
  const since = now() - DAY;
  const one = (sql: string, ...args: (string | number)[]) => (d.prepare(sql).get(...args) as { n: number }).n;
  return {
    players: one("SELECT COUNT(*) n FROM users"),
    matchesPlayed: one(`SELECT COUNT(*) n FROM matches WHERE status = 'finished' AND ${REAL_MATCH}`),
    matches24h: one(`SELECT COUNT(*) n FROM matches WHERE status = 'finished' AND ended_at > ? AND ${REAL_MATCH}`, since),
    activePlayers24h: one("SELECT COUNT(DISTINCT user_id) n FROM events WHERE ts > ? AND user_id NOT LIKE 'guest:%'", since),
    coinsStaked: one("SELECT COALESCE(SUM(stake * 2), 0) n FROM matches WHERE mode = 'staked' AND status = 'finished'"),
  };
}

/** Detailed analytics for the operator (admin-token protected). */
export function adminAnalytics(d: DB, days = 7) {
  const since = now() - days * DAY;
  const all = (sql: string, ...args: (string | number)[]) => d.prepare(sql).all(...args);
  const one = (sql: string, ...args: (string | number)[]) => (d.prepare(sql).get(...args) as { n: number }).n;
  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    totals: publicStats(d),
    eventsByType: all(`SELECT type, COUNT(*) n, COUNT(DISTINCT user_id) users FROM events WHERE ts > ? AND ${REAL_EVENT} GROUP BY type ORDER BY n DESC`, since),
    daily: all(`SELECT date(ts/1000, 'unixepoch') day, COUNT(*) events, COUNT(DISTINCT user_id) users,
                SUM(type = 'match_end') matches FROM events WHERE ts > ? AND ${REAL_EVENT} GROUP BY day ORDER BY day`, since),
    matchesByMode: all(`SELECT mode, COUNT(*) n, AVG(turns) avg_turns, SUM(end_reason = 'abandon') abandoned,
                        SUM(end_reason = 'forfeit') forfeits FROM matches WHERE created_at > ? AND ${REAL_MATCH} GROUP BY mode`, since),
    // Seats are randomized, so the bot can be p0 or p1.
    botResults: all(`SELECT CASE WHEN p0 LIKE 'bot:%' THEN p0 ELSE p1 END bot, COUNT(*) n,
                     SUM(winner = CASE WHEN p0 LIKE 'bot:%' THEN 1 ELSE 0 END) human_wins, SUM(winner IS NULL) draws
                     FROM matches WHERE mode = 'bot' AND status = 'finished' AND created_at > ? AND ${REAL_MATCH} GROUP BY bot`, since),
    payments: all("SELECT kind, status, COUNT(*) n, SUM(amount) amount FROM payments WHERE created_at > ? GROUP BY kind, status", since),
    errors: all("SELECT ts, data FROM events WHERE type = 'error' AND ts > ? ORDER BY ts DESC LIMIT 50", since),
    feedback: all("SELECT ts, user_id, data FROM events WHERE type = 'feedback' AND ts > ? ORDER BY ts DESC LIMIT 100", since),
    synthetic: one(`SELECT COUNT(*) n FROM matches WHERE created_at > ? AND NOT ${REAL_MATCH}`, since),
    clientErrors: all("SELECT ts, data FROM events WHERE type = 'client_error' AND ts > ? ORDER BY ts DESC LIMIT 50", since),
  };
}
