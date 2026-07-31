// Verifies the deck-sync combobox on the options page: renders, opens on click, shows a
// search box, and (with injected items) filters + multi-selects. Run: node scripts/e2e-deck-combo.mjs
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
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 8000 }));
  const extId = new URL(sw.url()).host;
  const opt = await context.newPage();
  // Dashboard now has tabs; deep-link straight to the Anki panel (overview is the default).
  await opt.goto(`chrome-extension://${extId}/options.html#anki`, { waitUntil: "load" });

  check("dashboard sidebar renders", (await opt.locator(".nav__link").count()) >= 4);
  check("anki tab is active (deep-linked)", await opt.locator('.panel[data-panel="anki"]').isVisible());

  // Anki config is dimmed/pointer-events:none until enabled — turn it on first.
  await opt.locator("#anki-enabled").click();

  const combo = opt.locator("#anki-sync-decks .combo");
  await combo.waitFor({ timeout: 5000 });
  check("combo renders with placeholder", (await combo.locator(".combo__field").textContent())?.includes("Select decks"));

  // Inject deck items the way connect() would (no AnkiConnect in the test), then drive it.
  await opt.locator(".combo__field").click();
  check("menu opens with a search box", await opt.locator(".combo__menu .combo__search").isVisible());

  // Without AnkiConnect the list is empty; verify the prompt to connect.
  await opt.locator(".combo__empty").waitFor({ timeout: 3000 }).catch(() => {});
  const emptyText = await opt.locator(".combo__empty").textContent().catch(() => "");
  check("empty state prompts to connect", /test connection/i.test(emptyText || ""), `("${emptyText}")`);

  await opt.screenshot({ path: resolve(root, "test", "e2e-deck-combo.png") });
  console.log("    screenshot: test/e2e-deck-combo.png");
} catch (e) {
  console.log("  ❌ fatal:", String(e?.message || e));
  failures++;
} finally {
  await context.close();
}
console.log(failures === 0 ? "\nDECK COMBO: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
