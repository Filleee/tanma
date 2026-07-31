// End-to-end smoke test: loads the built extension into real Chromium (new
// headless), opens a page with a <video>, imports the sample Japanese SRT, and
// verifies the overlay renders interactive tokens WITH furigana, plus a word
// lookup popup. Saves a screenshot. Run: node scripts/e2e.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");
const testDir = resolve(root, "test");

const TYPES = {
  ".html": "text/html",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".srt": "text/plain; charset=utf-8",
  ".js": "text/javascript",
};

function startServer() {
  return new Promise((resolveServer) => {
    const server = createServer(async (req, res) => {
      try {
        const name = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "auto.html";
        const buf = await readFile(resolve(testDir, name));
        res.writeHead(200, { "content-type": TYPES[extname(name)] || "application/octet-stream" });
        res.end(buf);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

const log = (...a) => console.log("•", ...a);
let failures = 0;
function check(name, ok) {
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}`);
  if (!ok) failures++;
}

const server = await startServer();
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
log("static server on", base);

const context = await chromium.launchPersistentContext("", {
  headless: false, // selects full Chromium (extensions need it)...
  args: [
    "--headless=new", // ...then actually run windowless via the new headless
    "--autoplay-policy=no-user-gesture-required",
    `--disable-extensions-except=${distDir}`,
    `--load-extension=${distDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

const consoleErrors = [];
context.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

try {
  // 1) Service worker (background) should register → confirms the extension loaded.
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 8000 }).catch(() => null);
  const extId = sw ? new URL(sw.url()).host : null;
  check("extension loaded (background service worker)", !!extId);
  log("extension id:", extId);

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });

  // 2) Content script injected the shadow host (the host div itself is 0×0 —
  //    its content lives in the shadow root — so wait for "attached", not visible).
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  check("content script injected (shadow host present)", true);

  // 3) TnmBar rendered (Playwright pierces the open shadow root).
  const toolbar = page.locator(".TnmBar");
  await toolbar.waitFor({ state: "visible", timeout: 8000 });
  check("toolbar visible", await toolbar.isVisible());

  // 4) Import the sample Japanese SRT through the real import button.
  const importBtn = page.locator('[data-tip*="Import"]');
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    importBtn.click(),
  ]);
  await chooser.setFiles(resolve(testDir, "sample.ja.srt"));
  log("imported sample.ja.srt");

  // Make sure we sit inside cue #1 (1.0–5.0s) regardless of autoplay/codec.
  await page.evaluate(async () => {
    const v = document.querySelector("video");
    try { await v.play().catch(() => {}); } catch {}
    v.currentTime = 2.0;
  });

  // 5) Subtitle browser populated (import opens it).
  const rows = page.locator(".TnmBrowser__list__item");
  await rows.first().waitFor({ timeout: 8000 }).catch(() => {});
  check("subtitle browser populated", (await rows.count()) >= 5);

  // 6) Tokens render for the active cue.
  await page.locator(".tnm-token").first().waitFor({ timeout: 15000 });
  const tokenCount = await page.locator(".tnm-token").count();
  check("interactive word tokens rendered", tokenCount > 0);
  log("token count:", tokenCount);

  // 7) Furigana appears once kuromoji finishes loading (give it time).
  let furi = "";
  try {
    const rt = page.locator("ruby.tnm-reading rt").first();
    await rt.waitFor({ timeout: 40000 });
    furi = (await rt.textContent())?.trim() ?? "";
  } catch {}
  check("furigana (kuromoji) rendered", /[぀-ゟ]/.test(furi));
  log("sample furigana:", JSON.stringify(furi));

  // 8) Clicking a word opens the lookup popup.
  await page.locator(".tnm-token.-tnm-word").first().click({ timeout: 5000 }).catch(() => {});
  const lookup = page.locator(".tnm-lookup");
  const lookupOk = await lookup.isVisible().catch(() => false);
  check("word lookup popup opens on click", lookupOk);

  // 9) Screenshot for visual confirmation.
  const shot = resolve(testDir, "e2e-screenshot.png");
  await page.screenshot({ path: shot, fullPage: false });
  log("screenshot saved:", shot);

  check("no uncaught page errors", pageErrors.length === 0);
  if (pageErrors.length) console.log("   pageerrors:", pageErrors.slice(0, 5));
  if (consoleErrors.length) console.log("   console.errors:", consoleErrors.slice(0, 8));
} finally {
  await context.close();
  server.close();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
