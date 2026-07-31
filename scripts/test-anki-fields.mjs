// Unit tests for the lapis-simplified field mapping. Run: node scripts/test-anki-fields.mjs
import * as esbuild from "esbuild";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { code } = await esbuild.transform(await readFile(resolve(root, "src/lib/anki/fields.ts"), "utf8"), { loader: "ts", format: "esm" });
const dir = await mkdtemp(join(tmpdir(), "tnm-anki-"));
const file = join(dir, "fields.mjs");
await writeFile(file, code);
const { boldSentence, buildLapisFields } = await import(pathToFileURL(file).href);

let failures = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}`);
  if (!ok) { console.log("     got :", JSON.stringify(got)); console.log("     want:", JSON.stringify(want)); failures++; }
};

console.log("boldSentence");
eq("bolds the surface in the line", boldSentence("日本語を勉強しています。", "勉強"), "日本語を<b>勉強</b>しています。");
eq("collapses whitespace/newlines", boldSentence("  これは \n  本です  ", "本"), "これは <b>本</b>です");
eq("no surface match → plain", boldSentence("今日はいい天気", "魚"), "今日はいい天気");
eq("empty surface → plain sentence", boldSentence("そのまま", ""), "そのまま");

console.log("\nbuildLapisFields");
{
  const f = buildLapisFields({
    word: "勉強", reading: "べんきょう", surface: "勉強", sentence: "日本語を勉強しています。",
    definition: "study", glossary: "study; diligence", frequency: "JPDB: 1500", freqSort: "1500",
    pitchPosition: "0", pitchCategories: "heiban", misc: "Title · 2:51 · https://youtu.be/x",
    wordAudioFilename: "tnm_w_benkyou.mp3", sentenceAudioFilename: "tnm_s_123.webm",
    pictureHtml: '<img src="tnm_i_123.jpg">',
  });
  eq("Expression", f.Expression, "勉強");
  eq("ExpressionReading", f.ExpressionReading, "べんきょう");
  eq("ExpressionAudio = [sound:]", f.ExpressionAudio, "[sound:tnm_w_benkyou.mp3]");
  eq("Sentence bolded", f.Sentence, "日本語を<b>勉強</b>しています。");
  eq("SentenceAudio = [sound:]", f.SentenceAudio, "[sound:tnm_s_123.webm]");
  eq("Picture = img html", f.Picture, '<img src="tnm_i_123.jpg">');
  eq("MainDefinition", f.MainDefinition, "study");
  eq("Frequency / FreqSort", [f.Frequency, f.FreqSort], ["JPDB: 1500", "1500"]);
}
{
  // no media → audio/picture fields are empty (not "[sound:undefined]")
  const f = buildLapisFields({
    word: "猫", reading: "ねこ", surface: "猫", sentence: "猫がいる", definition: "cat",
    glossary: "cat", frequency: "", freqSort: "", pitchPosition: "", pitchCategories: "", misc: "",
  });
  eq("no word audio → empty", f.ExpressionAudio, "");
  eq("no sentence audio → empty", f.SentenceAudio, "");
  eq("no picture → empty", f.Picture, "");
}

console.log(failures === 0 ? "\nANKI FIELDS: ALL TESTS PASS ✅" : `\n${failures} TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
