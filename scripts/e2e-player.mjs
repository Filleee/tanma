// Verifies the standalone TANMA! Player page: choosing a local video plays it and attaches
// the overlay; choosing a subtitle file loads it into the interactive browser/overlay.
// Run: node scripts/e2e-player.mjs
import { chromium } from "playwright";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");
const testDir = resolve(root, "test");

// ---- minimal MKV with one embedded Japanese ASS subtitle track (no playable video) ----
function synthMkv() {
  const enc = (s) => new TextEncoder().encode(s);
  const cat = (...a) => { const A = a.map((x) => (x instanceof Uint8Array ? x : new Uint8Array(x))); const n = A.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let p = 0; for (const x of A) { o.set(x, p); p += x.length; } return o; };
  const vint = (n) => { let len = 1; while (n > 2 ** (7 * len) - 2) len++; const b = new Uint8Array(len); let v = n; for (let i = len - 1; i >= 0; i--) { b[i] = v & 0xff; v = Math.floor(v / 256); } b[0] |= 0x80 >> (len - 1); return b; };
  const uintB = (n) => { if (!n) return new Uint8Array([0]); const b = []; let v = n; while (v > 0) { b.unshift(v & 0xff); v = Math.floor(v / 256); } return new Uint8Array(b); };
  const el = (id, d) => cat(new Uint8Array(id), vint(d.length), d);
  const block = (t, rel, p) => cat(vint(t), new Uint8Array([(rel >> 8) & 0xff, rel & 0xff, 0]), enc(p));
  const header = "[Script Info]\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";
  const trackJa = el([0xae], cat(el([0xd7], uintB(1)), el([0x83], uintB(0x11)), el([0x86], enc("S_TEXT/ASS")), el([0x63, 0xa2], enc(header)), el([0x22, 0xb5, 0x9c], enc("jpn"))));
  const trackEn = el([0xae], cat(el([0xd7], uintB(2)), el([0x83], uintB(0x11)), el([0x86], enc("S_TEXT/UTF8")), el([0x22, 0xb5, 0x9c], enc("eng"))));
  // No Language element → defaults to English per the Matroska spec (regression for the "Unknown" bug).
  const trackSigns = el([0xae], cat(el([0xd7], uintB(3)), el([0x83], uintB(0x11)), el([0x86], enc("S_TEXT/ASS")), el([0x63, 0xa2], enc(header)), el([0x53, 0x6e], enc("Signs"))));
  const tracks = el([0x16, 0x54, 0xae, 0x6b], cat(trackJa, trackEn, trackSigns));
  const info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], uintB(1_000_000)));
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], cat(
    el([0xe7], uintB(0)),
    el([0xa0], cat(el([0xa1], block(1, 0, "0,0,Default,,0,0,0,,組み込み字幕です")), el([0x9b], uintB(2000)))),
    el([0xa0], cat(el([0xa1], block(2, 100, "English embedded line")), el([0x9b], uintB(2000)))),
    el([0xa0], cat(el([0xa1], block(3, 200, "0,0,Default,,0,0,0,,Sign text")), el([0x9b], uintB(2000)))),
  ));
  return cat(el([0x1a, 0x45, 0xdf, 0xa3], enc("x")), el([0x18, 0x53, 0x80, 0x67], cat(info, tracks, cluster)));
}

