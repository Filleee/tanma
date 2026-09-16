// ---------------------------------------------------------------------------
// Shared domain types
// ---------------------------------------------------------------------------

/** A single subtitle cue (one displayed line/block). */
export interface Cue {
  id: number;
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  /** Raw text, may contain \n for multi-line cues. */
  text: string;
}

/** A loaded subtitle track. */
export interface SubtitleTrack {
  id: string;
  label: string;
  /** BCP-47-ish language code, e.g. "ja", "en", "zh", "ko". */
  lang: string;
  /** "target" = language being learned, "secondary" = translation. */
  role: "target" | "secondary";
  source: "file" | "youtube" | "jimaku" | "mt" | "lrclib";
  cues: Cue[];
}

/** One queued word awaiting batch mining. Everything mineCard needs to build the card later,
 *  captured at queue time (JSON-serializable so the queue survives a reload). */
export interface QueuedMine {
  id: string;
  token: Token;
  sentence: string;
  cue: Cue | null;
  candidates: string[];
  /** The reading shown/selected in the popup when queued. */
  reading: string;
  /** The timing offset active when queued, so batch-mining reproduces the alignment you saw
   *  even if you re-align the subtitles later (e.g. a drifting file). */
  offset?: number;
}

export type KnownStatus = "UNKNOWN" | "LEARNING" | "KNOWN" | "IGNORED";

/** A tokenized word inside a cue. */
export interface Token {
  /** Surface form as it appears in the text. */
  surface: string;
  /** Reading in hiragana (Japanese) for furigana; empty if none/not needed. */
  reading: string;
  /** Dictionary / base form used for lookups & known-word tracking. */
  dict: string;
  /** Part of speech (best-effort), e.g. "noun", "particle". */
  pos: string;
  /** True for punctuation / whitespace / symbols that shouldn't be interactive. */
  isWord: boolean;
  /** Morpheme breakdown, set only when the Japanese merge glued several together. Kept so a
   *  dictionary-validated pass can re-split an over-merge (see lib/splitTokens.ts). */
  parts?: Token[];
}

export interface DictEntry {
  term: string;
  reading?: string;
  /** Short part-of-speech / tag list. */
  partsOfSpeech?: string[];
  /** Definition glosses. */
  senses: { glosses: string[]; partsOfSpeech?: string[] }[];
  source: string;
}

// ---------------------------------------------------------------------------
// Persisted settings
// ---------------------------------------------------------------------------

export type PauseMode = "off" | "eachLine" | "onLookup";

/** Limits the overlay to certain URLs on a host. The overlay activates only when the URL
 *  (path + query) contains one of `patterns`; an empty `patterns` means "everywhere on this host". */
export interface ActivationRule {
  host: string;
  patterns: string[];
}

export interface Settings {
  enabled: boolean;
  targetLang: string;
  /** Native language to translate INTO (YouTube auto-translate via tlang); the "secondary" line. */
  nativeLang: string;
  /** Multiplier applied to base subtitle font size. */
  subtitleSize: number;
  /** Subtitle text shadow/outline strength (0 = none, 1 = default, up to 2 = heavy). */
  subtitleShadow: number;
  /** Opacity of a dark plate behind subtitle text for bright backgrounds (0 = off). */
  subtitleBackground: number;
  /** Seconds added to cue timing (positive = subs appear later). */
  subOffset: number;
  showFurigana: boolean;
  /** "Show translation when available" — show a real/official translation track in `nativeLang`
   *  (a manual YouTube caption track, an imported/embedded native sub). No machine translation. */
  showSecondary: boolean;
  /** "Show machine translation" — when no official translation track is available, generate one
   *  with the configured provider (YouTube's own auto-translate on YouTube+Google, else Google/DeepL).
   *  Works on any site, not just YouTube. */
  showMachineTranslation: boolean;
  /** Machine-translation provider: keyless Google, or DeepL (needs `mtApiKey`). Global. */
  mtProvider: "google" | "deepl";
  /** DeepL API key (free keys end in ":fx"). "" = not set. Global. */
  mtApiKey: string;
  /** Accent colour (hex) for the UI — overlay, dashboard, popup, player. Global preference. */
  accent: string;
  /** Color words by known status (underlines). */
  showKnownStatus: boolean;
  /** Tint grammar morphemes (particles & auxiliaries) a distinct colour, detected by part-of-speech. */
  colorGrammar: boolean;
  hoverLookup: boolean;
  pauseMode: PauseMode;
  /** "Pause each line" auto-resume delay, in seconds (0 = manual). ("Pause on lookup" instead
   *  resumes when the look-up popup closes.) */
  autoResume: number;
  /** "off" | "blur" | "hide" — obscure target subs until hovered (listening practice). */
  hideTarget: "off" | "blur" | "hide";
  hideSecondary: "off" | "blur" | "hide";
  /** Vertical position of overlay as a fraction (0 = top, 1 = bottom). */
  overlayPosition: number;
  browserOpen: boolean;

