import type {
  AnilistResolveResponse,
  AnkiMineResponse,
  AnkiProxyResponse,
  AnkiScreenshotResponse,
  AudioResponse,
  BgRequest,
  BgResponse,
  DictSection,
  DictSectionEntry,
  FrequencyInfo,
  JimakuResponse,
  KanjiInfo,
  LookupResult,
  LrclibHit,
  LrclibResponse,
  OnlineResponse,
  TranslateResponse,
} from "../common/types";
import { translateText } from "./translate";
import { normalizeLang } from "../lib/tokenizer";
import { loadSettings, mergeMined } from "../lib/storage";
import { expressionsExist, getMediaDataUrl, lookupFrequencies, lookupKanji, lookupPitch, lookupTerms, getTagsForDict } from "../lib/yomitan/db";
import { deinflect } from "../lib/deinflect";
import type { TermRecord } from "../lib/yomitan/types";
import { addCard, proxy as ankiProxy } from "../lib/anki/ankiconnect";
import { isNewerVersion } from "../lib/version";

// Dictionary lookups + audio run here (not the content script) so cross-origin
// fetches use the extension's host_permissions instead of the page's CORS rules,
// and so the extension-origin IndexedDB (populated by the options page) is shared.

chrome.runtime.onMessage.addListener((msg: BgRequest, _sender, sendResponse) => {
  if (msg?.type === "lookup") {
    lookup(msg.term, msg.surface, msg.reading, msg.candidates ?? [], msg.lang)
      .then((result) => sendResponse({ ok: true, result } satisfies BgResponse))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies BgResponse));
    return true; // async response
  }
  if (msg?.type === "lookupOnline") {
    withTimeout(lookupOnline(msg.term, msg.lang), 6000)
      .then((section) => sendResponse({ ok: true, section } satisfies OnlineResponse))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies OnlineResponse));
    return true;
  }
  if (msg?.type === "audio") {
    fetchPronunciation(msg.term, msg.reading, msg.lang)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl } satisfies AudioResponse))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies AudioResponse));
    return true;
  }
  if (msg?.type === "anki") {
    ankiProxy(msg.action, msg.params ?? {})
      .then((result) => sendResponse({ ok: true, result } satisfies AnkiProxyResponse))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies AnkiProxyResponse));
    return true;
  }
  if (msg?.type === "ankiScreenshot") {
    captureCrop(_sender, msg.rect, msg.dpr)
      .then((dataBase64) => sendResponse({ ok: true, dataBase64 } satisfies AnkiScreenshotResponse))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies AnkiScreenshotResponse));
    return true;
  }
  if (msg?.type === "ankiMine") {
    addCard(msg.card)
      .then((noteId) => sendResponse({ ok: true, noteId } satisfies AnkiMineResponse))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies AnkiMineResponse));
    return true;
  }
  if (msg?.type === "jimaku") {
    jimaku(msg)
      .then((result) => sendResponse({ ok: true, result } satisfies JimakuResponse))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies JimakuResponse));
    return true;
  }
  if (msg?.type === "lrclib") {
    lrclib(msg)
      .then((hits) => sendResponse({ ok: true, hits } satisfies LrclibResponse))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies LrclibResponse));
    return true;
  }
  if (msg?.type === "anilistResolve") {
    anilistResolve(msg)
      .then((r) => sendResponse({ ok: true, id: r.id, titles: r.titles } satisfies AnilistResolveResponse))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies AnilistResolveResponse));
    return true;
  }
  if (msg?.type === "dictMedia") {
    getMediaDataUrl(msg.dictId, msg.path)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true; // async response
  }
  if (msg?.type === "hasTerms") {
    expressionsExist(msg.terms ?? [])
      .then((found) => sendResponse({ ok: true, found }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }))
    return true; // async response
  }
  if (msg?.type === "translate") {
    translateText(msg.texts, msg.from, msg.to)
      .then((texts) => sendResponse({ ok: true, texts } satisfies TranslateResponse))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies TranslateResponse));
    return true; // async response
  }
  if (msg?.type === "autoSyncMined") {
    autoSyncMined().catch(() => {}); // fire-and-forget; failures (Anki down) retry next page
    return false;
  }
  if (msg?.type === "muteTab") {
    // Silence the tab's audible output during batch queue mining (the element still "plays" so
    // captureStream keeps recording the sentence audio — tab mute is downstream of the capture tap).
    const id = _sender.tab?.id;
    if (id != null) chrome.tabs.update(id, { muted: !!msg.on }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "checkUpdate") {
    checkForUpdate(false)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true;
  }
  return false;
});

