// Verifies per-media persistence across a reload: the imported subtitle TRACK is restored (no
// re-import) and the mining QUEUE is restored. Run: node scripts/e2e-persist.mjs
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

const seekToCue = (page) => page.evaluate(async () => { const v = document.querySelector("video"); try { await v.play().catch(() => {}); } catch {} v.currentTime = 2.0; });

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

  // Import a subtitle file → sets a "file" track (should persist).
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    page.locator('[data-tip*="Import"]').click(),
  ]);
  await chooser.setFiles(resolve(testDir, "sample.ja.srt"));
  await seekToCue(page);
  await page.locator(".tnm-token.-tnm-word").first().waitFor({ timeout: 20000 });

  // Queue the first word.
  await page.locator(".tnm-token.-tnm-word").first().click();
  await page.locator(".tnm-lookup").waitFor({ state: "visible", timeout: 6000 });
  await page.locator(".tnm-lookup__queue").click();
  await page.waitForTimeout(200);
  check("queued before reload (badge = 1)", (await page.locator(".TnmBar__queue__badge").textContent()).trim() === "1");

  // Give storage writes a beat, then RELOAD.
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  await seekToCue(page);

  // The subtitle track should be restored WITHOUT re-importing → tokens render again.
  const restoredTrack = await page.locator(".tnm-token.-tnm-word").first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  check("subtitle track restored after reload (no re-import)", restoredTrack);

  // And the queue should be restored → badge still 1.
  await page.waitForTimeout(300);
  const badge = await page.locator(".TnmBar__queue__badge").textContent().catch(() => "");
  check("queue restored after reload (badge = 1)", badge.trim() === "1");

  // Open the queue panel → the row is there.
  await page.locator(".TnmBar__queue").click();
  await page.locator(".tnm-queue").waitFor({ state: "visible", timeout: 4000 });
  check("restored queue lists the word", (await page.locator(".tnm-queue__row").count()) === 1);

  await page.screenshot({ path: resolve(testDir, "e2e-persist.png") });
  await page.close();
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nPERSISTENCE: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
