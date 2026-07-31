import type { Cue } from "../../common/types";
import { parseSrt } from "./srt";
import { parseVtt } from "./vtt";
import { parseAss } from "./ass";
import { parseLrc } from "./lrc";

export { parseSrt, parseVtt, parseAss, parseLrc };
export { parseYoutubeJson3, parseYoutubeXml, parseYoutubeSrv3, parseYoutubeTimedText } from "./youtube";

/** Normalize cues: sort by start, assign ids, drop empties. */
export function normalizeCues(cues: Cue[]): Cue[] {
  const cleaned = cues
    .filter((c) => c.text.trim().length > 0 && c.end > c.start)
    .sort((a, b) => a.start - b.start);
  cleaned.forEach((c, i) => (c.id = i));
  return cleaned;
}

/** Detect format from filename + content and parse into cues. */
export function parseSubtitleFile(filename: string, content: string): Cue[] {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  let cues: Cue[];
  if (ext === "ass" || ext === "ssa" || /^\s*\[Script Info\]/i.test(content)) {
    cues = parseAss(content);
  } else if (ext === "vtt" || /^﻿?WEBVTT/.test(content)) {
    cues = parseVtt(content);
  } else if (ext === "lrc") {
    cues = parseLrc(content);
  } else {
    cues = parseSrt(content);
  }
  return normalizeCues(cues);
}
