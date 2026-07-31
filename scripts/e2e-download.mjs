// Tests the one-click "Download" catalog: click Download on KANJIDIC (small),
// verify it downloads from GitHub + imports, then shows up in a kanji lookup.
// Run: node scripts/e2e-download.mjs
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
    } catch { res2.writeHead(404); res2.end("nf"); }
  });
  s.listen(0, "127.0.0.1", () => res(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "  ✅" : "  ❌"} ${n}${extra ? "  " + extra : ""}`); if (!ok) failures++; };

const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: ["--headless=new", "--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run"],
});

try {
  let sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }));
  const extId = new URL(sw.url()).host;

  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html#dicts`, { waitUntil: "load" });

  const kanjidicRow = opt.locator(".cat", { hasText: "KANJIDIC" });
  await kanjidicRow.waitFor({ timeout: 8000 });
  check("catalog lists KANJIDIC with a Download button", (await kanjidicRow.locator("button.btn-primary").count()) === 1);

  const t0 = await opt.evaluate(() => performance.now());
  await kanjidicRow.locator("button.btn-primary").click();
  // wait for it to download from GitHub + import → "✓ Installed"
  await kanjidicRow.locator(".installed-chip").waitFor({ timeout: 90000 });
  const ms = (await opt.evaluate(() => performance.now())) - t0;
  check("KANJIDIC downloaded + imported (✓ Installed)", true, `(${(ms / 1000).toFixed(1)}s)`);
  check("appears in installed list with kanji badge", (await opt.locator("tbody tr", { hasText: "KANJIDIC" }).locator(".badge.-kanji").count()) > 0);

  // look it up from a video page
  const page = await context.newPage();
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 10000 });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('[data-tip*="Import"]').click(),
  ]);
  await chooser.setFiles(resolve(testDir, "sample.ja.srt"));
  await page.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 2; v.play().catch(() => {}); });

  const token = page.locator('.TnmSubs__targetSubs .tnm-token.-tnm-word', { hasText: "日本語" }).first();
  await token.waitFor({ timeout: 20000 });
  await token.click();
  await page.locator(".tnm-lookup").waitFor({ state: "visible", timeout: 8000 });
  await page.locator(".tnm-lookup__section__title", { hasText: "Kanji" }).waitFor({ timeout: 8000 });
  const text = (await page.locator(".tnm-lookup").textContent()) || "";
  check("kanji section shows for downloaded KANJIDIC", /Kanji/.test(text) && /日/.test(text));

  await page.screenshot({ path: resolve(testDir, "e2e-download.png") });
} catch (e) {
  console.log("  ❌ fatal:", String(e?.stack || e).split("\n").slice(0, 3).join("\n"));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nDOWNLOAD CATALOG: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