// ============================================================ update check
// Compare the installed version against the repo's latest GitHub release. Cached (≤ every 6h)
// so opening the popup doesn't hammer the API; the toolbar icon gets a badge when one's available.
const UPDATE_REPO = "Filleee/tanma";
const UPDATE_KEY = "tnm:update";
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;

interface UpdateInfo {
  updateAvailable: boolean;
  latest: string | null;
  current: string;
  url: string;
}

async function checkForUpdate(force: boolean): Promise<UpdateInfo> {
  const current = chrome.runtime.getManifest().version;
  const cached = (await chrome.storage.local.get(UPDATE_KEY))[UPDATE_KEY] as { latest?: string | null; url?: string; at?: number } | undefined;
  let latest = cached?.latest ?? null;
  let url = cached?.url ?? `${RELEASES_URL}/latest`;
  const stale = !cached?.at || Date.now() - cached.at > UPDATE_CHECK_MS;
  if (force || stale) {
    try {
      const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (res.ok) {
        const j = (await res.json()) as { tag_name?: string; html_url?: string };
        latest = j.tag_name ?? null;
        url = j.html_url ?? `${RELEASES_URL}/latest`;
      } else if (res.status === 404) {
        latest = null; // no releases published yet
        url = RELEASES_URL;
      }
      await chrome.storage.local.set({ [UPDATE_KEY]: { latest, url, at: Date.now() } });
    } catch {
      /* offline / rate-limited — fall back to the cached value */
    }
  }
  const updateAvailable = !!latest && isNewerVersion(latest, current);
  try {
    await chrome.action.setBadgeText({ text: updateAvailable ? "↑" : "" });
    if (updateAvailable) await chrome.action.setBadgeBackgroundColor({ color: "#ff9345" });
  } catch {
    /* action badge unavailable */
  }
  return { updateAvailable, latest, current, url };
}

chrome.runtime.onStartup?.addListener(() => checkForUpdate(true).catch(() => {}));
chrome.runtime.onInstalled?.addListener(() => checkForUpdate(true).catch(() => {}));

// On startup, pull the mined tracking from the configured deck(s) so each browser
// reflects what's in Anki (cross-device sync lives in Anki/AnkiWeb, not chrome.storage).
let autoSyncOk = false;
let autoSyncAt = 0;
async function autoSyncMined(): Promise<void> {
  if (autoSyncOk) return; // already synced this service-worker session
  const s = await loadSettings();
  if (!s.ankiEnabled || !s.ankiAutoSyncMined) return;
  const decks = s.ankiSyncDecks?.length ? s.ankiSyncDecks : s.ankiDeck ? [s.ankiDeck] : [];
  if (!decks.length) return;
  if (Date.now() - autoSyncAt < 60_000) return; // don't hammer AnkiConnect while it's down
  autoSyncAt = Date.now();
  try {
    const query = decks.map((d) => `deck:"${d.replace(/"/g, "")}"`).join(" OR ");
    const ids = (await ankiProxy("findNotes", { query })) as number[];
    const infos = (await ankiProxy("notesInfo", { notes: ids })) as { fields?: Record<string, { value: string }> }[];
    const words: string[] = [];
    const sentences: string[] = [];
    for (const n of infos) {
      const exp = n.fields?.Expression?.value?.replace(/<[^>]*>/g, "").trim();
      const sen = n.fields?.Sentence?.value;
      if (exp) words.push(exp);
      if (sen) sentences.push(sen);
    }
    await mergeMined(words, sentences);
    autoSyncOk = true; // succeeded — stop retrying this session
    console.info(`[tnm] auto-synced mined tracking: ${infos.length} cards from ${decks.length} deck(s)`);
  } catch {
    /* AnkiConnect unreachable (Anki not open yet) — leave autoSyncOk false to retry */
  }
}
chrome.runtime.onStartup?.addListener(() => autoSyncMined().catch(() => {}));

