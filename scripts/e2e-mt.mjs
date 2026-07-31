// Verifies the machine-translation secondary line on a NON-YouTube page: with "Show machine
// translation" on (Google provider), importing a Japanese SRT should make the content script
// translate each line via the background and render it as the secondary line. The Google
// endpoint is mocked so the test is deterministic + offline. Run: node scripts/e2e-mt.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");
const testDir = resolve(root, "test");
const TYPES = { ".html": "text/html", ".webm": "video/webm", ".mp4": "video/mp4", ".srt": "text/plain; charset=utf-8", ".js": "text/javascript" };

const server = await new Promise((res) => {
  const s = createServer(async (req, res2) => {
    try {
      const name = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "auto.html";
      const buf = await readFile(resolve(testDir, name));
      res2.writeHead(200, { "content-type": TYPES[extname(name)] || "application/octet-stream" });
      res2.end(buf);
    } catch {
      res2.writeHead(404);
      res2.end("nf");
    }
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

// Mock Google's translate endpoint (the background service worker fetches it). The response
// shape is [[[ "<translation>", "<source>" ]]]; mark each so we can assert it reached the UI.
let mtCalls = 0;
await context.route(/translate\.googleapis\.com\/translate_a\/single/, async (route) => {
  mtCalls++;
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([[["machine-translated line", "src"]]]) });
});

try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }));
  // Machine translation ON (Google), official OFF, ja → en.
  await sw.evaluate(() =>
    chrome.storage.local.set({
      "tnm:settings": { showSecondary: false, showMachineTranslation: true, mtProvider: "google", targetLang: "ja", nativeLang: "en" },
    }),
  );

  const page = await context.newPage();
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 8000 });

  // Import the sample Japanese SRT through the real import button.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    page.locator('[data-tip*="Import"]').click(),
  ]);
  await chooser.setFiles(resolve(testDir, "sample.ja.srt"));

  await page.evaluate(async () => {
    const v = document.querySelector("video");
    try { await v.play().catch(() => {}); } catch {}
    v.currentTime = 2.0; // inside cue #1
  });

  // Target (Japanese) line renders.
  await page.locator(".TnmSubs__targetSubs__line .tnm-token").first().waitFor({ timeout: 20000 });

  // The secondary line should carry our (mocked) machine translation.
  let secondary = "";
  try {
    const sec = page.locator(".TnmSubs__secondarySubs__line").first();
    await sec.waitFor({ timeout: 15000 });
    secondary = (await sec.textContent())?.trim() ?? "";
  } catch {}
  check("background called the (mocked) translate endpoint", mtCalls > 0, `(${mtCalls} calls)`);
  check("machine-translation secondary line renders", /machine-translated line/.test(secondary), JSON.stringify(secondary));

  await page.screenshot({ path: resolve(testDir, "e2e-mt.png") });
  console.log("    screenshot: test/e2e-mt.png");
} catch (e) {
  console.log("  ❌ fatal:", String(e?.stack || e).split("\n").slice(0, 3).join("\n"));
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? "\nMACHINE TRANSLATION: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
