// Heuristic bot. Deterministic given its seed so matches can be replayed.
import { board, connected, incomeFor, distance, GameState, Orders, Player, rng, targetable } from "./game";

export type BotLevel = "easy" | "normal" | "hard";

interface Candidate {
  idx: number;
  value: number;
  cost: number;
}

interface Profile {
  noise: number; // randomness of valuations
  caution: number; // extra garrison assumed on contested hexes
  homeDefense: number; // share of the enemy's bank assumed to hit our home when threatened
  homeAttack: number; // share of the enemy's bank assumed to defend their home
  reserve: number; // share of energy held back
}

export const PROFILES: Record<BotLevel, Profile> = {
  easy: { noise: 1.6, caution: 0, homeDefense: 0.3, homeAttack: 0, reserve: 0.3 },
  normal: { noise: 0.7, caution: 0, homeDefense: 0.5, homeAttack: 0.2, reserve: 0 },
  hard: { noise: 0.2, caution: 0, homeDefense: 0.6, homeAttack: 0.3, reserve: 0 },
};

export function botOrders(s: GameState, p: Player, level: BotLevel, seed: number): Orders {
  const prof = PROFILES[level];
  const rand = rng((seed ^ (s.turn * 7919) ^ (p * 104729)) >>> 0);
  const b = board(s.config.radius);
  const enemy: Player = p === 0 ? 1 : 0;
  const enemyTargets = targetable(s, enemy);
  const myConn = connected(s, p);
  const enemyConn = connected(s, enemy);
  const enemyHomeIdx = s.homes[enemy];
  const myHomeIdx = s.homes[p];
  const enemyHome = b.coords[enemyHomeIdx];
  const myEnergy = s.energy[p];
  const enemyEnergy = s.energy[enemy];
  const lastTurns = s.config.maxTurns - s.turn;

  const cands: Candidate[] = [];
  for (const idx of targetable(s, p)) {
    const cell = s.cells[idx];
    const contested = enemyTargets.has(idx);
    const towardEnemy = 1 + (b.radius * 2 - distance(b.coords[idx], enemyHome)) / (b.radius * 2);

    if (cell.owner === p) {
      if (!contested) continue;
      if (idx === myHomeIdx) {
        // Home is reachable by the enemy: they could dump their whole bank on it.
        const expected = Math.ceil(enemyEnergy * prof.homeDefense);
        const need = expected - cell.strength + 1;
        // Partial defense still forces the attacker to commit more.
        if (need > 0) cands.push({ idx, value: 1000, cost: Math.min(need, myEnergy) });
        continue;
      }
      const enemyAdj = b.neighbors[idx].filter((n) => s.cells[n].owner === enemy).length;
      const threat = Math.min(enemyEnergy, enemyAdj * 1.5 + prof.caution);
      const need = Math.ceil(threat) - cell.strength;
      if (need <= 0) continue;
      const value = (cell.kind === "well" ? 7 : 2) * (myConn.has(idx) ? 1 : 0.3);
      cands.push({ idx, value, cost: need });
    } else if (idx === enemyHomeIdx) {
      const expectedDefense = Math.ceil(enemyEnergy * prof.homeAttack);
      const cost = cell.strength + expectedDefense + 1;
      cands.push({ idx, value: 500, cost });
    } else {
      const cost = cell.strength + (contested ? prof.caution : 0) + 1;
      let value: number;
      if (cell.owner === enemy) {
        value = cell.kind === "well" ? 10 : 4;
        // Hexes that hold the enemy's network together are worth more.
        const enemyNeighbors = b.neighbors[idx].filter((n) => s.cells[n].owner === enemy).length;
        value += enemyNeighbors * 0.6;
        if (!enemyConn.has(idx)) value *= 0.4; // already decaying
      } else {
        value = cell.kind === "well" ? 9 : 3;
        // Late game: raw hex count matters most, cheap neutral hexes are great.
        if (lastTurns < 4) value += 2;
      }
      value *= towardEnemy;
      cands.push({ idx, value, cost });
    }
  }

  for (const c of cands) c.value *= 1 + (rand() - 0.5) * prof.noise;
  cands.sort((x, y) => y.value / y.cost - x.value / x.cost);

  const orders: Orders = {};
  let budget = myEnergy - Math.floor(myEnergy * (lastTurns > 2 ? prof.reserve : 0));
  // If the enemy can reach our home, keep enough banked to answer next turn's bank.
  if (enemyTargets.has(myHomeIdx) && prof.homeDefense > 0) {
    const home = s.cells[myHomeIdx];
    const nextStrength = Math.min(s.config.maxStrength, home.strength + s.config.homeRegen);
    const enemyNext = Math.min(s.config.energyCap, enemyEnergy + incomeEstimate(s, enemy));
    const hold = Math.ceil(enemyNext * prof.homeDefense) - nextStrength - incomeEstimate(s, p);
    if (hold > 0) budget = Math.max(0, budget - hold);
  }
  for (const c of cands) {
    if (budget <= 0) break;
    if (c.value >= 1000) c.cost = Math.min(c.cost, budget);
    if (c.cost > budget) continue;
    orders[c.idx] = (orders[c.idx] ?? 0) + c.cost;
    budget -= c.cost;
  }
  // Don't waste income at the cap: top up the best target (or home).
  const nextIncome = s.config.incomeBase + 2;
  if (budget > 0 && (myEnergy - (myEnergy - budget) + nextIncome > s.config.energyCap || lastTurns === 0)) {
    const t = cands[0]?.idx ?? myHomeIdx;
    orders[t] = (orders[t] ?? 0) + budget;
  }
  return orders;
}

function incomeEstimate(s: GameState, p: Player): number {
  return incomeFor(s, p);
}
