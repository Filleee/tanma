// Confirms the ＋ "Add to Anki" button appears on the lookup popup ONLY when
// mining is enabled (settings.ankiEnabled). Run: node scripts/e2e-anki-button.mjs
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

async function clickWordAndCheckMine(page) {
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
  return page.locator(".tnm-lookup__mine").count();
}

try {
  let sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }).catch(() => null));
  check("extension loaded", !!sw);

  // 1) Default (mining OFF) → no ＋ button.
  const page1 = await context.newPage();
  await page1.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page1.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  const offCount = await clickWordAndCheckMine(page1);
  check("no ＋ button when mining is disabled (default)", offCount === 0);
  await page1.close();

  // 2) Enable mining in storage → ＋ button shows.
  await sw.evaluate(async () => {
    const got = await chrome.storage.local.get("tnm:settings");
    await chrome.storage.local.set({ "tnm:settings": { ...(got["tnm:settings"] ?? {}), ankiEnabled: true, ankiDeck: "Mining", ankiModel: "lapis-simplified" } });
  });
  const page2 = await context.newPage();
  await page2.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page2.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  const onCount = await clickWordAndCheckMine(page2);
  check("＋ button shows when mining is enabled", onCount >= 1);
  console.log("    mine buttons found:", onCount);
  await page2.screenshot({ path: resolve(testDir, "e2e-anki-button.png") });
  await page2.close();

  // 3) A word already in the mined store → popup shows ✓ (-mined), not ＋. Cue #1 starts with 日本語.
  await sw.evaluate(async () => {
    const got = await chrome.storage.local.get("tnm:settings");
    await chrome.storage.local.set({
      "tnm:settings": { ...(got["tnm:settings"] ?? {}), ankiEnabled: true, ankiDeck: "Mining", ankiModel: "lapis-simplified" },
      "tnm:mined": { words: ["日本語"], sentences: [] },
    });
  });
  const page3 = await context.newPage();
  await page3.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page3.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  await clickWordAndCheckMine(page3); // opens the lookup for the first word (日本語)
  const minedBtn = page3.locator(".tnm-lookup__mine");
  const isMined = await minedBtn.evaluate((b) => b.classList.contains("-mined")).catch(() => false);
  check("already-mined word shows ✓ (‑mined) instead of ＋", isMined);
  await page3.screenshot({ path: resolve(testDir, "e2e-anki-button-mined.png") });
  await page3.close();
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nMINE BUTTON: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
