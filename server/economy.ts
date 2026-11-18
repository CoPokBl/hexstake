// Challenges (friend / public lobbies) and coin escrow for staked matches.
//
// Flow for a staked challenge:
//   1. Creator opens a challenge lobby (stake S). It lives while the creator is connected.
//   2. Someone accepts -> both players get a Serble transaction proposal for S coins (user -> app).
//   3. When both proposals are Approved the match starts. If either is denied / expires, whoever
//      paid is refunded and the lobby re-opens.
//   4. On finish the winner receives 2S minus the rake via a balance transfer (no consent needed).
//      Draws and cancelled matches refund both stakes in full.
// Every money movement is a row in `payments` so it can be retried and audited.
import { track } from "./analytics";
import { config } from "./config";
import { randomId, shortCode } from "./crypto";
import { DB, now } from "./db";
import { log } from "./log";
import { Client, LiveMatch, MatchManager, Seat } from "./matches";
import { economyReady } from "./secrets";
import * as serbleApi from "./serble";

export type SerbleApi = Pick<typeof serbleApi, "createProposal" | "getProposal" | "cancelProposal" | "transfer" | "recentAppTransactions" | "writeBudgetRemaining">;

export interface Challenge {
  code: string;
  creator: string;
  creator_name: string;
  stake: number;
  public: number;
  target_user: string | null;
  status: "open" | "funding" | "started" | "cancelled" | "expired";
  acceptor: string | null;
  acceptor_name: string | null;
  match_id: string | null;
  created_at: number;
  expires_at: number;
}

export interface Payment {
  id: string;
  challenge_code: string | null;
  match_id: string | null;
  user_id: string;
  kind: "stake" | "payout" | "refund";
  amount: number; // whole coins
  proposal_id: string | null;
  consent_url: string | null;
  status: "pending" | "paid" | "failed" | "expired" | "cancelled";
  note: string | null;
  created_at: number;
  updated_at: number;
}

const LOBBY_GRACE_MS = 90_000;
const FUNDING_TIMEOUT_MS = 15 * 60_000;

