// Verifies the TANMA!-style dock: the browser wraps YouTube's #player in a flex
// row with a fixed-width standin, so the player SHRINKS and the browser sits in
// the reserved gap between the (now-narrower) video and the chat — outside the
// player — and below the masthead. Tearing down restores the player. Uses a fake
// watch layout (real YouTube blocks headless). Run: node scripts/e2e-dock.mjs
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
      const name = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "youtube-fake.html";
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
const rectOf = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; }, sel);

const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: ["--headless=new", "--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run", "--no-default-browser-check", "--window-size=1600,900"],
});

try {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${base}/youtube-fake.html`, { waitUntil: "load" });
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 8000 });

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    page.locator('[data-tip*="Import"]').click(),
  ]);
  await chooser.setFiles(resolve(testDir, "sample.ja.srt"));

  // Our flex row should wrap the player.
  await page.waitForFunction(() => document.querySelector(".tnm-dock-row #player") !== null, { timeout: 8000 }).catch(() => {});
  check("player wrapped in our dock row", await page.evaluate(() => !!document.querySelector(".tnm-dock-row > #player") && !!document.querySelector(".tnm-dock-row > .tnm-dock-standin")));

  await page.waitForTimeout(300);
  const player = await rectOf(page, "#movie_player");
  const secondary = await rectOf(page, "#secondary");
  const masthead = await rectOf(page, "#masthead");
  const bb = await page.locator(".TnmBrowser").boundingBox().catch(() => null);
  const browser = bb ? { left: bb.x, right: bb.x + bb.width, top: bb.y, bottom: bb.y + bb.height, width: bb.width } : null;

  // The player shrank (started at 1280px in the fixture).
  check("video player shrank to make room", player && player.width < 1000, `(player width ${player ? Math.round(player.width) : "?"}px, was 1280)`);

  // YouTube's control bar (1256px in the fixture) must be refit so it doesn't
  // overflow the shrunk player to the right (under the dock).
  const chrome = await rectOf(page, ".ytp-chrome-bottom");
  check("player controls refit inside the shrunk player", chrome && player && chrome.right <= player.right + 2, `(controls.right ${chrome ? Math.round(chrome.right) : "?"} vs player.right ${player ? Math.round(player.right) : "?"})`);

  if (browser && player && secondary) {
    check("browser is right of the (shrunk) video", browser.left >= player.right - 2, `(browser.left ${Math.round(browser.left)} vs video.right ${Math.round(player.right)})`);
    check("browser is left of the chat (no overlap)", browser.right <= secondary.left + 2, `(browser.right ${Math.round(browser.right)} vs chat.left ${Math.round(secondary.left)})`);
    check("browser top below the masthead header", browser.top >= masthead.bottom - 2, `(browser.top ${Math.round(browser.top)} vs header.bottom ${Math.round(masthead.bottom)})`);
  } else {
    check("browser positioned in the gap", false, "(no browser rect)");
  }

  await page.screenshot({ path: resolve(testDir, "e2e-dock.png") });
  console.log("    screenshot: test/e2e-dock.png");

  // Theater renders the video full-width in #full-bleed-container; the dock should
  // pad/shrink it and sit in the freed gap on the right — on-screen, no overlap.
  const innerW = await page.evaluate(() => window.innerWidth);
  await page.evaluate(() => document.querySelector("ytd-watch-flexy")?.setAttribute("theater", ""));
  await page.waitForTimeout(500);
  check("theater dock engaged", await page.evaluate(() => !!document.querySelector("ytd-watch-flexy[tnm-theater-dock]")));
  const tmp = await rectOf(page, "#full-bleed-container #movie_player");
  const tbb = await page.locator(".TnmBrowser").boundingBox().catch(() => null);
  const tBrowser = tbb ? { left: tbb.x, right: tbb.x + tbb.width } : null;
  check("theater player shrank to leave room", tmp && tmp.right <= innerW - 300, `(player.right ${tmp ? Math.round(tmp.right) : "?"} vs win ${innerW})`);
  check("theater dock sits right of the player, on-screen", tBrowser && tmp && tBrowser.left >= tmp.right - 2 && tBrowser.right <= innerW + 2, `(dock ${tBrowser ? Math.round(tBrowser.left) + ".." + Math.round(tBrowser.right) : "?"}, player.right ${tmp ? Math.round(tmp.right) : "?"}, win ${innerW})`);

  // Leaving theater restores the normal column wrap.
  await page.evaluate(() => document.querySelector("ytd-watch-flexy")?.removeAttribute("theater"));
  await page.waitForTimeout(500);
  check("normal wrap restored after leaving theater", await page.evaluate(() => !!document.querySelector("#primary-inner .tnm-dock-row > #player") && !document.querySelector("ytd-watch-flexy[tnm-theater-dock]")));

  // Fullscreen tears the wrap down and RESTORES the player to full size.
  await page.evaluate(() => document.querySelector("ytd-watch-flexy")?.setAttribute("fullscreen", ""));
  await page.waitForTimeout(300);
  check("undocks in fullscreen (wrapper removed)", await page.evaluate(() => !document.querySelector(".tnm-dock-row")));
  const restored = await rectOf(page, "#movie_player");
  check("player restored to full size after undock", restored && restored.width > 1100, `(player width ${restored ? Math.round(restored.width) : "?"}px)`);
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nSUBTITLE BROWSER DOCKING (wrap): WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