  // ---- Anki sentence mining (via AnkiConnect → lapis-simplified note type) ----
  ankiEnabled: boolean;
  /** Target deck name in Anki. */
  ankiDeck: string;
  /** Note type name (lapis-simplified). */
  ankiModel: string;
  /** Dictionary title used for the single MainDefinition field ("" = auto: prefer Jitendex/JMdict). */
  ankiMainDict: string;
  /** Capture a still screenshot into the Picture field. */
  ankiCaptureImage: boolean;
  /** Capture the line's audio into SentenceAudio. */
  ankiCaptureSentenceAudio: boolean;
  /** Put word audio (JapanesePod101) into ExpressionAudio. */
  ankiCaptureWordAudio: boolean;
  /** Use a looping clip instead of a still in Picture (bigger cards). */
  ankiAnimatedImage: boolean;
  /** Decks the "sync mined" backfill reads from (remembered selection). */
  ankiSyncDecks: string[];
  /** Auto-run the mined backfill from those decks on startup (keeps the ✓/dot tracking
   *  in sync across browsers/devices via Anki, since chrome.storage.local doesn't sync). */
  ankiAutoSyncMined: boolean;

  // ---- Mined-card translation (writes into an Anki field, e.g. Kiku's SentenceTranslation) ----
  /** Translate the mined line and write it into `trField`. OFF by default; mining-only (the live
   *  secondary subtitle line keeps using mtProvider — an LLM per line would be slow + costly). */
  trEnabled: boolean;
  /** Anki field the translation is written to ("" = skip). Filtered out if the note type lacks it. */
  trField: string;
  /** Provider for the mined translation, independent of the live line's `mtProvider`. */
  trProvider: "google" | "deepl" | "openai" | "gemini";
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 (no trailing /chat/completions). */
  trOpenaiUrl: string;
  trOpenaiModel: string;
  /** Tried when the primary model errors out. "" = no fallback. */
  trOpenaiBackupModel: string;
  trOpenaiKey: string;
  trGeminiModel: string;
  trGeminiKey: string;
  /** Subtitle lines of context handed to the LLM around the mined line. Unlike a text hooker we
   *  have the whole track, so we can look FORWARD too — Japanese resolves dropped subjects later. */
  trContextBefore: number;
  trContextAfter: number;
  trTemperature: number;
  trMaxTokens: number;
  trTopP: number;
  /** Custom prompt template; "" = the built-in canned prompt. */
  trPrompt: string;

  // ---- Look-up interaction + keybindings (global, not per-site) ----
  /** Match multi-word expressions on look-up (歳+食っちゃい → 歳食う), Yomitan-style.
   *  Off = look up exactly the clicked token, nothing else. */
  compoundLookup: boolean;
  /** Hold a modifier + hover to look up (Yomitan-style), no click needed. */
  holdLookup: boolean;
  /** Apply hold-to-look-up on the live video overlay too (not just the browser). */
  holdLookupOverlay: boolean;
  /** Modifier held for hold-to-look-up (Control | Alt | Shift | Meta). Hover the start of
   *  a word → whole word; hover mid-word (or drag) → the sub-piece from the cursor. */
  keyLookup: string;
  /** Single-key shortcuts for line navigation (lower-case key name, e.g. "a"). */
  keyPrevLine: string;
  keyNextLine: string;
  keyReplayLine: string;

