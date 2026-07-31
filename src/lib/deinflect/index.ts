// Japanese deinflection, ported from Yomitan (GPL-3.0-or-later — see the vendored files'
// headers; TANMA is GPL-3.0-or-later too). The rule table (japanese-transforms.js,
// ~1800 lines: 〜ちゃう/〜ます/〜させられる/…) strips conjugation suffixes step by step,
// so an inflected surface finds its dictionary form WITHOUT a morphological tokenizer.
//
// This complements kuromoji, not replaces it: kuromoji segments and lemmatizes (and is
// right for standard conjugation); this table catches what it mis-lemmatizes (slurred
// contractions, stacked aux chains) and deinflects compound TAILS (歳食っちゃい→歳食う).
import { LanguageTransformer } from "./language-transformer.js";
import { japaneseTransforms } from "./japanese-transforms.js";

let transformer: { transform(text: string): { text: string }[] } | null = null;

function ensure(): { transform(text: string): { text: string }[] } {
  if (!transformer) {
    const t = new LanguageTransformer();
    t.addDescriptor(japaneseTransforms);
    transformer = t;
  }
  return transformer;
}

/** All dictionary-form candidates for an inflected string (excluding the input itself),
 *  shortest chains first. Capped — exotic inputs can explode combinatorially. */
export function deinflect(text: string, cap = 24): string[] {
  if (!text || text.length > 24) return [];
  const out: string[] = [];
  try {
    for (const r of ensure().transform(text)) {
      if (r.text && r.text !== text && !out.includes(r.text)) {
        out.push(r.text);
        if (out.length >= cap) break;
      }
    }
  } catch {
    /* malformed input — no deinflections */
  }
  return out;
}
