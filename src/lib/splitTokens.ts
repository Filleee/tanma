// Dictionary-validated re-splitting of over-merged Japanese tokens.
//
// tokenizer/jaMerge.ts merges a verb/adjective with its inflection tail, but it is deliberately
// dictionary-blind and greedy: `isInflectionTail` continues on ANY 助動詞, and IPADIC tags the
// clause-level modal だろう (copula だ + volitional う) as 助動詞 just like the genuine inflections
// た/ない/ます/たい. So ねだらないだろう collapses into one token instead of ねだらない + だろう.
// Part of speech alone cannot separate the two cases — only the dictionary can.
//
// This pass does what Yomitan does: from each position take the LONGEST run of morphemes that
// still resolves to a real dictionary entry (the surface itself, or one of its deinflections).
// ねだらないだろう resolves to nothing, ねだらない resolves to ねだる, and だろう is an entry in its
// own right, so the token splits exactly where Yomitan would. Conversely 食べさせられた (→食べる),
// 勉強したくない (→勉強する) and 行こう (→行く) all resolve whole and are left alone — which is why
// this beats a hand-written stop-list: the volitional う merges in 行こう but not in だろう, and
// the dictionary decides that for us.
//
// Mirrors mergeTokens.ts: a pure, synchronous core over a session cache, plus an async wrapper
// that fills the cache. Deinflection itself happens in the background worker (the rule table
// never ships in the content bundle) — see the "resolveForms" message.

import type { Token } from "../common/types";

/** Resolve surfaces to dictionary headwords; unresolved surfaces are simply absent. */
export type ResolveFormsFn = (forms: string[]) => Promise<{ form: string; dict: string }[]>;

const cache = new Map<string, string | false>(); // surface → dictionary headword, or false

/** Merged tokens longer than this are left alone — deep chains are rare and the span scan is O(n²). */
const MAX_PARTS = 8;

/** Every contiguous run of morphemes in a merged token: the surfaces we may need to test. */
function spansOf(parts: Token[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let s = "";
    for (let j = i; j < parts.length; j++) {
      s += parts[j].surface;
      out.push(s);
    }
  }
  return out;
}

function splittable(t: Token): Token[] | null {
  const p = t.parts;
  return p && p.length >= 2 && p.length <= MAX_PARTS ? p : null;
}

/** The morpheme runs in `tokens` whose dictionary status is still unknown. */
export function unknownForms(tokens: Token[]): string[] {
  const out = new Set<string>();
  for (const t of tokens) {
    const p = splittable(t);
    if (!p) continue;
    for (const s of spansOf(p)) if (!cache.has(s)) out.add(s);
  }
  return [...out];
}

export function recordForms(queried: string[], resolved: { form: string; dict: string }[]): void {
  const byForm = new Map(resolved.map((r) => [r.form, r.dict]));
  for (const q of queried) cache.set(q, byForm.get(q) ?? false);
}

function joinParts(parts: Token[], dict: string): Token {
  return {
    surface: parts.map((p) => p.surface).join(""),
    // Concatenated SURFACE reading, never the dictionary reading: the entry's reading belongs to
    // the lemma (ねだる) and would be wrong furigana over an inflected form (ねだらない).
    reading: parts.map((p) => p.reading).join(""),
    dict,
    pos: parts[0].pos,
    isWord: parts.some((p) => p.isWord),
    ...(parts.length > 1 ? { parts } : {}),
  };
}

/**
 * Re-split over-merged tokens using the cache. Pure/synchronous — callers warm the cache first
 * via `unknownForms` + `recordForms` (or just use `splitOvermergedTokens`).
 */
export function splitKnownTokens(tokens: Token[]): { tokens: Token[]; changed: boolean } {
  const out: Token[] = [];
  let changed = false;
  for (const t of tokens) {
    const p = splittable(t);
    // The whole token resolves → the merge was right (食べさせられた, 行こう). Leave it alone.
    if (!p || cache.get(t.surface)) {
      out.push(t);
      continue;
    }
    const pieces: Token[] = [];
    let i = 0;
    let resolvedAny = false;
    while (i < p.length) {
      let take = 0;
      let dict = "";
      for (let j = p.length; j > i; j--) {
        const hit = cache.get(p.slice(i, j).map((x) => x.surface).join(""));
        if (hit) {
          take = j - i;
          dict = hit;
          break;
        }
      }
      if (!take) {
        // Nothing from here resolves — keep the rest whole rather than shattering it into bare
        // morphemes, which would be worse than the over-merge we set out to fix.
        pieces.push(joinParts(p.slice(i), t.dict));
        break;
      }
      pieces.push(joinParts(p.slice(i, i + take), dict));
      i += take;
      resolvedAny = true;
    }
    if (resolvedAny && pieces.length > 1) {
      out.push(...pieces);
      changed = true;
    } else {
      out.push(t); // nothing better than what we started with
    }
  }
  return { tokens: out, changed };
}

