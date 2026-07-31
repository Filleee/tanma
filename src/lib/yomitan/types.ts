// Types for the Yomitan dictionary format (v3) and our normalized records.

/** A glossary entry is either plain text or a structured-content / image object. */
export type GlossaryNode =
  | string
  | { type: "text"; text: string }
  | { type: "structured-content"; content: SCNode }
  | { type: "image"; [k: string]: unknown }
  | Record<string, unknown>;

/** Structured-content node: string, list of nodes, or an element object. */
export type SCNode = string | SCNode[] | SCElement;
export interface SCElement {
  tag: string;
  content?: SCNode;
  data?: Record<string, string>;
  style?: Record<string, string | number>;
  href?: string;
  lang?: string;
  [k: string]: unknown;
}

export type DictType = "term" | "kanji" | "freq" | "pitch" | "mixed";

export interface DictIndex {
  title: string;
  revision?: string;
  format?: number;
  version?: number;
  author?: string;
  description?: string;
  attribution?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
}

export interface DictionaryMeta {
  id: number;
  title: string;
  revision: string;
  enabled: boolean;
  order: number;
  /** Set when installed from the built-in download catalog (catalog entry id). */
  catalogId?: string;
  hasTerms: boolean;
  hasFreq: boolean;
  hasKanji: boolean;
  hasPitch: boolean;
  counts: { terms: number; termMeta: number; kanji: number; tags: number };
  importedAt: number;
}

// ---- Normalized records stored in IndexedDB ----

export interface TermRecord {
  dictId: number;
  expression: string;
  reading: string;
  defTags: string;
  rules: string;
  glossary: GlossaryNode[];
  termTags: string;
  score: number;
  sequence: number;
}

export interface FreqRecord {
  dictId: number;
  expression: string;
  reading: string; // "" if not reading-specific
  value: number; // numeric rank (for sorting); Infinity if unknown
  display: string; // what to show (e.g. "1,234" or "㋕ 500")
}

export interface PitchRecord {
  dictId: number;
  expression: string;
  reading: string;
  pitches: { position: number; devoice?: number[]; nasal?: number[] }[];
}

export interface KanjiRecord {
  dictId: number;
  character: string;
  onyomi: string[];
  kunyomi: string[];
  tags: string;
  meanings: string[];
  stats: Record<string, string>;
}

export interface TagRecord {
  dictId: number;
  name: string;
  category: string;
  order: number;
  notes: string;
  score: number;
}
