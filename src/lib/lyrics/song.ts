// Guess an artist + track from a messy media title (YouTube video titles, mostly) so we can
// query LRCLIB. Heuristic and forgiving — the lyrics panel always lets the user correct it.

export interface SongGuess {
  artistName?: string;
  trackName?: string;
  /** Cleaned free-text query, used when we can't confidently split artist/track. */
  query: string;
}

// Upload noise: "(Official Music Video)", "【MV】", "[Lyrics]", "feat.…", quality tags, etc.
const NOISE = /\b(official|music|lyric[s]?|audio|video|visuali[sz]er|m\/?v|hd|4k|full(?:\s*ver(?:sion)?)?|ver\.?|mv|pv|tv\s*size|edit)\b/gi;

function stripNoise(s: string): string {
  return s
    .replace(/[（(【\[｢][^）)】\]｣]*[）)】\]｣]/g, " ") // bracketed groups: (…) 【…】 [...]
    .replace(NOISE, " ")
    .replace(/\bfeat\.?[^-/｜|]*/gi, " ") // "feat. X" up to the next separator
    .replace(/["“”'']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-/｜|・:]+|[-/｜|・:]+$/g, "")
    .trim();
}

/**
 * Split a title into artist/track. Recognises, in order:
 *   Artist「Track」 / Artist『Track』  (Japanese convention)
 *   Track ／ Artist  (JP MV uploads often put the song first)
 *   Artist - Track   (the common Western/global convention)
 * Falls back to a plain query when nothing splits cleanly.
 */
export function guessSong(title: string, channel?: string): SongGuess {
  const cleaned = stripNoise(title || "");
  const query = cleaned || (title || "").trim();

  const bracket = cleaned.match(/^(.+?)\s*[「『｢]\s*(.+?)\s*[」』｣]/);
  if (bracket) {
    return { artistName: bracket[1].trim() || undefined, trackName: bracket[2].trim(), query };
  }

  const slash = cleaned.split(/\s*[／/｜|]\s*/);
  if (slash.length === 2 && slash[0] && slash[1]) {
    // "Track / Artist" — song first is the common JP MV layout.
    return { trackName: slash[0].trim(), artistName: slash[1].trim(), query };
  }

  const dash = cleaned.split(/\s+[-–—]\s+/);
  if (dash.length >= 2 && dash[0] && dash[1]) {
    // "Artist - Track"
    return { artistName: dash[0].trim(), trackName: dash.slice(1).join(" - ").trim(), query };
  }

  // Nothing split — if the channel looks like an artist, offer it alongside the whole title.
  const artist = channel && !/\b(topic|vevo|official|records|music)\b/i.test(channel) ? channel.trim() : undefined;
  return { artistName: artist, trackName: cleaned || undefined, query };
}
