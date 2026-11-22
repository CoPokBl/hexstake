// Interactive tutorial: a short sequence of steps shown during a tutorial match. Each step
// points at a hex on the board and advances when the player actually does the thing.
import { board, connected, distance, GameState, Orders, Player } from "../shared/game";

export interface TutorialCtx {
  state: GameState;
  me: Player;
  orders: Orders;
  submitted: boolean;
}

interface Step {
  id: string;
  text: (c: TutorialCtx, t: Tutorial) => string;
  /** Hex to highlight, if any. */
  focus?: (c: TutorialCtx, t: Tutorial) => number | null;
  /** Auto-advance when this returns true. Steps without it show a "Next" button. */
  done?: (c: TutorialCtx, t: Tutorial) => boolean;
  button?: string;
}

const STEPS: Step[] = [
  {
    id: "claim",
    text: () =>
      "Your home is the hex with the house: if your opponent captures it, you lose. Start by tapping the pulsing hex next to it to claim it.",
    focus: (_c, t) => t.claimTarget,
    done: (c, t) => (t.claimTarget !== null ? (c.orders[t.claimTarget] ?? 0) > 0 : Object.keys(c.orders).length > 0),
  },
  {
    id: "lock",
    text: () => "That put 1 energy on it: a bid to claim it. Now press Lock in. Both players plan at the same time, then every order resolves at once.",
    done: (c) => c.submitted,
  },
  {
    id: "wait",
    text: () => "Waiting for the turn to resolve…",
    done: (c, t) => c.state.turn > t.startTurn,
  },
  {
    id: "claimed",
    text: (c, t) =>
      t.claimTarget !== null && c.state.cells[t.claimTarget].owner === c.me
        ? "It's yours! The number on a hex is its strength: how much energy the enemy must beat to take it. Your home gives you +4 energy every turn."
        : "Hexes you own show their strength: how much energy the enemy must beat to take them. Your home gives you +4 energy every turn.",
    focus: (_c, t) => t.claimTarget,
    button: "Next",
  },
  {
    id: "well",
    text: (c) => {
      const w = nearestWell(c);
      const guard = w !== null ? c.state.cells[w].strength : 2;
      return `Ringed hexes are wells: +2 energy every turn while they're connected to your home. Expand toward this one, then claim it with a bid above its guard of ${guard}.`;
    },
    focus: (c) => nearestWell(c),
    done: (c) => ownsWell(c),
    button: "Skip",
  },
  {
    id: "attack",
    text: () =>
      "Last thing: the orange house is the enemy home. Capture it to win. Homes regain 2 strength a turn (up to 12), so bank energy, get next to it, and hit it with more than its strength. Watch their bank too: a big bank next to your home means an attack is coming.",
    focus: (c) => c.state.homes[c.me === 0 ? 1 : 0],
    button: "Finish tutorial",
  },
];

function nearestWell(c: TutorialCtx): number | null {
  const b = board(c.state.config.radius);
  const mine = [...connected(c.state, c.me)];
  let best: number | null = null;
  let bestD = Infinity;
  c.state.cells.forEach((cell, i) => {
    if (cell.kind !== "well" || cell.owner === c.me) return;
    const d = Math.min(...mine.map((m) => distance(b.coords[m], b.coords[i])));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function ownsWell(c: TutorialCtx): boolean {
  return c.state.cells.some((cell) => cell.kind === "well" && cell.owner === c.me);
}

export class Tutorial {
  step = 0;
  claimTarget: number | null = null;
  startTurn = 1;
  finished = false;

  constructor(public matchId: string, init: TutorialCtx) {
    this.startTurn = init.state.turn;
    // Pick a plain neutral neighbour of home, preferring the direction of the nearest well.
    const b = board(init.state.config.radius);
    const home = init.state.homes[init.me];
    const well = nearestWell(init);
    const options = b.neighbors[home].filter((n) => init.state.cells[n].kind === "plain" && init.state.cells[n].owner === null);
    options.sort((x, y) => (well === null ? 0 : distance(b.coords[x], b.coords[well]) - distance(b.coords[y], b.coords[well])));
    this.claimTarget = options[0] ?? null;
  }

  /** True while the player must act on the board before locking in. */
  get blocksLockIn(): boolean {
    return this.current?.id === "claim";
  }

  get current(): Step | null {
    return this.finished ? null : STEPS[this.step] ?? null;
  }

  /** Advance through any steps whose condition is met. Returns true if the step changed. */
  update(c: TutorialCtx): boolean {
    let changed = false;
    for (let guard = 0; guard < STEPS.length; guard++) {
      const s = this.current;
      if (!s?.done || !s.done(c, this)) break;
      if (s.id === "lock") this.startTurn = c.state.turn;
      this.next();
      changed = true;
    }
    return changed;
  }

  next() {
    this.step++;
    if (this.step >= STEPS.length) this.finished = true;
  }

  focus(c: TutorialCtx): number | null {
    return this.current?.focus?.(c, this) ?? null;
  }

  text(c: TutorialCtx): string {
    return this.current?.text(c, this) ?? "";
  }

  get progress(): string {
    return `${Math.min(this.step + 1, STEPS.length)}/${STEPS.length}`;
  }
}

const DONE_KEY = "hx_tutorial_done";
export function tutorialDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return true;
  }
}
export function markTutorialDone() {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* ignore */
  }
}
