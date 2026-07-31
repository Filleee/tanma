// Verifies the TANMA Reader (texthooker page) against a MOCK tanma-hook server:
// connect + hello, hooked lines render with tokens/furigana, click-to-look-up works,
// and mining sends a capture request with the LINE's timestamps (the retroactive
// audio window) and consumes the media reply. Run: node scripts/e2e-reader.mjs
import { chromium } from "playwright";
import { WebSocketServer } from "ws";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");
const testDir = resolve(root, "test");

let failures = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "  ✅" : "  ❌"} ${n}${extra ? "  " + extra : ""}`); if (!ok) failures++; };

// ---- mock tanma-hook: hello + text broadcast + capture→media ----
const TINY_JPEG_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const TINY_WAV_B64 = Buffer.concat([
  Buffer.from("RIFF"), Buffer.from([36 + 3200 & 0xff, (36 + 3200) >> 8 & 0xff, 0, 0]), Buffer.from("WAVEfmt "),
  Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 16, 0]),
  Buffer.from("data"), Buffer.from([3200 & 0xff, 3200 >> 8 & 0xff, 0, 0]), Buffer.alloc(3200),
]).toString("base64");

const captures = [];
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
const clients = new Set();
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.send(JSON.stringify({ type: "hello", app: "tanma-hook", version: "0.1.0", capabilities: ["text", "screenshot", "audio"] }));
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "capture") {
      captures.push(msg);
      ws.send(JSON.stringify({ type: "media", id: msg.id, image: msg.image ? TINY_JPEG_B64 : null, audio: msg.audioFrom != null ? TINY_WAV_B64 : null, audioExt: "wav" }));
    }
  });
});
await new Promise((r) => wss.once("listening", r));
const wsUrl = `ws://127.0.0.1:${wss.address().port}`;
const sendLine = (text, time, hookKey = "H1", hook = "KiriKiriZ2") => {
  for (const ws of clients) ws.send(JSON.stringify({ type: "text", text, sentence: text, time, hook, hookKey, process: "vn.exe" }));
};

