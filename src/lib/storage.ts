import { DEFAULT_SETTINGS, type KnownStatus, type QueuedMine, type Settings, type SubtitleTrack } from "../common/types";
import { normalizeLang } from "./tokenizer";

/** GLOBAL settings record — Anki/dictionary config that should be the same on every site. */
const SETTINGS_KEY = "tnm:settings";
export const GLOBAL_SETTINGS_KEY = SETTINGS_KEY;
const knownKey = (lang: string) => `tnm:known:${normalizeLang(lang)}`;

type Listener<T> = (value: T) => void;

function area(): chrome.storage.StorageArea {
  return chrome.storage.local;
}

/** One-time migration of data saved by older builds under a different key prefix, copying it
 *  to the current "tnm:" keys (so settings / known words / mined tracking carry over). Runs
 *  once per browser, guarded by a flag; safe to call from any entry point. */
export async function migrateLegacyKeys(): Promise<void> {
  const LEGACY = "mgk:";
  try {
    const all = await area().get(null);
    if (all["tnm:_migrated"]) return;
    const out: Record<string, unknown> = { "tnm:_migrated": 1 };
    for (const k of Object.keys(all)) if (k.startsWith(LEGACY)) out["tnm:" + k.slice(LEGACY.length)] = all[k];
    await area().set(out);
  } catch {
    /* storage unavailable — nothing to migrate */
  }
}

// --------------------------------------------------------------------------
// Settings — scoped at three levels:
//   • per-video  → subOffset (tnm:offset:<mediaKey>, see below)
//   • per-site   → the toolbar + subtitle-display options (tnm:settings:<host>)
//   • global     → Anki/dictionary config (tnm:settings)
// The runtime Settings object is the three merged together.
// --------------------------------------------------------------------------

/** Parent-site key for per-site settings, e.g. "youtube.com" for www.youtube.com. */
export function siteScope(host: string = location.hostname): string {
  return host.replace(/^www\./, "") || host;
}
/** storage.local key holding a site's per-site settings. */
export const hostSettingsKey = (host: string = location.hostname): string => `tnm:settings:${siteScope(host)}`;

/** Settings stored per parent site (everything the toolbar + subtitle settings panel
 *  edit, except the per-video timing offset). Anything not listed here — the Anki and
 *  dictionary config — is global; subOffset is per-video. */
export const HOST_SCOPED_KEYS = [
  "enabled", "targetLang", "nativeLang", "subtitleSize", "subtitleShadow", "subtitleBackground",
  "showFurigana", "showSecondary", "showMachineTranslation", "showKnownStatus", "hoverLookup",
  "compoundLookup", "pauseMode", "autoResume", "hideTarget", "hideSecondary", "overlayPosition", "browserOpen",
] as const satisfies readonly (keyof Settings)[];

const HOST_SET: ReadonlySet<string> = new Set(HOST_SCOPED_KEYS);

function pickHostScoped(s: Partial<Settings>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const k of HOST_SCOPED_KEYS) if (k in s) out[k] = (s as Record<string, unknown>)[k];
  return out as Partial<Settings>;
}
/** Global = every key that is neither per-site nor the per-video offset (i.e. Anki/dict config). */
function pickGlobal(s: Partial<Settings>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(s)) if (k !== "subOffset" && !HOST_SET.has(k)) out[k] = (s as Record<string, unknown>)[k];
  return out as Partial<Settings>;
}

/** Merge defaults ← global record ← per-site record. Pass a host to include per-site
 *  settings (content scripts); omit it for the options page (global keys only). */
export async function loadSettings(host?: string): Promise<Settings> {
  const hk = host !== undefined ? hostSettingsKey(host) : null;
  const got = await area().get(hk ? [SETTINGS_KEY, hk] : [SETTINGS_KEY]);
  const global = (got[SETTINGS_KEY] ?? {}) as Partial<Settings>;
  const perHost = (hk ? (got[hk] ?? {}) : {}) as Partial<Settings>;
  // The global record seeds per-site defaults (so existing prefs survive the upgrade and
  // new sites start from sensible values); a site's own per-site record then wins.
  return { ...DEFAULT_SETTINGS, ...global, ...(hk ? pickHostScoped(perHost) : {}) };
}

/** Persist the GLOBAL (Anki/dictionary) settings record. Per-site + offset keys are ignored. */
export async function saveSettings(s: Settings): Promise<void> {
  const existing = (await area().get(SETTINGS_KEY))[SETTINGS_KEY] ?? {};
  await area().set({ [SETTINGS_KEY]: { ...existing, ...pickGlobal(s) } });
}

