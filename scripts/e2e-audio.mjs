// Verifies the background audio path: real word -> JapanesePod101 data URL;
// missing word -> null (so the UI falls back to TTS). Drives the real extension
// messaging from an extension page. Run: node scripts/e2e-audio.mjs
import { chromium } from "playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");

let failures = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "  ✅" : "  ❌"} ${n}${extra ? "  " + extra : ""}`); if (!ok) failures++; };

const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: ["--headless=new", `--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run"],
});

try {
  let sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }));
  const extId = new URL(sw.url()).host;

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });

  const ask = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  const real = await ask({ type: "audio", term: "日本語", reading: "にほんご", lang: "ja" });
  check(
    "real word returns JapanesePod101 audio",
    real?.ok && typeof real.dataUrl === "string" && real.dataUrl.startsWith("data:audio/mpeg;base64,") && real.dataUrl.length > 500,
    real?.dataUrl ? `(${real.dataUrl.length} chars)` : JSON.stringify(real),
  );

  const missing = await ask({ type: "audio", term: "あ", reading: "ぐぇぐぇあ", lang: "ja" });
  check("missing word returns null (→ TTS fallback)", missing?.ok && missing.dataUrl === null, JSON.stringify(missing));
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
  failures++;
} finally {
  await context.close();
}
console.log(failures === 0 ? "\nJISHO/JPOD101 AUDIO: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
