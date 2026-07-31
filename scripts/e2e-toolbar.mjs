// Verifies the docked toolbar: full-width across the top of the video, visible
// when paused, auto-hides while playing, reveals on hover near the top.
// Run: node scripts/e2e-toolbar.mjs
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
const hidden = (page) => page.locator(".TnmBar").evaluate((el) => el.classList.contains("-hidden"));

const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: ["--headless=new", "--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run"],
});

try {
  const page = await context.newPage();
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.locator(".TnmBar").waitFor({ timeout: 10000 });

  // Docked geometry: spans the video width, anchored at its top.
  const tb = await page.locator(".TnmBar").boundingBox();
  const vid = await page.locator("video").boundingBox();
  check("toolbar spans the video width", Math.abs(tb.width - vid.width) < 4, `(toolbar ${Math.round(tb.width)} vs video ${Math.round(vid.width)})`);
  check("toolbar docked at the top of the video", Math.abs(tb.y - vid.y) < 4, `(toolbar y=${Math.round(tb.y)} vs video y=${Math.round(vid.y)})`);
  check("has left + right sections", (await page.locator(".TnmBar__leftSide").count()) === 1 && (await page.locator(".TnmBar__rightSide").count()) === 1);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('[data-tip*="Import"]').click(),
  ]);
  await chooser.setFiles(resolve(testDir, "sample.ja.srt"));

  // Paused → visible.
  await page.evaluate(() => document.querySelector("video").pause());
  await page.waitForTimeout(300);
  check("visible while paused", (await hidden(page)) === false);

  // Playing + mouse parked at the bottom → auto-hides after ~2.6s.
  await page.mouse.move(10, 10);
  await page.evaluate(() => document.querySelector("video").play().catch(() => {}));
  await page.mouse.move(400, 520); // bottom-ish, away from the top zone
  await page.waitForTimeout(3000);
  check("auto-hides while playing (mouse away)", (await hidden(page)) === true);

  // Move near the top of the video → reveals.
  const v2 = await page.locator("video").boundingBox();
  await page.mouse.move(v2.x + v2.width / 2, v2.y + 20);
  await page.waitForTimeout(300);
  check("reveals on hover near the top", (await hidden(page)) === false);

  await page.evaluate(() => document.querySelector("video").pause());
  await page.screenshot({ path: resolve(testDir, "e2e-toolbar.png") });
} catch (e) {
  console.log("  ❌ fatal:", String(e?.stack || e).split("\n").slice(0, 3).join("\n"));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nDOCKED TOOLBAR: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
