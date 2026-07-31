// Dictionary-assisted token merging. kuromoji's IPADIC lexicon lacks many compounds
// (魔族, 王都), so it segments them (魔|族) and they render as two underlined units.
// After tokenizing, adjacent noun-ish tokens whose CONCATENATION has a dictionary entry
// are merged into one token — segmentation then follows the user's own dictionary,
// like Yomitan. Results are cached, so after warm-up merging is synchronous.
//
// Deliberately only joins ADJACENT content words (魔+族), never across a grammatical
// particle: 諸悪|の|根源 stays three tokens, matching how the look-up treats it, so the
// on-screen segmentation and the popup headword never disagree.

import type { Token } from "../common/types";
import { katakanaToHiragana } from "./kana";

/** Batch existence check: which of these expressions have a dictionary entry? */
export type HasTermsFn = (terms: string[]) => Promise<{ expression: string; reading: string }[]>;

const cache = new Map<string, string | false>(); // expression → dictionary reading, or false (session-lived)

const MERGEABLE = new Set(["noun", "prefix", "suffix"]);
const canPair = (a: Token, b: Token): boolean =>
  a.isWord && b.isWord && MERGEABLE.has(a.pos) && MERGEABLE.has(b.pos) &&
  (a.surface + b.surface).length <= 6 && /[一-龯㐀-䶿々]/.test(a.surface + b.surface);

/** The pair-concatenations in `tokens` whose dictionary status is still unknown. */
export function unknownPairs(tokens: Token[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (!canPair(tokens[i], tokens[i + 1])) continue;
    const expr = tokens[i].surface + tokens[i + 1].surface;
    if (!cache.has(expr) && !out.includes(expr)) out.push(expr);
  }
  return out;
}

export function recordExists(queried: string[], found: { expression: string; reading: string }[]): void {
  const byExpr = new Map(found.map((f) => [f.expression, f.reading]));
  for (const q of queried) cache.set(q, byExpr.has(q) ? (byExpr.get(q) ?? "") : false);
}

/** Merge adjacent pairs known (from cache) to be dictionary entries. Left-to-right,
 *  a token participates in at most one merge. Pure/synchronous — callers resolve the
 *  cache first via unknownPairs + recordExists. */
export function mergeKnownCompounds(tokens: Token[]): { tokens: Token[]; changed: boolean } {
  const out: Token[] = [];
  let changed = false;
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    const dictReading = b && canPair(a, b) ? cache.get(a.surface + b.surface) : false;
    if (b && dictReading !== false && dictReading !== undefined) {
      out.push({
        surface: a.surface + b.surface,
        dict: a.surface + b.surface,
        // The DICTIONARY's reading (王都→おうと), not kuromoji's per-token concat
        // (おう+みやこ) — the entry knows how the compound is actually read.
        reading: katakanaToHiragana(dictReading || "") || (a.reading || "") + (b.reading || ""),
        pos: "noun",
        isWord: true,
      });
      changed = true;
      i++; // consumed b
    } else {
      out.push(a);
    }
  }
  return { tokens: out, changed };
}

/** Full async pipeline: resolve unknown pairs through `hasTerms`, then merge. */
export async function mergeCompoundTokens(tokens: Token[], hasTerms: HasTermsFn): Promise<{ tokens: Token[]; changed: boolean }> {
  const unknown = unknownPairs(tokens);
  if (unknown.length) {
    try {
      recordExists(unknown, await hasTerms(unknown));
    } catch {
      recordExists(unknown, []); // lookup unavailable — treat as absent this session
    }
  }
  return mergeKnownCompounds(tokens);
}
