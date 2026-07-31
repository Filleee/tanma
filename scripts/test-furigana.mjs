// Unit test for okurigana-aware furigana splitting (lib/kana furiganaParts).
// Run: node scripts/test-furigana.mjs
import * as esbuild from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { code } = await esbuild.transform(await readFile(resolve(root, "src/lib/kana.ts"), "utf8"), { loader: "ts", format: "esm" });
const f = join(await mkdtemp(join(tmpdir(), "tnm-furi-")), "kana.mjs");
await writeFile(f, code);
const { furiganaParts } = await import(pathToFileURL(f).href);

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}`);
  if (!ok) { console.log("     got :", JSON.stringify(got)); console.log("     want:", JSON.stringify(want)); fail++; }
};

eq("思う → 思[おも]+う (okurigana)", furiganaParts("思う", "おもう"), [{ text: "思", rt: "おも" }, { text: "う" }]);
eq("食べる → 食[た]+べる", furiganaParts("食べる", "たべる"), [{ text: "食", rt: "た" }, { text: "べる" }]);
eq("思います → 思[おも]+います (conjugated selection)", furiganaParts("思います", "おもいます"), [{ text: "思", rt: "おも" }, { text: "います" }]);
eq("持ち主 → 持[も]ち主[ぬし] (interior kana)", furiganaParts("持ち主", "もちぬし"), [{ text: "持", rt: "も" }, { text: "ち" }, { text: "主", rt: "ぬし" }]);
eq("お茶 → お+茶[ちゃ] (leading kana)", furiganaParts("お茶", "おちゃ"), [{ text: "お" }, { text: "茶", rt: "ちゃ" }]);
eq("修学旅行 → one ruby (all kanji)", furiganaParts("修学旅行", "しゅうがくりょこう"), [{ text: "修学旅行", rt: "しゅうがくりょこう" }]);
eq("港 + katakana reading コウ → hira ruby", furiganaParts("港", "コウ"), [{ text: "港", rt: "こう" }]);
eq("みなと (no kanji) → plain", furiganaParts("みなと", "みなと"), [{ text: "みなと" }]);
eq("empty reading → plain", furiganaParts("思う", ""), [{ text: "思う" }]);

console.log(fail ? `\n❌ ${fail} failure(s)` : "\nALL CHECKS PASSED ✅");
process.exit(fail ? 1 : 0);