  /** Per-host rules limiting WHERE the overlay activates (so it doesn't show on a site's
   *  home/feed pages with autoplay previews). Empty = activate everywhere. */
  activationRules: ActivationRule[];

  // ---- word-audio sources (🔊 + ExpressionAudio on cards), tried in order ----
  /** JapanesePod101 human recordings (JA only). */
  audioJpod101: boolean;
  /** Custom audio URL template with {term} and {reading} placeholders (e.g. a local
   *  forvo-scraper or another dictionary-audio server). "" = disabled. */
  audioCustomUrl: string;
  /** Google-translate TTS fallback (neural; still falls back to Web Speech if off). */
  audioGoogleTts: boolean;

  /** API key for jimaku.cc subtitle search (from jimaku.cc/profile). "" = not set. */
  jimakuApiKey: string;
  /** Auto-detect the show + episode on an anime page and load the matching Jimaku subtitle
   *  automatically (no panel needed). Requires jimakuApiKey; no-op without it. */
  jimakuAutoLoad: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  targetLang: "ja",
  nativeLang: "en",
  subtitleSize: 1,
  subtitleShadow: 1,
  subtitleBackground: 0,
  subOffset: 0,
  showFurigana: true,
  showSecondary: true,
  showMachineTranslation: false,
  mtProvider: "google",
  mtApiKey: "",
  accent: "#ff9345",
  showKnownStatus: true,
  colorGrammar: false, // opt-in
  hoverLookup: false, // off by default — hold-to-look-up (holdLookup) is the default hover
  pauseMode: "off",
  autoResume: 0,
  hideTarget: "off",
  hideSecondary: "off",
  overlayPosition: 0.92,
  browserOpen: false,
  ankiEnabled: false,
  ankiDeck: "",
  ankiModel: "",
  ankiMainDict: "",
  ankiCaptureImage: true,
  ankiCaptureSentenceAudio: true,
  ankiCaptureWordAudio: true,
  ankiAnimatedImage: false,
  ankiSyncDecks: [],
  ankiAutoSyncMined: false,
  trEnabled: false,
  trField: "SentenceTranslation",
  trProvider: "google",
  trOpenaiUrl: "https://api.openai.com/v1",
  trOpenaiModel: "",
  trOpenaiBackupModel: "",
  trOpenaiKey: "",
  trGeminiModel: "",
  trGeminiKey: "",
  trContextBefore: 8,
  trContextAfter: 4,
  trTemperature: 0.3,
  trMaxTokens: 1024,
  trTopP: 0.9,
  trPrompt: "",
  compoundLookup: true,
  holdLookup: true,
  holdLookupOverlay: true,
  keyLookup: "Alt",
  keyPrevLine: "a",
  keyNextLine: "d",
  keyReplayLine: "s",
  activationRules: [{ host: "youtube.com", patterns: ["/watch", "/shorts/", "/embed/", "/live/"] }],
  audioJpod101: true,
  audioCustomUrl: "",
  audioGoogleTts: true,
  jimakuApiKey: "",
  jimakuAutoLoad: true,
};

// ---------------------------------------------------------------------------
// Messaging (content <-> background, content <-> page-world inject)
// ---------------------------------------------------------------------------

