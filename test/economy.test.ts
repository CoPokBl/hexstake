import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db";
import { Economy, SerbleApi } from "../server/economy";
import { Client, LiveMatch, MatchManager, Seat } from "../server/matches";
import { RAW_PER_COIN } from "../server/serble";

function fakeApi() {
  const proposals = new Map<string, { userId: string; amount: bigint; status: string }>();
  const transfers: { to: string; amount: bigint; desc: string }[] = [];
  let n = 0;
  const api: SerbleApi = {
    async createProposal(userId, amount) {
      const id = `p${++n}`;
      proposals.set(id, { userId, amount, status: "Pending" });
      return { proposal: { proposalId: id, status: "Pending", userId, amount: Number(amount), expiresAt: "" }, consentUrl: `https://serble.test/consent?proposal=${id}` };
    },
    async getProposal(id) {
      const p = proposals.get(id)!;
      return { proposalId: id, status: p.status as any, userId: p.userId, amount: Number(p.amount), expiresAt: "" };
    },
    async cancelProposal(id) {
      const p = proposals.get(id)!;
      if (p.status !== "Pending") throw new Error("not pending");
      p.status = "Cancelled";
      return { proposalId: id, status: "Cancelled", userId: p.userId, amount: Number(p.amount), expiresAt: "" };
    },
    async transfer(to, amount, desc) {
      transfers.push({ to, amount, desc });
      return { transaction: { id: `t${transfers.length}` } };
    },
    async recentAppTransactions() {
      return transfers.map((t, i) => ({ id: `t${i}`, amount: String(t.amount), description: t.desc, dateCreated: "", toBalanceId: "", fromBalanceId: "" }));
    },
    writeBudgetRemaining: () => 50,
  };
  const setAll = (status: string, user?: string) => {
    for (const p of proposals.values()) if (p.status === "Pending" && (!user || p.userId === user)) p.status = status;
  };
  return { api, proposals, transfers, setAll };
}

function client(id: string): Client & { inbox: any[] } {
  const inbox: any[] = [];
  return { connId: id, userId: id, name: id.toUpperCase(), guest: false, send: (m) => inbox.push(m), inbox };
}

function setup() {
  const db = openDb(":memory:");
  for (const u of ["alice", "bob", "carol"]) db.prepare("INSERT INTO users (id, username, created_at, last_seen) VALUES (?, ?, 0, 0)").run(u, u);
  const mm = new MatchManager(db);
  const f = fakeApi();
  const started: LiveMatch[] = [];
  const seatFor = (id: string, name: string): Seat => ({ id, name, elo: 1000 });
  const eco = new Economy(db, mm, () => {}, (m) => started.push(m), seatFor, f.api, () => true);
  mm.hooks.onFinish = (m) => eco.settle(m);
  const poll = async () => {
    // bypass the per-payment poll interval
    (eco as any).lastPolled.clear();
    await (eco as any).pollStakes();
  };
  const cleanup = () => {
    for (const m of mm.live.values()) m.stop();
  };
  return { db, mm, eco, f, started, poll, cleanup };
}

const coins = (n: number) => BigInt(n) * RAW_PER_COIN;

test("staked challenge: both pay, winner receives pot minus rake", async () => {
  const { db, eco, f, started, poll, cleanup } = setup();
  const a = client("alice");
  const b = client("bob");
  const c = eco.create(a, 10, true);
  assert.equal(typeof c, "object");
  const code = (c as any).code;
  const r = await eco.accept(code, b);
  assert.equal(typeof r, "object", typeof r === "string" ? r : "");
  assert.equal(f.proposals.size, 2);
  f.setAll("Approved", "alice");
  await poll();
  assert.equal(eco.get(code)!.status, "funding");
  f.setAll("Approved", "bob");
  await poll();
  assert.equal(eco.get(code)!.status, "started");
  assert.equal(started.length, 1);
  const m = started[0];
  assert.equal(m.mode, "staked");
  const alicePlayer = m.seatOf("alice")!;
  m.resign(alicePlayer === 0 ? 1 : 0); // bob resigns -> alice wins
  await new Promise((x) => setTimeout(x, 20));
  await eco.processPayouts();
  assert.equal(f.transfers.length, 1);
  assert.equal(f.transfers[0].to, "alice");
  assert.equal(f.transfers[0].amount, coins(19)); // 20 pot, 5% rake = 1
  const row = db.prepare("SELECT status FROM payments WHERE kind = 'payout'").get() as { status: string };
  assert.equal(row.status, "paid");
  // settling twice must not pay twice
  eco.settle(m);
  await eco.processPayouts();
  assert.equal(f.transfers.length, 1);
  cleanup();
});

