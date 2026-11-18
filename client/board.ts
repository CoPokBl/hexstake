// Canvas hex-board renderer with hit testing.
import { Axial, board, Board, CellChange, GameState, Orders, Player, targetable } from "../shared/game";

export interface Palette {
  bg: string;
  plain: string;
  plainEdge: string;
  rock: string;
  well: string;
  mine: string;
  mineDim: string;
  theirs: string;
  theirsDim: string;
  text: string;
  textDim: string;
  highlight: string;
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    bg: v("--board-bg"), plain: v("--hex-plain"), plainEdge: v("--hex-edge"), rock: v("--hex-rock"),
    well: v("--hex-well"), mine: v("--p-mine"), mineDim: v("--p-mine-dim"), theirs: v("--p-theirs"),
    theirsDim: v("--p-theirs-dim"), text: v("--text"), textDim: v("--text-dim"), highlight: v("--highlight"),
  };
}

export interface BoardView {
  state: GameState;
  me: Player | null; // perspective (null = spectator: seat 0 colors as "mine")
  orders: Orders; // my pending orders
  reveal?: { changes: CellChange[]; orders: [Orders, Orders] } | null;
  interactive: boolean;
  hover?: number | null;
}

const SQRT3 = Math.sqrt(3);

export class BoardRenderer {
  private ctx: CanvasRenderingContext2D;
  private size = 30;
  private ox = 0;
  private oy = 0;
  private b: Board;
  private pal: Palette;
  private flip = false;
  private dpr = 1;
  view: BoardView | null = null;

  constructor(private canvas: HTMLCanvasElement, radius: number) {
    this.ctx = canvas.getContext("2d")!;
    this.b = board(radius);
    this.pal = readPalette();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.pal = readPalette();
      this.draw();
    });
  }

  refreshPalette() {
    this.pal = readPalette();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    const R = this.b.radius;
    // board extents in units of size
    const w = SQRT3 * (2 * R + 1);
    const h = 1.5 * (2 * R) + 2;
    this.size = Math.min(rect.width / w, rect.height / h) * 0.98;
    this.ox = rect.width / 2;
    this.oy = rect.height / 2;
    this.draw();
  }

  private toPixel(c: Axial): [number, number] {
    const q = this.flip ? -c.q : c.q;
    const r = this.flip ? -c.r : c.r;
    return [this.ox + this.size * SQRT3 * (q + r / 2), this.oy + this.size * 1.5 * r];
  }

  hitTest(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left - this.ox;
    const y = clientY - rect.top - this.oy;
    let q = ((SQRT3 / 3) * x - (1 / 3) * y) / this.size;
    let r = ((2 / 3) * y) / this.size;
    // cube round
    let s = -q - r;
    let rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
    const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) rq = -rr - rs;
    else if (dr > ds) rr = -rq - rs;
    if (this.flip) {
      rq = -rq;
      rr = -rr;
    }
    const idx = this.b.index.get(`${rq},${rr}`);
    return idx ?? null;
  }

  private hexPath(cx: number, cy: number, s: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      const x = cx + s * Math.cos(a);
      const y = cy + s * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  draw() {
    const v = this.view;
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!v) return;
    this.flip = v.me === 1;
    const p = this.pal;
    const mine: Player = v.me ?? 0;
    const s = v.state;
    const reach = v.interactive && v.me !== null ? targetable(s, v.me) : null;
    const changes = new Map((v.reveal?.changes ?? []).map((c) => [c.idx, c]));
    const font = (px: number, weight = 600) => `${weight} ${Math.round(px)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;

    this.b.coords.forEach((c, idx) => {
      const cell = s.cells[idx];
      const [x, y] = this.toPixel(c);
      const inner = this.size * 0.94;
      let fill = p.plain;
      if (cell.kind === "rock") fill = p.rock;
      else if (cell.owner !== null) fill = cell.owner === mine ? p.mine : p.theirs;
      else if (cell.kind === "well") fill = p.plain;

      this.hexPath(x, y, inner);
      ctx.fillStyle = fill;
      ctx.globalAlpha = cell.owner !== null ? 0.35 + Math.min(1, cell.strength / 8) * 0.65 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (cell.kind === "rock") {
        ctx.fillStyle = p.textDim;
        ctx.globalAlpha = 0.35;
        this.hexPath(x, y, inner * 0.45);
        ctx.fill();
        ctx.globalAlpha = 1;
        return;
      }

      // outline
      ctx.lineWidth = Math.max(1, this.size * 0.06);
      ctx.strokeStyle = p.plainEdge;
      this.hexPath(x, y, inner);
      ctx.stroke();

      if (cell.kind === "well") {
        ctx.strokeStyle = p.well;
        ctx.lineWidth = Math.max(2, this.size * 0.1);
        ctx.beginPath();
        ctx.arc(x, y, inner * 0.62, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (cell.kind === "home") {
        ctx.strokeStyle = cell.owner === mine || (cell.owner === null && s.homes[mine] === idx) ? p.mine : p.theirs;
        ctx.lineWidth = Math.max(2, this.size * 0.12);
        this.hexPath(x, y, inner * 0.72);
        ctx.stroke();
      }

      if (reach && reach.has(idx)) {
        ctx.strokeStyle = p.highlight;
        ctx.lineWidth = Math.max(1.5, this.size * 0.07);
        ctx.setLineDash([this.size * 0.18, this.size * 0.14]);
        this.hexPath(x, y, inner * 0.9);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (v.hover === idx && reach?.has(idx)) {
        ctx.fillStyle = p.highlight;
        ctx.globalAlpha = 0.18;
        this.hexPath(x, y, inner);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // strength
      if (cell.strength > 0 || cell.owner !== null) {
        ctx.fillStyle = p.text;
        ctx.font = font(this.size * 0.62, 700);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(cell.strength), x, y + this.size * 0.02);
      }

      // pending orders badge
      const mineOrder = v.orders[idx];
      if (mineOrder && !v.reveal) this.badge(x, y - inner * 0.62, `+${mineOrder}`, p.mine);

      // reveal: both bids
      const ch = changes.get(idx);
      if (ch && v.reveal) {
        const myBid = ch.bids[mine];
        const theirBid = ch.bids[mine === 0 ? 1 : 0];
        if (myBid) this.badge(x - inner * 0.42, y - inner * 0.6, String(myBid), p.mine);
        if (theirBid) this.badge(x + inner * 0.42, y - inner * 0.6, String(theirBid), p.theirs);
        if (ch.decayed) {
          ctx.fillStyle = p.textDim;
          ctx.font = font(this.size * 0.34, 600);
          ctx.fillText("−1", x, y + inner * 0.55);
        }
        if (ch.before.owner !== ch.after.owner) {
          ctx.strokeStyle = p.text;
          ctx.lineWidth = Math.max(2, this.size * 0.08);
          this.hexPath(x, y, inner);
          ctx.stroke();
        }
      }
    });
  }

  private badge(x: number, y: number, text: string, color: string) {
    const ctx = this.ctx;
    const h = this.size * 0.5;
    ctx.font = `700 ${Math.round(this.size * 0.36)}px ui-sans-serif, system-ui, sans-serif`;
    const w = Math.max(h, ctx.measureText(text).width + h * 0.6);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 1);
  }
}
