// Real-world importer test: import the actual JMdict (English) Yomitan zip
// (~200k entries) and look up 日本語. Run: node scripts/e2e-dict-real.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");
const testDir = resolve(root, "test");
const zipPath = resolve(testDir, "jmdict_en.zip");
const TYPES = { ".html": "text/html", ".webm": "video/webm" };

await stat(zipPath); // ensure present

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

  const t0 = await opt.evaluate(() => performance.now());
  await opt.locator("#file").setInputFiles(zipPath);
  // import is large; wait for the listed row + count
  await opt.locator(".title").first().waitFor({ timeout: 240000 });
  const importMs = (await opt.evaluate(() => performance.now())) - t0;
  const countText = (await opt.locator("tbody .count").first().textContent()) || "";
  check("real JMdict imported & listed", true, `(${countText.trim()} entries, ${(importMs / 1000).toFixed(1)}s)`);

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
  const tClick = await page.evaluate(() => performance.now());
  await token.click();
  const lookup = page.locator(".tnm-lookup");
  await lookup.waitFor({ state: "visible", timeout: 8000 });
  // wait for an imported (non-online) section to appear
  await page.locator(".tnm-lookup__section__title").first().waitFor({ timeout: 8000 });
  const lookupMs = (await page.evaluate(() => performance.now())) - tClick;

  const text = (await lookup.textContent()) || "";
  check("real lookup renders a dictionary section", (await lookup.locator(".tnm-lookup__section").count()) > 0);
  check("definition mentions 'Japanese'", /Japanese/i.test(text));
  check("lookup was fast (<3s)", lookupMs < 3000, `(${Math.round(lookupMs)}ms)`);

  await page.screenshot({ path: resolve(testDir, "e2e-dict-real.png") });
  console.log("  screenshot: test/e2e-dict-real.png");
} catch (e) {
  console.log("  ❌ fatal:", String(e?.stack || e).split("\n").slice(0, 3).join("\n"));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nREAL DICTIONARY: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
