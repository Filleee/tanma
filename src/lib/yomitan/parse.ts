import type {
  DictIndex,
  FreqRecord,
  GlossaryNode,
  KanjiRecord,
  PitchRecord,
  TagRecord,
  TermRecord,
} from "./types";

export function parseIndex(json: any): DictIndex {
  return {
    title: String(json?.title ?? "Untitled dictionary"),
    revision: json?.revision != null ? String(json.revision) : "",
    format: json?.format ?? json?.version,
    version: json?.version ?? json?.format,
    author: json?.author,
    description: json?.description,
    attribution: json?.attribution,
    sourceLanguage: json?.sourceLanguage,
    targetLanguage: json?.targetLanguage,
  };
}

/** term_bank: [expression, reading, defTags, rules, score, glossary[], sequence, termTags] */
export function parseTermBank(rows: any[], dictId: number): TermRecord[] {
  const out: TermRecord[] = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    out.push({
      dictId,
      expression: String(r[0] ?? ""),
      reading: String(r[1] ?? ""),
      defTags: r[2] == null ? "" : String(r[2]),
      rules: String(r[3] ?? ""),
      score: Number(r[4] ?? 0),
      glossary: Array.isArray(r[5]) ? (r[5] as GlossaryNode[]) : [String(r[5] ?? "")],
      sequence: Number(r[6] ?? 0),
      termTags: String(r[7] ?? ""),
    });
  }
  return out;
}

/** term_meta_bank: [expression, mode, data]; mode is "freq" | "pitch" | "ipa". */
export function parseTermMetaBank(
  rows: any[],
  dictId: number,
): { freq: FreqRecord[]; pitch: PitchRecord[] } {
  const freq: FreqRecord[] = [];
  const pitch: PitchRecord[] = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const expression = String(r[0] ?? "");
    const mode = r[1];
    const data = r[2];
    if (mode === "freq") {
      const f = parseFreqData(data);
      freq.push({ dictId, expression, reading: f.reading, value: f.value, display: f.display });
    } else if (mode === "pitch" && data && typeof data === "object") {
      pitch.push({
        dictId,
        expression,
        reading: String((data as any).reading ?? ""),
        pitches: ((data as any).pitches ?? []).map((p: any) => ({
          position: Number(p.position ?? 0),
          devoice: p.devoice,
          nasal: p.nasal,
        })),
      });
    }
  }
  return { freq, pitch };
}

/** Frequency `data` can be a number, string, {value,displayValue}, or {reading, frequency}. */
export function parseFreqData(data: any): { reading: string; value: number; display: string } {
  let reading = "";
  let inner = data;
  if (data && typeof data === "object" && !Array.isArray(data) && "frequency" in data) {
    reading = String(data.reading ?? "");
    inner = data.frequency;
  }
  if (typeof inner === "number") {
    return { reading, value: inner, display: inner.toLocaleString() };
  }
  if (typeof inner === "string") {
    const n = parseInt(inner.replace(/[^\d]/g, ""), 10);
    return { reading, value: Number.isFinite(n) ? n : Infinity, display: inner };
  }
  if (inner && typeof inner === "object") {
    const value = Number(inner.value ?? inner.frequency ?? Infinity);
    const display = inner.displayValue != null ? String(inner.displayValue) : value.toLocaleString();
    return { reading, value: Number.isFinite(value) ? value : Infinity, display };
  }
  return { reading, value: Infinity, display: String(inner ?? "") };
}

/** kanji_bank: [character, onyomi, kunyomi, tags, meanings[], stats{}] */
export function parseKanjiBank(rows: any[], dictId: number): KanjiRecord[] {
  const out: KanjiRecord[] = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    out.push({
      dictId,
      character: String(r[0] ?? ""),
      onyomi: splitReadings(r[1]),
      kunyomi: splitReadings(r[2]),
      tags: String(r[3] ?? ""),
      meanings: Array.isArray(r[4]) ? r[4].map(String) : [],
      stats: r[5] && typeof r[5] === "object" ? r[5] : {},
    });
  }
  return out;
}

/** kanji_meta_bank: [character, "freq", data] */
export function parseKanjiMetaBank(rows: any[], dictId: number): FreqRecord[] {
  const out: FreqRecord[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r[1] !== "freq") continue;
    const f = parseFreqData(r[2]);
    out.push({ dictId, expression: String(r[0] ?? ""), reading: "", value: f.value, display: f.display });
  }
  return out;
}

/** tag_bank: [name, category, order, notes, score] */
export function parseTagBank(rows: any[], dictId: number): TagRecord[] {
  const out: TagRecord[] = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    out.push({
      dictId,
      name: String(r[0] ?? ""),
      category: String(r[1] ?? ""),
      order: Number(r[2] ?? 0),
      notes: String(r[3] ?? ""),
      score: Number(r[4] ?? 0),
    });
  }
  return out;
}

function splitReadings(s: any): string[] {
  if (Array.isArray(s)) return s.map(String);
  const str = String(s ?? "").trim();
  return str ? str.split(/[\s,、]+/).filter(Boolean) : [];
}