// ============================================================ jimaku.cc proxy
// Runs in the background so the Authorization header + cross-origin fetch work
// (host_permissions cover jimaku.cc; a page can't add auth headers cross-origin).
const JIMAKU_API = "https://jimaku.cc/api";

async function jimaku(msg: Extract<BgRequest, { type: "jimaku" }>): Promise<unknown> {
  const key = (await loadSettings()).jimakuApiKey?.trim();
  if (!key) throw new Error("No Jimaku API key — set it in the extension's Options page.");
  const headers = { Authorization: key };

  if (msg.action === "download") {
    if (!msg.url) throw new Error("missing url");
    // Only attach the key for jimaku.cc itself; file URLs may be public/presigned.
    const auth = /(^|\.)jimaku\.cc$/i.test(safeHost(msg.url)) ? headers : undefined;
    const res = await fetch(msg.url, auth ? { headers: auth } : undefined);
    if (!res.ok) throw new Error(`download ${res.status}`);
    return res.text();
  }

  let url = "";
  if (msg.action === "search") {
    // Jimaku accepts anilist_id (exact) and/or query (title). Prefer the id when present.
    const qs = new URLSearchParams();
    if (msg.anilistId) qs.set("anilist_id", String(msg.anilistId));
    if (msg.query) qs.set("query", msg.query);
    if (![...qs.keys()].length) throw new Error("jimaku search needs a title or AniList id");
    url = `${JIMAKU_API}/entries/search?${qs.toString()}`;
  } else if (msg.action === "files") {
    url = `${JIMAKU_API}/entries/${msg.entryId}/files`;
  }
  if (!url) throw new Error("bad jimaku action");
  const res = await fetch(url, { headers });
  if (res.status === 401) throw new Error("Jimaku rejected the API key (check it in Options).");
  if (!res.ok) throw new Error(`jimaku ${res.status}`);
  return res.json();
}

// ============================================================ LRCLIB proxy
// Free, open, key-less time-synced lyrics DB. Runs in the background so the cross-origin
// fetch works (host_permissions cover it). Search results already include the LRC, so one
// call is enough — no separate "get".
const LRCLIB_API = "https://lrclib.net/api";