export type BgRequest =
  | { type: "lookup"; term: string; surface: string; reading: string; lang: string; candidates?: string[] }
  | { type: "lookupOnline"; term: string; lang: string }
  | { type: "audio"; term: string; reading: string; lang: string }
  // ---- Anki ----
  | { type: "anki"; action: string; params?: Record<string, unknown> }
  | { type: "ankiScreenshot"; rect: { x: number; y: number; width: number; height: number }; dpr: number }
  | { type: "ankiMine"; card: AnkiMinePayload }
  // ---- Jimaku (jimaku.cc subtitle search) ----
  | { type: "jimaku"; action: "search" | "files" | "download"; query?: string; entryId?: number; url?: string; anilistId?: number }
  // ---- LRCLIB lyrics search (time-synced song lyrics; no key) ----
  | { type: "lrclib"; action: "search"; q?: string; trackName?: string; artistName?: string }
  // ---- resolve an AniList/MAL id → canonical AniList id + its romaji/native/synonym
  //      titles (Jimaku indexes those, so they're the title-search fallbacks) ----
  | { type: "anilistResolve"; anilistId?: number; malId?: number }
  // ---- dictionary-bundled media (structured-content images) ----
  | { type: "dictMedia"; dictId: number; path: string }
  // ---- which of these surfaces resolve to a dictionary entry (itself or a deinflection)? ----
  | { type: "resolveForms"; forms: string[] }
  // ---- dictionary-assisted token merging: which expressions exist? ----
  | { type: "hasTerms"; terms: string[] }
  // ---- machine translation for the secondary line (provider/key read from settings) ----
  | { type: "translate"; texts: string[]; from: string; to: string }
  // ---- translate ONE mined line (provider/prompt/context read from settings) ----
  | { type: "aiTranslate"; sentence: string; word: string; title: string; context: string }
  // ---- list Gemini models for the options dropdown ----
  | { type: "geminiModels"; key: string }
  // ---- auto-sync mined tracking from the deck on startup ----
  | { type: "autoSyncMined" }
  // ---- mute this tab's audible output during batch (queue) mining ----
  | { type: "muteTab"; on: boolean }
  // ---- is a newer release available on GitHub than the installed version? ----
  | { type: "checkUpdate" };
export type UpdateCheckResponse =
  | { ok: true; updateAvailable: boolean; latest: string | null; current: string; url: string }
  | { ok: false; error: string };
export type BgResponse = { ok: true; result: LookupResult } | { ok: false; error: string };
export type DictMediaResponse = { ok: true; dataUrl: string | null } | { ok: false; error: string };
export type HasTermsResponse = { ok: true; found: { expression: string; reading: string }[] } | { ok: false; error: string };
export type ResolveFormsResponse = { ok: true; resolved: { form: string; dict: string }[] } | { ok: false; error: string };
export type TranslateResponse = { ok: true; texts: string[] } | { ok: false; error: string };
export type AiTranslateResponse = { ok: true; text: string } | { ok: false; error: string };
export type GeminiModelsResponse = { ok: true; models: string[] } | { ok: false; error: string };

/** One LRCLIB match. `syncedLyrics` is an LRC string ([mm:ss.xx] lines); null when only
 *  plain (untimed) lyrics exist. */
export interface LrclibHit {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}
export type LrclibResponse = { ok: true; hits: LrclibHit[] } | { ok: false; error: string };

/** Payload for adding one mined card (media is base64, no data: prefix). */
export interface AnkiMinePayload {
  deck: string;
  model: string;
  fields: Record<string, string>;
  media: { filename: string; dataBase64: string }[];
  tags: string[];
}
export type AnkiProxyResponse = { ok: true; result: unknown } | { ok: false; error: string };
export type AnkiScreenshotResponse = { ok: true; dataBase64: string } | { ok: false; error: string };
export type AnkiMineResponse = { ok: true; noteId: number } | { ok: false; error: string };
/** Online source (Jisho/Wiktionary), fetched separately so offline renders instantly. */
export type OnlineResponse = { ok: true; section: DictSection | null } | { ok: false; error: string };

// ---- Merged lookup result (imported Yomitan dicts + online sources) ----

import type { GlossaryNode } from "../lib/yomitan/types";

