// Scripted opponents used to keep the bots honest in tests.
import { board, distance, GameState, Orders, Player, targetable } from "../shared/game";

/** Human-like greedy play: grab wells, then go all-in on the enemy home once adjacent. */
export function rusher(s: GameState, p: Player): Orders {
  const b = board(s.config.radius);
  const e: Player = p === 0 ? 1 : 0;
  const reach = targetable(s, p);
  const enemyHome = s.homes[e];
  let budget = s.energy[p];
  const o: Orders = {};
  if (reach.has(enemyHome) && budget > s.cells[enemyHome].strength) {
    o[enemyHome] = budget;
    return o;
  }
  const wells = s.cells.map((_, i) => i).filter((i) => s.cells[i].kind === "well" && s.cells[i].owner !== p);
  const cands = [...reach]
    .filter((i) => s.cells[i].owner !== p)
    .map((i) => {
      const dw = Math.min(99, ...wells.map((w) => distance(b.coords[i], b.coords[w])));
      const dh = distance(b.coords[i], b.coords[enemyHome]);
      return { i, cost: s.cells[i].strength + 1 + (s.cells[i].owner === e ? 1 : 0), score: (s.cells[i].kind === "well" ? 10 : 0) - dw * 2 - dh * 0.5 };
    })
    .sort((x, y) => y.score - x.score);
  for (const c of cands) {
    if (c.cost <= budget) {
      o[c.i] = c.cost;
      budget -= c.cost;
    }
  }
  return o;
}