test("draw refunds both stakes in full", async () => {
  const { eco, f, started, poll, cleanup } = setup();
  const code = (eco.create(client("alice"), 7, false) as any).code;
  await eco.accept(code, client("bob"));
  f.setAll("Approved");
  await poll();
  const m = started[0];
  m.state = { ...m.state, over: true, winner: null, endReason: "turns" };
  eco.settle(m);
  await eco.processPayouts();
  assert.deepEqual(f.transfers.map((t) => [t.to, t.amount]).sort(), [["alice", coins(7)], ["bob", coins(7)]]);
  cleanup();
});

test("acceptor declines: lobby reopens, creator cancel refunds creator", async () => {
  const { eco, f, poll, cleanup } = setup();
  const code = (eco.create(client("alice"), 5, true) as any).code;
  await eco.accept(code, client("bob"));
  f.setAll("Approved", "alice");
  f.setAll("Denied", "bob");
  await poll();
  await poll();
  const c = eco.get(code)!;
  assert.equal(c.status, "open");
  assert.equal(c.acceptor, null);
  // a new acceptor only needs to pay their own stake
  await eco.accept(code, client("carol"));
  const pendingForCarol = [...f.proposals.values()].filter((p) => p.userId === "carol" && p.status === "Pending");
  assert.equal(pendingForCarol.length, 1);
  assert.equal([...f.proposals.values()].filter((p) => p.userId === "alice").length, 1);
  eco.cancelChallenge(code, "test");
  await eco.processPayouts();
  assert.deepEqual(f.transfers.map((t) => [t.to, t.amount]), [["alice", coins(5)]]);
  assert.equal([...f.proposals.values()].find((p) => p.userId === "carol")!.status, "Cancelled");
  cleanup();
});

test("payout retry is idempotent after a crash mid-transfer", async () => {
  const { db, eco, f, cleanup } = setup();
  // simulate: payout row whose transfer went through but wasn't recorded
  db.prepare(`INSERT INTO payments (id, user_id, kind, amount, status, created_at, updated_at) VALUES ('px1', 'alice', 'payout', 3, 'pending', 1, 2)`).run();
  await f.api.transfer("alice", coins(3), "Hexstake winnings #px1");
  await eco.processPayouts();
  assert.equal(f.transfers.length, 1);
  assert.equal((db.prepare("SELECT status FROM payments WHERE id = 'px1'").get() as any).status, "paid");
  cleanup();
});

test("guests and invalid stakes are rejected", () => {
  const { eco, cleanup } = setup();
  const g = { ...client("guest:x"), guest: true };
  assert.match(String(eco.create(g, 5, true)), /sign in/);
  assert.match(String(eco.create(client("alice"), -1, true)), /whole number/);
  assert.match(String(eco.create(client("alice"), 1.5, true)), /whole number/);
  assert.equal(typeof eco.create(g, 0, true), "object");
  cleanup();
});

test("payoutFor rounds the rake down", () => {
  const { eco, cleanup } = setup();
  assert.equal(eco.payoutFor(1), 2);
  assert.equal(eco.payoutFor(10), 19);
  assert.equal(eco.payoutFor(100), 190);
  cleanup();
});
