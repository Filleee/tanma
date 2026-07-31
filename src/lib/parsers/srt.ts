import type { Cue } from "../../common/types";

/** "00:01:02,500" or "00:01:02.500" or "1:02.5" -> seconds */
export function timecodeToSeconds(tc: string): number {
  const m = tc.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/);
  if (!m) {
    // mm:ss or ss
    const parts = tc.trim().split(":").map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return Number(tc) || 0;
  }
  const [, h, mm, ss, ms] = m;
  return (
    (h ? parseInt(h, 10) * 3600 : 0) +
    parseInt(mm, 10) * 60 +
    parseInt(ss, 10) +
    parseInt(ms.padEnd(3, "0"), 10) / 1000
  );
}

/** Strip SRT/HTML formatting tags but keep the text + line breaks. */
export function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/\{[^}]*\}/g, "") // SSA inline overrides that sometimes leak into SRT
    .trim();
}

export function parseSrt(content: string): Cue[] {
  const text = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^﻿/, "");
  const blocks = text.split(/\n{2,}/);
  const cues: Cue[] = [];
  let id = 0;
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0 || true);
    if (lines.length === 0) continue;
    // Optional numeric index line
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    const timeLine = lines[i];
    if (!timeLine) continue;
    const tm = timeLine.match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/);
    if (!tm) continue;
    const start = timecodeToSeconds(tm[1]);
    const end = timecodeToSeconds(tm[2]);
    const body = lines.slice(i + 1).join("\n");
    cues.push({ id: id++, start, end, text: stripTags(body) });
  }
  return cues;
}
