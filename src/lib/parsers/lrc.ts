import type { Cue } from "../../common/types";

// LRC time tag: [mm:ss.xx] (centi/milliseconds optional; ".", or rarely ":" separator).
// Metadata lines like [ar:…] [ti:…] [length:03:43] don't start with a digit after "[",
// so they never match — they fall through and are skipped as having no timestamp.
const TAG = /\[(\d{1,2}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g;

const DEFAULT_TAIL = 4; // seconds to hold the final line

/**
 * Parse an LRC lyrics string into cues. Each timestamped line becomes a cue whose end is the
 * next line's start (capped so a long instrumental gap doesn't stretch one line forever). A
 * line may carry several time tags (repeated chorus) → one cue per tag. Metadata-only and
 * blank lines are dropped.
 */
export function parseLrc(content: string): Cue[] {
  const cues: Cue[] = [];
  for (const raw of content.split(/\r?\n/)) {
    TAG.lastIndex = 0;
    const times: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = TAG.exec(raw))) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      times.push(Number(m[1]) * 60 + Number(m[2]) + frac);
    }
    if (!times.length) continue;
    const text = raw.replace(TAG, "").trim();
    if (!text) continue; // pure metadata / blank timing line
    for (const t of times) cues.push({ id: 0, start: t, end: t + DEFAULT_TAIL, text });
  }
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length - 1; i++) {
    const next = cues[i + 1].start;
    // End on the next line, but never before this one starts (duplicate stamps) and never
    // longer than a sensible hold.
    cues[i].end = Math.max(cues[i].start + 0.2, Math.min(next, cues[i].start + 12));
  }
  return cues;
}