/** Persist a site's per-site settings record (toolbar + subtitle display). */
export async function saveHostSettings(s: Settings, host?: string): Promise<void> {
  const key = hostSettingsKey(host);
  const existing = (await area().get(key))[key] ?? {};
  await area().set({ [key]: { ...existing, ...pickHostScoped(s) } });
}

// --------------------------------------------------------------------------
// Per-video subtitle timing offset. Stored per media (keyed by the video) so it
// resets to 0 on a new video but is restored when you come back. Values are
// tiny numbers, so this stays light even across many videos.
// --------------------------------------------------------------------------

const offsetKey = (mediaKey: string) => `tnm:offset:${mediaKey}`;

export async function loadOffset(mediaKey: string): Promise<number> {
  const key = offsetKey(mediaKey);
  const got = await area().get(key);
  const v = got[key];
  return typeof v === "number" && isFinite(v) ? v : 0;
}

export async function saveOffset(mediaKey: string, value: number): Promise<void> {
  const key = offsetKey(mediaKey);
  if (!value) await area().remove(key); // don't store the default
  else await area().set({ [key]: value });
}

// --------------------------------------------------------------------------
// Per-video persisted state so a reload restores exactly what you had: the loaded subtitle
// TRACK (which file you picked — not the auto default) and the mining QUEUE. Keyed by the same
// media identity as the offset. A track is ~15–30 KB of cues; the queue is a handful of items.
// --------------------------------------------------------------------------

const trackKey = (mediaKey: string) => `tnm:track:${mediaKey}`;
const queueMediaKey = (mediaKey: string) => `tnm:queue:${mediaKey}`;

export async function loadSavedTrack(mediaKey: string): Promise<SubtitleTrack | null> {
  const key = trackKey(mediaKey);
  const got = await area().get(key);
  const t = got[key] as SubtitleTrack | undefined;
  return t && Array.isArray(t.cues) && t.cues.length ? t : null;
}

export async function saveSavedTrack(mediaKey: string, track: SubtitleTrack | null): Promise<void> {
  const key = trackKey(mediaKey);
  if (!track || !track.cues?.length) await area().remove(key);
  else await area().set({ [key]: track });
}

export async function loadQueue(mediaKey: string): Promise<QueuedMine[]> {
  const key = queueMediaKey(mediaKey);
  const got = await area().get(key);
  const q = got[key];
  return Array.isArray(q) ? (q as QueuedMine[]) : [];
}

export async function saveQueue(mediaKey: string, items: QueuedMine[]): Promise<void> {
  const key = queueMediaKey(mediaKey);
  if (!items.length) await area().remove(key);
  else await area().set({ [key]: items });
}

// --------------------------------------------------------------------------
// Known words (per language). We only persist non-default statuses.
// --------------------------------------------------------------------------

export class KnownWordsStore {
  private map = new Map<string, KnownStatus>();
  private lang: string;
  private listeners = new Set<Listener<KnownWordsStore>>();

  constructor(lang: string) {
    this.lang = normalizeLang(lang);
  }

  async load(): Promise<void> {
    const key = knownKey(this.lang);
    const got = await area().get(key);
    const obj: Record<string, KnownStatus> = got[key] ?? {};
    this.map = new Map(Object.entries(obj));
    // React to edits from other tabs / the popup.
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[key]) return;
      const next: Record<string, KnownStatus> = changes[key].newValue ?? {};
      this.map = new Map(Object.entries(next));
      this.emit();
    });
  }

  get(dict: string): KnownStatus {
    return this.map.get(dict) ?? "UNKNOWN";
  }

  async set(dict: string, status: KnownStatus): Promise<void> {
    if (status === "UNKNOWN") this.map.delete(dict);
    else this.map.set(dict, status);
    await this.persist();
    this.emit();
  }

  /** Cycle UNKNOWN -> LEARNING -> KNOWN -> UNKNOWN (left-click). */
  async cycle(dict: string): Promise<KnownStatus> {
    const order: KnownStatus[] = ["UNKNOWN", "LEARNING", "KNOWN"];
    const cur = this.get(dict);
    const idx = order.indexOf(cur === "IGNORED" ? "KNOWN" : cur);
    const next = order[(idx + 1) % order.length];
    await this.set(dict, next);
    return next;
  }

  countKnown(): number {
    let n = 0;
    for (const v of this.map.values()) if (v === "KNOWN" || v === "IGNORED") n++;
    return n;
  }

  countLearning(): number {
    let n = 0;
    for (const v of this.map.values()) if (v === "LEARNING") n++;
    return n;
  }

  onChange(fn: Listener<KnownWordsStore>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this);
  }

  private async persist(): Promise<void> {
    const obj: Record<string, KnownStatus> = {};
    for (const [k, v] of this.map) obj[k] = v;
    await area().set({ [knownKey(this.lang)]: obj });
  }
}

