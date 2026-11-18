// Hexstake core rules engine. Pure and deterministic: shared by the server (authoritative)
// and the client (rendering, order validation, local practice previews).
//
// Rules summary (see docs/RULES.md for the player-facing version):
//  - Hexagonal board, point-symmetric terrain (plains, wells, rocks), one home per player.
//  - Each turn both players secretly allocate energy to hexes. A hex can be targeted if you
//    own it (fortify) or it touches a hex you owned at the start of the turn (claim / attack).
//  - Resolution per hex: the two bids cancel out; the larger remainder then fights the hex's
//    current garrison. Own bids add to your garrison instead.
//  - Territory cut off from your home decays by 1 per turn. Wells give extra income but only
//    while connected.
//  - Capture the enemy home to win instantly; otherwise most hexes after the last turn wins.

export type Player = 0 | 1;
export type CellKind = "plain" | "well" | "home" | "rock";

export interface Cell {
  kind: CellKind;
  owner: Player | null;
  strength: number;
}

export interface GameConfig {
  radius: number;
  maxTurns: number;
  incomeBase: number;
  wellIncome: number;
  energyCap: number;
  startEnergy: number;
  homeStrength: number;
  wellGuard: number;
  maxStrength: number;
  homeRegen: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  radius: 4,
  maxTurns: 30,
  incomeBase: 4,
  wellIncome: 2,
  energyCap: 24,
  startEnergy: 6,
  homeStrength: 6,
  wellGuard: 2,
  maxStrength: 12,
  homeRegen: 2,
};

export type EndReason = "home" | "turns" | "forfeit" | "abandon";

export interface GameState {
  config: GameConfig;
  seed: number;
  cells: Cell[];
  homes: [number, number];
  turn: number; // 1-based number of the turn currently being planned
  energy: [number, number];
  over: boolean;
  winner: Player | null; // null + over = draw
  endReason: EndReason | null;
}

/** Map of cell index -> energy allocated. */
export type Orders = Record<number, number>;

export interface CellChange {
  idx: number;
  bids: [number, number];
  before: { owner: Player | null; strength: number };
  after: { owner: Player | null; strength: number };
  decayed?: boolean;
}

export interface TurnResult {
  turn: number;
  orders: [Orders, Orders];
  changes: CellChange[];
  income: [number, number];
}

// ---------------------------------------------------------------- geometry

export interface Axial {
  q: number;
  r: number;
}

const DIRS: Axial[] = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
];

export interface Board {
  radius: number;
  coords: Axial[];
  index: Map<string, number>;
  neighbors: number[][];
}

const boardCache = new Map<number, Board>();

export function board(radius: number): Board {
  const cached = boardCache.get(radius);
  if (cached) return cached;
  const coords: Axial[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      coords.push({ q, r });
    }
  }
  const index = new Map<string, number>();
  coords.forEach((c, i) => index.set(key(c.q, c.r), i));
  const neighbors = coords.map((c) =>
    DIRS.map((d) => index.get(key(c.q + d.q, c.r + d.r))).filter((n): n is number => n !== undefined),
  );
  const b = { radius, coords, index, neighbors };
  boardCache.set(radius, b);
  return b;
}

export function key(q: number, r: number): string {
  return `${q},${r}`;
}

export function distance(a: Axial, b: Axial): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
}

/** Index of the point-mirrored cell (q,r) -> (-q,-r). */
export function mirror(b: Board, idx: number): number {
  const c = b.coords[idx];
  return b.index.get(key(-c.q, -c.r))!;
}

// ---------------------------------------------------------------- rng

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- setup

