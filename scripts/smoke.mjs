// Production smoke test: loads the site in a real browser, starts a bot match over the
// WebSocket, plays a turn and checks it resolves. Usage: node scripts/smoke.mjs [url]
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://hexstake.app";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
let ok = false;
try {
  await page.goto(base, { waitUntil: "load", timeout: 45000 });
  await page.click("text=Play now");
  await page.waitForSelector("canvas.board", { timeout: 15000 });
  await page.waitForSelector("text=Turn 1", { timeout: 10000 });
  await page.click('button:has-text("Pass turn"):visible');
  await page.waitForSelector("text=Turn 2", { timeout: 40000 });
  page.once("dialog", (d) => d.accept());
  await page.click("text=Resign");
  await page.waitForSelector(".end", { timeout: 10000 });
  ok = true;
  console.log("smoke: bot match started, turn resolved, resign ended the match");
} catch (e) {
  console.log("smoke failed:", String(e).split("\n")[0]);
  await page.screenshot({ path: "smoke-failure.png" });
} finally {
  if (errors.length) console.log("browser errors:", JSON.stringify(errors.slice(0, 10)));
  await browser.close();
}
process.exit(ok ? 0 : 1);