async function lrclib(msg: Extract<BgRequest, { type: "lrclib" }>): Promise<LrclibHit[]> {
  const qs = new URLSearchParams();
  // Structured (track+artist) is more precise; fall back to a free-text q.
  if (msg.trackName) qs.set("track_name", msg.trackName);
  if (msg.artistName) qs.set("artist_name", msg.artistName);
  if (msg.q && !qs.has("track_name")) qs.set("q", msg.q);
  if (![...qs.keys()].length) throw new Error("lrclib search needs a query");
  const res = await fetch(`${LRCLIB_API}/search?${qs.toString()}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`lrclib ${res.status}`);
  const arr = (await res.json()) as LrclibHit[];
  return Array.isArray(arr) ? arr : [];
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

// Resolve an AniList (or MAL) id to the canonical AniList id plus its titles via
// AniList's public GraphQL (no key needed). The romaji/native/synonym titles are the
// Jimaku title-search fallbacks, since Jimaku indexes those — not English titles —
// and an entry may exist without being tagged with the anilist_id.
async function anilistResolve(opts: { anilistId?: number; malId?: number }): Promise<{ id: number | null; titles: string[] }> {
  const byMal = !opts.anilistId && !!opts.malId;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query: byMal
        ? "query($m:Int){Media(idMal:$m,type:ANIME){id title{romaji native english} synonyms}}"
        : "query($id:Int){Media(id:$id,type:ANIME){id title{romaji native english} synonyms}}",
      variables: byMal ? { m: opts.malId } : { id: opts.anilistId },
    }),
  });
  if (!res.ok) throw new Error(`anilist ${res.status}`);
  const json = (await res.json()) as {
    data?: { Media?: { id?: number; title?: { romaji?: string; native?: string; english?: string }; synonyms?: string[] } };
  };
  const m = json?.data?.Media;
  if (!m) return { id: null, titles: [] }; // no such anime — let the caller drop the candidate id
  const raw = [m.title?.romaji, m.title?.native, m.title?.english, ...(m.synonyms ?? []).slice(0, 2)];
  const titles = [...new Set(raw.filter((t): t is string => !!t && t.trim().length >= 2))];
  return { id: m.id ?? null, titles };
}

// ============================================================ screenshot

/** Capture the visible tab and crop to the video's rect (CSS px × dpr). Returns base64 JPEG. */
async function captureCrop(
  sender: chrome.runtime.MessageSender,
  rect: { x: number; y: number; width: number; height: number },
  dpr: number,
): Promise<string> {
  const windowId = sender.tab?.windowId;
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId as number, { format: "jpeg", quality: 92 });
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(bmp.width - sx, Math.round(rect.width * dpr));
  const sh = Math.min(bmp.height - sy, Math.round(rect.height * dpr));
  if (sw < 2 || sh < 2) throw new Error("video not visible for screenshot");
  // Downscale to a long edge of ~640px (it only displays at ~480 on the card) so
  // cards stay small — a full-res frame is needlessly heavy.
  const scale = Math.min(1, 640 / sw, 640 / sh);
  const canvas = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return blobToBase64(out);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

// ============================================================ merged lookup

/** Offline lookup only — fast, so the popup renders instantly. Online is fetched
 *  separately (lookupOnline) and appended by the popup. */
async function lookup(term: string, surface: string, reading: string, candidates: string[] = [], lang = "ja"): Promise<LookupResult> {
  // Reading-based matching ONLY for kana-only input (Yomitan's rule): a kana word must find
  // its kanji headword via the reading (ください→下さい), but for kanji input the reading key
  // would drag in every homophone (奥 would also list 億 and 置く via おく).
  const kanaOnly = !/[一-龯㐀-䶿々]/.test(term + surface);
  // Yomitan-style deinflection (ported rule table): try dictionary forms of the raw
  // surface AND of each compound candidate's tail (歳食っちゃい → 歳食う), catching
  // conjugations kuromoji mis-lemmatizes. Same-form results just dedupe.
  const surfaceForms = normalizeLang(lang) === "ja" ? deinflect(surface) : [];
  const candidateForms = normalizeLang(lang) === "ja" ? candidates.flatMap((c) => deinflect(c)) : [];
  const allCandidates = [...new Set([...candidates, ...candidateForms])];
  const keys = [term, surface, kanaOnly ? reading : "", ...surfaceForms, ...allCandidates].filter(Boolean);
  // The clicked word's written forms (NOT its reading) — entries whose expression is one
  // of these are real matches; entries that only share the reading are homophones and rank lower.
  const exprKeys = new Set([term, surface, ...surfaceForms, ...allCandidates].filter(Boolean));
  // Include candidate chars so a matched compound's kanji (都 in 王都) get info rows too.
  const chars = [...new Set((surface + term + candidates.join("")).split(""))];
  // The token's reading disambiguates homophone dictionary forms (港→こう vs みなと) ONLY
  // when the word is uninflected — then the surface reading IS a dictionary reading. For a
  // conjugated word (足らない→足る) the surface reading is the CONJUGATED reading (タラナイ),
  // which would wrongly favour a surface-form entry that happens to exist (足らない
  // "insufficient") over the real lemma (足る "to be sufficient", read タル). So drop it.
  const matchReading = surface === term ? reading : "";
  const offline = await lookupOffline(keys, chars, exprKeys, matchReading, allCandidates).catch((e) => {
    console.warn("[tnm] offline lookup failed", e);
    return { sections: [] as DictSection[], frequencies: [] as FrequencyInfo[], kanji: [] as KanjiInfo[], primaryReading: "", readings: [] as string[], matchedTerm: "", pitches: [] };
  });
  // Prefer the matched entry's reading (the lemma reading おもう / the in-context reading
  // こう) over the conjugated surface reading the token carried (おもいます).
  // For a compound match (歳食う) the primary IS the compound's reading (としくう).
  const reading0 = offline.primaryReading || matchReading;
  // Put the auto-picked reading first, then the other candidates (for the manual switcher).
  const readings = [...new Set([reading0, ...offline.readings].filter(Boolean))];
  return {
    term,
    reading: reading0,
    readings,
    matchedTerm: offline.matchedTerm || undefined,
    pitches: offline.pitches,
    frequencies: offline.frequencies,
    sections: offline.sections,
    kanji: offline.kanji,
  };
}

async function lookupOffline(
  keys: string[],
  chars: string[],
  exprKeys: Set<string>,
  reading: string,
  candidates: string[] = [],
): Promise<{ sections: DictSection[]; frequencies: FrequencyInfo[]; kanji: KanjiInfo[]; primaryReading: string; readings: string[]; matchedTerm: string; pitches: { reading: string; positions: number[] }[] }> {
  const [{ enabled, terms }, freqs, kanjiRecs, pitchRecs] = await Promise.all([
    lookupTerms(keys),
    lookupFrequencies(keys),
    lookupKanji(chars),
    lookupPitch(keys),
  ]);

  // Compound candidates (歳食う built from 歳+食う): the LONGEST one with a real entry
  // wins the headword, Yomitan-style. Non-candidate expression matches rank as before.
  const candSet = new Set(candidates);
  const candRank = (expr: string): number => (candSet.has(expr) ? -expr.length : 0);

  // The reading to show / mine: the dictionary's reading for the clicked word — the
  // in-context reading (港→こう vs みなと, picked by matching the token's contextual
  // reading first) else the highest-scored sense. NOT the conjugated surface reading.
  const exprMatches = terms
    .filter((t) => exprKeys.has(t.expression))
    .sort((a, b) => {
      const ca = candRank(a.expression);
      const cb = candRank(b.expression);
      if (ca !== cb) return ca - cb; // longer compound match first
      const ra = reading && a.reading === reading ? 0 : 1;
      const rb = reading && b.reading === reading ? 0 : 1;
      if (ra !== rb) return ra - rb;
      if (a.score !== b.score) return b.score - a.score;
      return a.sequence - b.sequence;
    });
  const primary = exprMatches[0];
  const primaryReading = primary?.reading ?? "";
  const matchedTerm = primary && candSet.has(primary.expression) ? primary.expression : "";
  // Pitch accents for the SHOWN word (the primary expression), grouped per reading.
  const pitchByReading = new Map<string, number[]>();
  for (const r of pitchRecs) {
    if (primary && r.expression !== primary.expression) continue;
    const arr = pitchByReading.get(r.reading) ?? [];
    for (const pt of r.pitches) if (!arr.includes(pt.position)) arr.push(pt.position);
    pitchByReading.set(r.reading, arr);
  }
  const pitches = [...pitchByReading.entries()].map(([rd, positions]) => ({ reading: rd, positions }));
  // Distinct readings (best first) OF THE PRIMARY EXPRESSION, for the manual switcher —
  // a compound's readings shouldn't mix with the single word's.
  const readings = [
    ...new Set(exprMatches.filter((t) => t.expression === primary?.expression).map((t) => t.reading).filter(Boolean)),
  ];

  // Yomitan behavior: a matched longer expression REPLACES the clicked word — only the
  // compound's entries are shown (王都 doesn't also list 王/オオキミ). Clicking the other
  // token, or turning "Match multi-word expressions" off, still gives the standalone word.
  const shownTerms = matchedTerm ? terms.filter((t) => t.expression === matchedTerm) : terms;

  // group term entries by dictionary, ordered by the user's dictionary order
  const byDict = new Map<number, TermRecord[]>();
  for (const t of shownTerms) (byDict.get(t.dictId) ?? byDict.set(t.dictId, []).get(t.dictId)!).push(t);
  const orderedDictIds = [...byDict.keys()].sort(
    (a, b) => (enabled.get(a)?.order ?? 0) - (enabled.get(b)?.order ?? 0),
  );

  const sections: DictSection[] = [];
  for (const dictId of orderedDictIds) {
    const tagsMap = await getTagsForDict(dictId);
    const resolveTags = (s: string): string[] =>
      s
        .split(/\s+/)
        .filter(Boolean)
        .map((name) => tagsMap.get(name)?.notes || name);
    // Priority = the entry carries a "popular"/priority tag (JMdict P, ichi1, …), the
    // signal Yomitan shows as "high priority entry".
    const isPriority = (t: TermRecord): boolean =>
      `${t.termTags} ${t.defTags}`.split(/\s+/).filter(Boolean).some((name) => {
        const tag = tagsMap.get(name);
        return !!tag && (tag.category === "popular" || /priorit/i.test(tag.notes));
      });
    // Order within the dictionary so the most relevant sense is first: real
    // expression-matches before reading-only homophones; then the sense whose reading
    // matches the word's IN-CONTEXT reading (港→こう keeps the suffix sense on top in
    // 神浦港, みなと when standalone); then priority entries; then Yomitan's score
    // (higher = more common); then stable by sequence.
    const rank = (t: TermRecord): number[] =>
      [candRank(t.expression), exprKeys.has(t.expression) ? 0 : 1, reading && t.reading === reading ? 0 : 1, isPriority(t) ? 0 : 1, -t.score, t.sequence];
    const sorted = byDict.get(dictId)!.slice().sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return 0;
    });
    // Group rows that are the SAME dictionary entry (same JMdict sequence + reading —
    // kanji variants like 歳/才, or duplicate rows across query keys): merge their
    // glossaries instead of listing the entry twice (Yomitan's "merge" behavior, light).
    const grouped: TermRecord[] = [];
    const bySeq = new Map<string, TermRecord>();
    for (const t of sorted) {
      const key = t.sequence > 0 ? `${t.sequence}:${t.reading}` : `row#${grouped.length}`;
      const prev = bySeq.get(key);
      if (prev) {
        const seen = new Set(prev.glossary.map((g) => JSON.stringify(g)));
        for (const g of t.glossary) if (!seen.has(JSON.stringify(g))) prev.glossary.push(g);
        continue;
      }
      const copy = { ...t, glossary: [...t.glossary] };
      bySeq.set(key, copy);
      grouped.push(copy);
    }
    const entries: DictSectionEntry[] = grouped.map((t) => ({
      reading: t.reading,
      tags: [...new Set([...resolveTags(t.defTags), ...resolveTags(t.termTags)])].slice(0, 8),
      glossary: t.glossary,
    }));
    sections.push({ dictTitle: enabled.get(dictId)?.title ?? "Dictionary", source: "imported", dictId, entries });
  }

  // frequencies: dedupe per dictionary, most-frequent first
  const freqByDict = new Map<number, FrequencyInfo>();
  const shownFreqs = matchedTerm ? freqs.filter((f) => f.expression === matchedTerm) : freqs;
  for (const f of shownFreqs) {
    const title = enabled.get(f.dictId)?.title ?? "freq";
    const cur = freqByDict.get(f.dictId);
    if (!cur || f.value < cur.value) freqByDict.set(f.dictId, { dict: title, display: f.display, value: f.value });
  }
  const frequencies = [...freqByDict.values()].sort((a, b) => a.value - b.value);

  const kanji: KanjiInfo[] = kanjiRecs.map((k) => ({
    character: k.character,
    onyomi: k.onyomi,
    kunyomi: k.kunyomi,
    meanings: k.meanings,
    stats: k.stats,
    dict: enabled.get(k.dictId)?.title ?? "",
  }));

  return { sections, frequencies, kanji, primaryReading, readings, matchedTerm, pitches };
}