export function newGame(seed: number, config: GameConfig = DEFAULT_CONFIG): GameState {
  const b = board(config.radius);
  const R = config.radius;
  const homeA = b.index.get(key(-R, Math.floor(R / 2)))!;
  const homeB = mirror(b, homeA);
  const rand = rng(seed);

  for (let attempt = 0; attempt < 100; attempt++) {
    const kinds: CellKind[] = b.coords.map(() => "plain");
    kinds[homeA] = "home";
    kinds[homeB] = "home";
    const center = b.index.get(key(0, 0))!;
    kinds[center] = "well";

    // Candidate cells on "one half" of the board (mirror pairs are taken together).
    const half = b.coords
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => i !== center && (c.q < 0 || (c.q === 0 && c.r < 0)))
      .map(({ i }) => i);
    const farFromHomes = (i: number) =>
      distance(b.coords[i], b.coords[homeA]) >= 2 && distance(b.coords[i], b.coords[homeB]) >= 2;
    const pool = shuffle(half.filter(farFromHomes), rand);

    const wellPairs = 2;
    const rockPairs = 3 + Math.floor(rand() * 3);
    let placedWells = 0;
    let placedRocks = 0;
    for (const i of pool) {
      const m = mirror(b, i);
      if (kinds[i] !== "plain" || kinds[m] !== "plain") continue;
      if (placedWells < wellPairs) {
        // keep wells off the very edge and away from each other a bit
        if (distance(b.coords[i], { q: 0, r: 0 }) > R - 1) continue;
        kinds[i] = "well";
        kinds[m] = "well";
        placedWells++;
      } else if (placedRocks < rockPairs) {
        if (b.neighbors[i].some((n) => kinds[n] === "well" || kinds[n] === "rock")) continue;
        kinds[i] = "rock";
        kinds[m] = "rock";
        placedRocks++;
      }
    }
    if (!allConnected(b, kinds, homeA)) continue;

    const cells: Cell[] = kinds.map((kind) => ({
      kind,
      owner: null,
      strength: kind === "well" ? config.wellGuard : 0,
    }));
    cells[homeA] = { kind: "home", owner: 0, strength: config.homeStrength };
    cells[homeB] = { kind: "home", owner: 1, strength: config.homeStrength };
    return {
      config,
      seed,
      cells,
      homes: [homeA, homeB],
      turn: 1,
      energy: [config.startEnergy, config.startEnergy],
      over: false,
      winner: null,
      endReason: null,
    };
  }
  throw new Error("could not generate a connected map");
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function allConnected(b: Board, kinds: CellKind[], start: number): boolean {
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const n of b.neighbors[cur]) {
      if (!seen.has(n) && kinds[n] !== "rock") {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen.size === kinds.filter((k) => k !== "rock").length;
}

// ---------------------------------------------------------------- queries

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    cells: s.cells.map((c) => ({ ...c })),
    homes: [s.homes[0], s.homes[1]],
    energy: [s.energy[0], s.energy[1]],
  };
}

/** Cells a player may place energy on this turn. */
export function targetable(s: GameState, p: Player): Set<number> {
  const b = board(s.config.radius);
  const out = new Set<number>();
  s.cells.forEach((c, i) => {
    if (c.owner !== p) return;
    out.add(i);
    for (const n of b.neighbors[i]) if (s.cells[n].kind !== "rock") out.add(n);
  });
  return out;
}

/** Cells connected to the player's home through their own territory. */
export function connected(s: GameState, p: Player): Set<number> {
  const b = board(s.config.radius);
  const home = s.homes[p];
  const out = new Set<number>();
  if (s.cells[home].owner !== p) return out;
  out.add(home);
  const stack = [home];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const n of b.neighbors[cur]) {
      if (!out.has(n) && s.cells[n].owner === p) {
        out.add(n);
        stack.push(n);
      }
    }
  }
  return out;
}

export function incomeFor(s: GameState, p: Player): number {
  const conn = connected(s, p);
  let wells = 0;
  for (const i of conn) if (s.cells[i].kind === "well") wells++;
  return s.config.incomeBase + wells * s.config.wellIncome;
}

export function score(s: GameState, p: Player): { hexes: number; strength: number } {
  let hexes = 0;
  let strength = 0;
  for (const c of s.cells) {
    if (c.owner === p) {
      hexes++;
      strength += c.strength;
    }
  }
  return { hexes, strength };
}

export function orderTotal(o: Orders): number {
  let t = 0;
  for (const k in o) t += o[k];
  return t;
}

/** Returns an error string, or null if the orders are legal. */
export function validateOrders(s: GameState, p: Player, orders: unknown): string | null {
  if (typeof orders !== "object" || orders === null || Array.isArray(orders)) return "orders must be an object";
  const allowed = targetable(s, p);
  let total = 0;
  for (const [k, v] of Object.entries(orders as Record<string, unknown>)) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0 || idx >= s.cells.length) return `bad cell ${k}`;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return `bad amount on ${k}`;
    if (v === 0) continue;
    if (!allowed.has(idx)) return `cell ${k} is not reachable`;
    total += v;
  }
  if (total > s.energy[p]) return "not enough energy";
  return null;
}

export function normalizeOrders(orders: Orders): Orders {
  const out: Orders = {};
  for (const [k, v] of Object.entries(orders)) if (v > 0) out[Number(k)] = v;
  return out;
}

// ---------------------------------------------------------------- resolution

