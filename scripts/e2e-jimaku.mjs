// Verifies the Jimaku UI plumbing: toolbar button opens the search panel, and a search
// routes through the background proxy (which reports the missing API key, since none is
// set). Run: node scripts/e2e-jimaku.mjs
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
  const page = await context.newPage();
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 8000 });

  await page.locator('[data-tip="Find subtitles on jimaku.cc"]').click();
  const panel = page.locator(".tnm-jimaku-anime");
  await panel.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  check("toolbar button opens the Jimaku panel", await panel.isVisible().catch(() => false));

  await page.locator(".tnm-jimaku-anime .tnm-jimaku__search").fill("serial experiments lain");
  await page.locator(".tnm-jimaku-anime .tnm-btn.-primary").click();
  await page.waitForFunction(
    () => /api key/i.test(document.getElementById("tnm-root")?.shadowRoot?.querySelector(".tnm-jimaku-anime .tnm-jimaku__status")?.textContent || ""),
    { timeout: 6000 },
  ).catch(() => {});
  const status = await page.locator(".tnm-jimaku-anime .tnm-jimaku__status").textContent().catch(() => "");
  check("search routes to background → reports missing API key", /api key/i.test(status || ""), `(status="${status}")`);

  // Typing in the search box must (a) enter as text — not fire our line-nav hotkeys —
  // and (b) NOT leak to the page, where the site's player keyboard shortcuts live.
  await page.evaluate(() => { window.__pageKeys = 0; document.addEventListener("keydown", () => { window.__pageKeys++; }); });
  const search = page.locator(".tnm-jimaku-anime .tnm-jimaku__search");
  await search.click();
  await search.fill("");
  await search.pressSequentially("ada s", { delay: 25 }); // letters (a/d/s hotkeys) + a SPACE
  const val = await search.inputValue();
  check("typing incl. space enters as text (not nav/player shortcuts)", val === "ada s", `(value="${val}")`);
  const pageKeys = await page.evaluate(() => window.__pageKeys);
  check("keystrokes don't leak to the page (player) shortcuts", pageKeys === 0, `(page keydowns=${pageKeys})`);

  // Esc/close: clicking outside the panel dismisses it.
  await page.mouse.click(5, 5);
  await page.waitForTimeout(150);
  check("clicking outside closes the panel", !(await panel.isVisible().catch(() => false)));

  await page.screenshot({ path: resolve(testDir, "e2e-jimaku.png") });
  console.log("    screenshot: test/e2e-jimaku.png");
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nJIMAKU UI: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
