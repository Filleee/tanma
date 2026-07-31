// Verifies the mining QUEUE flow (no Anki needed): a look-up's queue button adds the word, the
// toolbar badge reflects the count, and the queue panel lists the queued item + can remove it.
// Run: node scripts/e2e-queue.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");
const testDir = resolve(root, "test");
const TYPES = { ".html": "text/html", ".webm": "video/webm", ".srt": "text/plain; charset=utf-8" };

const server = await new Promise((res) => {
  const s = createServer(async (req, res2) => {
    try {
      const name = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "auto.html";
      const buf = await readFile(resolve(testDir, name));
      res2.writeHead(200, { "content-type": TYPES[extname(name)] || "application/octet-stream" });
      res2.end(buf);
    } catch { res2.writeHead(404); res2.end("nf"); }
  });
  s.listen(0, "127.0.0.1", () => res(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (n, ok) => { console.log(`${ok ? "  ✅" : "  ❌"} ${n}`); if (!ok) failures++; };

const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: ["--headless=new", "--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run", "--no-default-browser-check"],
});

async function openLookup(page) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    page.locator('[data-tip*="Import"]').click(),
  ]);
  await chooser.setFiles(resolve(testDir, "sample.ja.srt"));
  await page.evaluate(async () => { const v = document.querySelector("video"); try { await v.play().catch(() => {}); } catch {} v.currentTime = 2.0; });
  await page.locator(".tnm-token.-tnm-word").first().waitFor({ timeout: 20000 });
  await page.locator(".tnm-token.-tnm-word").first().click();
  await page.locator(".tnm-lookup").waitFor({ state: "visible", timeout: 6000 });
  await page.waitForTimeout(150);
}

try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }).catch(() => null));
  check("extension loaded", !!sw);

  await sw.evaluate(async () => {
    const got = await chrome.storage.local.get("tnm:settings");
    await chrome.storage.local.set({ "tnm:settings": { ...(got["tnm:settings"] ?? {}), ankiEnabled: true, ankiDeck: "Mining", ankiModel: "lapis-simplified" } });
  });

  const page = await context.newPage();
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });

  await openLookup(page);
  const queueBtn = page.locator(".tnm-lookup__queue");
  check("queue button present on the look-up", (await queueBtn.count()) === 1);

  await queueBtn.click();
  await page.waitForTimeout(150);
  const badge = await page.locator(".TnmBar__queue__badge").textContent().catch(() => "");
  check("toolbar badge shows 1 after queueing", badge.trim() === "1");
  const queuedFlag = await queueBtn.evaluate((b) => b.classList.contains("-mined")).catch(() => false);
  check("queue button reflects queued state", queuedFlag);

  // Open the queue panel via the toolbar button and confirm the row is listed.
  await page.locator(".TnmBar__queue").click();
  await page.locator(".tnm-queue").waitFor({ state: "visible", timeout: 4000 });
  const rows = await page.locator(".tnm-queue__row").count();
  check("queue panel lists the queued word", rows === 1);

  // Remove it → badge clears.
  await page.locator(".tnm-queue__row__del").first().click();
  await page.waitForTimeout(120);
  const badge2 = await page.locator(".TnmBar__queue__badge").textContent().catch(() => "x");
  check("removing the row clears the badge", badge2.trim() === "");
  check("queue panel is empty after removal", (await page.locator(".tnm-queue__row").count()) === 0);

  await page.screenshot({ path: resolve(testDir, "e2e-queue.png") });
  await page.close();
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nMINING QUEUE: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
