import type { Cue } from "../../common/types";

/**
 * Pair a secondary (translation) track to a target track for per-line display.
 *
 * YouTube's auto-translation (tlang) is sentence-level while an ASR target track
 * is fragment-level, so a single translation cue routinely spans several target
 * cues. A naive "find the translation cue at this target cue's time" lookup then
 * repeats the same translation on every fragment it covers.
 *
 * Instead, assign each translation cue to the ONE target cue it overlaps most and
 * concatenate (skipping a repeat of the immediately-preceding piece). Each
 * translation then shows exactly once, on its best-fit line; target cues with no
 * overlapping translation get nothing.
 *
 * Both inputs must be sorted by `start` (our parsers guarantee this) — the sweep
 * pointer relies on it. Returns targetCueId -> joined translation text.
 */
export function alignSecondaryToTarget(targetCues: Cue[], secondaryCues: Cue[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!targetCues.length || !secondaryCues.length) return out;

  const pieces = new Map<number, string[]>();
  let lo = 0;
  for (const s of secondaryCues) {
    while (lo < targetCues.length && targetCues[lo].end <= s.start) lo++;
    let bestId = -1;
    let bestOverlap = 0;
    for (let k = lo; k < targetCues.length && targetCues[k].start < s.end; k++) {
      const overlap = Math.min(targetCues[k].end, s.end) - Math.max(targetCues[k].start, s.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestId = targetCues[k].id;
      }
    }
    if (bestId < 0) continue;
    const text = s.text.replace(/\n/g, " ").trim();
    if (!text) continue;
    const arr = pieces.get(bestId) ?? [];
    if (arr[arr.length - 1] !== text) arr.push(text);
    pieces.set(bestId, arr);
  }
  for (const [id, arr] of pieces) out.set(id, arr.join(" "));
  return out;
}