/** Resolve one turn. Orders must already be validated. Returns the new state and a diff. */
export function resolveTurn(prev: GameState, ordersA: Orders, ordersB: Orders): { state: GameState; result: TurnResult } {
  if (prev.over) throw new Error("game is over");
  const s = cloneState(prev);
  const cfg = s.config;
  const orders: [Orders, Orders] = [normalizeOrders(ordersA), normalizeOrders(ordersB)];
  s.energy[0] -= orderTotal(orders[0]);
  s.energy[1] -= orderTotal(orders[1]);

  const changes = new Map<number, CellChange>();
  const touched = new Set<number>([...Object.keys(orders[0]), ...Object.keys(orders[1])].map(Number));

  for (const idx of touched) {
    const cell = s.cells[idx];
    const bids: [number, number] = [orders[0][idx] ?? 0, orders[1][idx] ?? 0];
    const before = { owner: cell.owner, strength: cell.strength };
    if (cell.owner !== null) {
      const own = cell.owner;
      const other: Player = own === 0 ? 1 : 0;
      const defense = cell.strength + bids[own];
      const attack = bids[other];
      if (attack > defense) {
        cell.owner = other;
        cell.strength = attack - defense;
      } else if (attack === defense) {
        cell.owner = null;
        cell.strength = 0;
      } else {
        cell.strength = defense - attack;
      }
    } else {
      const diff = Math.abs(bids[0] - bids[1]);
      if (diff > 0) {
        const w: Player = bids[0] > bids[1] ? 0 : 1;
        if (diff > cell.strength) {
          cell.owner = w;
          cell.strength = diff - cell.strength;
        } else {
          cell.strength = cell.strength - diff;
        }
      }
    }
    cell.strength = Math.min(cell.strength, cfg.maxStrength);
    changes.set(idx, { idx, bids, before, after: { owner: cell.owner, strength: cell.strength } });
  }

  // Decay of cut-off territory.
  for (const p of [0, 1] as Player[]) {
    const conn = connected(s, p);
    s.cells.forEach((cell, idx) => {
      if (cell.owner !== p || conn.has(idx)) return;
      const ch = changes.get(idx) ?? {
        idx,
        bids: [0, 0] as [number, number],
        before: { owner: cell.owner, strength: cell.strength },
        after: { owner: cell.owner, strength: cell.strength },
      };
      cell.strength -= 1;
      if (cell.strength <= 0) {
        cell.owner = null;
        cell.strength = 0;
      }
      ch.after = { owner: cell.owner, strength: cell.strength };
      ch.decayed = true;
      changes.set(idx, ch);
    });
  }

  // Homes still held regenerate.
  for (const p of [0, 1] as Player[]) {
    const h = s.cells[s.homes[p]];
    if (h.owner === p && h.strength < cfg.maxStrength) {
      const ch = changes.get(s.homes[p]) ?? {
        idx: s.homes[p],
        bids: [0, 0] as [number, number],
        before: { owner: h.owner, strength: h.strength },
        after: { owner: h.owner, strength: h.strength },
      };
      h.strength = Math.min(cfg.maxStrength, h.strength + cfg.homeRegen);
      ch.after = { owner: h.owner, strength: h.strength };
      changes.set(s.homes[p], ch);
    }
  }

  const income: [number, number] = [0, 0];
  const lostA = s.cells[s.homes[0]].owner !== 0;
  const lostB = s.cells[s.homes[1]].owner !== 1;
  if (lostA || lostB) {
    s.over = true;
    s.endReason = "home";
    s.winner = lostA && lostB ? null : lostA ? 1 : 0;
  } else if (s.turn >= cfg.maxTurns) {
    finishOnScore(s);
  } else {
    for (const p of [0, 1] as Player[]) {
      income[p] = incomeFor(s, p);
      s.energy[p] = Math.min(cfg.energyCap, s.energy[p] + income[p]);
    }
    s.turn += 1;
  }

  return {
    state: s,
    result: { turn: prev.turn, orders, changes: [...changes.values()].sort((a, b) => a.idx - b.idx), income },
  };
}

function finishOnScore(s: GameState) {
  s.over = true;
  s.endReason = "turns";
  const a = score(s, 0);
  const b = score(s, 1);
  if (a.hexes !== b.hexes) s.winner = a.hexes > b.hexes ? 0 : 1;
  else if (a.strength !== b.strength) s.winner = a.strength > b.strength ? 0 : 1;
  else s.winner = null;
}

/** End the game early because a player forfeited / abandoned. */
export function forfeit(prev: GameState, loser: Player, reason: EndReason = "forfeit"): GameState {
  const s = cloneState(prev);
  s.over = true;
  s.endReason = reason;
  s.winner = loser === 0 ? 1 : 0;
  return s;
}
