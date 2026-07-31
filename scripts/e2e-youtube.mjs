// Full end-to-end test against a REAL YouTube video. Verifies the whole caption
// pipeline: MAIN-world inject finds caption tracks -> content script fetches
// timedtext -> parses -> overlay renders. Adapts to whatever caption languages
// the video offers. Run: node scripts/e2e-youtube.mjs [videoUrl]
import { chromium } from "playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");
const VIDEO_URL = process.argv[2] || "https://www.youtube.com/watch?v=KfojOyBEFF0";

const log = (...a) => console.log("•", ...a);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const context = await chromium.launchPersistentContext("", {
  headless: false,
  userAgent: UA,
  viewport: { width: 1366, height: 800 },
  args: [
    "--headless=new",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-blink-features=AutomationControlled",
    `--disable-extensions-except=${distDir}`,
    `--load-extension=${distDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

// Mask the most obvious automation tell + capture inject messages early.
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  window.__tnmYt = [];
  window.addEventListener("message", (e) => {
    if (e.data && e.data.source === "tnm-yt") window.__tnmYt.push(e.data);
  });
});
await context.addCookies([
  { name: "CONSENT", value: "YES+cb", domain: ".youtube.com", path: "/" },
  { name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/" },
]);

const timedtext = [];
const consoleErrors = [];

async function getSettingsWorker() {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 8000 }).catch(() => null);
  return sw;
}

async function setTargetLang(sw, lang) {
  if (!sw) return false;
  await sw.evaluate(async (l) => {
    const cur = (await chrome.storage.local.get("tnm:settings"))["tnm:settings"] || {};
    await chrome.storage.local.set({ "tnm:settings": { ...cur, targetLang: l, browserOpen: true } });
  }, lang);
  return true;
}

async function dismissConsent(page) {
  try {
    if (/consent\.youtube\.com|consent\.google\.com/.test(page.url())) {
      const btn = page.locator('button:has-text("Accept all"), button:has-text("Reject all"), form[action*="consent"] button').first();
      await btn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
  } catch {}
}

const result = {};

try {
  const sw = await getSettingsWorker();
  result.extensionLoaded = !!sw;
  log("extension service worker:", sw ? new URL(sw.url()).host : "MISSING");

  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/api/timedtext")) timedtext.push({ status: r.status(), url: u.slice(0, 120) });
  });

  // ---- Phase 1: discover the video's caption tracks -------------------------
  log("navigating (phase 1: discover captions):", VIDEO_URL);
  await page.goto(VIDEO_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await dismissConsent(page);
  await page.waitForSelector("video", { timeout: 30000 }).catch(() => {});
  // try to start playback so the player initializes
  await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); });
  await page.locator("video").click({ timeout: 4000 }).catch(() => {});

  // wait for the inject to report tracks
  let tracksMsg = null;
  for (let i = 0; i < 30 && !tracksMsg; i++) {
    const msgs = await page.evaluate(() => window.__tnmYt || []);
    tracksMsg = msgs.find((m) => m.kind === "tracks");
    if (!tracksMsg) await page.waitForTimeout(1000);
  }

  result.captionTracksFound = !!tracksMsg;
  const langs = tracksMsg ? tracksMsg.tracks.map((t) => `${t.lang}${t.kind === "asr" ? "(asr)" : ""}`) : [];
  result.captionLanguages = langs;
  log("caption tracks reported by inject:", langs.length ? langs.join(", ") : "NONE");

  // ---- Phase 2: pick a target language the video actually has, reload -------
  let chosen = null;
  if (tracksMsg) {
    const norm = (l) => l.toLowerCase().split("-")[0];
    const have = tracksMsg.tracks.map((t) => norm(t.lang));
    chosen = ["ja", "en"].find((l) => have.includes(l)) || norm(tracksMsg.tracks[0].lang);
    await setTargetLang(sw, chosen);
    result.chosenTargetLang = chosen;
    log("set extension target language to:", chosen, "(reloading)");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissConsent(page);
    await page.waitForSelector("video", { timeout: 30000 }).catch(() => {});
    await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); });
    await page.locator("video").click({ timeout: 4000 }).catch(() => {});
    await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); });
  }

  // ---- Phase 3: did subtitles load + render? --------------------------------
  // subtitle browser populated (we forced browserOpen)
  let rows = 0;
  for (let i = 0; i < 25 && rows < 1; i++) {
    rows = await page.locator(".TnmBrowser__list__item").count().catch(() => 0);
    if (rows < 1) await page.waitForTimeout(1000);
  }
  result.subtitleBrowserRows = rows;
  log("subtitle browser rows:", rows);

  // overlay tokens (needs an active cue while playing)
  let tokens = 0;
  for (let i = 0; i < 25 && tokens < 1; i++) {
    tokens = await page.locator(".tnm-token").count().catch(() => 0);
    if (tokens < 1) {
      // nudge playback into a captioned region
      await page.evaluate(() => {
        const v = document.querySelector("video");
        if (v && v.duration && isFinite(v.duration)) v.currentTime = Math.min(v.duration - 1, (v.currentTime || 0) + 5);
        v?.play().catch(() => {});
      });
      await page.waitForTimeout(1000);
    }
  }
  result.overlayTokens = tokens;
  log("overlay word tokens rendered:", tokens);

  const sampleLine = await page
    .locator(".TnmSubs__targetSubs__line")
    .first()
    .textContent()
    .catch(() => null);
  result.sampleOverlayLine = sampleLine?.trim() || null;

  result.timedtextRequests = timedtext;
  log("timedtext requests:", JSON.stringify(timedtext));

  const shot = resolve(root, "test", "e2e-youtube.png");
  await page.screenshot({ path: shot }).catch(() => {});
  result.screenshot = shot;
  log("screenshot:", shot);

  if (consoleErrors.length) log("console errors:", consoleErrors.slice(0, 6));
} catch (e) {
  result.fatal = String(e?.stack || e);
} finally {
  await context.close();
}

// ---- Verdict ---------------------------------------------------------------
console.log("\n================ RESULT ================");
console.log(JSON.stringify(result, null, 2));
const pass =
  result.extensionLoaded &&
  result.captionTracksFound &&
  (result.subtitleBrowserRows >= 1 || result.overlayTokens >= 1);
console.log(pass ? "\nYOUTUBE PIPELINE: WORKING ✅" : "\nYOUTUBE PIPELINE: NOT FULLY VERIFIED ❌ (see result + notes)");
process.exit(pass ? 0 : 1);
