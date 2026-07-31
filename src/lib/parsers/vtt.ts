import type { Cue } from "../../common/types";
import { timecodeToSeconds, stripTags } from "./srt";

export function parseVtt(content: string): Cue[] {
  const text = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^﻿/, "");
  const blocks = text.split(/\n{2,}/);
  const cues: Cue[] = [];
  let id = 0;
  for (const block of blocks) {
    if (/^WEBVTT/.test(block) || /^NOTE\b/.test(block) || /^STYLE\b/.test(block) || /^REGION\b/.test(block)) {
      continue;
    }
    const lines = block.split("\n");
    const timeIdx = lines.findIndex((l) => /-->/.test(l));
    if (timeIdx === -1) continue;
    const tm = lines[timeIdx].match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
    if (!tm) continue;
    const start = timecodeToSeconds(tm[1]);
    const end = timecodeToSeconds(tm[2]);
    const body = lines.slice(timeIdx + 1).join("\n");
    // VTT can carry inline timestamps <00:00:01.000> and <c> tags — strip them.
    const clean = stripTags(body.replace(/<\d{1,2}:\d{2}[:.][\d.]+>/g, ""));
    cues.push({ id: id++, start, end, text: clean });
  }
  return cues;
}
