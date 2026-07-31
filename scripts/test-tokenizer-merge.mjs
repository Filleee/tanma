// Tokenizer merge test: real kuromoji/IPADIC → our mergeJapaneseFeatures.
// Verifies conjugated verbs/adjectives/suru-verbs collapse to one token + lemma.
// Run: node scripts/test-tokenizer-merge.mjs
import * as esbuild from "esbuild";
import kuromoji from "kuromoji";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Bundle jaMerge.ts (+ its kana dep) for Node.
const out = join(await mkdtemp(join(tmpdir(), "tnm-merge-")), "jaMerge.mjs");
await esbuild.build({
  entryPoints: [resolve(root, "src/lib/tokenizer/jaMerge.ts")],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
});
const { mergeJapaneseFeatures } = await import(pathToFileURL(out).href);

const tok = await new Promise((res, rej) =>
  kuromoji.builder({ dicPath: resolve(root, "node_modules/kuromoji/dict") }).build((e, t) => (e ? rej(e) : res(t))),
);

let failures = 0;
const check = (text, wantSurfaces, wantDicts) => {
  const toks = mergeJapaneseFeatures(tok.tokenize(text));
  const surfaces = toks.map((t) => t.surface);
  const dicts = toks.filter((t) => t.isWord).map((t) => t.dict);
  const okS = JSON.stringify(surfaces) === JSON.stringify(wantSurfaces);
  const okD = wantDicts ? wantDicts.every((d) => dicts.includes(d)) : true;
  const ok = okS && okD;
  console.log(`${ok ? "  ✅" : "  ❌"} ${text}`);
  if (!ok) {
    if (!okS) { console.log("     surfaces got :", JSON.stringify(surfaces)); console.log("     surfaces want:", JSON.stringify(wantSurfaces)); }
    if (!okD) { console.log("     dict lemmas  :", JSON.stringify(dicts), "want⊇", JSON.stringify(wantDicts)); }
    failures++;
  }
};

console.log("conjugation chains collapse to one token with the lemma");
check("食べさせられたくなかった", ["食べさせられたくなかった"], ["食べる"]);
check("高かった", ["高かった"], ["高い"]);
check("食べている", ["食べている"], ["食べる"]);
check("乗り換える", ["乗り換える"], ["乗り換える"]);

console.log("\nsuru-verbs: noun + する(+infl) → one token, lemma = the noun");
check("勉強したくない", ["勉強したくない"], ["勉強"]);

console.log("\nparticles/case markers stay separate; te-form merges into the verb");
check("長崎駅からバスに乗って", ["長崎", "駅", "から", "バス", "に", "乗って"], ["乗る"]);
check("気をつけて", ["気", "を", "つけて"], ["つける"]);

console.log("\ncompounds IPADIC keeps whole are untouched");
check("修学旅行", ["修学旅行"], ["修学旅行"]);

console.log(failures ? `\n❌ ${failures} failure(s)` : "\nALL CHECKS PASSED ✅");
process.exit(failures ? 1 : 0);
