// Yomitan-style multi-word expression candidates. kuromoji segments 歳食っちゃい as
// 歳|食っちゃい (IPADIC has no entry for the idiom 歳食う), so a click on 歳 would only
// ever look up 歳. Instead of shipping a deinflection table like Yomitan, we lean on
// kuromoji's own lemmas: the clicked token's SURFACE + the following token's LEMMA
// (歳+食う) is exactly the dictionary headword of the compound. The background looks
// these up alongside the normal keys and prefers the longest one with a real entry.

import type { Token } from "../common/types";

const MAX_SPAN = 3; // clicked token + up to 2 more
const MAX_LEN = 12; // headwords longer than this are vanishingly rare

/** Compound headword candidates for a click on tokens[idx], longest first. */
export function buildCandidates(tokens: Token[], idx: number): string[] {
  const base = tokens[idx];
  if (!base?.isWord) return [];
  const out = new Set<string>();
  let surfaces = base.surface;
  for (let j = idx + 1; j < tokens.length && j < idx + MAX_SPAN; j++) {
    const t = tokens[j];
    // Stop at punctuation/whitespace — expressions don't cross 、。「 etc.
    if (!t.isWord || !t.surface.trim()) break;
    // Stop at grammatical particles/auxiliaries (の, に, が, だ…): the on-screen tokens
    // never merge across them (諸悪|の|根源 stays split), so the look-up must not either —
    // otherwise the popup headword (諸悪の根源) disagrees with the word you clicked. Only
    // contiguous content words chain (歳+食う), matching what's actually rendered.
    if (t.pos === "particle" || t.pos === "auxiliary") break;
    // surfaces-so-far + this token's LEMMA: the likely dictionary form
    // (歳+食う; 目+が+覚める on the next iteration).
    if (t.dict && t.dict !== t.surface) {
      const lemma = surfaces + t.dict;
      if (lemma.length <= MAX_LEN) out.add(lemma);
    }
    surfaces += t.surface;
    // The raw surface run too (covers expressions whose tail is already dictionary
    // form, e.g. 気+に+なる where なる is uninflected).
    if (surfaces.length <= MAX_LEN) out.add(surfaces);
    if (surfaces.length > MAX_LEN) break;
  }
  out.delete(base.surface);
  out.delete(base.dict);
  return [...out].sort((a, b) => b.length - a.length);
}
