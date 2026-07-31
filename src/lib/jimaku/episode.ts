// Pure episode-number heuristics for Jimaku auto-detect, kept dependency-free so
// they're unit-testable in isolation (scripts/test-jimaku-episode.mjs).

/** Filenames that hold a whole season/batch rather than a single episode. */
export const BATCH_RE = /(\ball\b|batch|complete|\bseason\b|\bfull\b|\bvol\b)/i;
/** An episode range like "01-24", "01~24", "1 to 12" — a batch, not one episode. */
const RANGE_RE = /\b(\d{1,4})\s*(?:-|~|–|to)\s*(\d{1,4})\b/;
/** Resolutions / years that look like numbers but aren't episodes. */
const NOT_EPISODE = new Set([360, 480, 540, 576, 720, 1080, 1440, 2160]);
const SUB_EXT = /\.(srt|ass|ssa|vtt)$/i;

/** A subtitle file that covers the whole season — a batch keyword or an episode range
 *  (e.g. "(01-24)"). Such files have no single episode number. */
export function isBatchFile(name: string): boolean {
  const base = name.replace(SUB_EXT, "");
  return BATCH_RE.test(base) || RANGE_RE.test(base);
}

/** Loadable subtitle file (others, e.g. archives, are ignored). */
function isSub(name: string): boolean {
  return SUB_EXT.test(name);
}
/** Rank by extension for auto-pick: .srt (cleanest for our renderer) → .ass/.ssa → .vtt. */
function extRank(name: string): number {
  const ext = name.toLowerCase().match(/\.(srt|ass|ssa|vtt)$/)?.[1];
  return ext === "srt" ? 0 : ext === "ass" || ext === "ssa" ? 1 : 2;
}

/** The single best file to auto-load for an episode: the matching file (prefer .srt) when
 *  `episode` is set; if no episode, only auto-pick when there's exactly one sub file.
 *  Returns null when the choice is ambiguous or nothing matches (caller should not guess). */
export function bestEpisodeFile<T extends { name: string }>(files: T[], episode: number | null): T | null {
  const subs = files.filter((f) => isSub(f.name));
  if (!subs.length) return null;
  if (episode == null) return subs.length === 1 ? subs[0] : null;
  const matched = subs.filter((f) => episodeFromFilename(f.name) === episode);
  if (!matched.length) return null;
  return [...matched].sort((a, b) => extRank(a.name) - extRank(b.name))[0];
}

/** Ordered Jimaku search attempts for a detected show: the exact anilist_id first, then the
 *  romaji/native/synonym titles (what Jimaku indexes), then the page title. First hit wins. */
export function searchAttempts(hint: { anilistId?: number; titles?: string[]; title?: string }): Array<{ anilistId?: number; query?: string }> {
  const out: Array<{ anilistId?: number; query?: string }> = [];
  if (hint.anilistId) out.push({ anilistId: hint.anilistId });
  const seen = new Set<string>();
  for (const q of [...(hint.titles ?? []), hint.title]) {
    const t = q?.trim();
    if (t && t.length >= 2 && !seen.has(t)) {
      seen.add(t);
      out.push({ query: t });
    }
  }
  return out;
}

/** Best-effort episode number from a page URL. Streaming sites are inconsistent, so
 *  try common query params (?ep=, ?episode=) then path patterns (/episode-12, /ep/12).
 *  Returns undefined when nothing looks like an episode. */
export function episodeFromUrl(href: string): number | undefined {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  for (const k of ["ep", "episode", "epi", "epno", "episode_no", "e"]) {
    const v = u.searchParams.get(k);
    if (v && /^\d{1,4}$/.test(v)) return Number(v);
  }
  const m = u.pathname.match(/(?:^|[/_-])(?:ep|episode)[-/_ ]?(\d{1,4})(?=$|[/_?-])/i);
  return m ? Number(m[1]) : undefined;
}

/** Best-effort episode number from a subtitle filename (ported from jimaku-dl's
 *  filter_files_by_episode): explicit E/EP/#/dash markers first, then a bare number,
 *  skipping resolutions and years. Returns null for batch/ambiguous filenames. */
export function episodeFromFilename(name: string): number | null {
  if (isBatchFile(name)) return null; // a season/batch/range covers no single episode
  const base = name.replace(SUB_EXT, "").replace(/\[[^\]]*\]/g, " "); // drop [group]/[1080p] tags
  for (const re of [
    /\b(?:ep|episode)[ ._-]*(\d{1,4})/i,
    /(?:^|[^a-z0-9])e[ ._-]*(\d{1,4})(?![0-9])/i,
    /#(\d{1,4})/,
    /\s-\s*(\d{1,4})(?:v\d)?(?:\s|$)/,
  ]) {
    const m = base.match(re);
    if (m) return Number(m[1]);
  }
  for (const m of base.matchAll(/(?:^|[\s._-])(\d{1,4})(?![0-9pkx])/gi)) {
    const n = Number(m[1]);
    if (!NOT_EPISODE.has(n) && !(n >= 1900 && n <= 2100)) return n;
  }
  return null;
}
