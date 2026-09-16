// Verifies the YouTube *render* path (intercept -> parse -> overlay) without
// hitting YouTube's anti-bot: it posts a realistic `captionData` message (the
// same shape the MAIN-world inject sends after capturing YouTube's own timedtext
// response) and checks the overlay renders Japanese tokens with furigana.
// Run: node scripts/e2e-youtube-sim.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");
const testDir = resolve(root, "test");
const TYPES = { ".html": "text/html", ".webm": "video/webm", ".json3": "application/json" };

const json3 = await readFile(resolve(testDir, "fake-timedtext.json3"), "utf8");

const server = await new Promise((res) => {
  const s = createServer(async (req, res2) => {
    const path = (req.url || "/").split("?")[0];
    // Stand in for YouTube's timedtext endpoint so the inject's fetch-hook fires.
    if (path.includes("/api/timedtext")) {
      res2.writeHead(200, { "content-type": "application/json" });
      res2.end(json3);
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
const check = (n, ok) => { console.log(`${ok ? "  ✅" : "  ❌"} ${n}`); if (!ok) failures++; };

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

try {
  const page = await context.newPage();
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.waitForSelector("#tnm-root", { state: "attached", timeout: 10000 });
  await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 8000 });
  check("toolbar visible on page", true);

  // Load the REAL built inject (installs the fetch/XHR hooks), exactly as the
  // manifest does on youtube.com, then make a real timedtext request. The inject
  // must intercept it, parse, and hand it to the content script.
  await page.addScriptTag({ path: resolve(distDir, "assets/youtube.js") });
  await page.evaluate(() => {
    // The inject keys captions off the last seen videoId; prime it.
    window.postMessage({ source: "tnm-yt", kind: "videoChanged", videoId: "sim123" }, "*");
  });
  await page.evaluate(async () => {
    await fetch("/api/timedtext?lang=ja&kind=asr&fmt=json3").catch(() => {});
    const v = document.querySelector("video");
    if (v) { v.currentTime = 2.0; v.play().catch(() => {}); }
  });

  // tokens should render for the active cue; furigana once kuromoji loads
  await page.locator(".tnm-token").first().waitFor({ timeout: 20000 });
  const tokens = await page.locator(".tnm-token").count();
  check("YouTube-format captions parsed & tokens rendered", tokens > 0);
  console.log("    token count:", tokens);

  let furi = "";
  try {
    const rt = page.locator("ruby.tnm-reading rt").first();
    await rt.waitFor({ timeout: 40000 });
    furi = (await rt.textContent())?.trim() ?? "";
  } catch {}
  check("furigana rendered on YouTube captions", /[぀-ゟ]/.test(furi));
  console.log("    sample furigana:", JSON.stringify(furi));

  const line = await page.locator(".TnmSubs__targetSubs__line").first().textContent().catch(() => "");
  console.log("    overlay line:", JSON.stringify(line?.trim()));

  await page.screenshot({ path: resolve(testDir, "e2e-youtube-sim.png") });
  console.log("    screenshot: test/e2e-youtube-sim.png");

  // Buffer + replay fix: the inject must re-deliver already-captured cues on a `replay` command
  // (covers the content listener starting after the capture, and YouTube serving cached cues on a
  // CC toggle with no network request for our hook to see).
  const replayed = await page.evaluate(
    () =>
      new Promise((res) => {
        let got = false;
        const onMsg = (e) => {
          const d = e.data;
          if (d && d.source === "tnm-yt" && d.kind === "captionData" && d.body) got = true;
        };
        window.addEventListener("message", onMsg);
        window.postMessage({ source: "tnm-cmd", cmd: "replay" }, "*");
        setTimeout(() => {
          window.removeEventListener("message", onMsg);
          res(got);
        }, 600);
      }),
  );
  check("inject replays buffered captionData on `replay`", replayed);
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
  failures++;
} finally {
  await context.close();
  server.close();
}

console.log(failures === 0 ? "\nYOUTUBE RENDER PATH: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
