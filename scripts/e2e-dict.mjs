// E2E for the Yomitan dictionary importer: import a dict via the options page,
// then verify a word click shows the merged popup (imported section + frequency
// + kanji + structured content). Run: node scripts/e2e-dict.mjs
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

  // ---- import the test dictionary via the options page ----
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html#dicts`, { waitUntil: "load" }); // dashboard tab
  await opt.locator("#file").setInputFiles(resolve(testDir, "test-dict.zip"));
  await opt.locator(".title", { hasText: "Test JA Dict" }).waitFor({ timeout: 15000 });
  check("dictionary imported & listed", true);
  const badges = await opt.locator("tr", { hasText: "Test JA Dict" }).locator(".badge").allTextContents();
  check("shows term+freq+kanji badges", ["terms", "freq", "kanji"].every((b) => badges.includes(b)), badges.join(","));

  // ---- look it up from a video page ----
  const page = await context.newPage();
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 10000 });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('[data-tip*="Import"]').click(),
  ]);
  await chooser.setFiles(resolve(testDir, "sample.ja.srt"));
  await page.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 2; v.play().catch(() => {}); });

  // 日本語 should tokenize; click it
  const token = page.locator('.TnmSubs__targetSubs .tnm-token.-tnm-word', { hasText: "日本語" }).first();
  await token.waitFor({ timeout: 20000 });
  await token.click();

  const lookup = page.locator(".tnm-lookup");
  await lookup.waitFor({ state: "visible", timeout: 8000 });
  // wait for the imported section to render (offline; should be fast)
  await page.locator(".tnm-lookup__section__title", { hasText: "Test JA Dict" }).waitFor({ timeout: 8000 }).catch(() => {});

  // Pitch accent line (from the test dict's term_meta pitch entry: 日本語 [0]).
  const pitchOk = await page.locator(".tnm-lookup__pitch .tnm-pitch .n", { hasText: "[0]" }).first().isVisible().catch(() => false);
  check("pitch accent renders ([0] heiban)", pitchOk);
  const highMoras = await page.locator(".tnm-lookup__pitch .tnm-pitch").first().locator(".m.-h").count().catch(() => 0);
  check("heiban pattern: 3 of 4 moras high", highMoras === 3, `(${highMoras} high)`);

  // Dictionary-bundled image (structured content img → media store → data: URL).
  const imgSrc = await page.locator(".tnm-gloss__media").first().getAttribute("src", { timeout: 8000 }).catch(() => null);
  check("dictionary image renders from the media store", (imgSrc ?? "").startsWith("data:image/png"), `(${(imgSrc ?? "null").slice(0, 30)}…)`);

  const text = (await lookup.textContent()) || "";
  check("imported dictionary section shows", /Test JA Dict/.test(text));
  check("definition text shows", /the Japanese language/.test(text));
  check("structured-content example renders", /example:/.test(text) && /日本語を話す/.test(text));
  check("frequency badge shows (834)", (await lookup.locator(".tnm-freq").count()) > 0 && /834/.test(text));
  check("kanji section shows (日 + meaning)", /Kanji/.test(text) && /day/.test(text));

  await page.screenshot({ path: resolve(testDir, "e2e-dict.png") });
  console.log("  screenshot: test/e2e-dict.png");
} catch (e) {
  console.log("  ❌ fatal:", String(e?.stack || e).split("\n").slice(0, 3).join("\n"));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nDICTIONARY IMPORTER: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
