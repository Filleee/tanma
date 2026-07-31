// Unit tests for buildCandidates (lib/compound) — multi-word expression candidates
// built from kuromoji tokens at look-up time. Run: node scripts/test-compound.mjs
import * as esbuild from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { code } = await esbuild.transform(await readFile(resolve(root, "src/lib/compound.ts"), "utf8"), { loader: "ts", format: "esm" });
const dir = await mkdtemp(join(tmpdir(), "tnm-compound-"));
const mod = join(dir, "compound.mjs");
await writeFile(mod, code);
const { buildCandidates } = await import(pathToFileURL(mod).href);

const tok = (surface, dict = surface, isWord = true, pos = "") => ({ surface, dict, reading: "", pos, isWord });

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
};

// 歳|食っちゃい(→食う): surface+lemma gives the dictionary headword 歳食う.
const line1 = [tok("歳"), tok("食っちゃい", "食う"), tok("ない", "ない")];
check("歳+食っちゃい → [歳食っちゃいない?, …] includes 歳食う first-ish",
  buildCandidates(line1, 0).includes("歳食う"), true);
check("longest candidates first",
  buildCandidates(line1, 0)[0].length >= buildCandidates(line1, 0).slice(-1)[0].length, true);

// 気|に|なる: a grammatical particle (に) STOPS the span, so no 気になる candidate — the
// look-up stays consistent with the on-screen tokens, which never merge across particles.
const line2 = [tok("気"), tok("に", "に", true, "particle"), tok("なる")];
check("particle stops the span (no 気になる)", buildCandidates(line2, 0).includes("気になる"), false);
check("particle → span yields nothing past 気", buildCandidates(line2, 0), []);

// 諸悪|の|根源: の (particle) stops the span — stays three separate words, like the tokens.
const line2b = [tok("諸悪"), tok("の", "の", true, "particle"), tok("根源")];
check("諸悪の根源 not merged in look-up (の stops span)", buildCandidates(line2b, 0), []);

// Contiguous content words still chain: 歳|食う (noun+verb, no particle between) → 歳食う.
const line2c = [tok("歳"), tok("食う")];
check("content words still chain (歳食う)", buildCandidates(line2c, 0).includes("歳食う"), true);

// Punctuation stops the span.
const line3 = [tok("歳"), tok("。", "。", false), tok("食う")];
check("punctuation stops candidates", buildCandidates(line3, 0), []);

// Clicking the last token → nothing to extend.
check("last token → no candidates", buildCandidates(line1, 2), []);

// The base word itself is never a candidate.
check("base word excluded", buildCandidates(line1, 0).includes("歳"), false);

// Non-word base (symbol) → nothing.
check("symbol base → no candidates", buildCandidates(line3, 1), []);

console.log(failures === 0 ? "\nCOMPOUND CANDIDATES: ALL PASSING ✅" : `\n${failures} FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
