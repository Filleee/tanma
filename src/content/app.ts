import type {
  ActivationRule,
  AnilistResolveResponse,
  AnkiMineResponse,
  AnkiScreenshotResponse,
  AudioResponse,
  BgResponse,
  Cue,
  DictSection,
  JimakuEntry,
  JimakuFile,
  JimakuResponse,
  KnownStatus,
  HasTermsResponse,
  LookupResult,
  LrclibHit,
  LrclibResponse,
  QueuedMine,
  MediaHint,
  OnlineResponse,
  Settings,
  SubtitleTrack,
  Token,
  TranslateResponse,
  YtCaptionTrack,
} from "../common/types";
import { buildLapisFields } from "../lib/anki/fields";
import { loadSettings, saveHostSettings, loadOffset, saveOffset, loadSavedTrack, saveSavedTrack, loadQueue, saveQueue, GLOBAL_SETTINGS_KEY, hostSettingsKey, KnownWordsStore, MinedStore, migrateLegacyKeys } from "../lib/storage";
import { initTokenizer, normalizeLang, tokenize } from "../lib/tokenizer";
import { parseSubtitleFile, parseYoutubeTimedText, normalizeCues, parseLrc } from "../lib/parsers";
import { guessSong } from "../lib/lyrics/song";
import { alignSecondaryToTarget } from "../lib/parsers/align";
import { episodeFromUrl, bestEpisodeFile, searchAttempts } from "../lib/jimaku/episode";
import { ShadowHost } from "./ui/host";
import { VideoManager } from "./videoManager";
import { YoutubeDock } from "./youtubeDock";
import { TnmSubs } from "./ui/TnmSubs";
import { TnmBar } from "./ui/TnmBar";
import { SettingsPanel } from "./ui/SettingsPanel";
import { TnmBrowser } from "./ui/TnmBrowser";
import { JimakuPanel } from "./ui/JimakuPanel";
import { LyricsPanel } from "./ui/LyricsPanel";
import { QueuePanel, type QueueRow } from "./ui/QueuePanel";
import { LookupPopup } from "./ui/LookupPopup";
import { renderSentence, refreshTokenStatuses, tokenContextOf } from "./ui/tokens";
import { buildCandidates } from "../lib/compound";
import { mergeCompoundTokens } from "../lib/mergeTokens";
import { pitchFields } from "../lib/pitch";
import { frameSend, topWindow, type FrameMsg } from "./frameBus";
import { renderGlossary, yomitanGlossary } from "./ui/structured";
import { el } from "./ui/dom";
import { audioBlobToMp3Base64 } from "./mp3";
import { applyAccentVars } from "../lib/theme";

/** Inline cap so mined Picture media isn't huge on the card (works on any deck). */
const MEDIA_STYLE = "max-width:480px;max-height:360px;height:auto";


