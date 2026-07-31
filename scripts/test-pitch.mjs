// Unit tests for lib/pitch (moras, patterns, categories, card fields).
import * as esbuild from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { code } = await esbuild.transform(await readFile(resolve(root, "src/lib/pitch.ts"), "utf8"), { loader: "ts", format: "esm" });
const dir = await mkdtemp(join(tmpdir(), "tnm-pitch-"));
const mod = join(dir, "pitch.mjs");
await writeFile(mod, code);
const { moraSplit, pitchPattern, pitchCategory, pitchFields } = await import(pathToFileURL(mod).href);

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
};

check("moras: きょう", moraSplit("きょう"), ["きょ", "う"]);
check("moras: にほんご", moraSplit("にほんご"), ["に", "ほ", "ん", "ご"]);
check("moras: コーヒー", moraSplit("コーヒー"), ["コ", "ー", "ヒ", "ー"]);
check("pattern [0] 4 moras (heiban LHHH)", pitchPattern(0, 4), [false, true, true, true]);
check("pattern [1] 3 moras (atamadaka HLL)", pitchPattern(1, 3), [true, false, false]);
check("pattern [2] 4 moras (LHLL)", pitchPattern(2, 4), [false, true, false, false]);
check("category 0", pitchCategory(0, 4), "heiban");
check("category 1", pitchCategory(1, 3), "atamadaka");
check("category odaka", pitchCategory(3, 3), "odaka");
check("category nakadaka", pitchCategory(2, 4), "nakadaka");
check("fields にほんご [0]", pitchFields([0], "にほんご"), { position: "[0]", categories: "heiban" });
check("fields multi", pitchFields([0, 2], "はし"), { position: "[0][2]", categories: "heiban,odaka" });

console.log(failures === 0 ? "\nPITCH: ALL PASSING ✅" : `\n${failures} FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
