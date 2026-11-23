import { botOrders, BotLevel } from "../shared/bot";
import {
  forfeit, GameState, newGame, Orders, Player, resolveTurn, TurnResult, validateOrders, normalizeOrders,
} from "../shared/game";
import { track } from "./analytics";
import { config } from "./config";
import { randomId } from "./crypto";
import { DB, now, tx } from "./db";
import { log } from "./log";

export type Mode = "bot" | "ranked" | "casual" | "staked" | "daily";

/** The daily challenge map: same seed for everyone on a given UTC day. */
export function dailySeed(date = new Date()): { day: string; seed: number } {
  const day = date.toISOString().slice(0, 10);
  let h = 2166136261;
  for (const ch of `hexstake-daily-${day}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return { day, seed: h >>> 0 };
}

export interface Seat {
  id: string; // user id, guest:xxx or bot:<level>
  name: string;
  elo: number;
  bot?: BotLevel;
}

export interface Client {
  connId: string;
  userId: string;
  name: string;
  guest: boolean;
  send(msg: object): void;
}

const MAX_MISSED = 3;
const TUTORIAL_PASSIVE_TURNS = 3;
const TUTORIAL_TURN_SECONDS = 90;
const FIRST_TURN_BONUS_MS = 8000;

export interface MatchHooks {
  onFinish(m: LiveMatch): Promise<void> | void;
}

export class LiveMatch {
  pending: [Orders | null, Orders | null] = [null, null];
  /** Orders a player has placed but not locked in; used if the turn times out. */
  drafts: [Orders | null, Orders | null] = [null, null];
  deadline = 0;
  missed: [number, number] = [0, 0];
  lastResult: TurnResult | null = null;
  subscribers = new Set<Client>();
  private timer: NodeJS.Timeout | null = null;
  private botTimers: NodeJS.Timeout[] = [];
  eloChange: number | null = null;
  finishing = false;
  /** Seconds per turn for this match (tutorials are relaxed). */
  turnSeconds = config.turnSeconds;
  /** Tutorial matches: the bot holds still for the first few turns. */
  tutorial = false;

  constructor(
    private mgr: MatchManager,
    public id: string,
    public mode: Mode,
    public seats: [Seat, Seat],
    public stake: number,
    public state: GameState,
    public botSeed: number,
    public history: [Orders, Orders][],
    public createdAt: number,
  ) {}

  seatOf(userId: string): Player | null {
    if (this.seats[0].id === userId) return 0;
    if (this.seats[1].id === userId) return 1;
    return null;
  }

  view(userId: string | null) {
    return {
      id: this.id,
      mode: this.mode,
      stake: this.stake,
      seats: this.seats.map((s) => ({ id: s.id.startsWith("guest:") ? "guest" : s.id, name: s.name, elo: s.elo, bot: s.bot ?? null })),
      you: userId ? this.seatOf(userId) : null,
      state: this.publicState(),
      deadline: this.deadline,
      serverNow: now(),
      submitted: [this.pending[0] !== null, this.pending[1] !== null],
      lastResult: this.lastResult,
      eloChange: this.eloChange,
      turnSeconds: this.turnSeconds,
      tutorial: this.tutorial,
    };
  }

  publicState() {
    // The seed is not secret (terrain is visible anyway); the bot seed is kept server-side.
    return this.state;
  }

  broadcast(msgFor: (c: Client) => object) {
    for (const c of this.subscribers) {
      try {
        c.send(msgFor(c));
      } catch {
        /* socket gone */
      }
    }
  }

  start(extraMs = FIRST_TURN_BONUS_MS) {
    this.scheduleTurn(extraMs);
  }

  private scheduleTurn(extraMs = 0) {
    this.clearTimers();
    this.pending = [null, null];
    this.drafts = [null, null];
    this.deadline = now() + this.turnSeconds * 1000 + extraMs;
    this.timer = setTimeout(() => this.resolve(), this.deadline - now());
    this.seats.forEach((seat, p) => {
      if (!seat.bot) return;
      const level = seat.bot;
      // think for a moment so it feels alive
      const delay = 1200 + ((this.botSeed + this.state.turn * 131) % 2500);
      this.botTimers.push(
        setTimeout(() => {
          if (this.state.over) return;
          const o = this.tutorial && this.state.turn <= TUTORIAL_PASSIVE_TURNS ? {} : botOrders(this.state, p as Player, level, this.botSeed);
          this.submit(p as Player, o);
        }, Math.min(delay, this.turnSeconds * 1000 - 500)),
      );
    });
  }

  private clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.botTimers) clearTimeout(t);
    this.botTimers = [];
  }

  submit(p: Player, orders: Orders): string | null {
    if (this.state.over) return "match is over";
    if (this.pending[p] !== null) return "orders already locked in";
    const err = validateOrders(this.state, p, orders);
    if (err) return err;
    this.pending[p] = normalizeOrders(orders);
    this.missed[p] = 0;
    if (this.pending[0] !== null && this.pending[1] !== null) {
      this.resolve();
    } else {
      this.broadcast(() => ({ t: "submitted", matchId: this.id, submitted: [this.pending[0] !== null, this.pending[1] !== null] }));
    }
    return null;
  }

  /** Remember in-progress orders so they still count if the timer runs out. */
  setDraft(p: Player, orders: Orders): string | null {
    if (this.state.over || this.pending[p] !== null) return null;
    const err = validateOrders(this.state, p, orders);
    if (err) return err;
    this.drafts[p] = normalizeOrders(orders);
    return null;
  }

  private resolve() {
    if (this.state.over) return;
    this.clearTimers();
    for (const p of [0, 1] as Player[]) {
      if (this.pending[p] === null) {
        const draft = this.drafts[p];
        if (draft && Object.keys(draft).length > 0) {
          // Timed out with orders placed: lock them in rather than discarding them.
          this.pending[p] = draft;
          this.missed[p] = 0;
        } else {
          this.pending[p] = {};
          if (!this.seats[p].bot) this.missed[p]++;
        }
      }
    }
    const [a, b] = [this.pending[0]!, this.pending[1]!];
    const { state, result } = resolveTurn(this.state, a, b);
    this.state = state;
    this.history.push([a, b]);
    this.lastResult = result;

    if (!state.over) {
      const afk = ([0, 1] as Player[]).filter((p) => this.missed[p] >= MAX_MISSED);
      if (afk.length === 2) {
        this.state = { ...forfeit(state, 0, "abandon"), winner: null };
      } else if (afk.length === 1) {
        this.state = forfeit(state, afk[0], "abandon");
      }
    }

    if (this.state.over) {
      void this.finish();
      return;
    }
    this.scheduleTurn();
    this.mgr.persist(this);
    this.broadcast((c) => ({ t: "turn", matchId: this.id, result, ...this.view(c.userId) }));
  }

  resign(p: Player) {
    if (this.state.over) return;
    this.clearTimers();
    this.state = forfeit(this.state, p, "forfeit");
    void this.finish();
  }

  async finish() {
    if (this.finishing) return;
    this.finishing = true;
    this.clearTimers();
    try {
      this.mgr.recordFinish(this);
      await this.mgr.hooks.onFinish(this);
    } catch (e) {
      log.error("finish hook failed", { match: this.id, err: String(e) });
    }
    this.broadcast((c) => ({ t: "end", matchId: this.id, result: this.lastResult, ...this.view(c.userId) }));
    this.mgr.retire(this);
  }

  stop() {
    this.clearTimers();
  }
}

export function eloDelta(ra: number, rb: number, scoreA: number, k = 32): number {
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  return Math.round(k * (scoreA - ea));
}

export class MatchManager {
  live = new Map<string, LiveMatch>();
  private recentlyEnded = new Map<string, LiveMatch>();
  hooks: MatchHooks = { onFinish: () => {} };

  constructor(private db: DB) {}

  create(mode: Mode, seats: [Seat, Seat], stake = 0, opts: { id?: string; swap?: boolean; tutorial?: boolean; seed?: number } = {}): LiveMatch {
    const seed = opts.seed ?? (Math.random() * 2 ** 31) >>> 0;
    const botSeed = (Math.random() * 2 ** 31) >>> 0;
    // Randomize who plays which side.
    if (opts.swap ?? Math.random() < 0.5) seats = [seats[1], seats[0]];
    const m = new LiveMatch(this, opts.id ?? randomId(9), mode, seats, stake, newGame(seed), botSeed, [], now());
    if (opts.tutorial) {
      m.tutorial = true;
      m.turnSeconds = TUTORIAL_TURN_SECONDS;
    }
    this.db
      .prepare(`INSERT INTO matches (id, mode, p0, p1, p0_name, p1_name, seed, stake, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .run(m.id, mode, seats[0].id, seats[1].id, seats[0].name, seats[1].name, seed, stake, m.createdAt);
    this.live.set(m.id, m);
    this.persist(m);
    m.start();
    track("match_start", seats.find((s) => !s.bot)?.id ?? null, { mode, stake, id: m.id, bot: seats.find((s) => s.bot)?.bot });
    return m;
  }

  get(id: string): LiveMatch | undefined {
    return this.live.get(id) ?? this.recentlyEnded.get(id);
  }

  activeFor(userId: string): LiveMatch | undefined {
    for (const m of this.live.values()) if (m.seatOf(userId) !== null && !m.state.over) return m;
    return undefined;
  }

  persist(m: LiveMatch) {
    const snap = JSON.stringify({
      state: m.state, botSeed: m.botSeed, history: m.history, missed: m.missed, seats: m.seats, lastResult: m.lastResult,
      tutorial: m.tutorial, turnSeconds: m.turnSeconds,
    });
    this.db.prepare("UPDATE matches SET snapshot = ?, turns = ? WHERE id = ?").run(snap, m.state.turn - 1, m.id);
  }

  recordFinish(m: LiveMatch) {
    const s = m.state;
    tx(this.db, () => {
      if (m.mode === "ranked" || m.mode === "staked") {
        const [a, b] = m.seats;
        if (!a.bot && !b.bot && !a.id.startsWith("guest:") && !b.id.startsWith("guest:")) {
          const scoreA = s.winner === null ? 0.5 : s.winner === 0 ? 1 : 0;
          const k = m.mode === "ranked" ? 32 : 24;
          const d = eloDelta(a.elo, b.elo, scoreA, k);
          m.eloChange = d;
          this.db.prepare("UPDATE users SET elo = elo + ? WHERE id = ?").run(d, a.id);
          this.db.prepare("UPDATE users SET elo = elo - ? WHERE id = ?").run(d, b.id);
        }
      }
      m.seats.forEach((seat, p) => {
        if (seat.bot || seat.id.startsWith("guest:")) return;
        const col = s.winner === null ? "draws" : s.winner === p ? "wins" : "losses";
        this.db.prepare(`UPDATE users SET games = games + 1, ${col} = ${col} + 1 WHERE id = ?`).run(seat.id);
      });
      this.db
        .prepare(`UPDATE matches SET status = 'finished', winner = ?, end_reason = ?, turns = ?, elo_change = ?,
                  history = ?, snapshot = NULL, ended_at = ? WHERE id = ?`)
        .run(s.winner, s.endReason, m.history.length, m.eloChange, JSON.stringify(m.history), now(), m.id);
    });
    track("match_end", m.seats.find((x) => !x.bot)?.id ?? null, {
      mode: m.mode, id: m.id, turns: m.history.length, reason: s.endReason, winner: s.winner,
      bot: m.seats.find((x) => x.bot)?.bot, humanSeat: m.seats.findIndex((x) => !x.bot),
    });
  }

  retire(m: LiveMatch) {
    this.live.delete(m.id);
    this.recentlyEnded.set(m.id, m);
    setTimeout(() => this.recentlyEnded.delete(m.id), 10 * 60_000).unref();
  }

  /** Resume matches that were running when the process last stopped. */
  resumeAll() {
    const rows = this.db.prepare("SELECT * FROM matches WHERE status = 'active'").all() as Record<string, any>[];
    for (const r of rows) {
      try {
        if (!r.snapshot) throw new Error("no snapshot");
        const snap = JSON.parse(r.snapshot);
        const m = new LiveMatch(this, r.id, r.mode, snap.seats, r.stake, snap.state, snap.botSeed, snap.history, r.created_at);
        m.missed = snap.missed;
        m.lastResult = snap.lastResult;
        m.tutorial = Boolean(snap.tutorial);
        m.turnSeconds = snap.turnSeconds ?? config.turnSeconds;
        this.live.set(m.id, m);
        m.start(10_000); // give players time to reconnect
        log.info("resumed match", { id: m.id, turn: m.state.turn });
      } catch (e) {
        this.db.prepare("UPDATE matches SET status = 'cancelled', ended_at = ? WHERE id = ?").run(now(), r.id);
        log.warn("could not resume match", { id: r.id, err: String(e) });
      }
    }
  }

  shutdown() {
    for (const m of this.live.values()) {
      m.stop();
      this.persist(m);
    }
  }
}
