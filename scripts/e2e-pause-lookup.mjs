// Verifies pauseMode "onLookup" (renamed "Pause on lookup"): browsing/hovering the subtitle
// list does NOT pause the video; only an actual look-up pauses it, and closing the look-up
// resumes. Run: node scripts/e2e-pause-lookup.mjs
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
const check = (n, ok, extra = "") => { console.log(`${ok ? "  ✅" : "  ❌"} ${n}${extra ? "  " + extra : ""}`); if (!ok) failures++; };

const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: ["--headless=new", "--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run", "--no-default-browser-check"],
});

try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }));
  const page = await context.newPage();
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 8000 });

  // Turn on "Pause on lookup" for this host (the content app live-syncs storage changes).
  await sw.evaluate(() => chrome.storage.local.set({ "tnm:settings:127.0.0.1": { pauseMode: "onLookup" } }));
  await page.waitForTimeout(300);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    page.locator('[data-tip*="Import"]').click(),
  ]);
  await chooser.setFiles(resolve(testDir, "sample.ja.srt"));

  await page.locator("ruby.tnm-reading rt").first().waitFor({ timeout: 40000 }).catch(() => {});
  const browserWord = page.locator(".TnmBrowser__list__item .tnm-token.-tnm-word").first();
  await browserWord.waitFor({ timeout: 15000 });

  const isPaused = () => page.evaluate(() => document.querySelector("video")?.paused);
  await page.evaluate(() => document.querySelector("video")?.play().catch(() => {}));
  await page.waitForFunction(() => document.querySelector("video") && !document.querySelector("video").paused, null, { timeout: 5000 }).catch(() => {});
  check("video is playing to start", (await isPaused()) === false);

  // 1) Browsing the subtitle list (plain hover, no modifier) must NOT pause.
  await page.locator(".TnmBrowser__list__item").first().hover();
  await page.locator(".TnmBrowser__list__item").nth(2).hover();
  await page.waitForTimeout(700);
  check("hovering / browsing the subtitle list does NOT pause", (await isPaused()) === false);

  // 2) Hold the look-up key (Alt) + hover a word → look-up → the video pauses.
  const box = await browserWord.boundingBox();
  await page.keyboard.down("Alt");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator(".tnm-lookup").waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector("video").paused, null, { timeout: 3000 }).catch(() => {});
  check("looking up a word pauses the video", (await isPaused()) === true);

  // 3) Move away → the transient look-up closes → playback resumes.
  await page.keyboard.up("Alt");
  await page.mouse.move(8, 8);
  await page.waitForFunction(() => !document.querySelector("video").paused, null, { timeout: 4000 }).catch(() => {});
  check("closing the look-up resumes playback", (await isPaused()) === false);

  await page.screenshot({ path: resolve(testDir, "e2e-pause-lookup.png") });
} catch (e) {
  console.log("  ❌ fatal:", String(e?.stack || e).split("\n").slice(0, 3).join("\n"));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nPAUSE ON LOOKUP: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