// --------------------------------------------------------------------------
// Mined items — words (Expression lemmas) + sentences we've made Anki cards for.
// Global (one store) so it works across languages and can be backfilled from the
// Anki deck. Used to mark mined lines (browser ✓) and mined words.
// --------------------------------------------------------------------------

const MINED_KEY = "tnm:mined";
const RECENT_MINED_KEY = "tnm:mined-recent";

/** One entry in the dashboard's "recently mined" activity feed. */
export interface RecentMine {
  word: string;
  sentence: string;
  at: number;
}
export async function loadRecentMined(): Promise<RecentMine[]> {
  const got = await area().get(RECENT_MINED_KEY);
  const list = got[RECENT_MINED_KEY];
  return Array.isArray(list) ? (list as RecentMine[]) : [];
}

/** Normalize a sentence to a stable key: strip HTML (the card's <b>…</b>) + all
 *  whitespace, so a cue's text and the mined Sentence field compare equal. */
export function normMinedSentence(s: string): string {
  return (s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, "");
}

/** Overwrite the mined store. */
export async function writeMined(words: string[], sentences: string[]): Promise<void> {
  await area().set({
    [MINED_KEY]: {
      words: [...new Set(words.filter(Boolean))],
      sentences: [...new Set(sentences.map(normMinedSentence).filter(Boolean))],
    },
  });
}

/** Clear ALL local mined tracking. Does NOT touch Anki cards — re-sync to rebuild. */
export async function clearMined(): Promise<void> {
  await area().set({ [MINED_KEY]: { words: [], sentences: [] } });
}

/** Add to the mined store (union) — used by the Anki backfill so syncing a deck never
 *  drops tracking from other decks or from words mined incrementally via the ＋ button. */
export async function mergeMined(words: string[], sentences: string[]): Promise<void> {
  const cur = ((await area().get(MINED_KEY))[MINED_KEY] ?? {}) as { words?: string[]; sentences?: string[] };
  const w = new Set([...(cur.words ?? []), ...words.filter(Boolean)]);
  const s = new Set([...(cur.sentences ?? []), ...sentences.map(normMinedSentence).filter(Boolean)]);
  await area().set({ [MINED_KEY]: { words: [...w], sentences: [...s] } });
}

export class MinedStore {
  private words = new Set<string>();
  private sentences = new Set<string>();
  private listeners = new Set<Listener<MinedStore>>();

  async load(): Promise<void> {
    const got = await area().get(MINED_KEY);
    this.ingest(got[MINED_KEY]);
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[MINED_KEY]) return;
      this.ingest(changes[MINED_KEY].newValue);
      this.emit();
    });
  }

  private ingest(v: unknown): void {
    const o = (v ?? {}) as { words?: string[]; sentences?: string[] };
    this.words = new Set(Array.isArray(o.words) ? o.words : []);
    this.sentences = new Set(Array.isArray(o.sentences) ? o.sentences : []);
  }

  hasWord(lemma: string): boolean {
    return this.words.has(lemma);
  }
  hasSentence(text: string): boolean {
    return this.sentences.has(normMinedSentence(text));
  }
  count(): number {
    return this.words.size;
  }

  async add(lemma: string, sentence: string): Promise<void> {
    if (lemma) this.words.add(lemma);
    const ns = normMinedSentence(sentence);
    if (ns) this.sentences.add(ns);
    // Keep a small, time-stamped recent-mines log for the dashboard activity feed.
    const recent = await loadRecentMined();
    if (lemma) recent.unshift({ word: lemma, sentence: (sentence || "").replace(/<[^>]*>/g, "").trim().slice(0, 140), at: Date.now() });
    await area().set({
      [MINED_KEY]: { words: [...this.words], sentences: [...this.sentences] },
      [RECENT_MINED_KEY]: recent.slice(0, 40),
    });
    this.emit();
  }

  onChange(fn: Listener<MinedStore>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn(this);
  }
}