/** Full async pipeline: resolve unknown runs through `resolve`, then split. */
export async function splitOvermergedTokens(
  tokens: Token[],
  resolve: ResolveFormsFn,
): Promise<{ tokens: Token[]; changed: boolean }> {
  const unknown = unknownForms(tokens);
  if (unknown.length) {
    try {
      recordForms(unknown, await resolve(unknown));
    } catch {
      recordForms(unknown, []); // lookup unavailable — treat as unresolved this session
    }
  }
  return splitKnownTokens(tokens);
}

// ---------------------------------------------------------------------------------------------
// The other direction: joining grammatical runs the morphological pass leaves scattered.
//
// jaMerge only starts merging from an inflectable head, so after a plain noun nothing merges at
// all: 新刊なんですが comes out 新刊 | な | ん | です | が. And mergeTokens.ts can't help — it joins
// content words only, needs a kanji, and handles pairs rather than runs. But なんです is a real
// dictionary entry, so the dictionary can arbitrate here exactly as it does for splitting.
//
// Restricted to runs of FUNCTION words (particles, auxiliaries, and the short kana non-independent
// nouns kuromoji flattens to "noun", like ん in なんです). Never crossing into content words is what
// keeps 諸悪 | の | 根源 three tokens — a general longest-match pass would glue those together, and
// then you could no longer click 根源 on its own.
// ---------------------------------------------------------------------------------------------

const MAX_RUN = 5; // tokens
const MAX_RUN_CHARS = 8;
const KANA = /^[ぁ-んァ-ヶー]+$/;

function isGrammatical(t: Token): boolean {
  if (!t.isWord) return false;
  if (t.pos === "particle" || t.pos === "auxiliary") return true;
  // ん (なんです) and こと (ということ) are 名詞/非自立 in IPADIC, which flattens to "noun" —
  // the 非自立 detail doesn't survive into Token, so fall back to "short and all kana".
  return t.pos === "noun" && t.surface.length <= 2 && KANA.test(t.surface);
}

/** Every joinable span inside a run of grammatical tokens. */
function runSpans(tokens: Token[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isGrammatical(tokens[i])) continue;
    let s = tokens[i].surface;
    for (let j = i + 1; j < tokens.length && j < i + MAX_RUN; j++) {
      if (!isGrammatical(tokens[j])) break;
      s += tokens[j].surface;
      if (s.length > MAX_RUN_CHARS) break;
      out.push(s);
    }
  }
  return out;
}

/** The grammatical runs whose dictionary status is still unknown. */
export function unknownRunForms(tokens: Token[]): string[] {
  return [...new Set(runSpans(tokens).filter((x) => !cache.has(x)))];
}

/** Join grammatical runs that are real entries, longest first. Pure — cache warmed by the caller. */
export function mergeKnownRuns(tokens: Token[]): { tokens: Token[]; changed: boolean } {
  const out: Token[] = [];
  let changed = false;
  let i = 0;
  while (i < tokens.length) {
    let take = 0;
    let dict = "";
    if (isGrammatical(tokens[i])) {
      let s = tokens[i].surface;
      for (let j = i + 1; j < tokens.length && j < i + MAX_RUN; j++) {
        if (!isGrammatical(tokens[j])) break;
        s += tokens[j].surface;
        if (s.length > MAX_RUN_CHARS) break;
        const hit = cache.get(s);
        if (hit) {
          take = j - i + 1; // keep scanning: prefer the LONGEST run that resolves
          dict = hit;
        }
      }
    }
    if (take >= 2) {
      out.push(joinParts(tokens.slice(i, i + take), dict));
      i += take;
      changed = true;
    } else {
      out.push(tokens[i]);
      i++;
    }
  }
  return { tokens: out, changed };
}

/** Full async pipeline: resolve unknown runs, then join. */
export async function mergeFunctionRuns(
  tokens: Token[],
  resolve: ResolveFormsFn,
): Promise<{ tokens: Token[]; changed: boolean }> {
  const unknown = unknownRunForms(tokens);
  if (unknown.length) {
    try {
      recordForms(unknown, await resolve(unknown));
    } catch {
      recordForms(unknown, []);
    }
  }
  return mergeKnownRuns(tokens);
}
