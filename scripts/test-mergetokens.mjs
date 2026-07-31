// Unit tests for dictionary-assisted token merging (lib/mergeTokens). Simulates the
// dictionary via a fake hasTerms and checks that adjacent content-word pairs whose surface
// is an entry merge (王都), while particle-glued phrases (諸悪の根源) stay SEPARATE — the
// merger never crosses a particle, keeping the tokens consistent with the look-up.
// Run: node scripts/test-mergetokens.mjs
import * as esbuild from "esbuild";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(await mkdtemp(join(tmpdir(), "tnm-mergetok-")), "mergeTokens.mjs");
await esbuild.build({
  entryPoints: [resolve(root, "src/lib/mergeTokens.ts")],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
});
const { mergeCompoundTokens } = await import(pathToFileURL(out).href);

const tok = (surface, opts = {}) => ({ surface, dict: opts.dict ?? surface, reading: opts.reading ?? "", pos: opts.pos ?? "noun", isWord: opts.isWord ?? true });

// The "dictionary": expression → reading. hasTerms returns only queried terms that exist.
const DICT = new Map([["王都", "おうと"], ["魔族", "まぞく"], ["諸悪の根源", "しょあくのこんげん"]]);
const hasTerms = async (terms) => terms.filter((t) => DICT.has(t)).map((t) => ({ expression: t, reading: DICT.get(t) }));

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
};
const surfaces = (r) => r.tokens.map((t) => t.surface);

// Adjacent content-word pair the dictionary knows → merge (王都), with its dictionary reading.
{
  const r = await mergeCompoundTokens([tok("王"), tok("都"), tok("の", { pos: "particle" }), tok("連中"), tok("め", { pos: "suffix" })], hasTerms);
  check("王|都 → 王都 (rest untouched)", surfaces(r), ["王都", "の", "連中", "め"]);
  check("merged 王都 carries dictionary reading", r.tokens[0].reading, "おうと");
  check("merged 王都 dict = surface (whole word mined)", r.tokens[0].dict, "王都");
}

// Particle-glued phrase must NOT merge, even though the whole surface is an entry — the
// merger only joins ADJACENT content words, so 諸悪|の|根源 stays three tokens (matches look-up).
{
  const r = await mergeCompoundTokens([tok("諸悪"), tok("の", { pos: "particle" }), tok("根源")], hasTerms);
  check("諸悪|の|根源 stays split (no particle crossing)", surfaces(r), ["諸悪", "の", "根源"]);
}

// A pair the dictionary does NOT have stays split.
{
  const r = await mergeCompoundTokens([tok("王"), tok("様", { pos: "suffix" })], hasTerms);
  check("unknown pair not merged", surfaces(r), ["王", "様"]);
}

console.log(failures === 0 ? "\nTOKEN MERGE: ALL PASSING ✅" : `\n${failures} FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
