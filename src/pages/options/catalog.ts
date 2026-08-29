// Curated, one-click-downloadable Yomitan dictionaries. URLs use GitHub's stable
// "latest/download" redirects or raw file paths (verified to resolve). Jisho stays
// the zero-setup default online source; these are optional extras.

export interface CatalogEntry {
  id: string;
  title: string;
  desc: string;
  kind: "terms" | "names" | "kanji" | "freq";
  sizeMB: number;
  url: string;
  attribution: string;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "jitendex",
    title: "Jitendex",
    desc: "Rich Japanese→English dictionary (JMdict-based) with example sentences, usage & etymology notes.",
    kind: "terms",
    sizeMB: 37,
    url: "https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip",
    attribution: "Jitendex — CC BY-SA 4.0 (stephenmk)",
  },
  {
    id: "jmnedict",
    title: "JMnedict",
    desc: "Japanese proper-names dictionary (people, places, organisations).",
    kind: "names",
    sizeMB: 11,
    url: "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.zip",
    attribution: "JMnedict — EDRDG, CC BY-SA",
  },
  {
    id: "kanjidic",
    title: "KANJIDIC (English)",
    desc: "Per-kanji readings, meanings, stroke counts, grade & JLPT level.",
    kind: "kanji",
    sizeMB: 1,
    url: "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/KANJIDIC_english.zip",
    attribution: "KANJIDIC — EDRDG, CC BY-SA",
  },
  {
    id: "jpdb",
    title: "JPDB v2.2 Frequency",
    desc: "Word-frequency ranks from JPDB's media corpus — shows how common each word is.",
    kind: "freq",
    sizeMB: 6,
    url: "https://github.com/Kuuuube/yomitan-dictionaries/raw/main/dictionaries/JPDB_v2.2_Frequency_2024-10-13.zip",
    attribution: "JPDB frequency (Kuuuube) — see repo for license",
  },
  {
    id: "bccwj",
    title: "BCCWJ Frequency",
    desc: "Frequency from the Balanced Corpus of Contemporary Written Japanese (SUW+LUW).",
    kind: "freq",
    sizeMB: 9,
    url: "https://github.com/Kuuuube/yomitan-dictionaries/raw/main/dictionaries/BCCWJ_SUW_LUW_combined.zip",
    attribution: "BCCWJ frequency (Kuuuube) — see repo for license",
  },
];

/** "owner/repo" for a catalog entry that tracks a GitHub `releases/latest` asset (updatable via
 *  the GitHub API), else null — pinned raw-file dicts (e.g. Kuuuube) have no "latest" to check. */
export function githubRepo(url: string): string | null {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/releases\/latest\//);
  return m ? m[1] : null;
}