// ============================================================ online sources

async function lookupOnline(term: string, lang: string): Promise<DictSection | null> {
  return normalizeLang(lang) === "ja" ? lookupJisho(term) : lookupWiktionary(term, normalizeLang(lang));
}

async function lookupJisho(term: string): Promise<DictSection | null> {
  const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(term)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jisho ${res.status}`);
  const json: any = await res.json();
  const data: any[] = (json?.data ?? []).slice(0, 5);
  if (!data.length) return null;
  const entries: DictSectionEntry[] = data.map((d) => {
    const jp = d.japanese?.[0] ?? {};
    const glossary = (d.senses ?? []).slice(0, 8).map((s: any) => (s.english_definitions ?? []).join("; "));
    return {
      reading: jp.reading ?? "",
      tags: d.senses?.[0]?.parts_of_speech ?? [],
      glossary,
    };
  });
  return { dictTitle: "Jisho", source: "jisho", entries };
}

const WIKT_LANG_NAMES: Record<string, string> = {
  ko: "Korean", zh: "Chinese", es: "Spanish", fr: "French", de: "German",
  pt: "Portuguese", it: "Italian", ru: "Russian", en: "English",
};

async function lookupWiktionary(term: string, lang: string): Promise<DictSection | null> {
  const url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(term)}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Wiktionary ${res.status}`);
  }
  const json: any = await res.json();
  const wantName = WIKT_LANG_NAMES[lang];
  const groups: any[] = Object.values(json).flat() as any[];
  const matched = wantName ? groups.filter((g) => g.language === wantName) : groups;
  const use = (matched.length ? matched : groups).slice(0, 4);
  if (!use.length) return null;
  const entries: DictSectionEntry[] = use.map((g) => ({
    reading: "",
    tags: g.partOfSpeech ? [g.partOfSpeech] : [],
    glossary: (g.definitions ?? []).slice(0, 8).map((def: any) => stripHtml(def.definition ?? "")).filter(Boolean),
  }));
  return { dictTitle: "Wiktionary", source: "wiktionary", entries };
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ==================================================== word audio (JapanesePod101)