export interface FrequencyInfo {
  dict: string;
  display: string;
  value: number;
}
export interface DictSectionEntry {
  reading: string;
  tags: string[];
  glossary: GlossaryNode[];
}
export interface DictSection {
  dictTitle: string;
  source: "imported" | "jisho" | "wiktionary";
  /** Present for imported dictionaries — lets the popup fetch dictionary-bundled media. */
  dictId?: number;
  /** The dictionary's bundled `styles.css` (structured-content styling), if any — injected into
   *  mined Anki cards so Jitendex's example/note boxes and tag chips render like Yomitan. */
  styles?: string;
  entries: DictSectionEntry[];
}
export interface KanjiInfo {
  character: string;
  onyomi: string[];
  kunyomi: string[];
  meanings: string[];
  stats: Record<string, string>;
  dict: string;
}
export interface LookupResult {
  term: string;
  reading: string;
  /** Candidate readings for the word (the auto-picked `reading` first), so the look-up popup can
   *  offer a manual switch when the tokenizer guessed the wrong one (e.g. 癖 へき vs くせ). */
  readings: string[];
  /** When a multi-word expression candidate (歳+食う → 歳食う) has a dictionary entry, the
   *  longest such match — the popup promotes it to the headword (Yomitan-style). */
  matchedTerm?: string;
  /** Pitch-accent downstep positions per reading of the shown word (from pitch dicts). */
  pitches?: { reading: string; positions: number[] }[];
  frequencies: FrequencyInfo[];
  sections: DictSection[];
  kanji: KanjiInfo[];
}
/** dataUrl is null when no recording exists (caller should fall back to TTS). */
export type AudioResponse = { ok: true; dataUrl: string | null } | { ok: false; error: string };
export type JimakuResponse = { ok: true; result: unknown } | { ok: false; error: string };
/** Canonical AniList id + its titles (romaji/native/english/synonyms), resolved from an
 *  AniList or MAL id. `id` is null when AniList has no match. */
export type AnilistResolveResponse = { ok: true; id: number | null; titles: string[] } | { ok: false; error: string };

/** Clues scraped from the host page to auto-find subtitles on Jimaku. */
export interface MediaHint {
  /** AniList anime id (preferred — Jimaku searches natively by it). */
  anilistId?: number;
  /** MyAnimeList id (mapped to an AniList id when no AniList link is present). */
  malId?: number;
  /** Best-effort show title from the page (fallback when no id matches). */
  title?: string;
  /** Official AniList titles (romaji/native/english/synonyms) — what Jimaku indexes,
   *  tried in order when an anilist_id search returns nothing. */
  titles?: string[];
  /** Episode number parsed from the page URL (best-effort). */
  episode?: number;
}

/** A jimaku.cc search result (entry) and one of its subtitle files. */
export interface JimakuEntry {
  id: number;
  name: string;
  english_name?: string;
  japanese_name?: string;
  anilist_id?: number;
}
export interface JimakuFile {
  url: string;
  name: string;
  size?: number;
}

/** Messages posted from the MAIN-world YouTube inject to the content script. */
export type YtMessage =
  | { source: "tnm-yt"; kind: "tracks"; videoId: string; tracks: YtCaptionTrack[] }
  | { source: "tnm-yt"; kind: "videoChanged"; videoId: string }
  // Raw caption payload captured from YouTube's OWN timedtext request (carries the
  // proof-of-origin token we can't forge), to be parsed by the content script.
  | { source: "tnm-yt"; kind: "captionData"; videoId: string; lang: string; asr: boolean; translated?: boolean; body: string };

export interface YtCaptionTrack {
  baseUrl: string;
  lang: string;
  name: string;
  kind: string; // "asr" for auto-generated
}

// ---------------------------------------------------------------------------
// Manifest typing (just enough for our generated manifest)
// ---------------------------------------------------------------------------

export interface ManifestV3 {
  manifest_version: 3;
  name: string;
  version: string;
  description: string;
  content_scripts: {
    matches: string[];
    js: string[];
    run_at?: "document_start" | "document_end" | "document_idle";
    world?: "ISOLATED" | "MAIN";
    all_frames?: boolean;
  }[];
  background: { service_worker: string; type: "module" };
  action: { default_title?: string; default_popup?: string };
  options_ui?: { page: string; open_in_tab?: boolean };
  permissions: string[];
  host_permissions: string[];
  web_accessible_resources: {
    matches: string[];
    resources: string[];
    use_dynamic_url?: boolean;
  }[];
  icons?: Record<string, string>;
}
