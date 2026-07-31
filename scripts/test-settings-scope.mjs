// Unit test for the 3-level settings scoping (per-video / per-site / global).
// Run: node scripts/test-settings-scope.mjs
import * as esbuild from "esbuild";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), "tnm-scope-"));

// Stub the tokenizer import (storage only needs normalizeLang, for the known-words key).
const stub = join(dir, "tokenizer-stub.mjs");
await writeFile(stub, "export function normalizeLang(l){return (l||'').toLowerCase().split('-')[0];}");

const out = join(dir, "storage.mjs");
await esbuild.build({
  entryPoints: [resolve(root, "src/lib/storage.ts")],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{ name: "stub-tok", setup(b) { b.onResolve({ filter: /tokenizer$/ }, () => ({ path: stub })); } }],
});

// In-memory chrome.storage.local + a location, set before importing the module.
const db = {};
globalThis.location = { hostname: "unit.test" };
globalThis.chrome = {
  storage: { local: {
    get: async (keys) => { const ks = Array.isArray(keys) ? keys : [keys]; const o = {}; for (const k of ks) if (k in db) o[k] = db[k]; return o; },
    set: async (obj) => { Object.assign(db, structuredClone(obj)); },
    remove: async (k) => { delete db[k]; },
  } },
};

const { loadSettings, saveSettings, saveHostSettings, siteScope, hostSettingsKey, HOST_SCOPED_KEYS } =
  await import(pathToFileURL(out).href);

let failures = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}`);
  if (!ok) { console.log("     got :", JSON.stringify(got)); console.log("     want:", JSON.stringify(want)); failures++; }
};

console.log("siteScope");
eq("strips leading www.", siteScope("www.youtube.com"), "youtube.com");
eq("keeps bare domain", siteScope("hianime.to"), "hianime.to");
eq("keeps non-www subdomain", siteScope("m.youtube.com"), "m.youtube.com");
eq("hostSettingsKey uses scope", hostSettingsKey("www.netflix.com"), "tnm:settings:netflix.com");

console.log("\npartition");
eq("offset is NOT host-scoped", HOST_SCOPED_KEYS.includes("subOffset"), false);
eq("anki keys are NOT host-scoped", HOST_SCOPED_KEYS.some((k) => k.startsWith("anki")), false);
eq("targetLang IS host-scoped", HOST_SCOPED_KEYS.includes("targetLang"), true);

console.log("\nper-site isolation + global seed");
// Simulate a pre-split monolithic global record (old prefs + anki config).
db["tnm:settings"] = { targetLang: "ja", subtitleSize: 1, ankiDeck: "DeckOne", ankiEnabled: true };

// Site A bumps subtitleSize to 2 (a host-scoped key) and changes targetLang to ko.
await saveHostSettings({ targetLang: "ko", subtitleSize: 2, ankiDeck: "HACK", ankiEnabled: false }, "a.example.com");

const a = await loadSettings("a.example.com");
const b = await loadSettings("b.example.com");
eq("site A sees its own subtitleSize", a.subtitleSize, 2);
eq("site A sees its own targetLang", a.targetLang, "ko");
eq("site B is unaffected (seeded from global)", b.subtitleSize, 1);
eq("site B targetLang from global seed", b.targetLang, "ja");
eq("global record NOT polluted by host save (anki intact)", db["tnm:settings"].ankiDeck, "DeckOne");
eq("host record did NOT capture anki keys", "ankiDeck" in (db["tnm:settings:a.example.com"] ?? {}), false);
eq("both sites share global anki config", [a.ankiDeck, b.ankiDeck], ["DeckOne", "DeckOne"]);

console.log("\nglobal save routes only global keys");
await saveSettings({ ankiDeck: "DeckTwo", subtitleSize: 9, targetLang: "zh" });
eq("global ankiDeck updated", db["tnm:settings"].ankiDeck, "DeckTwo");
eq("global save ignored host-scoped subtitleSize", db["tnm:settings"].subtitleSize, 1);
eq("global save preserved seed targetLang", db["tnm:settings"].targetLang, "ja");
eq("site A still isolated after global save", (await loadSettings("a.example.com")).subtitleSize, 2);

console.log(failures ? `\n❌ ${failures} failure(s)` : "\nALL CHECKS PASSED ✅");
process.exit(failures ? 1 : 0);
