import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db";
import { MatchManager } from "../server/matches";
import { targetable } from "../shared/game";

function setup() {
  const db = openDb(":memory:");
  const mm = new MatchManager(db);
  const m = mm.create("casual", [{ id: "a", name: "A", elo: 1000 }, { id: "b", name: "B", elo: 1000 }], 0, { swap: false });
  return { mm, m };
}

test("draft orders are locked in when the turn times out", () => {
  const { m } = setup();
  const t = [...targetable(m.state, 0)].find((i) => m.state.cells[i].owner === null)!;
  assert.equal(m.setDraft(0, { [t]: 2 }), null);
  (m as any).resolve(); // simulate the deadline passing with nobody locked in
  assert.equal(m.history.length, 1);
  assert.deepEqual(m.history[0][0], { [t]: 2 });
  assert.equal(m.state.cells[t].owner, 0);
  assert.deepEqual(m.missed, [0, 1]); // A had a draft, B placed nothing
  m.stop();
});

test("invalid drafts are rejected and drafts reset each turn", () => {
  const { m } = setup();
  assert.match(m.setDraft(0, { [m.state.homes[1]]: 1 }) ?? "", /reachable/);
  const t = [...targetable(m.state, 0)][0];
  m.setDraft(0, { [t]: 1 });
  (m as any).resolve();
  assert.deepEqual(m.drafts, [null, null]);
  m.stop();
});

test("a locked-in submission wins over the draft", () => {
  const { m } = setup();
  const ts = [...targetable(m.state, 0)];
  m.setDraft(0, { [ts[0]]: 1 });
  assert.equal(m.submit(0, { [ts[1]]: 1 }), null);
  assert.equal(m.setDraft(0, { [ts[0]]: 3 }), null); // ignored after lock-in
  (m as any).resolve();
  assert.deepEqual(m.history[0][0], { [ts[1]]: 1 });
  m.stop();
});
