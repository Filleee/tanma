// Verifies the auto-enable wiring: when the content script receives caption
// tracks containing the target language, it posts an `enableCaptions` command
// (which, on real YouTube, the inject turns into player.setOption / CC click).
// Run: node scripts/e2e-autoenable.mjs
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
    } catch {
      res2.writeHead(404);
      res2.end("nf");
    }
  });
  s.listen(0, "127.0.0.1", () => res(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: ["--headless=new", `--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run"],
});
await context.addInitScript(() => {
  window.__cmds = [];
  window.addEventListener("message", (e) => {
    if (e.data && e.data.source === "tnm-cmd") window.__cmds.push(e.data);
  });
});

let ok = false;
try {
  const page = await context.newPage();
  await page.goto(`${base}/auto.html`, { waitUntil: "load" });
  await page.locator(".TnmBar").waitFor({ state: "visible", timeout: 10000 });

  // Simulate the inject reporting a Japanese caption track.
  await page.evaluate(() => {
    window.postMessage(
      { source: "tnm-yt", kind: "tracks", videoId: "vid1", tracks: [{ baseUrl: "x", lang: "ja", name: "Japanese", kind: "asr" }] },
      "*",
    );
  });

  const cmd = await page
    .waitForFunction(() => (window.__cmds || []).find((c) => c.cmd === "enableCaptions"), null, { timeout: 5000 })
    .then((h) => h.jsonValue())
    .catch(() => null);

  ok = !!cmd && cmd.lang === "ja";
  console.log(ok ? "  ✅ content script auto-emitted enableCaptions" : "  ❌ no enableCaptions command", cmd || "");
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
} finally {
  await context.close();
  server.close();
}
console.log(ok ? "\nAUTO-ENABLE WIRING: OK ✅" : "\nAUTO-ENABLE WIRING: FAILED ❌");
process.exit(ok ? 0 : 1);