const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: ["--headless=new", `--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run", "--no-default-browser-check"],
});

// Mock the Google Translate endpoint (used by the reader's per-line machine translation).
await context.route(/translate\.googleapis\.com\/translate_a\/single/, (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([[["mock translation", "src"]]]) }),
);

try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }));
  const extId = new URL(sw.url()).host;
  // Enable mining so the ＋ button appears (Anki itself isn't running — the mine will
  // fail at AnkiConnect, but the capture round-trip is what we're testing).
  await sw.evaluate(() => chrome.storage.local.set({
    "tnm:settings": { ankiEnabled: true, ankiDeck: "Mining", ankiModel: "lapis-simplified", ankiCaptureImage: true, ankiCaptureSentenceAudio: true, ankiCaptureWordAudio: false },
  }));

  const page = await context.newPage();
  await page.addInitScript((url) => localStorage.setItem("tnm-reader-ws", url), wsUrl);
  await page.goto(`chrome-extension://${extId}/reader.html`, { waitUntil: "load" });

  // 1) Connects to the mock and identifies it via hello.
  await page.waitForFunction(() => document.getElementById("conn")?.classList.contains("-on"), null, { timeout: 60000 });
  const connLabel = await page.locator("#conn-label").textContent();
  check("connects and shows the source from hello", /tanma-hook/.test(connLabel ?? ""), `(${connLabel})`);

  // 2) Hooked lines render with interactive tokens + furigana.
  const t0 = Date.now() / 1000 - 8; // "the line appeared 8s ago"
  sendLine("日本語を勉強しています。", t0);
  sendLine("彼は昨日学校へ行きました。", t0 + 4);
  await page.locator(".line .tnm-token").first().waitFor({ timeout: 15000 });
  check("hooked lines render as token lines", (await page.locator(".line").count()) === 2, `(${await page.locator(".line").count()} lines)`);
  const rt = await page.locator(".line ruby.tnm-reading rt").first().textContent().catch(() => "");
  check("furigana rendered (tokenizer was awaited)", /[぀-ゟ]/.test(rt ?? ""), JSON.stringify(rt));

  // 3) Duplicate line within 2s is deduped.
  sendLine("彼は昨日学校へ行きました。", t0 + 4.5);
  await page.waitForTimeout(400);
  check("duplicate line deduped", (await page.locator(".line").count()) === 2);

  // 4) Click a word → the look-up popup opens (with the mine button, since Anki is on).
  await page.locator(".line .tnm-token.-tnm-word").first().click();
  await page.locator(".tnm-lookup").waitFor({ state: "visible", timeout: 8000 });
  check("clicking a word opens the look-up popup", true);
  await page.locator(".tnm-lookup__mine").waitFor({ timeout: 5000 });

  // 4b) Kana display toggle: readings flip hiragana ⇄ katakana (display only).
  await page.locator(".tnm-lookup__word ruby rt").first().waitFor({ timeout: 8000 });
  const rtHira = await page.locator(".tnm-lookup__word ruby rt").first().textContent();
  await page.locator(".tnm-lookup__kana").click();
  const rtKata = await page.locator(".tnm-lookup__word ruby rt").first().textContent();
  check("kana toggle flips the popup reading to katakana", /^[ァ-ヶー]+$/.test(rtKata ?? "") && rtKata !== rtHira, `(${rtHira} → ${rtKata})`);
  await page.locator(".tnm-lookup__kana").click(); // back to hiragana for the rest of the run

  // 5) Mining requests capture with the FIRST line's time window (retroactive audio).
  await page.locator(".tnm-lookup__mine").click();
  // Wait past the transient "Mining…" toast to the outcome toast (✓ or the Anki error —
  // AnkiConnect isn't running in this test, so an error is the expected outcome).
  await page.waitForFunction(() => {
    const t = document.getElementById("toast");
    return t?.style.display === "block" && !/^Mining/.test(t.textContent ?? "");
  }, null, { timeout: 30000 });
  check("mine sent a capture request to tanma-hook", captures.length === 1, `(${captures.length})`);
  const cap = captures[0] ?? {};
  check("capture asks for a screenshot", cap.image === true);
  const fromOk = Math.abs((cap.audioFrom ?? 0) - (t0 - 0.35)) < 0.01;
  const toOk = Math.abs((cap.audioTo ?? 0) - (t0 + 4)) < 0.01;
  check("audio window = [line.time−0.35 … next line.time]", fromOk && toOk, `(from Δ${((cap.audioFrom ?? 0) - t0).toFixed(2)}, to Δ${((cap.audioTo ?? 0) - t0).toFixed(2)})`);
  const toast = await page.locator("#toast").textContent();
  check("mine completed through to Anki call (fails w/o Anki, no crash)", /Anki|✓/.test(toast ?? ""), `(${JSON.stringify(toast)})`);

  // 6) Stats reflect the session.
  check("stats count lines/chars", (await page.locator("#st-lines").textContent()) === "2" && (await page.locator("#st-chars").textContent()) !== "0");

  // 7) Incremental growth (engine redraws the growing line) updates IN PLACE.
  const t2 = t0 + 10;
  sendLine("ぐ", t2);
  sendLine("ぐぬぬ", t2 + 0.4);
  sendLine("ぐぬぬぬぬ。", t2 + 0.8);
  await page.waitForFunction(() => [...document.querySelectorAll(".line")].some((l) => l.textContent?.includes("ぐぬぬぬぬ。")), null, { timeout: 8000 });
  const lineCount = await page.locator(".line").count();
  check("growing line replaces itself (no per-character rows)", lineCount === 3, `(${lineCount} lines)`);

  // 8) A second hook thread appears → the hook picker shows; filtering hides its lines.
  sendLine("セーブ画面カスタマイズ", t2 + 2, "H2", "GetGlyphOutlineW");
  await page.waitForFunction(() => document.getElementById("hook-filter")?.style.display !== "none", null, { timeout: 8000 });
  check("hook picker appears once a second thread emits", true);
  await page.selectOption("#hook-filter", "H1");
  await page.waitForTimeout(200);
  const visible = await page.evaluate(() => [...document.querySelectorAll(".line")].filter((l) => l.style.display !== "none").length);
  check("picking a hook hides the other thread's lines", visible === 3, `(${visible} visible of ${await page.locator(".line").count()})`);

  // 9) Name hook: designate a thread as the speaker source → its lines become a
  //    name chip on the next dialogue line instead of list rows.
  sendLine("【ムラサメ】", t2 + 3, "HN", "NameHook");
  await page.waitForFunction(() => (document.getElementById("name-hook")?.children.length ?? 0) >= 3, null, { timeout: 8000 });
  await page.selectOption("#name-hook", "HN");
  const before = await page.locator(".line").count();
  sendLine("【ムラサメ】", t2 + 5, "HN", "NameHook");
  sendLine("「吾輩は満足である」", t2 + 5.2);
  // NB: furigana <rt> text interleaves into textContent (吾輩わがはい…), so wait on a
  // kana-only fragment that survives ruby.
  await page.waitForFunction(() => [...document.querySelectorAll(".line")].some((l) => l.textContent?.includes("である」")), null, { timeout: 8000 });
  check("name-hook lines don't create rows", (await page.locator(".line").count()) === before + 1);
  const speaker = await page.locator(".line").last().locator(".line-speaker").textContent().catch(() => null);
  check("speaker chip attaches to the dialogue line", speaker === "ムラサメ", `(${JSON.stringify(speaker)})`);

  // 10) Reader settings popover: toggling furigana flips the body class; enabling
  //    machine translation renders a translation line under hooked lines.
  await page.locator("#settings").click();
  check("settings popover opens", await page.locator("#settings-pop").isVisible());
  await page.locator("#set-furi + i").click(); // styled switch — click its track
  await page.waitForTimeout(200);
  check("furigana toggle flips the body class", !(await page.evaluate(() => document.body.classList.contains("-tnm-furigana"))));
  await page.locator("#set-mt + i").click();
  await page.locator(".line .line-tr").first().waitFor({ timeout: 12000 });
  const trText = await page.locator(".line .line-tr").first().textContent();
  check("machine translation line renders under a hooked line", trText === "mock translation", `(${JSON.stringify(trText)})`);
  check("reader prefs saved under the reader scope", await sw.evaluate(async () => {
    const got = await chrome.storage.local.get("tnm:settings:reader");
    const s = got["tnm:settings:reader"] ?? {};
    return s.showFurigana === false && s.showMachineTranslation === true;
  }));

  await page.screenshot({ path: resolve(testDir, "e2e-reader.png") });
  console.log("    screenshot: test/e2e-reader.png");
} catch (e) {
  console.log("  ❌ fatal:", String(e?.stack || e).split("\n").slice(0, 3).join("\n"));
  failures++;
} finally {
  await context.close();
  wss.close();
}
console.log(failures === 0 ? "\nREADER: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
