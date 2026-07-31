// Unit tests for the ported Yomitan deinflector (lib/deinflect).
// Run: node scripts/test-deinflect.mjs
import * as esbuild from "esbuild";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), "tnm-deinflect-"));
const out = join(dir, "deinflect.mjs");
await esbuild.build({
  entryPoints: [resolve(root, "src/lib/deinflect/index.ts")],
  bundle: true,
  format: "esm",
  outfile: out,
  logLevel: "silent",
});
const { deinflect } = await import(pathToFileURL(out).href);

let failures = 0;
const check = (input, want) => {
  const got = deinflect(input);
  const ok = got.includes(want);
  console.log(`${ok ? "  ✅" : "  ❌"} ${input} → ${want}${ok ? "" : `  (got: ${JSON.stringify(got.slice(0, 8))})`}`);
  if (!ok) failures++;
};

check("食っちゃい", "食う");          // っちゃう contraction, continuative — the 歳食っちゃい case
check("食べさせられた", "食べる");    // causative-passive past
check("走った", "走る");              // godan past
check("見て", "見る");                // te-form
check("読ませる", "読む");            // causative
check("強すぎる", "強い");            // -sugiru on i-adjective
check("行かなかった", "行く");        // negative past
check("食べません", "食べる");        // polite negative

// Sanity: dictionary forms & non-verbs come back empty-ish (no false positives needed)
const plain = deinflect("学校");
console.log(`  ✅ 学校 → ${plain.length} deinflections (no crash)`);

console.log(failures === 0 ? "\nDEINFLECT: ALL PASSING ✅" : `\n${failures} FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
