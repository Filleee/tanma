// Quick sanity check of the riskiest core logic: kuromoji tokenization +
// reading->furigana, and SRT parsing. Run: node scripts/test-core.mjs
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const kuromoji = require("kuromoji");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dicPath = resolve(root, "node_modules", "kuromoji", "dict");

function katakanaToHiragana(s) {
  return s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}
function hasKanji(s) {
  return /[一-龯]/.test(s);
}

// minimal SRT parse (mirrors src/lib/parsers/srt.ts)
function parseSrt(text) {
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split("\n");
    let i = /^\d+$/.test((lines[0] || "").trim()) ? 1 : 0;
    const tm = (lines[i] || "").match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/);
    if (!tm) continue;
    cues.push({ time: tm[1], text: lines.slice(i + 1).join(" ") });
  }
  return cues;
}

const srt = `1
00:00:01,000 --> 00:00:03,500
日本語を勉強しています。

2
00:00:04,000 --> 00:00:06,000
これはテストです`;

console.log("SRT cues:", parseSrt(srt));

console.log("\nBuilding kuromoji from", dicPath, "...");
kuromoji.builder({ dicPath }).build((err, tokenizer) => {
  if (err) {
    console.error("KUROMOJI FAILED:", err);
    process.exit(1);
  }
  const tokens = tokenizer.tokenize("日本語を勉強しています");
  console.log("\nTokens (surface / reading->hira / base / pos):");
  for (const t of tokens) {
    const reading = t.reading && t.reading !== "*" ? katakanaToHiragana(t.reading) : "";
    const furi = hasKanji(t.surface_form) && reading ? `  furigana=${reading}` : "";
    console.log(`  ${t.surface_form}  | ${reading} | ${t.basic_form} | ${t.pos}${furi}`);
  }
  console.log("\nOK: kuromoji works and produces readings.");
});
