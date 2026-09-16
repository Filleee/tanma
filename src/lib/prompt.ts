// The mined-line translation prompt and its output cleaning. Pure + DOM/chrome-free so the
// background worker, the options page (which shows the canned prompt for editing) and the Node
// unit tests can all share one copy.

/** Placeholders a prompt template may use. */
export interface PromptVars {
  sentence: string;
  context: string;
  word: string;
  title: string;
  target_lang: string;
  native_lang: string;
}

/**
 * Built-in prompt. `{sentence}` arrives WITH its <b> tags around the mined surface, so the model
 * carries the highlight across to the matching words instead of us guessing at them afterwards.
 */
export const CANNED_PROMPT = [
  "Translate one line of {target_lang} dialogue into {native_lang} for a language-learning flashcard.",
  "",
  "Source: {title}",
  "",
  "Dialogue (context only — the line to translate is marked with →):",
  "{context}",
  "",
  "Line to translate:",
  "{sentence}",
  "",
  "Translation guidelines:",
  "- Translate ONLY the marked line. Use the surrounding dialogue to resolve dropped subjects,",
  "  pronouns, and referents — never translate or summarise the context itself.",
  "- Write natural, idiomatic {native_lang}, not a word-for-word gloss.",
  "- Preserve the speaker's register and tone (casual, polite, blunt, childish, archaic). Do not",
  "  sanitise: if the original is crude or blunt, match it — without exaggerating it.",
  "- Before translating any proper noun, decide whether it is a NAME (person, place, group, work,",
  "  handle). Names are transliterated, never translated into their literal meaning — 龍巻ちせ is",
  "  \"Tatsumaki Chise\", not \"Tornado Chise\". Keep honorifics romanised and attached (-san, -chan,",
  "  -kun, -sama, -senpai), since they carry register. Use the surrounding dialogue to settle",
  "  ambiguous cases, and if you cannot determine a name's reading, leave it in its original script",
  "  rather than guessing at one.",
  "- Add nothing that is not in the line, and drop nothing that is.",
  "- The learner is studying \"{word}\" — make sure its sense in this line comes through clearly.",
  "",
  "Output requirements:",
  "- Provide only the single best translation — one line.",
  "- Carry over any HTML tags in the line to the words that correspond to them in your translation.",
  "  Match the equivalent WORD, not the equivalent position — word order differs between languages.",
  "  Keep them as HTML tags; DO NOT convert them to Markdown.",
  "- If the line contains no HTML tags, do not add any to the translation whatsoever.",
  "- No quotes, no romaji, no notes, no alternatives, no explanations, no labels, no surrounding text.",
  "  Absolutely nothing but the translated line.",
].join("\n");

/** Substitute {placeholders}. Unknown ones are left as-is so a typo shows up instead of going blank. */
export function renderPrompt(template: string, vars: PromptVars): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String((vars as unknown as Record<string, string>)[k] ?? "") : m,
  );
}

/**
 * Models ignore "no Markdown / no notes" often enough that the field needs guarding: drop code
 * fences and wrapping quotes, convert Markdown bold to <b>, strip every tag except <b>, and remove
 * a bold that spans the whole line (highlighting everything highlights nothing).
 */
export function sanitizeTranslation(raw: string): string {
  const FENCE = "```";
  let t = (raw ?? "").trim();
  if (t.startsWith(FENCE)) {
    t = t.slice(FENCE.length).replace(/^[a-z]*\s*/i, "");
    const end = t.lastIndexOf(FENCE);
    if (end >= 0) t = t.slice(0, end);
    t = t.trim();
  }
  if (t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("「") && t.endsWith("」")))) {
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__([^_]+)__/g, "<b>$1</b>");
  t = t.replace(/<(?!\/?b\s*>)[^>]*>/gi, ""); // keep <b>/</b>, drop every other tag
  t = t.replace(/\s+/g, " ").trim();
  const whole = /^<b>([\s\S]*)<\/b>$/i.exec(t);
  if (whole && !/<b>/i.test(whole[1])) t = whole[1].trim();
  return t;
}
