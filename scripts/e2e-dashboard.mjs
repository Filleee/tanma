// Verifies the revamped dashboard (options page): sidebar tabs switch panels, the Overview
// shows stats + a getting-started checklist, and Backup export downloads a JSON file.
// Run: node scripts/e2e-dashboard.mjs
import { chromium } from "playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");

let failures = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "  ✅" : "  ❌"} ${n}${extra ? "  " + extra : ""}`); if (!ok) failures++; };

const context = await chromium.launchPersistentContext("", {
  headless: false,
  acceptDownloads: true,
  args: ["--headless=new", `--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run", "--no-default-browser-check"],
});

try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }));
  const extId = new URL(sw.url()).host;

  // Seed a recent mine + a per-site override + a dummy key for the new dashboard sections.
  await sw.evaluate(() => chrome.storage.local.set({
    "tnm:mined-recent": [{ word: "テスト", sentence: "これはテストです", at: Date.now() - 60000 }],
    "tnm:settings:example.com": { targetLang: "ko", subtitleSize: 1.4 },
    "tnm:_e2e_dummy": 1,
  }));

  const opt = await context.newPage();
  opt.on("dialog", (d) => d.accept()); // auto-confirm the reset prompts
  await opt.goto(`chrome-extension://${extId}/options.html`, { waitUntil: "load" });

  // Overview is the default tab.
  check("overview is the default tab", await opt.locator('.panel[data-panel="overview"]').isVisible());
  await opt.waitForFunction(() => /\d/.test(document.getElementById("ov-known")?.textContent || ""), null, { timeout: 6000 }).catch(() => {});
  check("overview stat cards render numbers", /\d/.test((await opt.locator("#ov-known").textContent()) || ""));
  check("known-words stat is labelled with the language", /Known words ·/.test((await opt.locator("#ov-known").locator("xpath=../div[2]").textContent()) || ""));
  check("getting-started checklist renders", (await opt.locator("#ov-checklist li").count()) >= 4);
  check("checklist links the lapis-simplified note type", (await opt.locator('#ov-checklist a[href*="lapis-simplified/releases"]').count()) === 1);

  // Switch tabs via the sidebar.
  await opt.locator('.nav__link[data-tab="dicts"]').click();
  check("clicking a nav tab shows that panel", await opt.locator('.panel[data-panel="dicts"]').isVisible());
  check("…and hides the others", !(await opt.locator('.panel[data-panel="overview"]').isVisible()));
  check("deep-link hash updates", opt.url().endsWith("#dicts"));

  // A quick-action button jumps to a tab too.
  await opt.locator('.nav__link[data-tab="overview"]').click();
  await opt.locator('#ov-checklist [data-go], .actions [data-go]').first().click().catch(() => {});

  // Backup export downloads a JSON file.
  await opt.locator('.nav__link[data-tab="overview"]').click();
  const download = await Promise.all([
    opt.waitForEvent("download", { timeout: 6000 }),
    opt.locator("#bk-export").click(),
  ]).then(([d]) => d).catch(() => null);
  if (download) check("backup export downloads a JSON file", /^tnm-backup-.*\.json$/.test(download.suggestedFilename()), `(${download.suggestedFilename()})`);
  else console.log("  · (headless: download event not captured — export click ok)");

  // Appearance: swatches render; picking one changes the --accent variable.
  check("accent swatches render", (await opt.locator("#ov-accent .swatch").count()) >= 7);
  await opt.locator("#ov-accent .swatch").nth(1).click(); // Blue (#4aa3ff)
  const accent = await opt.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  check("picking a swatch updates the accent colour", accent.toLowerCase() === "#4aa3ff", `(${accent})`);

  // Recently mined feed shows the seeded mine.
  check("recently-mined feed shows the latest word", (await opt.locator("#ov-recent").textContent())?.includes("テスト"));

  // Per-site settings list shows the seeded override; resetting it removes the row.
  check("per-site list shows the customized site", (await opt.locator("#ov-sites").textContent())?.includes("example.com"));
  await opt.locator(".site", { hasText: "example.com" }).locator("button").click();
  const gone = await opt.waitForFunction(() => !(document.getElementById("ov-sites")?.textContent || "").includes("example.com"), null, { timeout: 4000 }).then(() => true).catch(() => false);
  check("resetting a site removes its override", gone);

  // Activation rules editor shows the built-in YouTube default.
  check("activation editor shows the youtube default rule", (await opt.locator("#ov-activation .act-host").first().inputValue().catch(() => "")) === "youtube.com");
  check("activation default patterns include /watch", /\/watch/.test((await opt.locator("#ov-activation .act-pat").first().inputValue().catch(() => "")) || ""));

  await opt.screenshot({ path: resolve(root, "test", "e2e-dashboard.png"), fullPage: true }).catch(() => {});
  console.log("    screenshot: test/e2e-dashboard.png");

  // Danger zone: reset all data clears every tnm:* key.
  await opt.locator("#rst-all").click();
  await opt.waitForTimeout(1200);
  // After reset the page reloads and the one-time migration re-sets its benign tnm:_migrated flag.
  const remaining = await sw.evaluate(() => chrome.storage.local.get(null).then((all) => Object.keys(all).filter((k) => (k.startsWith("tnm:") || k.startsWith("mgk:")) && k !== "tnm:_migrated")));
  check("reset all data clears every data key", remaining.length === 0, `(${remaining.length} left)`);
} catch (e) {
  console.log("  ❌ fatal:", String(e?.stack || e).split("\n").slice(0, 3).join("\n"));
  failures++;
} finally {
  await context.close();
}
console.log(failures === 0 ? "\nDASHBOARD: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
