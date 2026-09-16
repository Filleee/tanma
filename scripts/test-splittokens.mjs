// Unit tests for lib/splitTokens — dictionary-validated re-splitting of over-merged Japanese
// tokens (the ねだらないだろう case). Feeds REAL kuromoji morpheme output through
// mergeJapaneseFeatures, then splits it against a stub dictionary.
// Run: node scripts/test-splittokens.mjs
import * as esbuild from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), "tnm-split-"));
const load = async (src, out, fix = (c) => c) => {
  const { code } = await esbuild.transform(await readFile(resolve(root, src), "utf8"), { loader: "ts", format: "esm" });
  await writeFile(join(dir, out), fix(code));
  return import(pathToFileURL(join(dir, out)).href);
};
await load("src/lib/kana.ts", "kana.mjs");
const { mergeJapaneseFeatures } = await load("src/lib/tokenizer/jaMerge.ts", "jaMerge.mjs", (c) =>
  c.replace('from "../kana"', 'from "./kana.mjs"'),
);
const { splitOvermergedTokens, unknownForms, mergeFunctionRuns } = await load("src/lib/splitTokens.ts", "splitTokens.mjs");

let failures = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}`);
  if (!ok) {
    console.log("     got :", JSON.stringify(got));
    console.log("     want:", JSON.stringify(want));
    failures++;
  }
};
const ok = (name, cond) => {
  console.log(`${cond ? "  ✅" : "  ❌"} ${name}`);
  if (!cond) failures++;
};

// kuromoji's actual output for these strings (captured from the bundled IPADIC).
const f = (surface_form, pos, pos_detail_1, basic_form) => ({ surface_form, pos, pos_detail_1, basic_form, reading: surface_form });
const FEATS = {
  ねだらないだろう: [
    f("ねだら", "動詞", "自立", "ねだる"), f("ない", "助動詞", "*", "ない"),
    f("だろ", "助動詞", "*", "だ"), f("う", "助動詞", "*", "う"),
  ],
  行っただろう: [
    f("行っ", "動詞", "自立", "行く"), f("た", "助動詞", "*", "た"),
    f("だろ", "助動詞", "*", "だ"), f("う", "助動詞", "*", "う"),
  ],
  食べさせられた: [
    f("食べ", "動詞", "自立", "食べる"), f("させ", "動詞", "接尾", "させる"),
    f("られ", "動詞", "接尾", "られる"), f("た", "助動詞", "*", "た"),
  ],
  行こう: [f("行こ", "動詞", "自立", "行く"), f("う", "助動詞", "*", "う")],
};

// Stub of the background resolver: surface -> dictionary headword (itself or a deinflection).
const DICT = {
  ねだらない: "ねだる",
  だろう: "だろう",
  行った: "行く",
  行こう: "行く",
  食べさせられた: "食べる",
};
const resolver = async (forms) => forms.filter((x) => DICT[x]).map((x) => ({ form: x, dict: DICT[x] }));
const deadResolver = async () => [];

const surfaces = (ts) => ts.map((t) => t.surface);
const dicts = (ts) => ts.map((t) => t.dict);

console.log("\nmergeJapaneseFeatures keeps the morpheme breakdown");
{
  const [t] = mergeJapaneseFeatures(FEATS["ねだらないだろう"]);
  eq("over-merges (the bug this pass fixes)", t.surface, "ねだらないだろう");
  eq("parts recorded", t.parts?.map((p) => p.surface), ["ねだら", "ない", "だろ", "う"]);
  ok("single morphemes carry no parts", mergeJapaneseFeatures([f("と", "助詞", "格助詞", "と")])[0].parts === undefined);
  ok("spans are offered for lookup", unknownForms([t]).includes("ねだらない") && unknownForms([t]).includes("だろう"));
}

console.log("\nsplitOvermergedTokens");
{
  const run = async (key) => (await splitOvermergedTokens(mergeJapaneseFeatures(FEATS[key]), resolver)).tokens;

  eq("ねだらないだろう splits like Yomitan", surfaces(await run("ねだらないだろう")), ["ねだらない", "だろう"]);
  eq("  …with the right headwords", dicts(await run("ねだらないだろう")), ["ねだる", "だろう"]);
  eq("行っただろう splits too", surfaces(await run("行っただろう")), ["行った", "だろう"]);
  eq("食べさせられた stays whole (it resolves)", surfaces(await run("食べさせられた")), ["食べさせられた"]);
  eq("行こう stays whole — volitional う is real inflection", surfaces(await run("行こう")), ["行こう"]);

  const furigana = (await run("ねだらないだろう"))[0];
  eq("keeps the surface reading, not the lemma's", furigana.reading, "ねだらない");
}

console.log("\nsafety");
{
  // The session cache is module-level (like mergeTokens.ts), and the runs above warmed it — so
  // "no dictionary" has to be exercised on a FRESH instance with a cold cache.
  const cold = await load("src/lib/splitTokens.ts", "splitTokens.cold.mjs");
  const merged = mergeJapaneseFeatures(FEATS["ねだらないだろう"]);
  const dead = await cold.splitOvermergedTokens(merged, deadResolver);
  eq("no dictionary → left untouched, never shattered", surfaces(dead.tokens), ["ねだらないだろう"]);
  ok("and reports no change", dead.changed === false);
  const kept = await splitOvermergedTokens(mergeJapaneseFeatures(FEATS["行こう"]), resolver);
  ok("unchanged tokens report changed=false", kept.changed === false);
}

console.log("\nmergeFunctionRuns (the under-merge direction)");
{
  const tok = (surface, pos) => ({ surface, reading: surface, dict: surface, pos, isWord: true });
  const RUN_DICT = { なんです: "なんです" };
  const runResolver = async (forms) => forms.filter((x) => RUN_DICT[x]).map((x) => ({ form: x, dict: RUN_DICT[x] }));

  // kuromoji's real output for 新刊なんですが: な=助動詞, ん=名詞/非自立, です=助動詞, が=助詞
  const line = [tok("新刊", "noun"), tok("な", "auxiliary"), tok("ん", "noun"), tok("です", "auxiliary"), tok("が", "particle")];
  const joined = await mergeFunctionRuns(line, runResolver);
  eq("な | ん | です joins into なんです", surfaces(joined.tokens), ["新刊", "なんです", "が"]);
  ok("reports a change", joined.changed === true);
  eq("headword is the entry", joined.tokens[1].dict, "なんです");
  eq("reading stays the surface", joined.tokens[1].reading, "なんです");
  ok("the content word is not absorbed", joined.tokens[0].surface === "新刊");

  // The guard that matters: a general longest-match pass would eat these into one blob.
  const across = [tok("諸悪", "noun"), tok("の", "particle"), tok("根源", "noun")];
  eq("never joins across content words", surfaces((await mergeFunctionRuns(across, runResolver)).tokens), ["諸悪", "の", "根源"]);

  const cold2 = await load("src/lib/splitTokens.ts", "splitTokens.cold2.mjs");
  const dead = await cold2.mergeFunctionRuns(line, deadResolver);
  eq("no dictionary → nothing joined", surfaces(dead.tokens), ["新刊", "な", "ん", "です", "が"]);
}

console.log(failures === 0 ? "\nSPLIT TOKENS: ALL TESTS PASS ✅" : `\n${failures} TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
