// Unit test for the mined-tracking store (sentence normalization + word/sentence
// membership + backfill via writeMined). Run: node scripts/test-mined.mjs
import * as esbuild from "esbuild";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), "tnm-mined-"));
const stub = join(dir, "tok.mjs");
await writeFile(stub, "export function normalizeLang(l){return (l||'').toLowerCase().split('-')[0];}");
const out = join(dir, "storage.mjs");
await esbuild.build({
  entryPoints: [resolve(root, "src/lib/storage.ts")],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{ name: "stub", setup(b) { b.onResolve({ filter: /tokenizer$/ }, () => ({ path: stub })); } }],
});

const db = {};
globalThis.location = { hostname: "unit.test" };
globalThis.chrome = {
  storage: {
    onChanged: { addListener: () => {} },
    local: {
      get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; for (const x of ks) if (x in db) o[x] = db[x]; return o; },
      set: async (obj) => { Object.assign(db, structuredClone(obj)); },
      remove: async (x) => { delete db[x]; },
    },
  },
};

const { MinedStore, writeMined, mergeMined, clearMined, normMinedSentence } = await import(pathToFileURL(out).href);

let failures = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}`);
  if (!ok) { console.log("     got :", JSON.stringify(got)); console.log("     want:", JSON.stringify(want)); failures++; }
};

console.log("normMinedSentence");
eq("strips <b> tags + whitespace", normMinedSentence("日本語を <b>食べる</b> 。"), "日本語を食べる。");

console.log("\nadd + membership (whitespace/HTML-insensitive)");
const m = new MinedStore();
await m.load();
await m.add("食べる", "私は 日本語を 食べる");
eq("hasWord(lemma)", m.hasWord("食べる"), true);
eq("hasWord(other) = false", m.hasWord("飲む"), false);
eq("hasSentence ignores spacing", m.hasSentence("私は日本語を食べる"), true);
eq("hasSentence matches the bolded card form", m.hasSentence("私は日本語を<b>食べる</b>"), true);
eq("hasSentence(other) = false", m.hasSentence("別の文"), false);

console.log("\nbackfill (writeMined) → a fresh store sees it");
await writeMined(["走る", "飲む"], ["<b>走る</b>のが好き", "水を 飲む"]);
const m2 = new MinedStore();
await m2.load();
eq("backfilled word", m2.hasWord("走る"), true);
eq("backfilled sentence (normalized from card HTML)", m2.hasSentence("走るのが好き"), true);
eq("backfilled sentence 2", m2.hasSentence("水を飲む"), true);
eq("old word gone after overwrite", m2.hasWord("食べる"), false);

console.log("\nmergeMined (union) — never drops existing tracking");
await mergeMined(["歩く"], ["道を 歩く"]);
const m3 = new MinedStore();
await m3.load();
eq("merged word added", m3.hasWord("歩く"), true);
eq("prior word kept", m3.hasWord("走る"), true);
eq("prior sentence kept", m3.hasSentence("水を飲む"), true);

console.log("\nclearMined — wipes local tracking (re-syncable)");
await clearMined();
const m4 = new MinedStore();
await m4.load();
eq("word cleared", m4.hasWord("歩く"), false);
eq("sentence cleared", m4.hasSentence("水を飲む"), false);
eq("count 0", m4.count(), 0);

console.log(failures ? `\n❌ ${failures} failure(s)` : "\nALL CHECKS PASSED ✅");
process.exit(failures ? 1 : 0);
