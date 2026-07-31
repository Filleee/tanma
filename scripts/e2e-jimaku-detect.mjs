// Verifies Jimaku auto-detect: opening the panel on an anime page reads the AniList id
// from a page link and the episode from the URL (?ep=12), pre-fills the episode field,
// and auto-runs a search (which here reports the missing API key, since none is set).
// Run: node scripts/e2e-jimaku-detect.mjs
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
      const name = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "jimaku-detect.html";
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
const shadowText = (page, sel) =>
  page.evaluate((s) => document.getElementById("tnm-root")?.shadowRoot?.querySelector(s)?.textContent || "", sel);

const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: ["--headless=new", "--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run", "--no-default-browser-check"],
});

try {
  const page = await context.newPage();
  // Episode lives in the URL query, exactly like miruro's ?ep=12.
  await page.goto(`${base}/jimaku-detect.html?ep=12`, { waitUntil: "load" });
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 8000 });

  // Open the Jimaku panel — auto-detect should fire on open (no typing, no clicks).
  await page.locator('[data-tip="Find subtitles on jimaku.cc"]').click();
  await page.locator(".tnm-jimaku").waitFor({ state: "visible", timeout: 4000 });

  // The episode field is filled from ?ep=12.
  await page.waitForFunction(
    () => document.getElementById("tnm-root")?.shadowRoot?.querySelector(".tnm-jimaku__ep")?.value === "12",
    { timeout: 6000 },
  ).catch(() => {});
  const ep = await page.evaluate(() => document.getElementById("tnm-root")?.shadowRoot?.querySelector(".tnm-jimaku__ep")?.value);
  check("episode auto-filled from ?ep=12", ep === "12", `(ep="${ep}")`);

  // Auto-detect ran a search by itself (no user input) → reaches the background, which
  // reports the missing key. That only happens if an AniList id or title was detected.
  await page.waitForFunction(
    () => /api key/i.test(document.getElementById("tnm-root")?.shadowRoot?.querySelector(".tnm-jimaku__status")?.textContent || ""),
    { timeout: 8000 },
  ).catch(() => {});
  const status = await shadowText(page, ".tnm-jimaku__status");
  check("auto-detect ran a search on open (no user action)", /api key/i.test(status || ""), `(status="${status}")`);

  await page.screenshot({ path: resolve(testDir, "e2e-jimaku-detect.png") });
  console.log("    screenshot: test/e2e-jimaku-detect.png");
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nJIMAKU AUTO-DETECT: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
