// Unit tests for alignSecondaryToTarget — the translation/target pairing used by
// the subtitle browser. Compiles src/lib/parsers/align.ts with esbuild.
// Run: node scripts/test-align.mjs
import * as esbuild from "esbuild";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = resolve(root, "src/lib/parsers/align.ts");
const { code } = await esbuild.transform(await readFile(src, "utf8"), { loader: "ts", format: "esm" });
const dir = await mkdtemp(join(tmpdir(), "tnm-align-"));
const file = join(dir, "align.mjs");
await writeFile(file, code);
const { alignSecondaryToTarget } = await import(pathToFileURL(file).href);

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
let nid = 0;
const cue = (start, end, text) => ({ id: nid++, start, end, text });
const asObj = (map) => Object.fromEntries([...map.entries()].sort((a, b) => a[0] - b[0]));

console.log("alignSecondaryToTarget");

// The real bug: one sentence-level translation spanning 3 fragment-level target
// cues must show ONCE (on its best-overlap line), not repeat on all three.
{
  nid = 0;
  const target = [cue(0, 2, "ました。はい。"), cue(2, 4, "つけちゃったね。"), cue(4, 6, "はい。やばい")];
  const secondary = [cue(1, 5, "Yeah. I was fully equipped.")];
  eq("sentence-level translation shows once, on best overlap", asObj(alignSecondaryToTarget(target, secondary)), {
    1: "Yeah. I was fully equipped.",
  });
}

// Finer translation than target: pieces concatenate onto the one target line.
{
  nid = 0;
  const target = [cue(0, 10, "長い文")];
  const secondary = [cue(0, 3, "A"), cue(3, 6, "B"), cue(6, 9, "C")];
  eq("finer translation concatenates onto target", asObj(alignSecondaryToTarget(target, secondary)), { 0: "A B C" });
}

// 1:1 timing: each target keeps its own translation.
{
  nid = 0;
  const target = [cue(0, 2, "あ"), cue(2, 4, "い")];
  const secondary = [cue(0, 2, "X"), cue(2, 4, "Y")];
  eq("1:1 aligned translations map straight across", asObj(alignSecondaryToTarget(target, secondary)), { 0: "X", 1: "Y" });
}

// Repeated identical pieces within one line are not doubled.
{
  nid = 0;
  const target = [cue(0, 10, "文")];
  const secondary = [cue(0, 3, "A"), cue(3, 6, "A"), cue(6, 9, "B")];
  eq("consecutive identical pieces de-duplicated", asObj(alignSecondaryToTarget(target, secondary)), { 0: "A B" });
}

// A target line with no overlapping translation simply has none.
{
  nid = 0;
  const target = [cue(0, 2, "あ"), cue(10, 12, "い")];
  const secondary = [cue(0, 2, "X")];
  eq("uncovered target line gets no translation", asObj(alignSecondaryToTarget(target, secondary)), { 0: "X" });
}

eq("empty inputs → empty map", asObj(alignSecondaryToTarget([], [])), {});

console.log(failures === 0 ? "\nSECONDARY ALIGNMENT: ALL TESTS PASS ✅" : `\n${failures} TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