const JPOD_PLACEHOLDER_BYTES = 52288; // size of the "no recording" placeholder clip

async function fetchPronunciation(term: string, reading: string, lang: string): Promise<string | null> {
  const s = await loadSettings();
  // 1) JapanesePod101 — real human audio, best when it exists (JA only).
  if (s.audioJpod101 !== false && normalizeLang(lang) === "ja") {
    const jpod = await fetchJpod101(term, reading).catch(() => null);
    if (jpod) return jpod;
  }
  // 2) Custom source — a user-provided URL template ({term}/{reading}), e.g. a local
  //    Forvo/NHK audio server. Must answer with an audio/* body.
  if (s.audioCustomUrl) {
    const custom = await fetchCustomAudio(s.audioCustomUrl, term, reading).catch(() => null);
    if (custom) return custom;
  }
  // 3) Google Translate TTS — neural quality (far better than Web Speech), and it
  //    covers everything the above miss (names like 長崎, rare words). Read here in
  //    the background, so CORS doesn't apply (host_permissions).
  if (s.audioGoogleTts !== false) {
    const tts = await fetchGoogleTts(reading || term).catch(() => null);
    if (tts) return tts;
  }
  return null; // content falls back to Web Speech TTS for the 🔊 button only
}

async function fetchCustomAudio(template: string, term: string, reading: string): Promise<string | null> {
  const url = template.replaceAll("{term}", encodeURIComponent(term)).replaceAll("{reading}", encodeURIComponent(reading || term));
  const res = await fetch(url);
  if (!res.ok) return null;
  const type = res.headers.get("content-type") ?? "";
  const buf = await res.arrayBuffer();
  if (!/audio|octet-stream/.test(type) || buf.byteLength < 200) return null;
  return `data:${/audio/.test(type) ? type.split(";")[0] : "audio/mpeg"};base64,${bufToB64(buf)}`;
}

async function fetchJpod101(term: string, reading: string): Promise<string | null> {
  const url =
    "https://assets.languagepod101.com/dictionary/japanese/audiomp3.php" +
    `?kanji=${encodeURIComponent(term)}&kana=${encodeURIComponent(reading || term)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength === JPOD_PLACEHOLDER_BYTES || buf.byteLength < 200) return null; // "no recording" placeholder
  return `data:audio/mpeg;base64,${arrayBufferToBase64(buf)}`;
}

async function fetchGoogleTts(text: string): Promise<string | null> {
  const t = (text || "").trim().slice(0, 200);
  if (!t) return null;
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=ja&client=tw-ob&q=${encodeURIComponent(t)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 200) return null;
  return `data:audio/mpeg;base64,${arrayBufferToBase64(buf)}`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}

function bufToB64(buf: ArrayBuffer): string {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
