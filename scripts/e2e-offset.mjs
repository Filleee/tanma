// Verifies the editable subtitle timing-offset box in the toolbar: typing a value shifts
// which cue is displayed (functional proof), it clamps to ±60s, and −/+ nudge.
// Run: node scripts/e2e-offset.mjs
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
  const page = await context.newPage();
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 10000 });

  const box = page.locator(".TnmBar__offset__val");
  const boxVal = () => page.evaluate(() => document.getElementById("tnm-root")?.shadowRoot?.querySelector(".TnmBar__offset__val")?.value);
  check("toolbar offset is an editable number box", (await box.count()) === 1 && (await box.getAttribute("type")) === "number");

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('[data-tip*="Import"]').click(),
  ]);
  await chooser.setFiles(resolve(testDir, "sample.ja.srt"));

  // The clip is only ~5s, so cue #2 (5–9s) is normally UNREACHABLE during playback.
  // It can only appear if the offset shifts subtitle timing — a clean proof.
  const waitForSub = (keywords, timeout = 12000) =>
    page
      .waitForFunction(
        (kws) => {
          const t = document.getElementById("tnm-root")?.shadowRoot?.querySelector(".TnmSubs__targetSubs")?.textContent || "";
          return kws.some((k) => t.includes(k));
        },
        keywords,
        { timeout },
      )
      .then(() => true)
      .catch(() => false);

  await page.evaluate(() => document.querySelector("video")?.play().catch(() => {}));
  check("cue #1 shows during playback (offset 0)", await waitForSub(["勉強"]));

  // Type −3s → show a cue 3s ahead → cue #2 appears despite the short clip.
  await box.fill("-3");
  await box.press("Enter");
  check("typed offset reads -3.0", (await boxVal()) === "-3.0", `(val="${await boxVal()}")`);
  check("offset −3s reveals cue #2 (only possible via offset)", await waitForSub(["テスト", "字幕"]));

  // Type 0 → back to cue #1.
  await box.fill("0");
  await box.press("Enter");
  check("reset to 0 returns to cue #1", await waitForSub(["勉強"]));

  // Clamp beyond the ±60 range.
  await box.fill("999");
  await box.press("Enter");
  check("clamps to +60 max", (await boxVal()) === "60.0", `(val="${await boxVal()}")`);

  // Precise negative + nudge.
  await box.fill("-7.3");
  await box.press("Enter");
  await page.locator(".TnmBar__offset .tnm-btn", { hasText: "+" }).click();
  check("+ nudges by 0.1 from a typed value", (await boxVal()) === "-7.2", `(val="${await boxVal()}")`);

  await page.screenshot({ path: resolve(testDir, "e2e-offset.png") });
} catch (e) {
  console.log("  ❌ fatal:", String(e?.stack || e).split("\n").slice(0, 3).join("\n"));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nOFFSET BOX: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
