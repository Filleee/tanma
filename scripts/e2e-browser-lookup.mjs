// Verifies hover-to-lookup works INSIDE the subtitle browser (lazily tokenized
// rows) and that the lookup popup is positioned clear of the row, so adjacent
// words stay hoverable. Run: node scripts/e2e-browser-lookup.mjs
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

  // Wait for kuromoji (overlay furigana) so browser rows tokenize with real word
  // boundaries (warmTokenizer refreshes the browser when ready).
  await page.locator("ruby.tnm-reading rt").first().waitFor({ timeout: 40000 }).catch(() => {});

  const rows = page.locator(".TnmBrowser__list__item");
  await rows.first().waitFor({ timeout: 8000 });
  check("subtitle browser populated", (await rows.count()) >= 3);

  // A row hydrated into interactive word tokens (lazy tokenize).
  const browserWord = page.locator(".TnmBrowser__list__item .tnm-token.-tnm-word").first();
  await browserWord.waitFor({ timeout: 15000 });
  check("browser rows hydrated into interactive word tokens", await browserWord.isVisible());

  // Hover a word in the browser → lookup popup opens.
  const row = browserWord.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' TnmBrowser__list__item ')]");
  const rowBox = await row.boundingBox();
  // Hold-to-look-up: hold the look-up key (default Alt) + hover the start of the word.
  await browserWord.evaluate((el) => {
    const s = el.querySelector(".tnm-surface") || el;
    const node = s.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    const r = range.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, altKey: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  });
  const lookup = page.locator(".tnm-lookup");
  await lookup.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  check("hold-Alt + hover opens the popup in the browser", await lookup.isVisible().catch(() => false));

  // The popup must not overlap the row it was opened from (so neighbouring words
  // stay hoverable).
  const popBox = await lookup.boundingBox();
  if (popBox && rowBox) {
    const clears = popBox.y + popBox.height <= rowBox.y + 4 || popBox.y >= rowBox.y + rowBox.height - 4;
    check("popup is positioned clear of the row", clears, `(popup ${Math.round(popBox.y)}..${Math.round(popBox.y + popBox.height)}, row ${Math.round(rowBox.y)}..${Math.round(rowBox.y + rowBox.height)})`);
  } else {
    check("popup is positioned clear of the row", false, "(no box)");
  }

  await page.screenshot({ path: resolve(testDir, "e2e-browser-lookup.png") });
  console.log("    screenshot: test/e2e-browser-lookup.png");
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nBROWSER LOOKUP: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
