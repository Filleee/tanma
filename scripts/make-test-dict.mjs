// Builds a tiny Yomitan-format dictionary zip for testing the importer.
import { zipSync, strToU8 } from "fflate";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const j = (o) => strToU8(JSON.stringify(o));

const index = { title: "Test JA Dict", revision: "test-1", format: 3, sourceLanguage: "ja", targetLanguage: "en" };

const term_bank_1 = [
  ["日本語", "にほんご", "n", "", 100, [
    "the Japanese language",
    {
      type: "structured-content",
      content: { tag: "div", content: [
        { tag: "span", content: "example: " },
        { tag: "span", style: { fontStyle: "italic" }, content: "日本語を話す" },
        { tag: "img", path: "img/test.png", width: 2, height: 2, title: "test image" },
      ] },
    },
  ], 1, ""],
  ["勉強", "べんきょう", "n vs", "", 90, ["study", "diligence"], 2, ""],
  ["する", "する", "vs-i", "", 80, ["to do", "to make"], 3, ""],
];

const term_meta_bank_1 = [
  ["日本語", "freq", 834],
  ["日本語", "pitch", { reading: "にほんご", pitches: [{ position: 0 }] }],
  ["勉強", "pitch", { reading: "べんきょう", pitches: [{ position: 0 }] }],
  ["勉強", "freq", { value: 1200, displayValue: "1,200" }],
  ["する", "freq", { reading: "する", frequency: 5 }],
];

const kanji_bank_1 = [
  ["日", "ニチ ジツ", "ひ び -か", "grade1 jouyou", ["day", "sun", "Japan"], { strokes: "4", grade: "1" }],
  ["本", "ホン", "もと", "grade1 jouyou", ["book", "origin", "main"], { strokes: "5" }],
  ["語", "ゴ", "かた-る", "grade2 jouyou", ["language", "word", "speech"], { strokes: "14" }],
];

const tag_bank_1 = [
  ["n", "partOfSpeech", 0, "noun", 0],
  ["vs", "partOfSpeech", 0, "suru verb", 0],
  ["vs-i", "partOfSpeech", 0, "suru verb - irregular", 0],
];

// 1x1 red PNG for the structured-content image test.
const TEST_PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
), (c) => c.charCodeAt(0));

const zip = zipSync({
  "img/test.png": TEST_PNG,
  "index.json": j(index),
  "term_bank_1.json": j(term_bank_1),
  "term_meta_bank_1.json": j(term_meta_bank_1),
  "kanji_bank_1.json": j(kanji_bank_1),
  "tag_bank_1.json": j(tag_bank_1),
});

const out = resolve(root, "test", "test-dict.zip");
writeFileSync(out, zip);
console.log("wrote", out, zip.length, "bytes");
