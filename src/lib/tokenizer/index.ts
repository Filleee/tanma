import type { Token } from "../../common/types";
import { ensureJapanese, isJapaneseReady, tokenizeJapanese } from "./japanese";

export { ensureJapanese, isJapaneseReady } from "./japanese";

/** Languages that don't separate words with spaces and need a segmenter. */
const NO_SPACE_LANGS = new Set(["ja", "zh", "zh-cn", "zh-tw", "yue", "ko", "th", "lo", "km", "my"]);

let segmenters = new Map<string, Intl.Segmenter>();
function getSegmenter(lang: string): Intl.Segmenter | null {
  if (typeof Intl === "undefined" || typeof (Intl as any).Segmenter === "undefined") return null;
  let s = segmenters.get(lang);
  if (!s) {
    try {
      s = new Intl.Segmenter(lang, { granularity: "word" });
    } catch {
      s = new Intl.Segmenter(undefined, { granularity: "word" });
    }
    segmenters.set(lang, s);
  }
  return s;
}

/**
 * Prepare any heavy resources for a language. For Japanese this loads kuromoji.
 * Safe to call repeatedly; resolves once ready (or rejects if the dict fails).
 */
export async function initTokenizer(lang: string): Promise<void> {
  if (normalizeLang(lang) === "ja") {
    await ensureJapanese();
  }
}

export function normalizeLang(lang: string): string {
  const l = (lang || "").toLowerCase();
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("zh") || l === "yue") return "zh";
  if (l.startsWith("ko")) return "ko";
  return l.split("-")[0] || l;
}

/**
 * Tokenize text for a language. Synchronous and always returns *something*:
 * if the Japanese dictionary hasn't finished loading yet it falls back to the
 * segmenter so words are still clickable (without furigana), then callers can
 * re-render once `initTokenizer` resolves.
 */
export function tokenize(text: string, lang: string): Token[] {
  const l = normalizeLang(lang);
  if (l === "ja" && isJapaneseReady()) {
    return tokenizeJapanese(text);
  }
  if (NO_SPACE_LANGS.has(l)) {
    return segmentTokens(text, l);
  }
  return spacedTokens(text);
}

/** CJK/no-space languages: use Intl.Segmenter when available, else per-char. */
function segmentTokens(text: string, lang: string): Token[] {
  const seg = getSegmenter(lang);
  if (seg) {
    const out: Token[] = [];
    for (const part of seg.segment(text)) {
      const surface = part.segment;
      const wordLike = (part as any).isWordLike ?? /\p{L}/u.test(surface);
      out.push({ surface, reading: "", dict: surface, pos: "", isWord: !!wordLike && /\S/.test(surface) });
    }
    return out;
  }
  // No Intl.Segmenter: split into single characters (CJK is mostly 1 char = 1 unit).
  return Array.from(text).map((ch) => ({
    surface: ch,
    reading: "",
    dict: ch,
    pos: "",
    isWord: /\p{L}/u.test(ch),
  }));
}

/** Space-delimited languages: keep words and the separators between them. */
function spacedTokens(text: string): Token[] {
  const out: Token[] = [];
  // \p{L}\p{M} = letters + combining marks; ' and - keep contractions/hyphenates together.
  const re = /[\p{L}\p{M}][\p{L}\p{M}'’-]*|[^\p{L}\p{M}]+/gu;
  for (const m of text.matchAll(re)) {
    const surface = m[0];
    const isWord = /[\p{L}\p{M}]/u.test(surface);
    out.push({ surface, reading: "", dict: surface.toLowerCase(), pos: "", isWord });
  }
  return out;
}
