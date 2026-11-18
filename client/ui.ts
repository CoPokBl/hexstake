type Attrs = Record<string, string | boolean | number | ((e: any) => void) | undefined | null>;
type Child = Node | string | null | undefined | false;

export function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "value" && "value" in el) (el as HTMLInputElement).value = String(v);
    else if (k === "checked") (el as HTMLInputElement).checked = Boolean(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let toastWrap: HTMLElement | null = null;
export function toast(text: string, kind: "info" | "error" = "info") {
  if (!toastWrap) {
    toastWrap = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastWrap);
  }
  const t = h("div", { class: `toast ${kind}` }, text);
  toastWrap.append(t);
  setTimeout(() => t.classList.add("out"), 3200);
  setTimeout(() => t.remove(), 3700);
}

export function timeAgo(ts: number | null): string {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const fmtCoins = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export async function api(path: string): Promise<any> {
  try {
    const r = await fetch(path, { headers: { Accept: "application/json" } });
    if (r.status === 404) return r.json().catch(() => ({ error: "not found" }));
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

export async function post(path: string, body: unknown): Promise<any> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json().catch(() => null);
  } catch {
    return null;
  }
}

const ICONS: Record<string, string> = {
  logo: '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path d="M16 2 28 9v14l-12 7-12-7V9z" fill="var(--p-mine)"/><path d="M16 9l6 3.5v7L16 23l-6-3.5v-7z" fill="var(--bg)"/><path d="M16 12.5l3 1.75v3.5L16 19.5l-3-1.75v-3.5z" fill="var(--p-theirs)"/></svg>',
  bolt: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9 1 3 9h4l-1 6 6-8H8z" fill="currentColor"/></svg>',
  hex: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1l6 3.5v7L8 15l-6-3.5v-7z" fill="currentColor"/></svg>',
};

export function icon(name: string): HTMLElement {
  const s = document.createElement("span");
  s.className = `icon icon-${name}`;
  s.innerHTML = ICONS[name] ?? "";
  return s;
}
