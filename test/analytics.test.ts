import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db";
import { adminAnalytics, publicStats } from "../server/analytics";

test("synthetic guests are excluded from stats", () => {
  const db = openDb(":memory:");
  const t = Date.now();
  const ins = db.prepare(`INSERT INTO matches (id, mode, p0, p1, p0_name, p1_name, seed, status, winner, turns, created_at, ended_at)
                          VALUES (?, 'bot', ?, 'bot:easy', 'x', 'Bot', 1, 'finished', 1, 3, ?, ?)`);
  ins.run("real", "guest:abc", t, t);
  ins.run("smoke", "guest:synth-xyz", t, t);
  db.prepare("INSERT INTO events (ts, user_id, type) VALUES (?, ?, 'ui_page')").run(t, "guest:abc");
  db.prepare("INSERT INTO events (ts, user_id, type) VALUES (?, ?, 'ui_page')").run(t, "guest:synth-xyz");
  assert.equal(publicStats(db).matchesPlayed, 1);
  const a = adminAnalytics(db, 1);
  assert.equal((a.eventsByType as any[]).find((e) => e.type === "ui_page").n, 1);
  assert.equal((a.botResults as any[])[0].n, 1);
  assert.equal(a.synthetic, 1);
});