/** First id captured by `re` from any anchor href on the page (AniList/MAL link). */
function matchIdFromLinks(re: RegExp): number | undefined {
  for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const m = a.getAttribute("href")?.match(re);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** Sites like miruro embed the AniList id in the watch URL (`/watch/<id>/<slug>`). Take the
 *  first standalone 1–6 digit path segment as a candidate (validated against AniList later,
 *  so a non-AniList number just resolves to nothing). Used when no DOM AniList link exists. */
function anilistIdFromUrl(href: string): number | undefined {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  for (const seg of u.pathname.split("/")) {
    if (/^\d{1,6}$/.test(seg)) return Number(seg);
  }
  return undefined;
}

/** A title fallback for sites with no AniList/MAL link — og:title, then a cleaned <title>. */
function detectPageTitle(): string | undefined {
  const og = document.querySelector<HTMLMetaElement>('meta[property="og:title"], meta[name="og:title"]')?.content?.trim();
  let t = og || document.title || "";
  t = t.replace(/^\s*(watch|stream)\s+(online\s+)?/i, ""); // "Watch X" / "Stream X" → "X"
  // Strip trailing site/episode noise: " - Episode 12", " | Site", " - Watch online".
  t = t.replace(/\s*[-|–·:]\s*(episode\s*\d+|ep\.?\s*\d+|watch.*|sub.*|dub.*|stream.*|english.*)$/i, "").trim();
  t = t.replace(/\s*[-|–·:]\s*[^-|–·:]{1,30}$/i, (m) => (/\d/.test(m) ? "" : m)).trim(); // drop a trailing " - 12"
  t = t.replace(/[.\s]+$/, "").trim(); // trailing period(s)/space from "...Detective."
  return t.length >= 2 ? t : undefined;
}

/** Width (px) the floating subtitle browser occupies on the right edge — matches
 *  `.TnmBrowser { width }` in overlay.css. In fullscreen we shrink the video
 *  by this much so the panel sits beside it instead of covering it. */
const BROWSER_DOCK_WIDTH = 340;

/** Short language codes → BCP-47 tags for the TTS fallback. */
const SPEECH_LANG: Record<string, string> = {
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN",
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  pt: "pt-PT",
  it: "it-IT",
  ru: "ru-RU",
};

export class App {
  private host = new ShadowHost();
  private video = new VideoManager();
  private settings!: Settings;
  private known!: KnownWordsStore;
  private mined = new MinedStore();

  private overlay!: TnmSubs;
  private toolbar!: TnmBar;
  private settingsPanel!: SettingsPanel;
  private browser!: TnmBrowser;
  private jimakuPanel!: JimakuPanel;
  private lyricsPanel!: LyricsPanel;
  private queuePanel!: QueuePanel;
  /** Words tagged while watching, mined later in a batch (see mineQueueAll). */
  private mineQueue: QueuedMine[] = [];
  private queueMining = false;
  /** The persist-key whose saved subtitle track we've restored — auto-load skips it so a reload
   *  keeps the file you actually picked instead of re-selecting the default. */
  private restoredTrackKey = "";
  /** True while adopting a track pushed from another frame — suppresses re-broadcasting it. */
  private adoptingRemote = false;
  /** The top frame's URL/title, relayed so a player-iframe app can detect the real show. */
  private topPageInfo: { href: string; title?: string } | null = null;
  /** Sub-frames (player iframes) that have registered with this (top) frame — we push track
   *  and page-identity updates straight to them, bypassing any intermediate frames. */
  private frameClients = new Set<Window>();
  private lookup = new LookupPopup();
  private dock = new YoutubeDock();

  private targetTrack: SubtitleTrack | null = null;
  /** The media the current target track was loaded for, so we can drop it when the media changes. */
  private targetTrackMediaKey: string | null = null;
  /** The <video> the current target track was loaded for — streaming sites swap the player or its
   *  source on an episode change, sometimes without changing the URL we can see. */
  private targetTrackVideo: HTMLVideoElement | null = null;
  /** Last source URL seen on the current <video>, to spot an episode change that reuses the element. */
  private lastVideoSrc = "";
  /** Notifies the standalone player when the active target track changes (so its embedded-track
   *  selector can reflect a Jimaku/imported source taking over, and switch back). */
  onTrackChange?: (track: SubtitleTrack | null) => void;
  /** Whether the loaded YouTube target track is auto-generated (asr); manual wins. */
  private targetTrackAsr = false;
  private secondaryTrack: SubtitleTrack | null = null;
  /** True when our own machine translation drives the secondary line (no track-based translation). */
  private mtOn = false;
  /** Target-line text → its machine translation, filled lazily as you watch. */
  private mtCache = new Map<string, string>();
  private mtPending = new Set<string>();
  private bookmarks = new Set<number>();
  private mediaKey = location.href;
  private lastUrl = location.href;
  /** Set once the extension context is invalidated (the extension was reloaded or auto-updated
   *  while this page stayed open). Any chrome.* call then throws "Extension context invalidated",
   *  so we stop our loops and go quiet — a page reload re-injects a fresh content script. */
  private dead = false;
  private urlTimer = 0;

  private currentVideo: HTMLVideoElement | null = null;
  private activeTargetId = -1;
  private targetHint = 0;
  private secondaryHint = 0;

  // pause-mode bookkeeping
  private armedCueId = -1;
  private pausedForCueId = -1;
  private resumeTimer = 0;

  // youtube
  private ytTracks: YtCaptionTrack[] = [];
  private ytVideoId = "";
  private captionHintTimer = 0;

  async start(): Promise<void> {
    await migrateLegacyKeys(); // carry over data saved by older builds (once per browser)
    this.settings = await loadSettings(location.hostname); // global ⊕ this site's per-site settings
    this.settings.subOffset = 0; // timing offset is per-video, loaded below — never global
    this.known = new KnownWordsStore(this.settings.targetLang);
    await this.known.load();
    this.known.onChange(() => this.onKnownChanged());
    await this.mined.load();
    this.mined.onChange(() => this.onMinedChanged());

    this.buildUi();
    this.applyTheme();
    this.updateActive(); // hide the UI on excluded pages (e.g. youtube.com home, not /watch)

    // Live-sync settings edited elsewhere (the popup, the options page, or another
    // tab) — either the global record or THIS site's per-site record.
    const myHostKey = hostSettingsKey(location.hostname);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!changes[GLOBAL_SETTINGS_KEY] && !changes[myHostKey]) return;
      this.onSettingsRecordsChanged();
    });

    this.video.onChange((v) => this.onVideoChanged(v));
    this.onVideoChanged(this.video.current);
    this.refreshOffsetForMedia(); // load this page/video's saved offset (default 0)

    // If we're a player iframe, register with the top frame and pull its page identity + any
    // already-loaded track — directly, so it works even when an intermediate embed frame
    // doesn't relay. Retry until the identity arrives (the top app may boot after us).
    if (!this.isTopFrame()) {
      const top = topWindow();
      const ask = () => {
        frameSend(top, "requestPageInfo", {});
        frameSend(top, "requestTrack", {});
      };
      ask();
      let tries = 0;
      const iv = window.setInterval(() => {
        if (this.topPageInfo || ++tries > 12) window.clearInterval(iv);
        else ask();
      }, 1000);
    }

    // If the extension is reloaded/updated while this page is open, our context dies and any
    // in-flight chrome.* call rejects with "Extension context invalidated". Swallow those stray
    // rejections (instead of spamming the page console) and tear down cleanly.
    window.addEventListener("unhandledrejection", (e) => {
      const msg = String((e.reason && e.reason.message) || e.reason || "");
      if (msg.includes("Extension context invalidated") || msg.includes("context invalidated")) {
        e.preventDefault();
        this.teardown();
      }
    });

    window.addEventListener("message", (e) => this.onWindowMessage(e));
    // Reveal the docked toolbar when the mouse is near the top of the video.
    document.addEventListener(
      "mousemove",
      (e) => {
        this.lastMouse = { x: e.clientX, y: e.clientY };
        const v = this.currentVideo;
        if (!v) return;
        const r = v.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 8 && e.clientY <= r.top + 120) {
          this.lastTopHover = performance.now();
        }
      },
      true,
    );
    this.installDismiss();
    this.installHotkeys();
    this.installExternalPopupPause();

    if (normalizeLang(this.settings.targetLang) === "ja") this.warmTokenizer();

    // Ask the background to pull mined tracking from Anki (it dedups across tabs and
    // only acts when auto-sync is on + Anki is reachable) — keeps browsers in sync.
    if (this.settings.ankiEnabled && this.settings.ankiAutoSyncMined) {
      chrome.runtime.sendMessage({ type: "autoSyncMined" }).catch(() => {});
    }

    // Restore what a previous session had for this media — the mining queue and the subtitle
    // file you picked — BEFORE auto-load, so it keeps your pick instead of the default.
    await this.restorePersistedForMedia().catch(() => {});

    // Auto-load Jimaku subs for this anime page, and re-run on SPA navigation (sites like
    // miruro change ?ep= / the show without a full reload). The DOM/links may render after
    // us, so retry shortly; the per-key dedupe makes repeats cheap.
    this.autoLoadJimakuForPage().catch(() => {});
    window.setTimeout(() => this.autoLoadJimakuForPage().catch(() => {}), 2500);
    // React to navigation the instant it happens — browser back/forward (popstate) and hash
    // routing (hashchange). The 1s poll below is only a fallback for SPA history.pushState,
    // which fires no event we can see from here.
    window.addEventListener("popstate", () => this.onUrlMaybeChanged());
    window.addEventListener("hashchange", () => this.onUrlMaybeChanged());
    this.urlTimer = window.setInterval(() => this.onUrlMaybeChanged(), 1000);

    requestAnimationFrame(this.tick);
  }

  // ----------------------------------------------------------------- UI setup
  private buildUi(): void {
    this.overlay = new TnmSubs(this.settings.overlayPosition);
    this.overlay.setSize(this.settings.subtitleSize);
    this.overlay.setContrast(this.settings.subtitleShadow, this.settings.subtitleBackground);
    this.overlay.onReposition = (f) => this.patch({ overlayPosition: f });
    this.overlay.onHover = (over) => (over ? this.onRegionEnter() : this.onRegionLeave());

    this.toolbar = new TnmBar({
      onToggleEnabled: () => this.patch({ enabled: !this.settings.enabled }),
      onPrev: () => this.jumpCue(-1),
      onReplay: () => this.replayCue(),
      onPlayPause: () => this.togglePlay(),
      onNext: () => this.jumpCue(1),
      onToggleBrowser: () => this.patch({ browserOpen: !this.settings.browserOpen }),
      onToggleSettings: () => this.toggleSettings(),
      onToggleHide: () =>
        this.patch({ hideTarget: this.settings.hideTarget === "off" ? "hide" : "off" }),
      onImport: () => this.importFile(),
      onJimaku: () => this.jimakuPanel.toggle(),
      onLyrics: () => this.lyricsPanel.toggle(),
      onToggleQueue: () => this.toggleQueuePanel(),
      onSetOffset: (v) => this.patch({ subOffset: v }),
    });
    this.toolbar.setOffsetValue(this.settings.subOffset);

    this.settingsPanel = new SettingsPanel(this.settings, (p) => this.patch(p));
    this.browser = new TnmBrowser({
      // The browser passes a SUBTITLE cue time; the video must land at that time PLUS the
      // timing offset (else jumping to a line with an offset set lands at the wrong spot).
      onSeek: (t) => this.seek(t + this.settings.subOffset),
      onToggleBookmark: (id) => this.toggleBookmark(id),
      onSyncOffset: (cueStart) => this.syncOffsetToCue(cueStart),
      onClose: () => this.patch({ browserOpen: false }),
      isBookmarked: (id) => this.bookmarks.has(id),
      isMined: (text) => this.mined.hasSentence(text),
    });
    this.browser.onHover = (over) => (over ? this.onRegionEnter() : this.onRegionLeave());
    this.lookup.onHover = (over) => (over ? this.onRegionEnter() : this.onRegionLeave());

    this.jimakuPanel = new JimakuPanel({
      search: (opts) => this.jimakuApi("search", opts) as Promise<JimakuEntry[]>,
      files: (id) => this.jimakuApi("files", { entryId: id }) as Promise<JimakuFile[]>,
      pick: (entry, file) => this.loadJimakuFile(entry, file),
      detect: () => this.detectMedia(),
    });

    this.lyricsPanel = new LyricsPanel({
      search: (opts) => this.lrclibApi(opts),
      pick: (hit) => this.loadLyrics(hit),
      guess: () => {
        // Prefer the top frame's title (relayed) when we're inside a player iframe; else the
        // local og:title (which omits the " - YouTube" suffix). Let guessSong clean it.
        const og = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content?.trim();
        const raw = (this.topPageInfo?.title || og || document.title || "").replace(/\s*[-–]\s*YouTube\s*$/i, "").trim();
        return { ...guessSong(raw), duration: this.video.current?.duration || 0 };
      },
    });

    this.queuePanel = new QueuePanel({
      mineAll: () => this.mineQueueAll(),
      remove: (id) => this.removeFromQueue(id),
      clear: () => this.clearQueue(),
    });

    const layer = this.host.layer;
    // Highlight box drawn over the grabbed sub-piece during hold-key + hover (sits over
    // the text, under the popup). Appended before the popup so the popup stays on top.
    this.subHl = el("div", { class: "tnm-sub-hl" });
    layer.append(this.overlay.el, this.browser.el, this.toolbar.el, this.settingsPanel.el, this.subHl, this.jimakuPanel.el, this.lyricsPanel.el, this.queuePanel.el, this.lookup.el);
    this.refreshQueueUi();
    this.reflectChrome();
  }

  private applyTheme(): void {
    this.host.setThemeFlags({
      furigana: this.settings.showFurigana,
      knownStatus: this.settings.showKnownStatus,
      grammar: this.settings.colorGrammar,
    });
    applyAccentVars(this.host.root, this.settings.accent || "#ff9345", "--tnm-accent");
  }

  /** Reflect settings/state into toolbar + panel visibility. */
  private reflectChrome(): void {
    const hasVideo = !!this.currentVideo;
    this.toolbar.el.style.display = hasVideo ? "" : "none";
    this.toolbar.setEnabled(this.settings.enabled);
    this.toolbar.setBrowserActive(this.settings.browserOpen);
    this.toolbar.setHideActive(this.settings.hideTarget !== "off");
    this.toolbar.setKnownCount(this.known.countKnown());

    const showOverlay = hasVideo && this.settings.enabled && !!this.targetTrack;
    this.overlay.el.style.display = showOverlay ? "" : "none";
    this.browser.el.style.display = hasVideo && this.settings.enabled && this.settings.browserOpen ? "" : "none";
    this.overlay.setObscure(this.settings.hideTarget, this.settings.hideSecondary);
  }

  private active = true;
  /** Whether the overlay should activate for the current URL, per `activationRules` (so it
   *  doesn't show on a site's home/feed pages — e.g. youtube.com vs youtube.com/watch). */
  /** Built-in watch-page rules for known streaming SPAs, so the overlay/toolbar don't show on
   *  their home/browse pages out of the box. A user rule for the same host (set in the dashboard's
   *  Activation section) takes precedence. */
  private static readonly BUILTIN_RULES: ActivationRule[] = [
    { host: "miruro.tv", patterns: ["/watch"] },
    { host: "miruro.to", patterns: ["/watch"] },
    { host: "miruro.online", patterns: ["/watch"] },
  ];

  private siteActive(): boolean {
    const host = location.hostname;
    const match = (r: ActivationRule) => !!r.host && (host === r.host || host.endsWith("." + r.host));
    // A user rule wins; otherwise fall back to a built-in rule for known streaming sites.
    const rule = this.settings.activationRules?.find(match) ?? App.BUILTIN_RULES.find(match);
    if (!rule || !rule.patterns?.length) return true; // no rule for this host → active everywhere
    const url = location.pathname + location.search;
    return rule.patterns.some((p) => p && url.includes(p));
  }
  /** Hide the whole UI (host) on excluded pages; show it on allowed ones. */
  private updateActive(): void {
    const active = this.siteActive();
    if (active === this.active) return;
    this.active = active;
    this.host.host.style.display = active ? "" : "none";
  }

  // ----------------------------------------------------------------- settings
  /** Single funnel for setting changes. Applies UI immediately; persists debounced. */
  private patch(p: Partial<Settings>): void {
    const prevLang = this.settings.targetLang;
    this.settings = { ...this.settings, ...p };
    if (p.subtitleSize != null) this.overlay.setSize(p.subtitleSize);
    if (p.subtitleShadow != null || p.subtitleBackground != null) {
      this.overlay.setContrast(this.settings.subtitleShadow, this.settings.subtitleBackground);
    }
    if (p.overlayPosition != null) this.overlay.setPosition(p.overlayPosition);
    if (p.subOffset != null) this.toolbar.setOffsetValue(p.subOffset);
    this.applyTheme();
    this.reflectChrome();
    if (p.targetLang && p.targetLang !== prevLang) this.changeLang(p.targetLang);
    // Toggling multi-word matching re-segments: re-render the current line + browser rows
    // (merges are cached, so this is instant — the toggle switches views on the fly).
    if ("compoundLookup" in p) {
      this.activeTargetId = -1; // syncTarget re-renders the on-screen line next tick
      this.refreshBrowserTrack();
    }
    // Re-resolve the secondary (translation) line whenever its inputs change. Changing the
    // language/target invalidates cached machine translations.
    if ("nativeLang" in p || "targetLang" in p || "mtProvider" in p) this.mtCache.clear();
    if (
      "showSecondary" in p ||
      "showMachineTranslation" in p ||
      "nativeLang" in p ||
      "targetLang" in p ||
      "mtProvider" in p ||
      "mtApiKey" in p
    ) {
      this.updateSecondary();
    }
    // The timing offset is per-video, not global — persist it under the media key.
    if (p.subOffset != null) this.saveOffsetForMedia(p.subOffset);
    this.scheduleSave();
  }

  /** Languages with a real/official translation track for the current media (so "Show
   *  translation when available" can use them, and the settings panel can grey out the rest). */
  private officialSecondaryLangs(): Set<string> {
    const target = normalizeLang(this.settings.targetLang);
    const langs = new Set<string>();
    for (const t of this.ytTracks) {
      if (t.kind === "asr") continue; // auto-transcription, not an official translation
      const l = normalizeLang(t.lang);
      if (l && l !== target) langs.add(l);
    }
    // An imported / embedded native track counts as official.
    if (this.secondaryTrack && this.secondaryTrack.source !== "mt") {
      const l = normalizeLang(this.secondaryTrack.lang);
      if (l && l !== target) langs.add(l);
    }
    return langs;
  }

  /** Where the secondary (translation) line comes from for the current media + settings. */
  private secondaryMode(): "official" | "yt-translate" | "mt" | "off" {
    const native = normalizeLang(this.settings.nativeLang);
    if (!native || native === normalizeLang(this.settings.targetLang)) return "off";
    if (this.settings.showSecondary && this.officialSecondaryLangs().has(native)) return "official";
    if (this.settings.showMachineTranslation) {
      // YouTube's own auto-translate is free + instant and is Google MT, so use it on YouTube
      // when the provider is Google; everywhere else (and for DeepL) use our own translator.
      return this.ytVideoId && this.settings.mtProvider === "google" ? "yt-translate" : "mt";
    }
    return "off";
  }

  /** Decide + drive the secondary line. Called when settings, tracks, or the video change. */
  private updateSecondary(): void {
    this.settingsPanel.setAvailableSecondary([...this.officialSecondaryLangs()]);
    const mode = this.secondaryMode();
    this.mtOn = mode === "mt";
    if (mode === "off") {
      if (this.secondaryTrack) this.setSecondaryTrack(null);
      this.overlay.setSecondary([]);
      return;
    }
    if (mode === "mt") {
      if (this.secondaryTrack) this.setSecondaryTrack(null); // our MT drives syncSecondary instead
      this.primeMt();
      return;
    }
    if (!this.ytVideoId) return; // non-YouTube "official": the loaded track is already the secondary
    const native = normalizeLang(this.settings.nativeLang);
    if (mode === "yt-translate") {
      if (this.secondaryTrack?.source === "youtube" && normalizeLang(this.secondaryTrack.lang) === native) return;
      if (this.secondaryTrack && normalizeLang(this.secondaryTrack.lang) !== native) this.setSecondaryTrack(null);
      window.postMessage(
        { source: "tnm-cmd", cmd: "enableCaptions", lang: this.settings.targetLang, translateTo: this.settings.nativeLang },
        "*",
      );
    } else if (mode === "official") {
      if (this.secondaryTrack && normalizeLang(this.secondaryTrack.lang) === native) return; // already loaded
      window.postMessage(
        { source: "tnm-cmd", cmd: "enableCaptions", lang: this.settings.nativeLang, translateTo: "" },
        "*",
      );
    }
  }

  /** Kick off machine translation of the current target line + a few upcoming ones. */
  private primeMt(): void {
    const cues = this.targetTrack?.cues ?? [];
    if (!cues.length) return;
    const start = Math.max(0, this.targetHint);
    this.requestMt(cues.slice(start, start + 4).map((c) => c.text));
  }

  /** Translate the given target lines via the background (cached + deduped); fill mtCache. */
  private requestMt(texts: string[]): void {
    const need = texts.map((t) => t.trim()).filter((t) => t && !this.mtCache.has(t) && !this.mtPending.has(t));
    if (!need.length) return;
    for (const t of need) this.mtPending.add(t);
    chrome.runtime
      .sendMessage({ type: "translate", texts: need, from: this.settings.targetLang, to: this.settings.nativeLang })
      .then((res: TranslateResponse) => {
        if (res?.ok) need.forEach((t, i) => this.mtCache.set(t, res.texts[i] ?? ""));
      })
      .catch(() => {})
      .finally(() => need.forEach((t) => this.mtPending.delete(t)));
  }

  private async changeLang(lang: string): Promise<void> {
    this.known = new KnownWordsStore(lang);
    await this.known.load();
    this.known.onChange(() => this.onKnownChanged());
    if (normalizeLang(lang) === "ja") this.warmTokenizer();
    this.activeTargetId = -1; // re-tokenize current line for the new language
    this.toolbar.setKnownCount(this.known.countKnown());
  }

  private saveTimer = 0;
  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      // The toolbar + subtitle settings are per-site → this site's record. subOffset is
      // per-video (saved elsewhere); Anki/dict config is global and only edited in the
      // options page, so the content script never writes the global record.
      saveHostSettings(this.settings, location.hostname);
    }, 200);
  }

  /** A settings record we depend on changed in storage — re-merge and apply if it
   *  actually differs from what we already have (so our own writes are no-ops). */
  private async onSettingsRecordsChanged(): Promise<void> {
    const next = await loadSettings(location.hostname);
    next.subOffset = this.settings.subOffset; // per-video; not carried by these records
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
    this.applyExternalSettings(next);
  }

  /** Apply settings changed elsewhere (the popup / options / another tab) without re-saving. */
  private applyExternalSettings(next: Settings): void {
    const prevLang = this.settings.targetLang;
    const keepOffset = this.settings.subOffset; // per-video; not carried by global settings
    this.settings = { ...next, subOffset: keepOffset };
    this.overlay.setSize(next.subtitleSize);
    this.overlay.setContrast(next.subtitleShadow, next.subtitleBackground);
    this.overlay.setPosition(next.overlayPosition);
    this.toolbar.setOffsetValue(keepOffset);
    this.applyTheme();
    this.settingsPanel.update(this.settings);
    this.reflectChrome();
    this.updateActive(); // activation rules may have changed in the dashboard
    if (next.targetLang !== prevLang) this.changeLang(next.targetLang);
  }

  private toggleSettings(): void {
    this.settingsPanel.toggle();
    this.toolbar.setSettingsActive(this.settingsPanel.isOpen());
    if (this.settingsPanel.isOpen()) {
      const a = this.toolbar.settingsAnchor;
      const s = this.settingsPanel.el.style;
      const w = 320;
      s.left = `${Math.max(8, Math.min(a.left, window.innerWidth - w - 8))}px`;
      s.top = `${a.bottom + 8}px`;
    }
  }

  // ----------------------------------------------------------------- video
  private onVideoChanged(v: HTMLVideoElement | null): void {
    if (this.currentVideo === v) return;
    if (this.currentVideo) {
      this.currentVideo.removeEventListener("play", this.onPlayState);
      this.currentVideo.removeEventListener("pause", this.onPlayState);
      this.currentVideo.removeEventListener("emptied", this.onMediaReload);
      this.currentVideo.removeEventListener("loadstart", this.onMediaReload);
    }
    const prevTrackVideo = this.targetTrackVideo;
    this.currentVideo = v;
    if (v) {
      v.addEventListener("play", this.onPlayState);
      v.addEventListener("pause", this.onPlayState);
      v.addEventListener("emptied", this.onMediaReload);
      v.addEventListener("loadstart", this.onMediaReload);
      this.lastVideoSrc = v.currentSrc || v.src || "";
      this.onPlayState();
      this.lastTopHover = performance.now(); // briefly reveal the toolbar on a new video
    }
    this.reflectChrome();
    // A different <video> element means new content — e.g. an episode change on a player that
    // recreates the element. Drop subtitles that belonged to the previous one.
    if (this.targetTrack && prevTrackVideo && prevTrackVideo !== v) {
      console.info("[tnm] video element changed");
      this.clearSubtitleForNewMedia("video element changed");
    }
  }

  /** The current <video> began loading a different source — an episode change on a player that
   *  reuses the element. Subtitles for the old source are stale (same-source re-buffers ignored). */
  private onMediaReload = () => {
    const src = this.currentVideo?.currentSrc || this.currentVideo?.src || "";
    if (!src || src === this.lastVideoSrc) return;
    this.lastVideoSrc = src;
    if (this.targetTrack) {
      console.info("[tnm] video source changed:", src);
      this.clearSubtitleForNewMedia("video source changed");
    }
  };

  /** Drop the stale subtitle when we move to different media, and let auto-load fetch the new one. */
  private clearSubtitleForNewMedia(reason: string): void {
    if (!this.targetTrack) return;
    console.info(`[tnm] clearing stale subtitles (${reason})`);
    this.setSecondaryTrack(null);
    this.setTargetTrack(null);
    this.autoLoadedKey = "";
    this.autoLoadJimakuForPage().catch(() => {});
  }

  private onPlayState = () => {
    this.toolbar.setPlaying(!!this.currentVideo && !this.currentVideo.paused);
  };

  /** Detect SPA navigation (URL changed without a reload) → refresh per-page state and
   *  re-run Jimaku auto-load for the new episode/show. YouTube drives its own key via
   *  postMessage, so leave the media key alone there. */
  private onUrlMaybeChanged(): void {
    if (this.dead || !this.extAlive()) return this.teardown(); // context gone — stop polling
    if (location.href === this.lastUrl) return;
    console.info("[tnm] url changed:", this.lastUrl, "→", location.href);
    this.lastUrl = location.href;
    this.updateActive(); // SPA nav (e.g. youtube home → /watch) → re-check activation
    if (!this.ytVideoId) this.setMediaKey(location.href);
    this.autoLoadJimakuForPage().catch(() => {});
  }

  /** Switch the media identity (used for per-video offset + bookmarks). */
  private setMediaKey(key: string): void {
    if (key === this.mediaKey) return;
    this.mediaKey = key;
    this.autoLoadedKey = ""; // let auto-load run for the new (or revisited) page
    this.restoredTrackKey = "";
    this.mineQueue = []; // the queue belongs to the media it was built for; the new one loads below
    // A loaded subtitle belongs to the media it was loaded for. When the URL changes to a
    // different episode (SPA back/next), drop the stale track so it doesn't linger.
    if (this.targetTrack && this.targetTrackMediaKey !== key) {
      this.clearSubtitleForNewMedia("url changed");
    }
    this.refreshOffsetForMedia();
    this.restorePersistedForMedia().catch(() => {}); // pull this media's saved track + queue
  }

  /** Load this video's saved timing offset (0 if none) and reflect it in the UI. */
  private async refreshOffsetForMedia(): Promise<void> {
    const key = this.mediaKey;
    const v = await loadOffset(key);
    if (key !== this.mediaKey) return; // a newer video won the race
    this.settings.subOffset = v;
    this.toolbar.setOffsetValue(v);
    this.settingsPanel.update(this.settings);
  }

  private offsetSaveTimer = 0;
  private saveOffsetForMedia(value: number): void {
    const key = this.mediaKey;
    clearTimeout(this.offsetSaveTimer);
    this.offsetSaveTimer = window.setTimeout(() => saveOffset(key, value), 200);
  }

  /** A stable media identity shared across frames — the top page's URL when we're a player
   *  iframe, else this frame's media key — so the persisted track (set in the top frame) and the
   *  queue (built in the video frame) land under the SAME key and stay consistent. */
  private persistKey(): string {
    return this.topPageInfo?.href ?? this.mediaKey;
  }

  /** Persist the loaded subtitle track for this media so a reload restores THIS file (not the
   *  auto default). YouTube's own caption flow re-loads its track, and MT re-derives — skip both. */
  private persistTrack(): void {
    if (this.adoptingRemote) return; // the owning frame persists; adopters don't
    const t = this.targetTrack;
    if (!t || t.source === "youtube" || t.source === "mt") return;
    saveSavedTrack(this.persistKey(), t).catch(() => {});
  }

  private persistQueue(): void {
    saveQueue(this.persistKey(), this.mineQueue).catch(() => {});
  }

  /** On load / media change, restore the saved queue (any frame) and — in the frame that drives
   *  track selection — the saved subtitle track, so auto-load doesn't override the picked file. */
  private async restorePersistedForMedia(): Promise<void> {
    const key = this.persistKey();
    const q = await loadQueue(key).catch(() => [] as QueuedMine[]);
    if (key === this.persistKey() && q.length && !this.mineQueue.length) {
      this.mineQueue = q;
      this.refreshQueueUi();
    }
    if (this.isTopFrame()) {
      const track = await loadSavedTrack(key).catch(() => null);
      if (track && key === this.persistKey() && !this.targetTrack) {
        this.restoredTrackKey = key; // tell auto-load to stand down for this media
        this.setTargetTrack(track);
      }
    }
  }

  /** One-click sync: shift the timing so this cue lines up with the current playhead
   *  (videoTime = cueStart + offset ⇒ offset = now − cueStart). */
  private syncOffsetToCue(cueStart: number): void {
    const v = this.currentVideo;
    if (!v) {
      this.toast("No video to sync to.");
      return;
    }
    const offset = Math.round((v.currentTime - cueStart) * 100) / 100; // 0.01s precision
    this.patch({ subOffset: offset });
    this.toast(`Subtitles synced — offset ${offset >= 0 ? "+" : ""}${offset.toFixed(2)}s`);
  }

  private togglePlay(): void {
    const v = this.currentVideo;
    if (!v) return;
    if (v.paused) this.playVideo();
    else v.pause();
  }

  private playVideo(): void {
    this.currentVideo?.play().catch(() => {});
  }

  private seek(t: number): void {
    if (this.currentVideo) this.currentVideo.currentTime = t;
  }

  /** False once our extension context is gone (reloaded/updated) — chrome.* would throw. */
  private extAlive(): boolean {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  /** Stop all background work after the extension context is invalidated: no more timers,
   *  no more chrome.* calls. The page keeps its now-inert overlay until it's reloaded. */
  private teardown(): void {
    if (this.dead) return;
    this.dead = true;
    clearInterval(this.urlTimer);
    console.info("[tnm] extension context invalidated — paused. Reload the page to re-enable.");
  }

  // ----------------------------------------------------------------- sync loop
  private tick = () => {
    if (this.dead || !this.extAlive()) return this.teardown(); // context gone — stop the loop
    requestAnimationFrame(this.tick);
    const v = this.currentVideo;
    if (!v) {
      this.clearFullscreenScale();
      return;
    }
    // In fullscreen the browser can't dock into the page layout, so shrink the
    // video toward its right edge to make room on the left (before measuring, so the
    // rect we place the overlay/toolbar against reflects the shrunken video).
    this.updateFullscreenDock(v);
    const rect = v.getBoundingClientRect();
    if (rect.width < 1) return;

    // Dock + auto-hide the toolbar even when disabled (so it can be re-enabled).
    this.toolbar.place(rect);
    this.updateTnmBarVisibility(v, rect);

    // Dock the subtitle browser: in fullscreen, align it to the scaled (letterboxed)
    // video so the two form one clean centered band; on YouTube, dock between the
    // video and chat; otherwise float on the right via CSS. Tear the wrapper down when
    // not showing it — even while disabled — so the player is never left shrunk.
    if (this.settings.enabled && this.settings.browserOpen) {
      const fsRect = this.fsDockOn ? this.fullscreenVideoRect() : null;
      if (fsRect) {
        this.dock.remove();
        this.browser.dock(fsRect);
      } else {
        this.browser.dock(this.dock.dockBox());
      }
    } else {
      this.dock.remove();
      this.browser.dock(null);
    }

    if (!this.settings.enabled) return;
    this.overlay.place(rect);
    const t = v.currentTime - this.settings.subOffset;
    this.syncTarget(t);
    this.syncSecondary(t);
    this.handlePauseEachLine(t, v);
  };

  // --------------------------------------------------- player-scale dock (room-making)
  private fsScaledEl: HTMLElement | null = null;
  private fsPrevTransform = "";
  private fsPrevOrigin = "";
  private fsDockOn = false;
  private fsLeftDock = false; // true when the panel sits on the LEFT (fullscreen), false = right (theater/wide)

  /** Common player-root classes — scaling the whole player (video + its controls)
   *  beats scaling the bare <video> (whose controls are siblings and wouldn't move). */
  private static readonly PLAYER_ROOT_SEL =
    ".plyr,.art-video-player,.video-js,[data-vjs-player],.jwplayer,.html5-video-player,.shaka-video-container,.vjs-player";

  /** Which element to scale: the whole player container when we can find one that does
   *  NOT contain our overlay host (so its controls shrink WITH the picture); otherwise
   *  the bare <video> (controls won't move — cosmetic fallback). */
  private scaleTarget(v: HTMLVideoElement): HTMLElement {
    const host = this.host.host;
    const known = v.closest(App.PLAYER_ROOT_SEL) as HTMLElement | null;
    if (known && known !== host && !known.contains(host)) return known;
    // Unknown player: walk up to the largest still-player-sized ancestor (controls add a
    // little height/width over the video) that doesn't enclose our UI. offsetW/H are
    // layout-only (transform-independent) so this is stable while we're scaling.
    let best: HTMLElement = v;
    for (let p = v.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (p.contains(host)) break;
      if (p.offsetHeight > v.offsetHeight * 1.4 || p.offsetWidth > v.offsetWidth * 1.4) break;
      best = p;
    }
    return best;
  }

  /** When the browser is open and a wide video would sit under the (right-docked) panel
   *  — in fullscreen OR a windowed "theater" player that fills the width — scale the
   *  player toward its left edge so its right edge lands at the panel's left edge.
   *  `getBoundingClientRect()` reflects the transform, so the overlay, toolbar and
   *  subtitles follow the shrunken video automatically. */
  private updateFullscreenDock(v: HTMLVideoElement): void {
    const fsEl = (document.fullscreenElement ?? (document as any).webkitFullscreenElement ?? null) as HTMLElement | null;
    const inRealFullscreen = !!fsEl && (fsEl === v || fsEl.contains(v));
    const target = this.scaleTarget(v);

    // Geometry that ignores our own transform: offset* is layout-only (stable while scaling),
    // and the bounding-rect edge on the transform-origin side equals the unscaled edge — so
    // measuring it each frame gives no scale→measure→scale feedback.
    const rect = target.getBoundingClientRect();
    const unscaledWidth = target.offsetWidth || rect.width;
    const vw = window.innerWidth;
    const panelW = BROWSER_DOCK_WIDTH;
    const open = this.settings.enabled && this.settings.browserOpen;

    // In real fullscreen we dock the panel on the LEFT and scale the player toward its RIGHT edge,
    // so the player's own bottom-right controls/menus (settings, quality, speed) stay clear of the
    // panel instead of being covered by it. (Sites that fullscreen a nested player — miruro — report
    // real fullscreen inside that frame, where this runs.) A windowed "theater"/wide player keeps
    // the original right-dock (scale toward the left edge).
    const fsLike = inRealFullscreen;

    let shouldDock: boolean;
    let scale = 1;
    let origin: string;
    if (fsLike) {
      shouldDock = open;
      origin = "right center"; // .right is fixed under it → stable to measure
      scale = Math.max(0.3, Math.min(1, (rect.right - panelW) / unscaledWidth));
    } else {
      // Skip when YouTube's own dock reshapes the page (canDock) — it resizes the player instead.
      const left = rect.left; // fixed under transform-origin:left
      const panelLeft = vw - panelW;
      const wideEnough = unscaledWidth >= vw * 0.6; // the main player, not a small embed
      const underPanel = left + unscaledWidth > panelLeft + 2; // would be covered by the right panel
      shouldDock = open && wideEnough && underPanel && !this.dock.canDock();
      origin = "left center";
      scale = Math.max(0.3, Math.min(1, (panelLeft - left) / unscaledWidth));
    }
    const transition = shouldDock !== this.fsDockOn;

    if (shouldDock) {
      if (this.fsScaledEl !== target) {
        this.clearFullscreenScale(); // restore any previously-scaled element first
        this.fsPrevTransform = target.style.transform;
        this.fsPrevOrigin = target.style.transformOrigin;
        this.fsScaledEl = target;
      }
      target.style.setProperty("transform-origin", origin, "important");
      target.style.setProperty("transform", `scale(${scale.toFixed(4)})`, "important");
      this.fsLeftDock = fsLike;
    } else if (this.fsScaledEl) {
      this.clearFullscreenScale();
      this.fsLeftDock = false;
    }

    if (transition) {
      this.fsDockOn = shouldDock;
      const what = this.fsScaledEl === v ? "video" : this.fsScaledEl?.className?.toString().split(/\s+/)[0] || "player";
      console.info(`[tnm] player dock ${shouldDock ? "ON" : "off"} (${fsLike ? "fullscreen" : "theater/wide"}, scaled ${shouldDock ? what : "—"}, panel ${this.fsLeftDock ? "left" : "right"})`);
    }
  }

  /** The on-screen box the docked browser panel occupies — beside the scaled player, on the
   *  LEFT in fullscreen (clear of the player's menus) or the RIGHT for a windowed wide player. */
  fullscreenVideoRect(): DOMRect | null {
    if (!this.fsScaledEl) return null;
    const r = this.fsScaledEl.getBoundingClientRect();
    const x = this.fsLeftDock ? 0 : window.innerWidth - BROWSER_DOCK_WIDTH;
    return new DOMRect(x, r.top, BROWSER_DOCK_WIDTH, r.height);
  }

  /** Undo the player scale, restoring whatever inline transform was there. */
  private clearFullscreenScale(): void {
    const el = this.fsScaledEl;
    if (!el) return;
    this.fsScaledEl = null;
    if (this.fsPrevTransform) el.style.setProperty("transform", this.fsPrevTransform);
    else el.style.removeProperty("transform");
    if (this.fsPrevOrigin) el.style.setProperty("transform-origin", this.fsPrevOrigin);
    else el.style.removeProperty("transform-origin");
    this.fsPrevTransform = this.fsPrevOrigin = "";
  }

  private lastTopHover = 0;
  /** Show the docked bar when paused, when the popovers are open, or on recent
   *  mouse activity near the top of the video; otherwise slide it away. */
  private updateTnmBarVisibility(v: HTMLVideoElement, _rect: DOMRect): void {
    const recent = performance.now() - this.lastTopHover < 2600;
    const show = v.paused || recent || this.settingsPanel.isOpen() || this.lookup.isOpen();
    this.toolbar.setVisible(show);
  }

  private syncTarget(t: number): void {
    const cues = this.targetTrack?.cues ?? [];
    const idx = findCueAt(cues, t, this.targetHint);
    const cue = idx >= 0 ? cues[idx] : null;
    if (idx >= 0) this.targetHint = idx;
    const id = cue?.id ?? -1;
    if (id === this.activeTargetId) return;
    this.activeTargetId = id;

    this.activeCueText = cue?.text ?? "";
    this.activeCue = cue;
    if (cue) {
      this.armedCueId = cue.id;
      this.pausedForCueId = -1;
      const lines = cue.text.split("\n").map((line) => this.renderTargetLine(line));
      this.overlay.setTarget(lines);
    } else {
      this.overlay.setTarget([]);
    }
    if (this.settings.browserOpen && cue) this.browser.setActive(cue.id);
  }

  private renderTargetLine(text: string): HTMLElement {
    const tokens: Token[] = tokenize(text, this.settings.targetLang);
    // Always build the ruby; the `-tnm-furigana` root class controls visibility,
    // so toggling furigana is instant (pure CSS) with no re-tokenize.
    const ctx = {
      known: this.known,
      showFurigana: true,
      mined: (dict: string) => this.mined.hasWord(dict),
      onClick: (token: Token, tokenEl: HTMLElement, ev: MouseEvent) => this.onWordClick(token, tokenEl, ev),
      onMove: (token: Token, tokenEl: HTMLElement, ev: MouseEvent) => this.onWordMove(token, tokenEl, ev),
      onLeave: () => this.onWordLeave(),
    };
    const sentence = renderSentence(tokens, ctx);
    // Dictionary-assisted merging: IPADIC splits compounds it doesn't know (魔|族), so
    // re-segment against the user's dictionary and patch the line in place. Cached
    // pairs resolve in a microtask, so the swap is invisible after warm-up.
    if (this.settings.compoundLookup && normalizeLang(this.settings.targetLang) === "ja") {
      mergeCompoundTokens(tokens, (t) => this.hasTerms(t))
        .then(({ tokens: merged, changed }) => {
          if (changed && sentence.isConnected) sentence.replaceWith(renderSentence(merged, ctx));
        })
        .catch(() => {});
    }
    return sentence;
  }

  private async hasTerms(terms: string[]): Promise<{ expression: string; reading: string }[]> {
    const res = (await chrome.runtime.sendMessage({ type: "hasTerms", terms })) as HasTermsResponse;
    return res?.ok ? res.found : [];
  }

  private syncSecondary(t: number): void {
    // A real/official or YouTube-translated track drives the line directly.
    if (this.secondaryTrack && (this.settings.showSecondary || this.settings.showMachineTranslation)) {
      const cues = this.secondaryTrack.cues;
      const idx = findCueAt(cues, t, this.secondaryHint);
      if (idx >= 0) this.secondaryHint = idx;
      const cue = idx >= 0 ? cues[idx] : null;
      this.overlay.setSecondary(cue ? cue.text.split("\n") : []);
      return;
    }
    // Our machine translation: translate the current target cue on demand (+ prefetch upcoming).
    if (this.mtOn) {
      const cue = this.activeCue;
      if (!cue) {
        this.overlay.setSecondary([]);
        return;
      }
      const cues = this.targetTrack?.cues ?? [];
      this.requestMt(cues.slice(this.targetHint, this.targetHint + 4).map((c) => c.text));
      const txt = this.mtCache.get(cue.text.trim()) ?? "";
      this.overlay.setSecondary(txt ? txt.split("\n") : []);
      return;
    }
    this.overlay.setSecondary([]);
  }

  private handlePauseEachLine(t: number, v: HTMLVideoElement): void {
    if (this.settings.pauseMode !== "eachLine" || v.paused) return;
    const cues = this.targetTrack?.cues ?? [];
    if (this.armedCueId < 0) return;
    const cue = cues[this.targetHint];
    if (!cue || cue.id !== this.armedCueId) return;
    if (t >= cue.end && this.pausedForCueId !== cue.id) {
      this.pausedForCueId = cue.id;
      v.pause();
      this.scheduleAutoResume();
    }
  }

  // ----------------------------------------------------------------- words
  private onWordClick(token: Token, tokenEl: HTMLElement, _ev: MouseEvent): void {
    // Toggle: clicking a word opens its look-up; clicking the SAME word again closes it.
    // The click's pointerdown already dismissed the popup (installDismiss) just before this
    // fires, so detect "just closed this word" and leave it closed instead of re-opening.
    if (this.justClosedTokenEl === tokenEl && Date.now() - this.justClosedAt < 350) {
      this.justClosedTokenEl = null;
      return;
    }
    if (this.lookup.isOpen() && this.lookupTokenEl === tokenEl) {
      this.lookup.hide(); // (defensive) still open for the same word → close it
      return;
    }
    this.openLookup(token, tokenEl, false);
  }

  private hoverTimer = 0;
  private lookupViaHover = false;
  /** The token whose look-up popup is currently open (for click-to-toggle). */
  private lookupTokenEl: HTMLElement | null = null;
  private justClosedTokenEl: HTMLElement | null = null;
  private justClosedAt = 0;
  private hovered: { token: Token; el: HTMLElement } | null = null;
  private lastMouse = { x: 0, y: 0 };
  private hoverKey = ""; // dedupes repeated hover look-ups of the same word/char
  private subHl!: HTMLElement; // highlight box over the grabbed sub-piece

  private showSubHl(rect: DOMRect): void {
    const s = this.subHl.style;
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    s.display = "block";
  }
  private hideSubHl(): void {
    this.subHl.style.display = "none";
  }

  /** Is the configured modifier ("Control"|"Alt"|"Shift"|"Meta") down in this event? */
  private modHeld(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }, key: string): boolean {
    return key === "Control" ? e.ctrlKey : key === "Alt" ? e.altKey : key === "Shift" ? e.shiftKey : key === "Meta" ? e.metaKey : false;
  }

  private onWordMove(token: Token, tokenEl: HTMLElement, ev: MouseEvent): void {
    this.lastMouse = { x: ev.clientX, y: ev.clientY };
    this.hovered = { token, el: tokenEl };
    this.lastTokenHoverAt = performance.now(); // for external-popup (Yomitan) pause
    this.maybeHoverLookup(ev);
  }
  private onWordLeave(): void {
    this.hovered = null;
    this.hoverKey = "";
    clearTimeout(this.hoverTimer);
    this.hideSubHl();
  }

  /** Decide what (if anything) a hover should look up: hold-key + word-start → whole word;
   *  hold-key + mid-word → forward sub-piece; else the always-on hover setting → whole word
   *  but ONLY on the live overlay (in the browser, look-up needs a click or the hold-key, so
   *  scrolling the list doesn't fire look-ups). Deduped so it doesn't re-open every move. */
  private maybeHoverLookup(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; clientX: number; clientY: number }): void {
    if (!this.hovered) return;
    const { token, el } = this.hovered;
    const inBrowser = !!el.closest(".TnmBrowser__list__item");
    const holdOn = this.settings.holdLookup && (inBrowser || this.settings.holdLookupOverlay);

    let mode: "word" | "char" | "" = "";
    let charIdx = -1;
    if (holdOn && this.modHeld(e, this.settings.keyLookup)) {
      // Hold-key + hover: the start of a word → whole word; mid-word → scan forward
      // from the cursor character (Yomitan-style sub-piece grab).
      charIdx = this.charIndexAt(el, e.clientX, e.clientY);
      mode = charIdx > 0 ? "char" : charIdx === 0 ? "word" : "";
    } else if (this.settings.hoverLookup && !inBrowser) {
      mode = "word"; // always-on hover applies to the live overlay only, NOT the browser
    }

    if (mode !== "char") this.hideSubHl(); // sub-piece highlight only while scanning mid-word
    if (!mode) {
      this.hoverKey = "";
      clearTimeout(this.hoverTimer);
      return;
    }
    const key = mode === "char" ? `char:${charIdx}` : `word:${token.dict}`;
    if (key === this.hoverKey && this.lookup.isOpen()) return;
    this.hoverKey = key;
    clearTimeout(this.hoverTimer);
    this.hoverTimer = window.setTimeout(() => {
      if (mode === "char") this.openSubLookup(el, charIdx);
      else this.openLookup(token, el, true);
    }, 120);
  }

  /** Index of the character in a token's surface text node under (x,y), or -1. */
  private charIndexAt(tokenEl: HTMLElement, x: number, y: number): number {
    const surface = tokenEl.querySelector(".tnm-surface");
    const node = surface?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return -1;
    const text = node.textContent ?? "";
    const range = document.createRange();
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
    }
    return -1;
  }

  /** Sub-piece hover (hold sub-key): scan FORWARD from the character under the cursor to
   *  the next word boundary (Yomitan-style) and look that up — so hovering 疲 inside
   *  お疲れ様 grabs 疲れ, not just 疲. Forward text is read across the line (base text
   *  only, no furigana) and re-tokenized; the first word is the grab. */
  private openSubLookup(tokenEl: HTMLElement, idx: number): void {
    const node = tokenEl.querySelector(".tnm-surface")?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? "";
    if (idx < 0 || idx >= text.length) return;
    let fwd = text.slice(idx);
    for (let sib = tokenEl.nextSibling; sib && fwd.length < 12; sib = sib.nextSibling) {
      if (sib.nodeType === Node.TEXT_NODE) fwd += sib.textContent ?? "";
      else fwd += (sib as HTMLElement).querySelector?.(".tnm-surface")?.textContent ?? "";
    }
    const grab = tokenize(fwd, this.settings.targetLang).filter((t) => t.isWord)[0]?.surface || text[idx];
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, Math.min(text.length, idx + grab.length));
    const rect = range.getBoundingClientRect();
    this.showSubHl(rect); // outline exactly what's being grabbed
    this.openSelectionLookup(grab, tokenEl.closest(".TnmBrowser__list__item") as HTMLElement | null, rect, true);
  }

  /** viaHover popups are transient (close when you move away); click popups are pinned. */
  private openLookup(token: Token, tokenEl: HTMLElement, viaHover: boolean): void {
    clearTimeout(this.hoverTimer);
    this.lookupViaHover = viaHover;
    this.lookupTokenEl = tokenEl; // remember the word for click-to-toggle
    this.pauseForLookup();
    // Keep the whole subtitle line/row clear so you can hover neighbouring words.
    const block = tokenEl.closest(".TnmSubs__container, .TnmBrowser__list__item") as HTMLElement | null;
    const { cue, sentence } = this.lineFor(tokenEl);
    // Multi-word expression candidates (歳+食っちゃい → 歳食う) from the rendered sentence.
    const tctx = this.settings.compoundLookup ? tokenContextOf(tokenEl) : undefined;
    const candidates = tctx ? buildCandidates(tctx.tokens, tctx.index) : [];
    this.presentLookup(token, tokenEl.getBoundingClientRect(), block?.getBoundingClientRect(), cue, sentence, candidates);
  }

  /** Look up an arbitrary drag-selected string (a sub-piece of a word, e.g. 疲れ out of
   *  お疲れ様). Tokenizes the selection: a single word → that word's lemma/reading; a
   *  multi-word span → the raw selection. Anchored to the selection's on-screen box. */
  private openSelectionLookup(text: string, rowEl: HTMLElement | null, rect: DOMRect, viaHover = false): void {
    const sel = text.trim();
    if (!sel) return;
    clearTimeout(this.hoverTimer);
    this.lookupViaHover = viaHover;
    this.lookupTokenEl = null; // a drag/sub-piece look-up isn't a single word — no click-toggle
    this.pauseForLookup();
    const words = tokenize(sel, this.settings.targetLang).filter((t) => t.isWord);
    const token: Token =
      words.length === 1
        ? words[0]
        : { surface: sel, dict: sel, reading: words.map((w) => w.reading).join(""), pos: "", isWord: true };
    const { cue, sentence } = this.lineFor(rowEl);
    this.presentLookup(token, rect, rowEl?.getBoundingClientRect(), cue, sentence);
  }

  /** The cue + sentence a looked-up element belongs to: a browser row's own cue (it may
   *  differ from the playing line) else the currently-playing overlay line. */
  private lineFor(node: HTMLElement | null): { cue: Cue | null; sentence: string } {
    const row = node?.closest(".TnmBrowser__list__item") as HTMLElement | null;
    if (row?.dataset.cueId) {
      const rowCue = this.targetTrack?.cues.find((c) => c.id === Number(row.dataset.cueId));
      if (rowCue) return { cue: rowCue, sentence: rowCue.text };
    }
    return { cue: this.activeCue, sentence: this.activeCueText };
  }

  private presentLookup(token: Token, anchor: DOMRect, avoid: DOMRect | undefined, cue: Cue | null, sentence: string, candidates: string[] = []): void {
    // currentTerm() = the matched compound once the popup promotes one, else the token's lemma
    // — status, audio and mining all follow the headword the user is actually seeing.
    const term = () => this.lookup.currentTerm() || token.dict;
    this.lookup.show({
      term: token.dict,
      reading: token.reading,
      selection: token.surface,
      selectionReading: token.reading,
      status: this.known.get(token.dict),
      anchor,
      avoid,
      fetchResult: () => this.fetchLookup(token, candidates),
      fetchOnline: () => this.fetchOnline(token.dict),
      onStatus: (s) => this.setStatus(term(), s),
      onSpeak: (reading) => this.playPronunciation(term(), reading || token.reading),
      onMine: this.settings.ankiEnabled ? () => this.mineCard(token, sentence, cue, candidates) : undefined,
      mined: this.mined.hasWord(token.dict),
      onQueue: this.settings.ankiEnabled ? () => this.queueMine(token, sentence, cue, candidates) : undefined,
      queued: this.isQueued(token, cue),
      onClose: () => {
        // Remember which word just closed so an immediately-following click on that same
        // word (this click's own pointerdown triggered the close) doesn't re-open it.
        this.justClosedTokenEl = this.lookupTokenEl;
        this.justClosedAt = Date.now();
        this.lookupTokenEl = null;
        this.hideSubHl();
        this.resumeAfterLookup();
      },
    });
  }

  // ----------------------------------------------------------------- anki mining
  private activeCueText = "";
  private activeCue: Cue | null = null;
  private mining = false;

  /** Gather word + sentence + definition + screenshot + word/sentence audio → AnkiConnect.
   *  Returns whether the card landed (ok or duplicate). `opts` drives batch queue mining:
   *  reading pins the reading captured when queued; quiet suppresses the per-card toasts/popup flip. */
  private async mineCard(
    token: Token,
    sentence: string,
    cue: Cue | null,
    candidates: string[] = [],
    opts: { reading?: string; quiet?: boolean; offset?: number } = {},
  ): Promise<boolean> {
    if (this.mining) return false;
    if (!this.settings.ankiDeck || !this.settings.ankiModel) {
      this.toast("Set your Anki deck & note type in the extension options first.");
      return false;
    }
    this.mining = true;
    if (!opts.quiet) this.toast("Mining…");
    try {
      const media: { filename: string; dataBase64: string }[] = [];
      const stamp = Date.now();

      // definition / glossary / frequency from the offline lookup. Render the
      // structured glossary to HTML (the same formatted list the popup shows) —
      // flattening it to text produced the run-on "jumble". MainDefinition = the
      // top dictionary's glossary; Glossary = every dictionary's, with headings.
      const result = await this.fetchLookup(token, candidates).catch(() => null);
      const sections = result?.sections ?? [];
      // A matched multi-word expression (歳食う) becomes the card's word.
      const dict = result?.matchedTerm || token.dict;
      // The lemma reading from the dictionary (おもう), NOT the conjugated surface reading
      // the token carries (おもいます) — used for ExpressionReading + word audio.
      // Honour a reading the user manually switched to in the popup; else the looked-up lemma reading.
      // For a batch (quiet) mine the popup is closed/elsewhere — use the reading captured when the
      // word was queued, not whatever the live popup shows.
      const liveReading = opts.quiet ? "" : this.lookup.currentReading();
      const lemmaReading = opts.reading || liveReading || result?.reading || token.reading;
      // Emit Yomitan's exact glossary structure (yomitan-glossary > ol >
      // li[data-dictionary]) so the lapis template's JS can separate dictionaries,
      // de-duplicate the primary from the glossary, and parse pitch.
      // MainDefinition = ONE dictionary (chosen, else auto-prefer Jitendex/JMdict,
      // else first); Glossary = ALL dictionaries (lapis hides the primary's dict).
      const pick = this.settings.ankiMainDict;
      const mainSection =
        (pick && sections.find((s) => s.dictTitle === pick)) ||
        sections.find((s) => /jmdict|jitendex/i.test(s.dictTitle)) ||
        sections[0];
      const definition = mainSection ? yomitanGlossary([mainSection]) : "";
      const glossary = yomitanGlossary(sections);
      const f0 = result?.frequencies?.[0];
      const frequency = f0 ? `${f0.dict.split(/[\s(]/)[0]}: ${f0.display}` : "";
      const freqSort = f0 ? String(f0.value) : "";

      // word audio (JapanesePod101, JA only)
      let wordAudioFilename: string | undefined;
      if (this.settings.ankiCaptureWordAudio && normalizeLang(this.settings.targetLang) === "ja") {
        const dataUrl = await this.fetchWordAudioDataUrl(dict, lemmaReading).catch(() => null);
        const b64 = dataUrl?.split(",")[1];
        if (b64) {
          wordAudioFilename = `tnm_w_${stamp}.mp3`;
          media.push({ filename: wordAudioFilename, dataBase64: b64 });
        }
      }

      // Media (Picture + SentenceAudio). Position the video AT the mined line
      // first — when mining from the browser the player can be elsewhere, so we
      // seek (and wait for it to land) before grabbing the frame AND the audio,
      // then restore the original position/play-state.
      let pictureHtml: string | undefined;
      let sentenceAudioFilename: string | undefined;
      const v = this.currentVideo;
      const animated = this.settings.ankiCaptureImage && this.settings.ankiAnimatedImage;
      const wantClip = this.settings.ankiCaptureImage && animated;
      const wantStill = this.settings.ankiCaptureImage && !animated;
      const wantSentenceAudio = this.settings.ankiCaptureSentenceAudio;
      // Queued items carry the offset from when they were queued (opts.offset); a live ＋ mine uses
      // the current offset. So re-aligning drifting subs later won't shift already-queued lines.
      const offset = opts.offset ?? this.settings.subOffset;
      const cueStart = cue && v ? Math.max(0, cue.start + offset) : 0;
      const cueEnd = cue && v ? cue.end + offset : 0;
      const atCue = !!(cue && v && v.currentTime >= cueStart - 0.1 && v.currentTime < cueEnd);
      const needRecord = wantClip || wantSentenceAudio;
      const willSeek = !!(v && cue && (needRecord || (wantStill && !atCue)));
      const origTime = v?.currentTime ?? 0;
      const origPaused = v?.paused ?? true;
      // Batch mining runs muted and may be backgrounded, but a cross-origin screenshot/clip can
      // only be captured while the tab is actually rendering — wait for it to be visible again.
      if (opts.quiet && (wantStill || wantClip) && document.hidden) await this.waitForVisible(120_000);
      try {
        if (wantStill && v) {
          if (cue && !atCue) {
            v.pause();
            await this.seekTo(v, cueStart); // move to the mined line's frame
          }
          const b64 = await this.captureScreenshot().catch(() => null);
          if (b64) {
            const fn = `tnm_i_${stamp}.jpg`;
            media.push({ filename: fn, dataBase64: b64 });
            pictureHtml = `<img src="${fn}" style="${MEDIA_STYLE}">`;
          }
        }
        if (cue && v && needRecord) {
          this.toast("Recording line…");
          v.pause();
          await this.seekTo(v, cueStart); // start of the mined line
          const durMs = Math.min(12000, Math.max(300, (cue.end - cue.start) * 1000));
          const { video, audio } = await this.recordFromHere(v, durMs, { video: wantClip, audio: wantSentenceAudio }).catch(() => ({ video: null, audio: null }));
          if (wantClip && video) {
            const fn = `tnm_clip_${stamp}.${video.ext}`;
            media.push({ filename: fn, dataBase64: video.base64 });
            pictureHtml = `<video src="${fn}" autoplay loop muted playsinline style="${MEDIA_STYLE}"></video>`;
          }
          if (wantSentenceAudio && audio) {
            const fn = `tnm_s_${stamp}.${audio.ext}`;
            media.push({ filename: fn, dataBase64: audio.base64 });
            sentenceAudioFilename = fn;
          }
        }
      } finally {
        if (v && willSeek) {
          await this.seekTo(v, origTime).catch(() => {});
          if (origPaused) v.pause();
          else v.play().catch(() => {});
        }
      }

      // Pitch accent for the card (lapis' PitchPosition/PitchCategories fields).
      const pitchEntry = result?.pitches?.find((pe) => pe.reading === lemmaReading) ?? result?.pitches?.[0];
      const pitch = pitchEntry ? pitchFields(pitchEntry.positions, pitchEntry.reading) : { position: "", categories: "" };

      const fields = buildLapisFields({
        word: dict,
        reading: lemmaReading,
        surface: token.surface,
        sentence,
        definition,
        glossary,
        frequency,
        freqSort,
        pitchPosition: pitch.position,
        pitchCategories: pitch.categories,
        misc: this.mineMiscInfo(),
        wordAudioFilename,
        sentenceAudioFilename,
        pictureHtml,
      });

      const res = (await chrome.runtime.sendMessage({
        type: "ankiMine",
        card: { deck: this.settings.ankiDeck, model: this.settings.ankiModel, fields, media, tags: ["tnm"] },
      })) as AnkiMineResponse;

      if (res?.ok || res?.error === "duplicate") {
        // Track it locally either way (a duplicate means it's already in the deck).
        this.mined.add(dict, sentence);
        if (!opts.quiet) {
          this.lookup.setMined(true); // flip the popup's ＋ to ✓
          this.toast(res?.ok ? "✓ Added to Anki" : "Already in Anki (duplicate)");
        }
        return true;
      }
      if (!opts.quiet) this.toast("Anki: " + (res?.error ?? "failed"));
      return false;
    } catch (e) {
      if (!opts.quiet) this.toast("Mining failed: " + String((e as Error)?.message ?? e));
      return false;
    } finally {
      this.mining = false;
    }
  }

  // ----------------------------------------------------------------- mining queue
  private queueKey(token: Token, cue: Cue | null): string {
    return `${cue?.id ?? -1}:${token.dict}:${token.surface}`;
  }
  private isQueued(token: Token, cue: Cue | null): boolean {
    const k = this.queueKey(token, cue);
    return this.mineQueue.some((q) => this.queueKey(q.token, q.cue) === k);
  }

  /** Tag a word+line for later batch mining (from a look-up's queue button). */
  private queueMine(token: Token, sentence: string, cue: Cue | null, candidates: string[]): void {
    if (this.isQueued(token, cue)) {
      this.toast("Already in the queue");
      return;
    }
    const reading = this.lookup.currentReading() || token.reading;
    this.mineQueue.push({ id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, token, sentence, cue, candidates, reading, offset: this.settings.subOffset });
    this.lookup.setQueued(true);
    this.persistQueue();
    this.refreshQueueUi();
    this.toast(`Queued (${this.mineQueue.length}) — mine later from the ⬖ queue`);
  }

  private removeFromQueue(id: string): void {
    this.mineQueue = this.mineQueue.filter((q) => q.id !== id);
    this.persistQueue();
    this.refreshQueueUi();
  }
  private clearQueue(): void {
    if (this.queueMining) return;
    this.mineQueue = [];
    this.persistQueue();
    this.refreshQueueUi();
  }
  private toggleQueuePanel(): void {
    this.queuePanel.toggle();
    this.refreshQueueUi();
  }
  private queueRows(): QueueRow[] {
    return this.mineQueue.map((q) => ({ id: q.id, word: q.token.dict, reading: q.reading, snippet: q.sentence }));
  }
  private refreshQueueUi(): void {
    this.toolbar.setQueueCount(this.mineQueue.length);
    this.toolbar.setQueueActive(this.queuePanel.isOpen());
    this.queuePanel.update(this.queueRows(), { busy: this.queueMining });
  }

  /** Mine every queued word one by one — seek to its line, record + screenshot, send to Anki. Runs
   *  with the tab MUTED (the sentence audio still records — tab mute is downstream of the capture),
   *  so you can look away while it works. Sentence audio + text keep going even if the tab is
   *  backgrounded; a screenshot/clip needs the tab rendering, so those steps wait for it to be
   *  visible again (mineCard's waitForVisible). */
  private async mineQueueAll(): Promise<void> {
    if (this.queueMining || !this.mineQueue.length) return;
    if (!this.currentVideo) {
      this.toast("Open the video first, then mine the queue.");
      return;
    }
    if (!this.settings.ankiDeck || !this.settings.ankiModel) {
      this.toast("Set your Anki deck & note type in the extension options first.");
      return;
    }
    this.queueMining = true;
    this.lookup.hide(); // a look-up open over the video would fight the seeks
    const wasPaused = this.currentVideo.paused;
    await chrome.runtime.sendMessage({ type: "muteTab", on: true }).catch(() => {});
    const items = [...this.mineQueue];
    let done = 0;
    let failed = 0;
    try {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        this.queuePanel.update(this.queueRows(), { busy: true, status: `Mining ${i + 1}/${items.length}: ${it.token.dict}… (muted — you can look away)` });
        const ok = await this.mineCard(it.token, it.sentence, it.cue, it.candidates, { reading: it.reading, quiet: true, offset: it.offset }).catch(() => false);
        if (ok) {
          this.mineQueue = this.mineQueue.filter((q) => q.id !== it.id);
          this.persistQueue(); // crash-safe: don't re-mine what already landed
          done++;
        } else {
          failed++;
        }
        this.toolbar.setQueueCount(this.mineQueue.length);
      }
    } finally {
      await chrome.runtime.sendMessage({ type: "muteTab", on: false }).catch(() => {});
      // The per-card capture leaves the video paused; restore what the user had.
      if (!wasPaused) this.currentVideo?.play().catch(() => {});
      this.queueMining = false;
      this.refreshQueueUi();
    }
    this.toast(failed ? `Queue done: ${done} added, ${failed} failed` : `Queue complete — ${done} added ✓`);
  }

  /** Resolve once the tab is visible (rendering) again, or after `maxMs`. Batch mining uses this
   *  before a screenshot/clip, since a cross-origin frame can't be captured from a hidden tab. */
  private waitForVisible(maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (!document.hidden) return resolve();
      const t0 = performance.now();
      const done = () => {
        if (document.hidden && performance.now() - t0 < maxMs) return;
        document.removeEventListener("visibilitychange", done);
        clearInterval(iv);
        resolve();
      };
      const iv = window.setInterval(done, 400);
      document.addEventListener("visibilitychange", done);
    });
  }

  /** Hide our overlay, capture the video frame via the background, then restore. */
  private async captureScreenshot(): Promise<string | null> {
    const v = this.currentVideo;
    if (!v) return null;
    const r = v.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const hostEl = this.host.host;
    const prev = hostEl.style.visibility;
    hostEl.style.visibility = "hidden";
    try {
      await new Promise((res) => setTimeout(res, 50)); // let the hide paint before capture
      const res = (await chrome.runtime.sendMessage({
        type: "ankiScreenshot",
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        dpr: window.devicePixelRatio || 1,
      })) as AnkiScreenshotResponse;
      return res?.ok ? res.dataBase64 : null;
    } finally {
      hostEl.style.visibility = prev;
    }
  }

  /** Set currentTime and resolve once the seek lands ('seeked'), with a fallback. */
  private seekTo(v: HTMLVideoElement, time: number): Promise<void> {
    return new Promise((resolve) => {
      if (!isFinite(time) || Math.abs(v.currentTime - time) < 0.05) return resolve();
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        v.removeEventListener("seeked", fin);
        resolve();
      };
      v.addEventListener("seeked", fin);
      try {
        v.currentTime = time;
      } catch {
        fin();
        return;
      }
      setTimeout(fin, 1500); // fallback if 'seeked' never fires
    });
  }

  /**
   * Record from the video's CURRENT position (the caller has already seeked there)
   * for `durMs`, capturing the player's stream — the line plays ALOUD (capturing a
   * muted element yields silence, so this is unavoidable; most players do the
   * same). Runs up to two recorders: a VIDEO-only clip (Picture) and an AUDIO-only
   * clip (SentenceAudio) — kept separate so Anki's [sound:] never replays the video.
   * The caller restores the position/play-state afterwards.
   */
  private async recordFromHere(v: HTMLVideoElement, durMs: number, opts: { video: boolean; audio: boolean }): Promise<{ video: { base64: string; ext: string } | null; audio: { base64: string; ext: string } | null }> {
    const none = { video: null, audio: null };
    const vv = v as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
    const grab = vv.captureStream?.bind(vv) ?? vv.mozCaptureStream?.bind(vv);
    if (!grab) return none;
    let stream: MediaStream;
    try {
      stream = grab();
    } catch {
      return none;
    }
    const supported = (m: string) => {
      try {
        return MediaRecorder.isTypeSupported(m);
      } catch {
        return false;
      }
    };
    type Kind = "video" | "audio";
    const recs: { kind: Kind; rec: MediaRecorder; chunks: Blob[]; mime: string }[] = [];
    const make = (kind: Kind, tracks: MediaStreamTrack[], candidates: string[]) => {
      if (!tracks.length) return;
      const mime = candidates.find(supported);
      if (!mime) return;
      // Cap bitrate to keep clips small (they only display at ~480px): ~1 Mbps
      // video, ~64 kbps Opus speech. We can't downscale the video's resolution —
      // drawing the cross-origin frame to a canvas taints it — so bitrate is the lever.
      const recOpts: MediaRecorderOptions = { mimeType: mime };
      if (kind === "audio") recOpts.audioBitsPerSecond = 64_000;
      else recOpts.videoBitsPerSecond = 1_000_000;
      try {
        const rec = new MediaRecorder(new MediaStream(tracks), recOpts);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        recs.push({ kind, rec, chunks, mime });
      } catch {
        /* unsupported */
      }
    };
    // The Picture clip is webm/vp9 — reliable from captureStream. (mp4/H.264 would play
    // on iOS but Chrome records it EMPTY from captureStream here, so we don't use it; the
    // clip is desktop-only, the still-image Picture covers mobile.)
    if (opts.video) make("video", stream.getVideoTracks?.() ?? [], ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]);
    if (opts.audio) make("audio", stream.getAudioTracks?.() ?? [], ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]);
    if (!recs.length) return none;

    const stops = recs.map((r) => new Promise<Blob | null>((res) => (r.rec.onstop = () => res(r.chunks.length ? new Blob(r.chunks, { type: r.mime }) : null))));
    const rate = v.playbackRate || 1;
    try {
      await v.play().catch(() => {});
      recs.forEach((r) => r.rec.start());
      await new Promise((r) => setTimeout(r, durMs / rate + 120));
      recs.forEach((r) => { try { r.rec.stop(); } catch { /* ignore */ } });
    } catch {
      recs.forEach((r) => { try { r.rec.stop(); } catch { /* ignore */ } });
    }
    const blobs = await Promise.all(stops);
    const out: { video: { base64: string; ext: string } | null; audio: { base64: string; ext: string } | null } = { video: null, audio: null };
    for (let i = 0; i < recs.length; i++) {
      const blob = blobs[i];
      if (!blob || !blob.size) continue;
      if (recs[i].kind === "video") {
        out.video = { base64: await blobToDataBase64(blob), ext: "webm" };
      } else {
        // Transcode opus/webm → MP3 so it plays on iOS / AnkiMobile; fall back to the
        // original container (desktop-only) if decoding fails.
        const mp3 = await audioBlobToMp3Base64(blob).catch(() => null);
        out.audio = mp3 ? { base64: mp3, ext: "mp3" } : { base64: await blobToDataBase64(blob), ext: "webm" };
      }
    }
    return out;
  }

  private async fetchWordAudioDataUrl(term: string, reading: string): Promise<string | null> {
    const res = (await chrome.runtime.sendMessage({
      type: "audio",
      term,
      reading,
      lang: this.settings.targetLang,
    })) as AudioResponse;
    return res?.ok ? res.dataUrl : null;
  }

  private mineMiscInfo(): string {
    const t = this.currentVideo?.currentTime ?? 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2, "0");
    return `${document.title} · ${m}:${s} · ${location.href}`;
  }

  /** Prefer JapanesePod101's human recording (via background); fall back to TTS. */
  private async playPronunciation(term: string, reading: string): Promise<void> {
    const lang = this.settings.targetLang;
    if (normalizeLang(lang) === "ja") {
      try {
        const res = (await chrome.runtime.sendMessage({
          type: "audio",
          term,
          reading,
          lang,
        })) as AudioResponse;
        if (res?.ok && res.dataUrl) {
          await new Audio(res.dataUrl).play();
          return;
        }
      } catch {
        /* fall through to TTS */
      }
    }
    this.speakTts(reading || term, lang);
  }

  private speakTts(text: string, lang: string): void {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = SPEECH_LANG[normalizeLang(lang)] || lang;
      const want = utter.lang.toLowerCase().split("-")[0];
      const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith(want));
      if (voice) utter.voice = voice;
      utter.rate = 0.9;
      synth.cancel();
      synth.speak(utter);
    } catch {
      /* speech not available */
    }
  }

  // -------------------------------------------------- pause-on-lookup (hover)
  private hoverRegions = 0;
  private hoverPaused = false;
  private hoverHideTimer = 0;

  /** Pointer entered a "study" region (subtitle text, the browser, or the look-up popup).
   *  Used ONLY to keep a transient hover popup alive while the pointer moves between the word
   *  and the popup — it does NOT pause the video (that happens only on an actual look-up, so
   *  you can browse/scroll the subtitle list without the video stopping). */
  private onRegionEnter(): void {
    this.hoverRegions++;
    clearTimeout(this.hoverHideTimer);
  }

  private onRegionLeave(): void {
    this.hoverRegions = Math.max(0, this.hoverRegions - 1);
    if (this.hoverRegions === 0) this.scheduleHoverHide();
  }

  /** After leaving all study regions, close a TRANSIENT (hover) look-up popup; its onClose
   *  then resumes the video. A pinned (click) popup stays open until dismissed. */
  private scheduleHoverHide(): void {
    clearTimeout(this.hoverHideTimer);
    this.hoverHideTimer = window.setTimeout(() => {
      if (this.hoverRegions === 0 && this.lookup.isOpen() && this.lookupViaHover) this.lookup.hide();
    }, 350);
  }

  /** Pause the video when a look-up popup opens (pauseMode "onLookup"). */
  // ------------------------------------------- external (Yomitan) popup pause
  private lastTokenHoverAt = 0;
  private extPopups = new Set<HTMLIFrameElement>();
  private extPaused = false;
  private extEvalTimer = 0;

  /** "Pause on lookup" for OTHER dictionary extensions (Yomitan): their popup is an
   *  iframe from a foreign chrome-extension:// origin. When one appears while the
   *  pointer was just over our subtitles, pause; resume when it hides/disappears.
   *  Honors the same pauseMode === "onLookup" setting as our own popup. */
  private installExternalPopupPause(): void {
    const ours = chrome.runtime.id;
    const attrObs = new MutationObserver(() => this.scheduleExtEval());
    const register = (fr: HTMLIFrameElement) => {
      if (!fr.src.startsWith("chrome-extension://") || fr.src.includes(ours) || this.extPopups.has(fr)) return;
      this.extPopups.add(fr);
      attrObs.observe(fr, { attributes: true, attributeFilter: ["style", "class"] });
    };
    const scan = (node: Element) => {
      if (node instanceof HTMLIFrameElement) register(node);
      node.querySelectorAll?.("iframe[src^='chrome-extension://']").forEach((f) => register(f as HTMLIFrameElement));
    };
    const obs = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n instanceof Element) scan(n);
      this.scheduleExtEval(); // additions AND removals re-evaluate visibility
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    scan(document.documentElement);
  }

  private scheduleExtEval(): void {
    clearTimeout(this.extEvalTimer);
    this.extEvalTimer = window.setTimeout(() => this.evalExternalPopups(), 80);
  }

  private evalExternalPopups(): void {
    let visible = false;
    for (const fr of [...this.extPopups]) {
      if (!fr.isConnected) {
        this.extPopups.delete(fr);
        continue;
      }
      const r = fr.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) visible = true;
    }
    if (visible) {
      // Only when the pointer was on OUR subtitles just now — a Yomitan scan elsewhere
      // on the page (comments, titles) shouldn't pause the video.
      if (performance.now() - this.lastTokenHoverAt < 2500) {
        this.extPaused = true;
        this.pauseForLookup();
      }
    } else if (this.extPaused && !this.lookup.isOpen()) {
      this.extPaused = false;
      this.resumeAfterLookup();
    }
  }

  private pauseForLookup(): void {
    if (this.settings.pauseMode !== "onLookup") return;
    const v = this.currentVideo;
    if (v && !v.paused) {
      v.pause();
      this.hoverPaused = true;
    }
  }

  /** Resume once the look-up popup closes (pauseMode "onLookup"). */
  private resumeAfterLookup(): void {
    if (this.settings.pauseMode !== "onLookup" || !this.hoverPaused) return;
    this.hoverPaused = false;
    this.playVideo();
  }

  private async setStatus(dict: string, status: KnownStatus): Promise<void> {
    await this.known.set(dict, status);
  }

  private onKnownChanged(): void {
    this.toolbar.setKnownCount(this.known.countKnown());
    refreshTokenStatuses(this.overlay.el, this.known);
  }

  /** Mined set changed (a new mine, or a backfill from Anki) — refresh the "mined"
   *  markers on words (overlay + browser) and the ✓ on mined browser rows. */
  private onMinedChanged(): void {
    const isMined = (d: string) => this.mined.hasWord(d);
    refreshTokenStatuses(this.overlay.el, this.known, isMined);
    refreshTokenStatuses(this.browser.el, this.known, isMined);
    this.browser.refreshMined((text) => this.mined.hasSentence(text));
    this.lookup.refreshMined(isMined); // if the popup is open, update its ＋/✓ after a sync
  }

  private async fetchLookup(token: Token, candidates: string[] = []): Promise<LookupResult> {
    const res = (await chrome.runtime.sendMessage({
      type: "lookup",
      term: token.dict,
      surface: token.surface,
      reading: token.reading,
      lang: this.settings.targetLang,
      candidates: candidates.length ? candidates : undefined,
    })) as BgResponse;
    if (!res || !res.ok) throw new Error(res?.error ?? "lookup failed");
    return res.result;
  }

  /** Online source (Jisho/Wiktionary), fetched after offline so the popup is instant. */
  private async fetchOnline(term: string): Promise<DictSection | null> {
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "lookupOnline",
        term,
        lang: this.settings.targetLang,
      })) as OnlineResponse;
      return res && res.ok ? res.section : null;
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------------- navigation
  private jumpCue(dir: -1 | 1): void {
    const cues = this.targetTrack?.cues ?? [];
    if (!cues.length || !this.currentVideo) return;
    const t = this.currentVideo.currentTime - this.settings.subOffset;
    const idx = findCueAt(cues, t, this.targetHint);
    let next: Cue | undefined;
    if (idx >= 0) {
      next = cues[idx + dir];
    } else {
      // in a gap: find the upcoming/preceding cue
      const after = cues.findIndex((c) => c.start > t);
      next = dir > 0 ? cues[after] : cues[after - 1] ?? cues[cues.length - 1];
    }
    if (next) this.seek(next.start + 0.01 + this.settings.subOffset);
  }

  private replayCue(): void {
    const cues = this.targetTrack?.cues ?? [];
    const cue = cues[this.targetHint];
    if (cue) this.seek(cue.start + 0.01 + this.settings.subOffset);
    this.playVideo();
  }

  private scheduleAutoResume(): void {
    clearTimeout(this.resumeTimer);
    if (this.settings.autoResume > 0) {
      this.resumeTimer = window.setTimeout(() => this.playVideo(), this.settings.autoResume * 1000);
    }
  }

  // ----------------------------------------------------------------- tracks
  private setTargetTrack(track: SubtitleTrack | null): void {
    this.targetTrack = track;
    this.targetTrackMediaKey = track ? this.mediaKey : null;
    this.targetTrackVideo = track ? this.currentVideo : null;
    this.activeTargetId = -1;
    this.targetHint = 0;
    this.activeCue = null;
    this.activeCueText = "";
    // Wipe any line still painted on screen now. syncTarget short-circuits when the cue id
    // is unchanged, so for a cleared (null) track it would otherwise leave the last line up;
    // a real new track simply re-renders on the next tick.
    this.overlay.setTarget([]);
    this.loadBookmarks();
    this.refreshBrowserTrack();
    this.reflectChrome();
    // When we show our own overlay from a YouTube track, hide YouTube's native
    // captions so they don't double up (we still rely on its fetch for the data).
    this.hideNativeCaptions(track?.source === "youtube");
    if (track && normalizeLang(track.lang) === "ja") this.warmTokenizer();
    this.onTrackChange?.(track);
    // A new target track → (re)resolve the secondary line: prime machine translation for it,
    // or pick up an official track. (Skip while clearing — null is handled by the sync loop.)
    if (track) this.updateSecondary();
    // Push to any registered player iframes — the frame that owns the <video> may be nested.
    if (!this.adoptingRemote) this.pushToClients("track", { role: "target", track });
    // Remember this pick so a reload restores it (skips YouTube/MT — those re-load themselves).
    this.persistTrack();
  }

  /** Send a message to every registered sub-frame (player iframe). */
  private pushToClients(kind: string, payload: Record<string, unknown>): void {
    for (const w of this.frameClients) frameSend(w, kind, payload);
  }

  private nativeCaptionStyle: HTMLStyleElement | null = null;
  private hideNativeCaptions(hide: boolean): void {
    if (!/youtube\.com$/.test(location.hostname) && !location.hostname.endsWith(".youtube.com")) return;
    if (hide && !this.nativeCaptionStyle) {
      const style = document.createElement("style");
      style.id = "tnm-hide-native-captions";
      style.textContent = ".ytp-caption-window-container, .caption-window { display: none !important; }";
      document.head.append(style);
      this.nativeCaptionStyle = style;
    } else if (!hide && this.nativeCaptionStyle) {
      this.nativeCaptionStyle.remove();
      this.nativeCaptionStyle = null;
    }
  }

  private setSecondaryTrack(track: SubtitleTrack | null): void {
    this.secondaryTrack = track;
    this.secondaryHint = 0;
    this.refreshBrowserTrack();
    if (!this.adoptingRemote) this.pushToClients("track", { role: "secondary", track });
  }

  /** A message from another frame (see frameBus). A player iframe registers with us and
   *  adopts the track we loaded; we reply directly to its window (msg source), bypassing any
   *  intermediate frames. */
  onFrameMessage(msg: FrameMsg, source: Window | null): void {
    if (msg.kind === "requestTrack") {
      if (source) this.frameClients.add(source);
      if (this.targetTrack) frameSend(source, "track", { role: "target", track: this.targetTrack });
      if (this.secondaryTrack) frameSend(source, "track", { role: "secondary", track: this.secondaryTrack });
      return;
    }
    if (msg.kind === "requestPageInfo") {
      if (source) this.frameClients.add(source);
      // Only the frame that owns the real page identity should answer.
      if (this.isTopFrame()) frameSend(source, "pageInfo", { href: location.href, title: detectPageTitle() ?? document.title });
      return;
    }
    if (msg.kind === "pageInfo") {
      const { href, title } = msg as { href?: string; title?: string };
      const firstHref = href && !this.topPageInfo;
      if (href) this.topPageInfo = { href, title };
      // In a player iframe the true media identity is the top page's URL, which arrives here
      // (relayed) after we start — retry the restore now that persistKey() is correct.
      if (firstHref) this.restorePersistedForMedia().catch(() => {});
      return;
    }
    if (msg.kind === "track") {
      const { role, track } = msg as { role?: string; track?: SubtitleTrack | null };
      this.adoptingRemote = true;
      try {
        if (role === "secondary") this.setSecondaryTrack(track ?? null);
        else this.setTargetTrack(track ?? null);
      } finally {
        this.adoptingRemote = false;
      }
    }
  }

  private refreshBrowserTrack(): void {
    const cues = this.targetTrack?.cues ?? [];
    this.rebuildSecondaryAlignment();
    this.browser.setTrack(
      cues,
      (cue) => this.secondaryTextFor(cue),
      (cue) => this.renderTargetLine(cue.text), // hover/click-to-lookup, same as the overlay
    );
    this.browser.refreshBookmarks();
  }

  // Per-target-cue translation for the browser (see alignSecondaryToTarget): each
  // translation cue is shown once, on the target line it overlaps most, rather
  // than repeated across every line a sentence-level translation happens to span.
  private secondaryByTargetId = new Map<number, string>();
  private rebuildSecondaryAlignment(): void {
    this.secondaryByTargetId = alignSecondaryToTarget(this.targetTrack?.cues ?? [], this.secondaryTrack?.cues ?? []);
  }

  private secondaryTextFor(cue: Cue): string {
    if (this.mtOn) return this.mtCache.get(cue.text.trim()) ?? "";
    return this.secondaryByTargetId.get(cue.id) ?? "";
  }

  // ----------------------------------------------------------------- bookmarks
  private bookmarkKey(): string {
    return `tnm:bookmarks:${this.mediaKey}:${this.targetTrack?.id ?? "none"}`;
  }
  private async loadBookmarks(): Promise<void> {
    const key = this.bookmarkKey();
    const got = await chrome.storage.local.get(key);
    this.bookmarks = new Set<number>(got[key] ?? []);
    this.browser.refreshBookmarks();
  }
  private async toggleBookmark(id: number): Promise<void> {
    if (this.bookmarks.has(id)) this.bookmarks.delete(id);
    else this.bookmarks.add(id);
    await chrome.storage.local.set({ [this.bookmarkKey()]: [...this.bookmarks] });
  }

  // ----------------------------------------------------------------- import
  private importFile(): void {
    const input = el("input", { type: "file", accept: ".srt,.vtt,.ass,.ssa,.txt", class: "tnm-hidden-file" }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) this.loadSubtitleFile(file);
    });
    this.host.layer.append(input);
    input.click();
    setTimeout(() => input.remove(), 1000);
  }

  /** Parse a subtitle file and load it as the target track. Public so the standalone
   *  player page can hand off a dropped file. Returns false if it couldn't be parsed. */
  async loadSubtitleFile(file: File): Promise<boolean> {
    const text = await file.text();
    const cues = parseSubtitleFile(file.name, text);
    if (!cues.length) {
      this.toast("Couldn't parse that subtitle file.");
      return false;
    }
    this.setTargetTrack({
      id: "file:" + file.name,
      label: file.name,
      lang: this.settings.targetLang,
      role: "target",
      source: "file",
      cues,
    });
    this.patch({ browserOpen: true });
    this.toast(`Loaded ${cues.length} lines from ${file.name}`);
    return true;
  }

  private isTopFrame(): boolean {
    try {
      return window.top === window.self;
    } catch {
      return false; // cross-origin ancestor → we're in a sub-frame
    }
  }

  /** Push this (top) frame's URL + cleaned title to registered sub-frames for their detection. */
  private broadcastPageInfo(): void {
    this.pushToClients("pageInfo", { href: location.href, title: detectPageTitle() ?? document.title });
  }

  // ----------------------------------------------------------------- jimaku.cc
  /** Call the background jimaku proxy (auth + CORS handled there). */
  private async jimakuApi(action: "search" | "files" | "download", params: { query?: string; entryId?: number; url?: string; anilistId?: number }): Promise<unknown> {
    const res = (await chrome.runtime.sendMessage({ type: "jimaku", action, ...params })) as JimakuResponse;
    if (!res?.ok) throw new Error(res?.error ?? "Jimaku request failed");
    return res.result;
  }

  /** Scrape the host page for clues to find subtitles automatically: an AniList id
   *  (preferred), a MAL id (mapped to AniList), a title fallback, and the episode
   *  number from the URL. Best-effort — anything missing is just left undefined. */
  private async detectMedia(): Promise<MediaHint> {
    const hint: MediaHint = {};
    // When the app runs inside the player iframe (a nested cross-origin frame), our own
    // location is the embed host (e.g. strm.cx) — useless for detection. Use the top frame's
    // URL/title, relayed via the frame bus, so the show/episode come from the real page.
    const href = this.topPageInfo?.href ?? location.href;
    const domAnilist = matchIdFromLinks(/anilist\.co\/anime\/(\d+)/i);
    const malId = matchIdFromLinks(/myanimelist\.net\/anime\/(\d+)/i);
    if (malId) hint.malId = malId;
    hint.episode = episodeFromUrl(href);
    hint.title = this.topPageInfo?.title ?? detectPageTitle();
    // Prefer a DOM AniList link; otherwise, on an episode page (e.g. miruro), try the id in
    // the URL path. AniList validates it below and returns null if it isn't a real anime.
    const candidateId = domAnilist ?? (hint.episode != null ? anilistIdFromUrl(href) : undefined);
    if (candidateId) hint.anilistId = candidateId;
    // Resolve via AniList: maps MAL→AniList when needed, validates the candidate id, and
    // (crucially) gets the romaji/native/synonym titles to fall back on when an anilist_id
    // search is empty (Jimaku indexes those, not English titles).
    if (candidateId || malId) {
      try {
        const r = (await chrome.runtime.sendMessage({ type: "anilistResolve", anilistId: candidateId, malId })) as AnilistResolveResponse;
        if (r?.ok) {
          hint.anilistId = r.id ?? domAnilist; // drop an invalid URL-path id; keep a real DOM id
          if (r.titles.length) hint.titles = r.titles;
        }
      } catch {
        /* leave the candidate id as-is; page-title fallback still works */
      }
    }
    return hint;
  }

  // Page-load / SPA-navigation auto-load of Jimaku subtitles (gated by jimakuAutoLoad + key).
  private autoLoadedKey = "";
  private async autoLoadJimakuForPage(): Promise<void> {
    // Re-share the (possibly changed) page identity with player iframes on every nav.
    if (this.isTopFrame()) this.broadcastPageInfo();
    // A reload restored the subtitle you'd picked for this media — don't override it with the default.
    if (this.restoredTrackKey === this.persistKey() && this.targetTrack) return;
    if (!this.settings.jimakuAutoLoad || !this.settings.jimakuApiKey) return;
    let hint: MediaHint;
    try {
      hint = await this.detectMedia();
    } catch {
      return;
    }
    // Require a strong "anime episode page" signal so we don't query Jimaku on random pages.
    if (!hint.anilistId && hint.episode == null) return;
    const attempts = searchAttempts(hint);
    if (!attempts.length) return;
    const key = `${hint.anilistId ?? attempts[0].query ?? location.href}|ep${hint.episode ?? "?"}`;
    if (this.autoLoadedKey === key) return;
    this.autoLoadedKey = key;
    try {
      let entries: JimakuEntry[] = [];
      for (const a of attempts) {
        entries = (await this.jimakuApi("search", a)) as JimakuEntry[];
        if (entries.length) break;
      }
      if (!entries.length) return; // not on Jimaku — stay silent
      const entry = entries[0];
      const files = (await this.jimakuApi("files", { entryId: entry.id })) as JimakuFile[];
      const best = bestEpisodeFile(files, hint.episode ?? null);
      if (best) await this.loadJimakuFile(entry, best);
    } catch {
      this.autoLoadedKey = ""; // transient failure (e.g. key not ready) → allow retry
    }
  }

  /** Download a chosen jimaku.cc subtitle file and load it as the target track. */
  private async loadJimakuFile(entry: JimakuEntry, file: JimakuFile): Promise<void> {
    this.toast(`Downloading ${file.name}…`);
    try {
      const text = (await this.jimakuApi("download", { url: file.url })) as string;
      const cues = parseSubtitleFile(file.name, text);
      if (!cues.length) {
        this.toast("Couldn't parse that subtitle file.");
        return;
      }
      this.setTargetTrack({
        id: `jimaku:${entry.id}:${file.name}`,
        label: file.name,
        lang: this.settings.targetLang,
        role: "target",
        source: "jimaku",
        cues,
      });
      this.patch({ browserOpen: true });
      this.toast(`Loaded ${cues.length} lines from ${file.name}`);
    } catch (e) {
      this.toast("Jimaku: " + String((e as Error)?.message ?? e));
    }
  }

  // ----------------------------------------------------------------- LRCLIB (song lyrics)
  private async lrclibApi(opts: { q?: string; trackName?: string; artistName?: string }): Promise<LrclibHit[]> {
    const res = (await chrome.runtime.sendMessage({ type: "lrclib", action: "search", ...opts })) as LrclibResponse;
    if (!res?.ok) throw new Error(res?.error ?? "LRCLIB request failed");
    return res.hits;
  }

  /** Load a chosen LRCLIB hit's synced lyrics as the target track. */
  private loadLyrics(hit: LrclibHit): void {
    if (!hit.syncedLyrics) {
      this.toast("That result has no synced lyrics.");
      return;
    }
    const cues = normalizeCues(parseLrc(hit.syncedLyrics));
    if (!cues.length) {
      this.toast("Couldn't parse those lyrics.");
      return;
    }
    this.setTargetTrack({
      id: `lrclib:${hit.id}`,
      label: `${hit.trackName} — ${hit.artistName}`,
      lang: this.settings.targetLang,
      role: "target",
      source: "lrclib",
      cues,
    });
    this.patch({ browserOpen: true });
    this.toast(`Loaded lyrics: ${hit.trackName} (${cues.length} lines)`);
  }

  // ----------------------------------------------------------------- youtube
  private onWindowMessage(e: MessageEvent): void {
    const data = e.data;
    if (!data || data.source !== "tnm-yt") return;
    if (data.kind === "videoChanged") {
      if (data.videoId !== this.ytVideoId) {
        this.ytVideoId = data.videoId;
        this.setMediaKey(location.origin + "/watch?v=" + data.videoId);
        this.ytTracks = [];
        this.targetTrackAsr = false;
        this.captionTries = 0;
        clearTimeout(this.captionHintTimer);
        this.setTargetTrack(null);
        this.setSecondaryTrack(null);
      }
    } else if (data.kind === "tracks") {
      this.ytVideoId = data.videoId;
      this.setMediaKey(location.origin + "/watch?v=" + data.videoId);
      this.ytTracks = data.tracks;
      const tracks = data.tracks as YtCaptionTrack[];
      const langs = tracks.map((t) => t.lang + (t.kind === "asr" ? "(asr)" : "")).join(", ");
      console.info("[tnm] YouTube caption tracks:", langs || "none");
      // The cues arrive via captionData (intercepted from YouTube's own request).
      // Auto-enable the target-language captions so that request fires — no manual
      // CC click needed. We still intercept + hide YouTube's native rendering.
      const haveTarget = tracks.some((t) => normalizeLang(t.lang) === normalizeLang(this.settings.targetLang));
      if (haveTarget && !this.targetTrack && this.settings.enabled) {
        this.captionTries = 0;
        window.postMessage(
          { source: "tnm-cmd", cmd: "enableCaptions", lang: this.settings.targetLang, translateTo: this.translateTo() },
          "*",
        );
        this.scheduleCaptionRetry();
      }
      // Now that we know the available tracks, resolve the secondary line (official vs MT) and
      // refresh the settings panel's grey-out state.
      this.updateSecondary();
    } else if (data.kind === "captionData") {
      this.loadYtCaptionData(data.lang, data.body, !!data.asr);
    }
  }

  /**
   * Load caption data captured from YouTube's own request (the reliable path —
   * see the inject). Routes to target or secondary track by language.
   */
  private loadYtCaptionData(lang: string, body: string, asr = false): void {
    const cues = normalizeCues(parseYoutubeTimedText(body, lang));
    if (!cues.length) return;
    const l = normalizeLang(lang);
    if (l === normalizeLang(this.settings.targetLang)) {
      // Don't let an auto-generated track clobber a human-made one already loaded.
      if (this.targetTrack && !this.targetTrackAsr && asr) return;
      const wasEmpty = !this.targetTrack;
      clearTimeout(this.captionHintTimer);
      this.targetTrackAsr = asr;
      this.setTargetTrack({
        id: "yt:" + lang + ":" + this.ytVideoId,
        label: `YouTube · ${lang}${asr ? " (auto)" : ""}`,
        lang,
        role: "target",
        source: "youtube",
        cues,
      });
      console.info(`[tnm] loaded ${cues.length} YouTube captions (${lang}${asr ? ", asr" : ""})`);
      if (wasEmpty) this.toast(`Loaded ${cues.length} YouTube subtitles (${lang})`);
    } else if (l === normalizeLang(this.settings.nativeLang) && l !== normalizeLang(this.settings.targetLang)) {
      this.setSecondaryTrack({
        id: "yt-sec:" + lang + ":" + this.ytVideoId,
        label: `Translation · ${lang}`,
        lang,
        role: "secondary",
        source: "youtube",
        cues,
      });
      console.info(`[tnm] loaded ${cues.length} translation captions (${lang})`);
    }
  }

  /** The language for YouTube to auto-translate the target track into (empty = none). Only when
   *  we're relying on YouTube's own machine translation (see secondaryMode → "yt-translate"). */
  private translateTo(): string {
    return this.secondaryMode() === "yt-translate" ? this.settings.nativeLang : "";
  }

  /**
   * Auto-enabling captions can miss the first time (player module not ready, or
   * YouTube doesn't fetch the track), so retry the enable a few times before
   * giving up — this is what otherwise needs a manual CC-button click.
   */
  private captionTries = 0;
  private scheduleCaptionRetry(): void {
    clearTimeout(this.captionHintTimer);
    this.captionHintTimer = window.setTimeout(() => {
      if (this.targetTrack || !this.settings.enabled) return; // captions arrived (or disabled)
      if (this.captionTries++ < 5) {
        window.postMessage(
          { source: "tnm-cmd", cmd: "enableCaptions", lang: this.settings.targetLang, translateTo: this.translateTo() },
          "*",
        );
        this.scheduleCaptionRetry();
      } else {
        this.toast("Couldn't auto-load captions — try YouTube's CC button or import a file.");
      }
    }, 2500);
  }

  // ----------------------------------------------------------------- misc
  private async warmTokenizer(): Promise<void> {
    try {
      await initTokenizer(this.settings.targetLang);
      this.activeTargetId = -1; // re-render the overlay with furigana once ready
      this.refreshBrowserTrack(); // re-tokenize browser rows now that boundaries are accurate
    } catch (e) {
      console.warn("[tnm] tokenizer init failed", e);
    }
  }

  private installDismiss(): void {
    const close = () => {
      this.lookup.hide();
      if (this.settingsPanel.isOpen()) {
        this.settingsPanel.close();
        this.toolbar.setSettingsActive(false);
      }
      this.jimakuPanel.close();
      this.lyricsPanel.close();
      if (this.queuePanel.isOpen() && !this.queueMining) {
        this.queuePanel.close();
        this.toolbar.setQueueActive(false);
      }
    };
    // Clicks inside popovers/toolbar call stopPropagation, so these only fire for "outside" clicks.
    this.host.shadow.addEventListener("pointerdown", close);
    document.addEventListener("pointerdown", close, false);
    this.toolbar.el.addEventListener("pointerdown", (e) => e.stopPropagation());
  }

  /** True if the event target is one of OUR shadow-DOM fields (search boxes etc.). */
  private isOurField(node: EventTarget | null | undefined): boolean {
    const el = node as HTMLElement | null;
    const tag = el?.tagName;
    const editable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
    return editable && el?.getRootNode?.() === this.host.shadow;
  }

  private installHotkeys(): void {
    // While typing in OUR search boxes, the site's player grabs space / arrows in the
    // CAPTURE phase (before our input sees them) and preventDefaults — so space doesn't
    // type and arrows seek the video. Beat it with an early capture-phase shield that
    // stops just those keys from propagating to the page (the input's own typing /
    // cursor-move default still happens; Enter/Escape/letters pass through normally).
    const SHIELD = new Set([" ", "Spacebar", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
    window.addEventListener(
      "keydown",
      (e) => {
        if (SHIELD.has(e.key) && this.isOurField(e.composedPath?.()[0] ?? e.target)) e.stopImmediatePropagation();
      },
      true,
    );

    document.addEventListener(
      "keydown",
      (e) => {
        // Hold a lookup modifier (Ctrl/Alt/…) while hovering a word → look it up now,
        // even if the pointer hasn't moved since pressing the key.
        if ((e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") && this.settings.holdLookup && this.hovered) {
          this.maybeHoverLookup({ ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey, clientX: this.lastMouse.x, clientY: this.lastMouse.y });
          return;
        }
        if (!this.settings.enabled || !this.currentVideo) return;
        // Events from our shadow-DOM inputs (the Jimaku / browser search boxes) retarget
        // to the host at document level, so check the REAL composed target, not e.target —
        // otherwise typing "a"/"d"/"s" in a search box fires the line-nav shortcuts.
        const t = ((e.composedPath?.()[0] as HTMLElement) ?? (e.target as HTMLElement));
        const tag = t?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const k = e.key.toLowerCase();
        const s = this.settings;
        if (k === s.keyPrevLine) this.jumpCue(-1);
        else if (k === s.keyNextLine) this.jumpCue(1);
        else if (k === s.keyReplayLine) this.replayCue();
        else return;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );

    // Releasing the look-up key removes the sub-piece highlight (keyup flags reflect the
    // post-release modifier state).
    document.addEventListener("keyup", (e) => { if (!this.modHeld(e, this.settings.keyLookup)) this.hideSubHl(); }, true);

    // Drag-select a sub-piece of a word → look up exactly that span. Gated behind the
    // sub-piece modifier (so plain drags aren't hijacked) + the overlay-scope toggle.
    this.host.layer.addEventListener("mouseup", (e) => this.onSelectionMouseUp(e));
  }

  private onSelectionMouseUp(e: MouseEvent): void {
    if (!this.settings.holdLookup || !this.modHeld(e, this.settings.keyLookup)) return;
    const root = this.host.shadow as unknown as { getSelection?: () => Selection | null };
    const sel = root.getSelection?.() ?? window.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (!text) return;
    const range = sel.getRangeAt(0);
    const anc = range.commonAncestorContainer;
    const host = (anc.nodeType === Node.ELEMENT_NODE ? anc : anc.parentElement) as HTMLElement | null;
    if (!host) return;
    const inBrowser = !!host.closest(".TnmBrowser__list__item");
    if (!inBrowser && !this.settings.holdLookupOverlay) return; // overlay selection disabled
    const rowEl = host.closest(".TnmBrowser__list__item") as HTMLElement | null;
    this.openSelectionLookup(text, rowEl, range.getBoundingClientRect());
  }

  private toastEl: HTMLElement | null = null;
  private toastTimer = 0;
  private toast(msg: string): void {
    if (!this.toastEl) {
      this.toastEl = el("div", { class: "tnm-toast" });
      this.host.layer.append(this.toastEl);
    }
    this.toastEl.textContent = msg;
    this.toastEl.style.display = "";
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      if (this.toastEl) this.toastEl.style.display = "none";
    }, 3500);
  }
}

/** Find the cue covering time t, using a hint index to stay O(1) while playing. */
/** Blob → base64 (no data: prefix) via FileReader. Splits on "base64," (not the
 *  first comma) because video MIME types contain a comma, e.g. codecs=vp9,opus. */
function blobToDataBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      const i = s.indexOf("base64,");
      resolve(i >= 0 ? s.slice(i + 7) : "");
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// yomitanGlossary moved to ./ui/structured (shared with the reader page).

function findCueAt(cues: Cue[], t: number, hint: number): number {
  if (!cues.length) return -1;
  const within = (i: number) => i >= 0 && i < cues.length && t >= cues[i].start && t < cues[i].end;
  if (within(hint)) return hint;
  if (within(hint + 1)) return hint + 1;
  // binary search
  let lo = 0,
    hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < cues[mid].start) hi = mid - 1;
    else if (t >= cues[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}
