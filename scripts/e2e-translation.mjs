// Verifies the translation (secondary) path: the inject captures the Japanese
// target track, then re-requests the SAME url with &tlang=en (YouTube auto-
// translate), and the content script renders that as the secondary line.
// The stand-in server returns Japanese json3 normally, English when tlang=en.
// Run: node scripts/e2e-translation.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");
const testDir = resolve(root, "test");
const TYPES = { ".html": "text/html", ".webm": "video/webm" };

// Japanese fixture: 4 cues at 1-5s, 5-9s, 9-13s, 13-17s.
const jaJson3 = await readFile(resolve(testDir, "fake-timedtext.json3"), "utf8");
// English (tlang) deliberately COARSER: 2 sentence-level cues, each spanning 2 of
// the Japanese cues — this is the real-world case that used to repeat the same
// translation on every fragment in the browser.
const enJson3 = JSON.stringify({
  events: [
    { tStartMs: 1000, dDurationMs: 8000, segs: [{ utf8: "I'm studying Japanese, nice weather" }] },
    { tStartMs: 9000, dDurationMs: 8000, segs: [{ utf8: "Let's go fishing, big fish here" }] },
  ],
});

let sawTlangRequest = false;
const server = await new Promise((res) => {
  const s = createServer(async (req, res2) => {
    const url = req.url || "/";
    const path = url.split("?")[0];
    if (path.includes("/api/timedtext")) {
      const isTlang = /[?&]tlang=/.test(url);
      if (isTlang) sawTlangRequest = true;
      res2.writeHead(200, { "content-type": "application/json" });
      res2.end(isTlang ? enJson3 : jaJson3);
      return;
    }
    try {
      const name = decodeURIComponent(path).replace(/^\/+/, "") || "auto.html";
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
  args: [
    "--headless=new",
    "--autoplay-policy=no-user-gesture-required",
    `--disable-extensions-except=${distDir}`,
    `--load-extension=${distDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

// YouTube auto-translate is now the "Show machine translation" path — enable it (Google provider
// is the default, so on YouTube the inject is asked to translate via &tlang).
const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }));
await sw.evaluate(() => chrome.storage.local.set({ "tnm:settings": { showMachineTranslation: true } }));

try {
  const page = await context.newPage();
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 8000 });

  await page.addScriptTag({ path: resolve(distDir, "assets/youtube.js") });

  // Announce the video + its caption tracks. The content script auto-enables the
  // Japanese target and (because "Show machine translation" is on, Google provider)
  // asks the inject to translate into English.
  await page.evaluate(() => {
    window.postMessage({ source: "tnm-yt", kind: "videoChanged", videoId: "tr123" }, "*");
    window.postMessage(
      { source: "tnm-yt", kind: "tracks", videoId: "tr123", tracks: [{ baseUrl: "/api/timedtext?lang=ja", lang: "ja", name: "Japanese", kind: "" }] },
      "*",
    );
  });
  await page.waitForTimeout(400); // let the enableCaptions command reach the inject

  // The player fetches the Japanese track; the inject intercepts it and then
  // re-fetches it with &tlang=en for the translation.
  await page.evaluate(async () => {
    await fetch("/api/timedtext?lang=ja&fmt=json3").catch(() => {});
    const v = document.querySelector("video");
    if (v) { v.currentTime = 2.0; v.play().catch(() => {}); }
  });

  await page.locator(".TnmSubs__targetSubs__line .tnm-token").first().waitFor({ timeout: 20000 });
  const targetLine = (await page.locator(".TnmSubs__targetSubs__line").first().textContent())?.trim() ?? "";
  check("target (Japanese) line renders", /[぀-ヿ一-鿿]/.test(targetLine), JSON.stringify(targetLine));

  // The secondary line should now carry the English auto-translation.
  let secondary = "";
  try {
    const sec = page.locator(".TnmSubs__secondarySubs__line").first();
    await sec.waitFor({ timeout: 15000 });
    secondary = (await sec.textContent())?.trim() ?? "";
  } catch {}
  check("inject re-requested with &tlang=en", sawTlangRequest);
  check("secondary (English translation) line renders", /studying Japanese/i.test(secondary), JSON.stringify(secondary));

  // Open the subtitle browser and confirm the coarse translation is NOT repeated
  // across the Japanese fragments it spans (the reported bug).
  await page.locator('[data-tip="Subtitle browser"]').click();
  await page.locator(".TnmBrowser__list__item").first().waitFor({ timeout: 5000 });
  const secLines = (await page.locator(".TnmBrowser__list__item .sec").allTextContents()).map((t) => t.trim()).filter(Boolean);
  console.log("    browser translations:", JSON.stringify(secLines));
  const firstCount = secLines.filter((t) => /studying Japanese/i.test(t)).length;
  check("each translation appears once in the browser (no repeat)", firstCount === 1, `(appeared ${firstCount}×)`);
  check("both sentence translations present, not smeared", secLines.length === 2, `(${secLines.length} translated lines)`);

  await page.screenshot({ path: resolve(testDir, "e2e-translation.png") });
  console.log("    screenshot: test/e2e-translation.png");
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
  failures++;
} finally {
  await context.close();
  server.close();
}

console.log(failures === 0 ? "\nTRANSLATION PATH: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
