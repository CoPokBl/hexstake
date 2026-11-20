import { test } from "node:test";
import assert from "node:assert/strict";
import { board, mirror, newGame, resolveTurn, validateOrders, targetable, connected, GameState, Player } from "../shared/game";
import { botOrders } from "../shared/bot";
import { rusher } from "./strategies";

test("board radius 4 has 61 cells and symmetric terrain", () => {
  const b = board(4);
  assert.equal(b.coords.length, 61);
  for (let seed = 1; seed < 50; seed++) {
    const s = newGame(seed);
    s.cells.forEach((c, i) => {
      const m = s.cells[mirror(b, i)];
      assert.equal(c.kind, m.kind);
    });
    assert.equal(s.cells[s.homes[0]].owner, 0);
    assert.equal(s.cells[s.homes[1]].owner, 1);
  }
});

test("order validation", () => {
  const s = newGame(42);
  const t = [...targetable(s, 0)];
  assert.ok(t.length >= 3);
  assert.equal(validateOrders(s, 0, { [t[0]]: 1 }), null);
  assert.match(validateOrders(s, 0, { [s.homes[1]]: 1 }) ?? "", /reachable/);
  assert.match(validateOrders(s, 0, { [t[0]]: 999 }) ?? "", /energy/);
  assert.match(validateOrders(s, 0, { [t[0]]: -1 }) ?? "", /bad amount/);
  assert.match(validateOrders(s, 0, [1, 2]) ?? "", /object/);
});

test("contest resolution: bids cancel, remainder fights garrison", () => {
  let s = newGame(7);
  const b = board(4);
  const n = b.neighbors[s.homes[0]].find((i) => s.cells[i].kind === "plain")!;
  ({ state: s } = resolveTurn(s, { [n]: 3 }, {}));
  assert.equal(s.cells[n].owner, 0);
  assert.equal(s.cells[n].strength, 3);
  // fortify
  ({ state: s } = resolveTurn(s, { [n]: 2 }, {}));
  assert.equal(s.cells[n].strength, 5);
});

test("cut-off territory decays", () => {
  let s = newGame(7);
  const b = board(4);
  const n = b.neighbors[s.homes[0]].find((i) => s.cells[i].kind === "plain")!;
  ({ state: s } = resolveTurn(s, { [n]: 2 }, {}));
  // manually sever: give an isolated cell to player 0
  const far = s.cells.findIndex((c, i) => c.kind === "plain" && c.owner === null && !b.neighbors[i].some((x) => s.cells[x].owner !== null));
  s.cells[far] = { kind: "plain", owner: 0, strength: 2 };
  assert.ok(!connected(s, 0).has(far));
  ({ state: s } = resolveTurn(s, {}, {}));
  assert.equal(s.cells[far].strength, 1);
  ({ state: s } = resolveTurn(s, {}, {}));
  assert.equal(s.cells[far].owner, null);
});

test("home capture wins", () => {
  const s = newGame(3);
  s.cells[s.homes[1]].strength = 1;
  // pretend player 0 is adjacent
  const b = board(4);
  const adj = b.neighbors[s.homes[1]][0];
  s.cells[adj] = { kind: "plain", owner: 0, strength: 1 };
  s.energy[0] = 5;
  const { state } = resolveTurn(s, { [s.homes[1]]: 3 }, {});
  assert.equal(state.over, true);
  assert.equal(state.winner, 0);
  assert.equal(state.endReason, "home");
});

test("bots always produce legal orders and games terminate", () => {
  for (let seed = 1; seed <= 40; seed++) {
    let s: GameState = newGame(seed);
    let guard = 0;
    while (!s.over && guard++ < 100) {
      const o: [any, any] = [0, 1].map((p) => botOrders(s, p as Player, p ? "hard" : "normal", seed)) as any;
      for (const p of [0, 1] as Player[]) assert.equal(validateOrders(s, p, o[p]), null, `seed ${seed} turn ${s.turn}`);
      s = resolveTurn(s, o[0], o[1]).state;
    }
    assert.ok(s.over);
  }
});

test("hard bot beats easy bot more often than not", () => {
  let hardWins = 0;
  for (let seed = 1; seed <= 60; seed++) {
    let s = newGame(seed);
    const hardSide: Player = (seed % 2) as Player;
    while (!s.over) {
      const o0 = botOrders(s, 0, hardSide === 0 ? "hard" : "easy", seed);
      const o1 = botOrders(s, 1, hardSide === 1 ? "hard" : "easy", seed);
      s = resolveTurn(s, o0, o1).state;
    }
    if (s.winner === hardSide) hardWins++;
  }
  assert.ok(hardWins > 33, `hard won ${hardWins}/60`);
});

test("hard bot holds up against an all-in well rusher", () => {
  let wins = 0;
  const n = 80;
  for (let seed = 1; seed <= n; seed++) {
    let s = newGame(seed * 7 + 3);
    const side: Player = (seed % 2) as Player;
    while (!s.over) {
      const o0 = side === 0 ? botOrders(s, 0, "hard", seed) : rusher(s, 0);
      const o1 = side === 1 ? botOrders(s, 1, "hard", seed) : rusher(s, 1);
      s = resolveTurn(s, o0, o1).state;
    }
    if (s.winner === side) wins++;
  }
  assert.ok(wins / n >= 0.6, `hard won ${wins}/${n} against the rusher`);
});
