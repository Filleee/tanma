// Verifies click-to-toggle on word look-ups: clicking a word opens its look-up; clicking the
// SAME word again closes it (instead of re-triggering); clicking once more re-opens it.
// Run: node scripts/e2e-lookup-toggle.mjs
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

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    page.locator('[data-tip*="Import"]').click(),
  ]);
  await chooser.setFiles(resolve(testDir, "sample.ja.srt"));

  await page.locator("ruby.tnm-reading rt").first().waitFor({ timeout: 40000 }).catch(() => {});
  const word = page.locator(".TnmBrowser__list__item .tnm-token.-tnm-word").first();
  await word.waitFor({ timeout: 15000 });
  const popup = page.locator(".tnm-lookup");
  const popupVisible = () => popup.isVisible().catch(() => false);

  // 1st click → look-up opens.
  await word.click();
  await popup.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  check("clicking a word opens the look-up", await popupVisible());

  // 2nd click on the SAME word → look-up closes (does NOT re-trigger).
  await word.click();
  await popup.waitFor({ state: "hidden", timeout: 4000 }).catch(() => {});
  check("clicking the same word again closes the look-up", !(await popupVisible()));

  // 3rd click → opens again.
  await word.click();
  await popup.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  check("clicking once more re-opens it", await popupVisible());

  // Clicking a DIFFERENT word switches the look-up (stays open).
  const word2 = page.locator(".TnmBrowser__list__item .tnm-token.-tnm-word").nth(2);
  if (await word2.count()) {
    await word2.click();
    await page.waitForTimeout(300);
    check("clicking a different word keeps a look-up open (switches)", await popupVisible());
  }

  await page.screenshot({ path: resolve(testDir, "e2e-lookup-toggle.png") });
} catch (e) {
  console.log("  ❌ fatal:", String(e?.stack || e).split("\n").slice(0, 3).join("\n"));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nLOOKUP TOGGLE: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