export class Economy {
  private creatorPresence = new Map<string, number>(); // code -> last time creator seen (0 = connected)
  private pollTimer: NodeJS.Timeout | null = null;
  private payoutTimer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private mm: MatchManager,
    private notify: (userId: string, msg: object) => void,
    private onMatchStart: (m: LiveMatch) => void,
    private seatFor: (userId: string, name: string) => Seat,
    private api: SerbleApi = serbleApi,
    private ready: () => boolean = economyReady,
  ) {}

  start() {
    this.pollTimer = setInterval(() => void this.pollStakes().catch((e) => log.error("poll failed", { err: String(e) })), 4000);
    this.payoutTimer = setInterval(() => void this.processPayouts().catch((e) => log.error("payouts failed", { err: String(e) })), 30_000);
    this.pollTimer.unref();
    this.payoutTimer.unref();
    // Lobbies don't survive a restart (creators must reconnect): cancel and refund any funding.
    const stale = this.db.prepare("SELECT * FROM challenges WHERE status IN ('open','funding')").all() as unknown as Challenge[];
    for (const c of stale) this.cancelChallenge(c.code, "server restart");
    this.refundCancelledMatches();
    void this.processPayouts();
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.payoutTimer) clearInterval(this.payoutTimer);
  }

  // ------------------------------------------------------------ challenges

  get(code: string): Challenge | undefined {
    return this.db.prepare("SELECT * FROM challenges WHERE code = ?").get(code.toUpperCase()) as Challenge | undefined;
  }

  view(c: Challenge, userId: string | null) {
    const payments = this.db
      .prepare("SELECT user_id, status, consent_url FROM payments WHERE challenge_code = ? AND kind = 'stake' AND status IN ('pending','paid')")
      .all(c.code) as { user_id: string; status: string; consent_url: string }[];
    const mine = payments.find((p) => p.user_id === userId);
    return {
      code: c.code,
      creator: { id: c.creator, name: c.creator_name },
      acceptor: c.acceptor ? { id: c.acceptor.startsWith("guest:") ? "guest" : c.acceptor, name: c.acceptor_name } : null,
      stake: c.stake,
      public: Boolean(c.public),
      status: c.status,
      matchId: c.match_id,
      paid: {
        creator: payments.some((p) => p.user_id === c.creator && p.status === "paid"),
        acceptor: payments.some((p) => p.user_id === c.acceptor && p.status === "paid"),
      },
      yourPayment: mine ? { status: mine.status, consentUrl: mine.status === "pending" ? mine.consent_url : null } : null,
      creatorOnline: this.creatorPresence.get(c.code) === 0,
      payout: c.stake ? this.payoutFor(c.stake) : 0,
      rakePercent: config.rakePercent,
    };
  }

  /** Winner's payout in whole coins: the pot minus the rake, rake rounded down. */
  payoutFor(stake: number) {
    const pot = 2 * stake;
    return pot - Math.floor((pot * config.rakePercent) / 100);
  }

  openPublic() {
    const rows = this.db
      .prepare("SELECT * FROM challenges WHERE status = 'open' AND public = 1 ORDER BY stake DESC, created_at DESC LIMIT 50")
      .all() as unknown as Challenge[];
    return rows.filter((c) => this.creatorPresence.get(c.code) === 0).map((c) => this.view(c, null));
  }

  create(creator: Client, stake: number, isPublic: boolean, target?: string): Challenge | string {
    if (!Number.isInteger(stake) || stake < 0) return "stake must be a whole number of coins";
    if (stake > config.maxStake) return `max stake is ${config.maxStake}`;
    if (stake > 0 && creator.guest) return "sign in with Serble to play for coins";
    if (stake > 0 && !this.ready()) return "coin matches are not available right now";
    if (this.mm.activeFor(creator.userId)) return "finish your current match first";
    // one open lobby per user
    const existing = this.db
      .prepare("SELECT code FROM challenges WHERE creator = ? AND status IN ('open','funding')")
      .all(creator.userId) as { code: string }[];
    for (const e of existing) this.cancelChallenge(e.code, "replaced");
    let code = shortCode();
    while (this.get(code)) code = shortCode();
    const t = now();
    this.db
      .prepare(`INSERT INTO challenges (code, creator, creator_name, stake, public, target_user, status, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .run(code, creator.userId, creator.name, stake, isPublic ? 1 : 0, target ?? null, t, t + 24 * 3600_000);
    this.creatorPresence.set(code, 0);
    track("challenge_create", creator.userId, { stake, public: isPublic, friend: Boolean(target) });
    return this.get(code)!;
  }

  /** Called by the socket layer to track whether the creator is still in their lobby. */
  creatorConnected(userId: string, connected: boolean) {
    const rows = this.db
      .prepare("SELECT code FROM challenges WHERE creator = ? AND status IN ('open','funding')")
      .all(userId) as { code: string }[];
    for (const r of rows) this.creatorPresence.set(r.code, connected ? 0 : now());
  }

  sweepLobbies() {
    const t = now();
    for (const [code, seen] of this.creatorPresence) {
      const c = this.get(code);
      if (!c || (c.status !== "open" && c.status !== "funding")) {
        this.creatorPresence.delete(code);
        continue;
      }
      if (seen !== 0 && t - seen > LOBBY_GRACE_MS) this.cancelChallenge(code, "creator left");
      else if (c.expires_at < t) this.cancelChallenge(code, "expired", "expired");
    }
    // funding that never completes
    const stuck = this.db
      .prepare("SELECT * FROM challenges WHERE status = 'funding'")
      .all() as unknown as Challenge[];
    for (const c of stuck) {
      const first = this.db
        .prepare("SELECT MIN(created_at) t FROM payments WHERE challenge_code = ? AND kind = 'stake' AND status IN ('pending','paid')")
        .get(c.code) as { t: number | null };
      if (first.t && t - first.t > FUNDING_TIMEOUT_MS + 60_000) this.reopen(c, "payment timed out");
    }
  }

  async accept(code: string, acceptor: Client): Promise<Challenge | string> {
    const c = this.get(code);
    if (!c) return "challenge not found";
    if (c.status !== "open") return c.status === "funding" ? "someone else is already accepting" : `challenge is ${c.status}`;
    if (c.creator === acceptor.userId) return "you can't accept your own challenge";
    if (c.target_user && c.target_user !== acceptor.userId) return "this challenge is for someone else";
    if (c.stake > 0 && acceptor.guest) return "sign in with Serble to play for coins";
    if (this.creatorPresence.get(c.code) !== 0) return "the challenger isn't in the lobby right now";
    if (this.mm.activeFor(acceptor.userId)) return "finish your current match first";

    this.db
      .prepare("UPDATE challenges SET status = 'funding', acceptor = ?, acceptor_name = ? WHERE code = ? AND status = 'open'")
      .run(acceptor.userId, acceptor.name, c.code);
    track("challenge_accept", acceptor.userId, { stake: c.stake, code: c.code });

    if (c.stake === 0) return this.launch(this.get(c.code)!);

    try {
      for (const uid of [c.creator, acceptor.userId]) {
        const already = this.db
          .prepare("SELECT id FROM payments WHERE challenge_code = ? AND user_id = ? AND kind = 'stake' AND status IN ('pending','paid')")
          .get(c.code, uid);
        if (already) continue;
        await this.requestStake(c, uid);
      }
    } catch (e) {
      log.error("stake request failed", { code: c.code, err: String(e) });
      this.reopen(this.get(c.code)!, "could not create payment");
      return "could not create the coin payment, try again shortly";
    }
    const updated = this.get(c.code)!;
    this.pushChallenge(updated);
    return updated;
  }

  private async requestStake(c: Challenge, userId: string) {
    const id = randomId(9);
    const { proposal, consentUrl } = await this.api.createProposal(
      userId,
      serbleApi.coinsToRaw(c.stake),
      `Hexstake stake: ${c.stake} coins for match ${c.code}. Winner takes ${this.payoutFor(c.stake)}.`,
      `${config.publicUrl}/wallet/return`,
    );
    this.db
      .prepare(`INSERT INTO payments (id, challenge_code, user_id, kind, amount, proposal_id, consent_url, status, created_at, updated_at)
                VALUES (?, ?, ?, 'stake', ?, ?, ?, 'pending', ?, ?)`)
      .run(id, c.code, userId, c.stake, proposal.proposalId, consentUrl, now(), now());
    track("stake_requested", userId, { code: c.code, stake: c.stake });
  }

  /** Check a single proposal now (used when the user is redirected back from Serble). */
  async checkProposal(proposalId: string) {
    const p = this.db.prepare("SELECT * FROM payments WHERE proposal_id = ?").get(proposalId) as Payment | undefined;
    if (!p || p.status !== "pending") return p;
    await this.refreshStake(p);
    return this.db.prepare("SELECT * FROM payments WHERE id = ?").get(p.id) as unknown as Payment;
  }

  private lastPolled = new Map<string, number>();

  private async pollStakes() {
    const pending = this.db
      .prepare("SELECT * FROM payments WHERE kind = 'stake' AND status = 'pending' ORDER BY created_at")
      .all() as unknown as Payment[];
    const t = now();
    for (const p of pending) {
      const age = t - p.created_at;
      const interval = age < 3 * 60_000 ? 4000 : age < 10 * 60_000 ? 10_000 : 20_000;
      if (t - (this.lastPolled.get(p.id) ?? 0) < interval) continue;
      if (this.api.writeBudgetRemaining() < 10) break; // keep headroom for payouts
      this.lastPolled.set(p.id, t);
      await this.refreshStake(p).catch((e) => log.warn("refresh stake failed", { id: p.id, err: String(e) }));
    }
  }

  private async refreshStake(p: Payment) {
    if (!p.proposal_id) return;
    const prop = await this.api.getProposal(p.proposal_id);
    let status: Payment["status"] | null = null;
    if (prop.status === "Approved") status = "paid";
    else if (prop.status === "Denied" || prop.status === "Failed" || prop.status === "Cancelled") status = "failed";
    else if (prop.status === "Expired") status = "expired";
    if (!status) return;
    const res = this.db
      .prepare("UPDATE payments SET status = ?, note = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, prop.failureReason ?? prop.status, now(), p.id);
    if (res.changes === 0) return;
    this.lastPolled.delete(p.id);
    track(status === "paid" ? "stake_paid" : "stake_failed", p.user_id, { code: p.challenge_code, stake: p.amount, why: prop.status });
    const c = p.challenge_code ? this.get(p.challenge_code) : undefined;
    if (!c) return;
    if (status !== "paid") {
      // Lobby goes back to open if the acceptor bailed; cancels entirely if the creator did.
      if (p.user_id === c.creator) this.cancelChallenge(c.code, "challenger did not pay");
      else this.reopen(c, "opponent did not pay");
      return;
    }
    if (c.status === "cancelled" || c.status === "expired" || (c.status === "open" && p.user_id !== c.creator)) {
      // Paid into a challenge that is no longer funding this pairing: refund.
      this.queueRefund(p, "challenge no longer active");
      return;
    }
    const paid = this.db
      .prepare("SELECT user_id FROM payments WHERE challenge_code = ? AND kind = 'stake' AND status = 'paid'")
      .all(c.code) as { user_id: string }[];
    const ids = new Set(paid.map((x) => x.user_id));
    if (c.status === "funding" && c.acceptor && ids.has(c.creator) && ids.has(c.acceptor)) {
      this.launch(c);
    } else {
      this.pushChallenge(c);
    }
  }

  private launch(c: Challenge): Challenge {
    const seats: [Seat, Seat] = [this.seatFor(c.creator, c.creator_name), this.seatFor(c.acceptor!, c.acceptor_name!)];
    const mode = c.stake > 0 ? "staked" : "casual";
    const m = this.mm.create(mode, seats, c.stake);
    this.db.prepare("UPDATE challenges SET status = 'started', match_id = ? WHERE code = ?").run(m.id, c.code);
    this.db.prepare("UPDATE payments SET match_id = ? WHERE challenge_code = ? AND kind = 'stake'").run(m.id, c.code);
    this.creatorPresence.delete(c.code);
    const updated = this.get(c.code)!;
    this.pushChallenge(updated);
    this.onMatchStart(m);
    return updated;
  }

  private reopen(c: Challenge, why: string) {
    // refund whoever already paid, except the creator (their stake stays for the next acceptor)
    const paid = this.db
      .prepare("SELECT * FROM payments WHERE challenge_code = ? AND kind = 'stake' AND status IN ('pending','paid')")
      .all(c.code) as unknown as Payment[];
    for (const p of paid) {
      if (p.user_id === c.creator) continue;
      if (p.status === "paid") this.queueRefund(p, why);
      else this.cancelPending(p);
    }
    const stillHere = this.creatorPresence.get(c.code) === 0;
    this.db
      .prepare("UPDATE challenges SET status = ?, acceptor = NULL, acceptor_name = NULL WHERE code = ?")
      .run(stillHere ? "open" : "cancelled", c.code);
    if (!stillHere) this.refundAllStakes(c.code, why);
    if (c.acceptor) this.notify(c.acceptor, { t: "challenge", challenge: this.view(this.get(c.code)!, c.acceptor), note: why });
    this.pushChallenge(this.get(c.code)!, why);
  }

  cancelChallenge(code: string, why: string, status: "cancelled" | "expired" = "cancelled") {
    const c = this.get(code);
    if (!c || c.status === "started" || c.status === "cancelled" || c.status === "expired") return;
    this.db.prepare("UPDATE challenges SET status = ? WHERE code = ?").run(status, code);
    this.refundAllStakes(code, why);
    this.creatorPresence.delete(code);
    this.pushChallenge(this.get(code)!, why);
    if (c.acceptor) this.notify(c.acceptor, { t: "challenge", challenge: this.view(this.get(code)!, c.acceptor), note: why });
  }

  private refundAllStakes(code: string, why: string) {
    const ps = this.db
      .prepare("SELECT * FROM payments WHERE challenge_code = ? AND kind = 'stake' AND status IN ('pending','paid')")
      .all(code) as unknown as Payment[];
    for (const p of ps) {
      if (p.status === "paid") this.queueRefund(p, why);
      else this.cancelPending(p);
    }
  }

  private cancelPending(p: Payment) {
    this.db.prepare("UPDATE payments SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'").run(now(), p.id);
    if (p.proposal_id) {
      this.api.cancelProposal(p.proposal_id).catch(async () => {
        // It may have been approved in the meantime; re-check and refund if so.
        try {
          const prop = await this.api.getProposal(p.proposal_id!);
          if (prop.status === "Approved") {
            this.db.prepare("UPDATE payments SET status = 'paid', updated_at = ? WHERE id = ?").run(now(), p.id);
            this.queueRefund({ ...p, status: "paid" }, "cancelled after approval");
          }
        } catch (e) {
          log.warn("cancel recheck failed", { id: p.id, err: String(e) });
        }
      });
    }
  }

  private queueRefund(stake: Payment, why: string) {
    // mark the stake as consumed so it can't be refunded twice
    const r = this.db
      .prepare("UPDATE payments SET status = 'cancelled', note = ?, updated_at = ? WHERE id = ? AND status = 'paid'")
      .run(`refunded: ${why}`, now(), stake.id);
    if (r.changes === 0) return;
    this.queueTransfer(stake.user_id, stake.amount, "refund", stake.challenge_code, stake.match_id, why);
  }

  private queueTransfer(userId: string, amount: number, kind: "payout" | "refund", code: string | null, matchId: string | null, note: string) {
    if (amount <= 0) return;
    this.db
      .prepare(`INSERT INTO payments (id, challenge_code, match_id, user_id, kind, amount, status, note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(randomId(9), code, matchId, userId, kind, amount, note, now(), now());
    setImmediate(() => void this.processPayouts());
  }

  private processing = false;
  async processPayouts() {
    if (this.processing || !this.ready()) return;
    this.processing = true;
    try {
      const due = this.db
        .prepare("SELECT * FROM payments WHERE kind IN ('payout','refund') AND status = 'pending' ORDER BY created_at LIMIT 20")
        .all() as unknown as Payment[];
      if (!due.length) return;
      let recent: Awaited<ReturnType<typeof this.api.recentAppTransactions>> | null = null;
      for (const p of due) {
        const tag = `#${p.id}`;
        // Idempotency: if a previous attempt went through but we crashed before recording it, don't pay twice.
        if (p.updated_at !== p.created_at) {
          recent ??= await this.api.recentAppTransactions(200).catch(() => null);
          if (!recent) continue;
          if (recent.some((t) => t.description?.includes(tag))) {
            this.db.prepare("UPDATE payments SET status = 'paid', updated_at = ? WHERE id = ?").run(now(), p.id);
            continue;
          }
        }
        this.db.prepare("UPDATE payments SET updated_at = ? WHERE id = ?").run(now() + 1, p.id);
        const desc = p.kind === "payout" ? `Hexstake winnings ${tag}` : `Hexstake refund ${tag}`;
        try {
          await this.api.transfer(p.user_id, serbleApi.coinsToRaw(p.amount), desc);
          this.db.prepare("UPDATE payments SET status = 'paid', updated_at = ? WHERE id = ?").run(now(), p.id);
          track(p.kind === "payout" ? "payout_paid" : "refund_paid", p.user_id, { amount: p.amount, match: p.match_id });
          this.notify(p.user_id, { t: "toast", text: p.kind === "payout" ? `You won ${p.amount} coins!` : `Refunded ${p.amount} coins` });
        } catch (e) {
          const err = String(e);
          log.error("transfer failed", { id: p.id, err });
          track("error", p.user_id, { where: "transfer", id: p.id, err: err.slice(0, 300) });
          // Permanent-looking failures get parked for manual attention after a few tries.
          const attempts = (p.note?.match(/\[attempt (\d+)\]/)?.[1] ?? "0");
          const n = Number(attempts) + 1;
          const note = `${(p.note ?? "").replace(/ ?\[attempt \d+\]/, "")} [attempt ${n}]`;
          this.db.prepare("UPDATE payments SET note = ?, status = ? WHERE id = ?").run(note, n >= 20 ? "failed" : "pending", p.id);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** Called by the match manager when a match ends. */
  settle(m: LiveMatch) {
    if (m.mode !== "staked" || m.stake <= 0) return;
    const stakes = this.db
      .prepare("SELECT * FROM payments WHERE match_id = ? AND kind = 'stake' AND status = 'paid'")
      .all(m.id) as unknown as Payment[];
    const winner = m.state.winner;
    const mark = (p: Payment, note: string) =>
      this.db.prepare("UPDATE payments SET status = 'cancelled', note = ?, updated_at = ? WHERE id = ? AND status = 'paid'").run(note, now(), p.id);
    if (winner === null) {
      for (const p of stakes) this.queueRefund(p, "draw");
      return;
    }
    const winnerId = m.seats[winner].id;
    const loserId = m.seats[winner === 0 ? 1 : 0].id;
    let changed = 0;
    for (const p of stakes) changed += Number(mark(p, "settled").changes);
    if (changed === 0) return; // already settled
    const pot = stakes.reduce((a, p) => a + p.amount, 0);
    const payout = pot - Math.floor((pot * config.rakePercent) / 100);
    this.queueTransfer(winnerId, payout, "payout", null, m.id, `won match ${m.id}`);
    this.db.prepare("UPDATE users SET coins_won = coins_won + ? WHERE id = ?").run(Math.round(payout - m.stake), winnerId);
    this.db.prepare("UPDATE users SET coins_lost = coins_lost + ? WHERE id = ?").run(m.stake, loserId);
  }

  /** Staked matches that could not be resumed after a restart: refund both sides. */
  private refundCancelledMatches() {
    const ps = this.db
      .prepare(`SELECT p.* FROM payments p JOIN matches m ON m.id = p.match_id
                WHERE p.kind = 'stake' AND p.status = 'paid' AND m.status = 'cancelled'`)
      .all() as unknown as Payment[];
    for (const p of ps) this.queueRefund(p, "match cancelled");
  }

  paymentsFor(userId: string) {
    return this.db
      .prepare("SELECT id, kind, amount, status, match_id, challenge_code, consent_url, created_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
      .all(userId);
  }

  pushChallenge(c: Challenge, note?: string) {
    for (const uid of [c.creator, c.acceptor].filter(Boolean) as string[]) {
      this.notify(uid, { t: "challenge", challenge: this.view(c, uid), note });
    }
  }
}
