import type { Cue } from "../../common/types";

// ---------------------------------------------------------------------------
// YouTube caption cleaning + de-duplication.
//
// We intercept YouTube's OWN timedtext response (see src/inject/youtube.ts).
// The player asks for json3; manual tracks are clean line-level cues, but
// auto-generated (ASR) tracks are noisy: a rolling two-line display re-emits
// the same line several times, sound effects leak in as "[音楽]"/"♪", and HTML
// entities ("&#39;") survive, so we clean
// them up here so the overlay matches a clean, manual-track display.
//
// The core (json3 parse + clean + merge) is intentionally DOM-free so it can be
// unit-tested in plain Node (scripts/test-youtube.mjs). Only the srv3/legacy-XML
// parsers touch DOMParser, and they route their extracted text through the same
// cleaner.
// ---------------------------------------------------------------------------

/** Trailing punctuation that marks a "complete" line (so we shouldn't glue more onto it). */
const SENTENCE_DELIMITERS = [".", "?", "!", ":", "--", "。", "？", "！", "："];
/** A line fully wrapped in one of these pairs is a self-contained unit (e.g. "[音楽]", "(laughs)"). */
const BRACKET_PAIRS = ["()", "[]", "（）", "【】"];
/** Lines that are nothing but musical/▁wave glyphs are sound cues, not speech. */
const MUSIC_ONLY = /^[\s♪♫♬♩〜～]+$/;
/** ASR rolling-window repeats land within a few seconds — collapse identical lines this close. */
const MERGE_ALIKE_MAX_GAP = 5; // seconds
const MERGE_ALIKE_MAX_AHEAD = 5; // cues
/** Languages with no letter case — never run sentence-case normalization on these. */
const LANG_WITHOUT_CASE = new Set(["zh", "yue", "ja", "ko", "th", "lo", "km", "my", "bo", "am", "ka", "he", "ar", "syc"]);
/** If more than this fraction of lines are ALL CAPS, the track is shouting — fix it. */
const ALL_CAPS_THRESHOLD = 0.7;
/** CJK ranges — used to decide whether joined fragments need a separating space. */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Decode HTML entities without touching the DOM (named + numeric, dec & hex). */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m) => {
    if (NAMED_ENTITIES[m] !== undefined) return NAMED_ENTITIES[m];
    const hex = /^&#x([0-9a-fA-F]+);$/.exec(m);
    if (hex) return safeCodePoint(parseInt(hex[1], 16));
    const dec = /^&#([0-9]+);$/.exec(m);
    if (dec) return safeCodePoint(parseInt(dec[1], 10));
    return m;
  });
}
function safeCodePoint(n: number): string {
  try {
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

/**
 * Normalize one cue's text: strip leftover markup, decode entities, drop
 * direction/zero-width control marks, and collapse whitespace to a single line.
 */
function cleanText(raw: string): string {
  let s = raw;
  s = s.replace(/<[^>]+>/g, ""); // strip any HTML/markup tags
  s = decodeEntities(s);
  // Bidi embeddings/overrides, LRM/RLM, BOM, zero-width — never part of the words.
  s = s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** True if the line is a complete unit we shouldn't append more text to. */
function endsWithDelimiter(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (SENTENCE_DELIMITERS.some((d) => t.endsWith(d))) return true;
  return BRACKET_PAIRS.some((p) => t.startsWith(p[0]) && t.endsWith(p[1]));
}

/** Join two fragments, inserting a space only when neither side of the seam is CJK. */
function joinFragments(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const seam = CJK.test(a[a.length - 1]) || CJK.test(b[0]) ? "" : " ";
  return a + seam + b;
}

/**
 * Collapse the ASR rolling-window: when the same line is re-emitted within a few
 * seconds (the two-line display scrolling it up), keep one cue and extend its end.
 */
function mergeAlike(cues: Cue[]): Cue[] {
  const consumed = new Set<number>();
  const out: Cue[] = [];
  for (let a = 0; a < cues.length; a++) {
    if (consumed.has(a)) continue;
    const cur = cues[a];
    let end = cur.end;
    for (let k = a + 1; k <= a + MERGE_ALIKE_MAX_AHEAD && k < cues.length; k++) {
      if (consumed.has(k)) continue;
      const o = cues[k];
      if (o.text === cur.text && Math.abs(o.start - cur.end) <= MERGE_ALIKE_MAX_GAP) {
        consumed.add(k);
        end = Math.max(end, o.end);
      }
    }
    out.push({ ...cur, end });
  }
  return out;
}

/**
 * Merge fragments that share the exact same time span (multi-line cues split
 * across positioned segments) into one line — unless the first already reads as
 * a complete sentence.
 */
function mergeSameSpan(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && prev.start === c.start && prev.end === c.end && !endsWithDelimiter(prev.text)) {
      prev.text = joinFragments(prev.text, c.text);
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

/**
 * Auto-generated tracks sometimes come ALL CAPS. If most lines are uppercase
 * (and the language has case), drop to sentence case so it reads — and tokenizes
 * — naturally. Normalises ALL-CAPS subtitle lines.
 */
function normaliseAllCaps(cues: Cue[], lang?: string): Cue[] {
  const base = (lang || "").toLowerCase().split("-")[0];
  if (!base || LANG_WITHOUT_CASE.has(base)) return cues;
  const allCaps = cues.filter((c) => c.text === c.text.toLocaleUpperCase()).length;
  if (cues.length === 0 || allCaps / cues.length <= ALL_CAPS_THRESHOLD) return cues;
  return cues.map((c) => ({
    ...c,
    text: c.text.charAt(0).toLocaleUpperCase() + c.text.slice(1).toLocaleLowerCase(),
  }));
}

/**
 * YouTube's rolling caption display gives each line a long duration that overruns
 * into the next line (the old line lingers while the next scrolls in). Trim every
 * cue's end to the next cue's start so cues are sequential, not overlapping — then
 * the active cue tracks the speech (and our hint-sticky lookup doesn't lag a line
 * behind). Trims to clean, back-to-back ranges.
 */
function trimOverlaps(cues: Cue[]): Cue[] {
  for (let i = 0; i < cues.length - 1; i++) {
    const next = cues[i + 1];
    if (next.start > cues[i].start && next.start < cues[i].end) cues[i].end = next.start;
  }
  return cues;
}

/** Split text into sentences, keeping the terminator (and any trailing close-quote/bracket). */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  const chars = Array.from(text);
  let cur = "";
  for (let i = 0; i < chars.length; i++) {
    cur += chars[i];
    if ("。．.!?！？".includes(chars[i])) {
      while (i + 1 < chars.length && "」』】）)".includes(chars[i + 1])) cur += chars[++i];
      out.push(cur);
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * YouTube's rolling ASR often packs several spoken sentences into ONE long cue, shown all at once
 * at its start — so later sentences appear on screen before they're actually said. Split a long,
 * multi-sentence cue into one cue per sentence, sharing the cue's [start,end] proportionally to
 * each sentence's length so each shows roughly when it's spoken. Short/single-sentence cues are
 * left alone (manual captions are already one line per cue).
 */
function splitLongCues(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    const dur = c.end - c.start;
    const parts = splitSentences(c.text);
    if (parts.length < 2 || dur < 4) {
      out.push(c);
      continue;
    }
    const lens = parts.map((p) => p.replace(/\s/g, "").length || 1);
    const total = lens.reduce((a, b) => a + b, 0);
    let t = c.start;
    parts.forEach((p, i) => {
      const end = i === parts.length - 1 ? c.end : t + (dur * lens[i]) / total;
      out.push({ id: 0, start: t, end, text: p });
      t = end;
    });
  }
  return out;
}

/** Shared finishing pipeline: clean -> drop noise -> sort -> de-dup -> trim -> split long -> case-fix -> re-id. */
function finalize(cues: Cue[], lang?: string): Cue[] {
  let c = cues
    .map((x) => ({ ...x, text: cleanText(x.text) }))
    .filter((x) => x.text.length > 0 && x.end > x.start && !MUSIC_ONLY.test(x.text));
  c.sort((a, b) => a.start - b.start || a.end - b.end);
  c = mergeAlike(c);
  c = mergeSameSpan(c);
  c = trimOverlaps(c);
  c = splitLongCues(c);
  c = normaliseAllCaps(c, lang);
  c.forEach((x, i) => (x.id = i));
  return c;
}

/**
 * YouTube timedtext JSON3:
 *   { events: [ { tStartMs, dDurationMs, segs: [ { utf8 } ] }, ... ] }
 * Each event is one displayed line; segs are word pieces whose own leading
 * spaces are already embedded, so we concatenate (never space-join — that would
 * wreck Japanese/Chinese). Append-only window events ("\n") clean to empty.
 */
export function parseYoutubeJson3(json: any, lang?: string): Cue[] {
  const events: any[] = json?.events ?? [];
  const cues: Cue[] = [];
  for (const ev of events) {
    if (!ev.segs) continue;
    const evStart = (ev.tStartMs ?? 0) / 1000;
    const evEnd = evStart + ((ev.dDurationMs ?? 0) / 1000 || 4);
    const segs = (ev.segs as any[]).filter((s) => (s.utf8 ?? "") !== "" && s.utf8 !== "\n");
    if (!segs.length) continue;
    // Auto-captions stamp each word with its spoken time (tOffsetMs) — YouTube's own speech
    // recognition. Use it to give each SENTENCE the time its first word is actually said, instead
    // of dumping the whole rolling line at the event's start. (Ends overrun; trimOverlaps in
    // finalize clips each to the next cue → clean, voice-aligned ranges.)
    const hasWordTiming = segs.some((s) => typeof s.tOffsetMs === "number" && s.tOffsetMs > 0);
    if (!hasWordTiming) {
      cues.push({ id: 0, start: evStart, end: evEnd, text: segs.map((s) => s.utf8).join("") });
      continue;
    }
    let buf = "";
    let sentStart = evStart;
    const flush = () => {
      if (buf.trim()) cues.push({ id: 0, start: sentStart, end: evEnd, text: buf });
      buf = "";
    };
    for (const s of segs) {
      if (!buf) sentStart = evStart + (s.tOffsetMs ?? 0) / 1000;
      buf += s.utf8;
      const last = buf.trimEnd().slice(-1);
      if ("。．.!?！？".includes(last)) flush();
    }
    flush();
  }
  return finalize(cues, lang);
}

/**
 * srv3 timedtext: <timedtext><body><p t="1359" d="2400"><s>he</s><s>llo</s></p>…
 * (t/d are milliseconds; text may be split across <s> segments).
 */
export function parseYoutubeSrv3(xml: string, lang?: string): Cue[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const ps = Array.from(doc.querySelectorAll("p"));
  const cues: Cue[] = [];
  for (const p of ps) {
    const t = parseInt(p.getAttribute("t") ?? "0", 10);
    const d = parseInt(p.getAttribute("d") ?? "0", 10);
    const text = p.textContent ?? "";
    const start = t / 1000;
    cues.push({ id: 0, start, end: start + (d ? d / 1000 : 4), text });
  }
  return finalize(cues, lang);
}

/** Legacy XML timedtext: <transcript><text start="1.2" dur="3.4">...</text></transcript> */
export function parseYoutubeXml(xml: string, lang?: string): Cue[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const nodes = Array.from(doc.querySelectorAll("text"));
  const cues: Cue[] = [];
  for (const n of nodes) {
    const start = parseFloat(n.getAttribute("start") ?? "0");
    const dur = parseFloat(n.getAttribute("dur") ?? "0");
    cues.push({ id: 0, start, end: start + (dur || 4), text: n.textContent ?? "" });
  }
  return finalize(cues, lang);
}

/** Detect and parse whatever timedtext format YouTube returned (json3 / srv3 / srv1). */
export function parseYoutubeTimedText(body: string, lang?: string): Cue[] {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      return parseYoutubeJson3(JSON.parse(body), lang);
    } catch {
      /* fall through */
    }
  }
  if (/<timedtext|<p[\s>]/i.test(body)) return parseYoutubeSrv3(body, lang);
  if (/<text[\s>]/i.test(body)) return parseYoutubeXml(body, lang);
  return [];
}

// Exposed for unit tests (DOM-free helpers).
export const __test = { cleanText, decodeEntities, endsWithDelimiter, joinFragments, mergeAlike, mergeSameSpan, trimOverlaps, normaliseAllCaps, finalize };