let failures = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "  ✅" : "  ❌"} ${n}${extra ? "  " + extra : ""}`); if (!ok) failures++; };

const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: ["--headless=new", "--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run", "--no-default-browser-check"],
});

try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }));
  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/player.html`, { waitUntil: "load" });

  check("chooser is shown before any media", await page.locator("#drop").isVisible());

  // Choose a local video → it should play and the chooser should disappear.
  await page.locator("#video-input").setInputFiles(resolve(testDir, "test.webm"));
  await page.waitForFunction(() => !!document.getElementById("tnm-player")?.src, null, { timeout: 5000 });
  check("video loaded (object URL set)", await page.evaluate(() => document.getElementById("tnm-player").src.startsWith("blob:")));
  check("chooser hides once media loads", !(await page.locator("#drop").isVisible()));

  // Custom control bar replaces the native <video> controls.
  const noNativeControls = (await page.locator("#tnm-player").getAttribute("controls")) === null;
  check("custom control bar replaces native controls", noNativeControls && (await page.locator("#player-ui #c-play").count()) === 1 && (await page.locator("#scrubber").count()) === 1);

  // The content overlay attaches to the page's <video>.
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 8000 });
  check("overlay host attached to the player video", (await page.locator("#tnm-root").count()) === 1);

  // Choose a subtitle file → it loads into the subtitle browser (which opens automatically).
  await page.locator("#sub-input").setInputFiles(resolve(testDir, "sample.ja.srt"));
  const rows = await page
    .waitForFunction(
      () => (document.getElementById("tnm-root")?.shadowRoot?.querySelectorAll(".TnmBrowser__list__item")?.length || 0) > 0,
      null,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  check("subtitle file loaded into the browser", rows);

  // Play → the overlay should render a target cue from the loaded file.
  await page.evaluate(() => document.getElementById("tnm-player")?.play().catch(() => {}));
  const showedCue = await page
    .waitForFunction(
      () => /[一-龯ぁ-んァ-ン]/.test(document.getElementById("tnm-root")?.shadowRoot?.querySelector(".TnmSubs__targetSubs")?.textContent || ""),
      null,
      { timeout: 12000 },
    )
    .then(() => true)
    .catch(() => false);
  check("overlay shows a Japanese cue during playback", showedCue);

  await page.screenshot({ path: resolve(testDir, "e2e-player.png") });
  console.log("    screenshot: test/e2e-player.png");

  // Embedded-subtitle extraction: drop an .mkv (unplayable video, but with an ASS track) on a
  // fresh page → the subs should be pulled out of the container and loaded into the overlay.
  const mkvPath = join(await mkdtemp(join(tmpdir(), "tnm-mkv-")), "embedded.mkv");
  await writeFile(mkvPath, synthMkv());
  await page.evaluate(() => document.getElementById("tnm-player")?.pause()); // free CPU for page2's tokenizer
  const page2 = await context.newPage();
  await page2.goto(`chrome-extension://${extId}/player.html`, { waitUntil: "load" });
  await page2.locator("#video-input").setInputFiles(mkvPath);
  const browserText = () => page2.evaluate(() => document.getElementById("tnm-root")?.shadowRoot?.querySelector(".TnmBrowser__list")?.textContent || "");
  // Match "字幕" (subtitle) — robust to furigana being interleaved into the row's textContent.
  const extracted = await page2
    .waitForFunction(() => (document.getElementById("tnm-root")?.shadowRoot?.querySelector(".TnmBrowser__list")?.textContent || "").includes("字幕"), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("default (Japanese) embedded track auto-loaded", extracted);

  // Reveal the auto-hiding control bar before interacting with it.
  await page2.mouse.move(500, 400);
  // The track selector + fullscreen button live in the control bar.
  check("track selector is shown", await page2.locator("#player-ui #sub-selector").isVisible());
  check("fullscreen button is shown", await page2.locator("#player-ui #c-fs").isVisible());
  check("selector lists all embedded tracks", (await page2.locator("#sub-track option").count()) === 3);
  const optText = (await page2.locator("#sub-track option").allTextContents()).join(" | ");
  check("options name language + format", /Japanese.*ASS/.test(optText) && /English.*SRT/.test(optText), `(${optText})`);
  check("track with no Language defaults to English (not 'Unknown')", /English.*ASS.*Signs/.test(optText) && !/Unknown/.test(optText), `(${optText})`);

  // Switching to the English track loads it.
  await page2.selectOption("#sub-track", "1");
  const switched = await page2
    .waitForFunction(() => (document.getElementById("tnm-root")?.shadowRoot?.querySelector(".TnmBrowser__list")?.textContent || "").includes("English embedded line"), null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("selecting another track switches the loaded subtitle", switched, `(after switch: "${(await browserText()).slice(0, 60)}…")`);

  // Loading an EXTERNAL subtitle (here: an imported sidecar file — same path Jimaku uses) must
  // mark it as the active source in the selector, so you can still switch back to an embedded track.
  await page2.locator("#sub-input").setInputFiles(resolve(testDir, "sample.ja.srt"));
  const extActive = await page2
    .waitForFunction(() => {
      const sel = document.getElementById("sub-track");
      return sel && sel.value === "ext" && [...sel.options].some((o) => o.value === "ext" && /File/.test(o.textContent || ""));
    }, null, { timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  check("external (Jimaku/imported) subtitle shows as the active source", extActive, `(sel="${await page2.locator("#sub-track").inputValue().catch(() => "?")}")`);

  // Switch back to the embedded Japanese track — re-selecting an embedded option works again.
  await page2.selectOption("#sub-track", "0");
  const backToEmbedded = await page2
    .waitForFunction(() => (document.getElementById("tnm-root")?.shadowRoot?.querySelector(".TnmBrowser__list")?.textContent || "").includes("字幕"), null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("can switch back from the external source to an embedded track", backToEmbedded && (await page2.locator("#sub-track").inputValue()) === "0");

  // Fullscreen must target the whole page (so the overlay/browser stay on top), NOT the bare
  // <video> (which would hide them). Only assert if headless actually enters fullscreen.
  await page2.mouse.move(500, 400); // reveal the bar so the button is clickable
  await page2.locator("#player-ui #c-fs").click();
  await page2.waitForTimeout(300);
  const fsTag = await page2.evaluate(() => document.fullscreenElement?.tagName ?? "");
  if (fsTag) check("fullscreen targets the page (HTML), not the bare video", fsTag === "HTML", `(${fsTag})`);
  else console.log("  · (headless: fullscreen not entered — target check skipped)");
  await page2.screenshot({ path: resolve(testDir, "e2e-player-mkv.png") });
} catch (e) {
  console.log("  ❌ fatal:", String(e?.stack || e).split("\n").slice(0, 3).join("\n"));
  failures++;
} finally {
  await context.close();
}
console.log(failures === 0 ? "\nTANMA! PLAYER: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
