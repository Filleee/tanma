import type { Cue } from "../../common/types";
import { timecodeToSeconds } from "./srt";

/** Parse SubStation Alpha (.ass/.ssa). Reads the [Events] section's Dialogue lines. */
export function parseAss(content: string): Cue[] {
  const text = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  const cues: Cue[] = [];
  let id = 0;

  let inEvents = false;
  let format: string[] = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"];

  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[Events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;

    if (/^Format:/i.test(line)) {
      format = line.slice(line.indexOf(":") + 1).split(",").map((s) => s.trim());
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;

    const body = line.slice(line.indexOf(":") + 1);
    // Text is the last field and may itself contain commas, so split with a limit.
    const parts = body.split(",");
    const fixed = format.length - 1;
    const head = parts.slice(0, fixed);
    const textField = parts.slice(fixed).join(",");

    const startIdx = format.indexOf("Start");
    const endIdx = format.indexOf("End");
    const start = timecodeToSeconds(head[startIdx] ?? "0");
    const end = timecodeToSeconds(head[endIdx] ?? "0");

    const cleanText = textField
      .replace(/\{[^}]*\}/g, "") // override tags
      .replace(/\\N/gi, "\n")
      .replace(/\\h/gi, " ")
      .trim();

    if (cleanText) cues.push({ id: id++, start, end, text: cleanText });
  }
  return cues;
}
