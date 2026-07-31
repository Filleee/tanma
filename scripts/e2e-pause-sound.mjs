// Verifies pause-on-hover (pauseMode=onLookup) and the lookup pronounce button.
// Run: node scripts/e2e-pause-sound.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");
const testDir = resolve(root, "test");
const TYPES = { ".html": "text/html", ".webm": "video/webm" };

const server = await new Promise((res) => {
  const s = createServer(async (req, res2) => {
    try {
      const name = (req.url || "/").split("?")[0].replace(/^\/+/, "") || "auto.html";
      const buf = await readFile(resolve(testDir, name));
      res2.writeHead(200, { "content-type": TYPES[extname(name)] || "application/octet-stream" });
      res2.end(buf);
    } catch {
      res2.writeHead(404);
      res2.end("nf");
    }
  });
  s.listen(0, "127.0.0.1", () => res(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (n, ok) => { console.log(`${ok ? "  ✅" : "  ❌"} ${n}`); if (!ok) failures++; };
const paused = (page) => page.evaluate(() => document.querySelector("video").paused);

const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: ["--headless=new", "--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run"],
});

try {
  // Enable pause-on-lookup via the background service worker before loading the page.
  let sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }));
  await sw.evaluate(async () => {
    const cur = (await chrome.storage.local.get("tnm:settings"))["tnm:settings"] || {};
    await chrome.storage.local.set({ "tnm:settings": { ...cur, pauseMode: "onLookup", enabled: true, targetLang: "ja", autoResume: 0 } });
  });

  const page = await context.newPage();
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 10000 });

  // Import the sample subtitles via the toolbar.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('[data-tip*="Import"]').click(),
  ]);
  await chooser.setFiles(resolve(testDir, "sample.ja.srt"));

  // Put us inside a cue and start playback.
  await page.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 2; v.play().catch(() => {}); });
  await page.locator(".tnm-token").first().waitFor({ timeout: 20000 });

  await page.waitForTimeout(300);
  check("video is playing before hover", (await paused(page)) === false);

  // Hover the subtitle → should pause.
  await page.locator(".TnmSubs__targetSubs").hover();
  await page.waitForTimeout(150);
  check("hovering subtitle pauses the video", (await paused(page)) === true);

  // Move away → should resume.
  await page.mouse.move(3, 3);
  await page.waitForTimeout(700);
  check("leaving subtitle resumes the video", (await paused(page)) === false);

  // Hover the subtitle browser → should also pause.
  await page.evaluate(() => document.querySelector("video").play().catch(() => {}));
  await page.waitForTimeout(150);
  await page.locator(".TnmBrowser").hover();
  await page.waitForTimeout(150);
  check("hovering subtitle browser pauses the video", (await paused(page)) === true);
  await page.mouse.move(3, 3);
  await page.waitForTimeout(700);

  // Hover a word → lookup popup opens and has the pronounce button.
  await page.evaluate(() => document.querySelector("video").play().catch(() => {}));
  await page.locator(".TnmSubs__targetSubs .tnm-token.-tnm-word").first().hover();
  await page.locator(".tnm-lookup").waitFor({ state: "visible", timeout: 6000 });
  check("lookup has a pronounce (sound) button", await page.locator(".tnm-lookup__speak").isVisible());
  await page.locator(".tnm-lookup__speak").click().catch(() => {}); // shouldn't throw

  await page.screenshot({ path: resolve(testDir, "e2e-pause-sound.png") });
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nPAUSE-ON-HOVER + SOUND: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
