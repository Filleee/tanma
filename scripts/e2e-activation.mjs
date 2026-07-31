// Verifies per-host activation rules: with a rule "this host → only /watch", the overlay is
// hidden on a non-matching URL and shown on a matching one. Run: node scripts/e2e-activation.mjs
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
      const buf = await readFile(resolve(testDir, name.endsWith(".webm") ? name : "auto.html"));
      res2.writeHead(200, { "content-type": TYPES[extname(name)] || "text/html" });
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

const hostDisplay = (page) => page.evaluate(() => getComputedStyle(document.getElementById("tnm-root")).display);

try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }));
  // Rule: on this host, only activate on URLs containing "/watch".
  await sw.evaluate(() => chrome.storage.local.set({ "tnm:settings": { activationRules: [{ host: "127.0.0.1", patterns: ["/watch"] }] } }));

  const page = await context.newPage();

  // A non-matching URL (like youtube.com home) → the overlay UI is hidden.
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  await page.waitForTimeout(800);
  check("overlay host is hidden on a non-matching URL", (await hostDisplay(page)) === "none", `(display=${await hostDisplay(page)})`);
  check("toolbar is not shown on a non-matching URL", !(await page.locator(".TnmBar").isVisible().catch(() => false)));

  // A matching URL (…/watch) → the overlay activates and the toolbar shows.
  await page.goto(`${base}/auto.html?p=/watch`, { waitUntil: "load" });
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  check("overlay host is shown on a matching URL", (await hostDisplay(page)) !== "none", `(display=${await hostDisplay(page)})`);
  const toolbarShows = await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);
  check("toolbar shows on a matching URL", toolbarShows);

  await page.screenshot({ path: resolve(testDir, "e2e-activation.png") });
} catch (e) {
  console.log("  ❌ fatal:", String(e?.stack || e).split("\n").slice(0, 3).join("\n"));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nACTIVATION RULES: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
