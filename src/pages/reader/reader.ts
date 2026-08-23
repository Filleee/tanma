// TANMA! Reader — texthooker page for VNs/games. Connects to tanma-hook (or Textractor's
// WebSocket plugin) on a local WebSocket, renders each hooked line through the same
// pipeline as subtitles (kuromoji tokens, furigana, known-status colors, click-to-look-up,
// reading switcher), and mines to Anki. When tanma-hook is the source, mining also asks it
// for a game screenshot and the line's audio (cut retroactively from its rolling buffer by
// the line's timestamp — so the voice that already played is still captured correctly).
import overlayCss from "../../content/ui/overlay.css?inline";
import { LookupPopup } from "../../content/ui/LookupPopup";
import { renderSentence, refreshTokenStatuses, tokenContextOf } from "../../content/ui/tokens";
import { buildCandidates } from "../../lib/compound";
import { mergeCompoundTokens } from "../../lib/mergeTokens";
import { pitchFields } from "../../lib/pitch";
import { yomitanGlossary } from "../../content/ui/structured";
import { buildLapisFields } from "../../lib/anki/fields";
import { initTokenizer, tokenize, normalizeLang } from "../../lib/tokenizer";
import { KnownWordsStore, MinedStore, loadSettings, migrateLegacyKeys, saveHostSettings } from "../../lib/storage";
import { applyAccentVars } from "../../lib/theme";
import type {
  AnkiMineResponse,
  AudioResponse,
  BgResponse,
  DictSection,
  KnownStatus,
  HasTermsResponse,
  LookupResult,
  OnlineResponse,
  Settings,
  Token,
  TranslateResponse,
} from "../../common/types";

const MEDIA_STYLE = "max-width:480px;max-height:360px;height:auto";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The reader keeps its own display preferences, scoped like a site's ("reader"),
 *  so furigana/translation here don't affect your video-page settings. */
const READER_SCOPE = "reader";

const LANGS: [string, string][] = [
  ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["en", "English"],
  ["id", "Indonesian"], ["es", "Spanish"], ["fr", "French"], ["de", "German"],
  ["pt", "Portuguese"], ["it", "Italian"], ["ru", "Russian"],
];

interface Line {
  text: string;
  time: number; // epoch seconds — tanma-hook's clock for audio slicing
  process: string;
  hookKey: string; // which hook thread produced it (games emit several)
  speaker?: string; // from the designated "name hook" thread (VNs put names on their own hook)
  el: HTMLElement;
}

class Reader {
  private settings!: Settings;
  private known!: KnownWordsStore;
  private mined = new MinedStore();
  private lookup = new LookupPopup();
  private lines: Line[] = [];
  private ws: WebSocket | null = null;
  private wantConnect = false;
  private retryTimer = 0;
  private hookCapable = false; // true when the source answers capture requests (tanma-hook)
  private captureWaiters = new Map<string, (msg: Record<string, unknown>) => void>();
  private captureSeq = 0;
  private charCount = 0;
  private minedCount = 0;
  private startedAt = Date.now();
  private lookupToken: { token: Token; line: Line } | null = null;
  /** Hook threads seen (key → label), and the user's pick ("" = show all). Games emit
   *  several threads (UI, choices, dialogue, dirty glyph hooks) — picking the clean
   *  dialogue thread is the standard texthooker step. Remembered per game process. */
  private hooksSeen = new Map<string, string>();
  /** Latest line seen per hook — shown as a preview in the picker so you can tell which thread
   *  is the clean dialogue without clicking each one. */
  private lastByHook = new Map<string, string>();
  private hookFilter = "";
  private currentProcess = "";
  /** The hook thread that carries the speaker NAME (VNs render it separately). Its
   *  emissions become a label on the next dialogue line instead of list rows. */
  private nameHook = "";
  private lastName: { text: string; time: number } | null = null;

  async start(): Promise<void> {
    await migrateLegacyKeys();
    this.settings = await loadSettings(READER_SCOPE); // global ⊕ the reader's own display prefs
    applyAccentVars(document.documentElement, this.settings.accent || "#ff9345");

    // Token/lookup styles come from the same overlay.css the in-page UI uses; the page's
    // <body class="tnm-root -tnm-furigana -tnm-show-known-status"> scopes them here.
    const style = document.createElement("style");
    style.textContent = overlayCss;
    document.head.append(style);
    this.applyDisplayFlags();

    // The look-up popup lives in a viewport-fixed layer (same coordinates the popup expects).
    const layer = document.createElement("div");
    layer.className = "tnm-layer";
    layer.append(this.lookup.el);
    document.body.append(layer);

    this.known = new KnownWordsStore(this.settings.targetLang);
    await Promise.all([this.known.load(), this.mined.load()]);
    const isMined = (d: string) => this.mined.hasWord(d);
    this.known.onChange(() => refreshTokenStatuses($("lines"), this.known, isMined));
    this.mined.onChange(() => {
      refreshTokenStatuses($("lines"), this.known, isMined);
      this.lookup.refreshMined(isMined);
    });

    // Live-sync settings edited in the dashboard/popup while this tab is open
    // (e.g. enabling Anki mining, changing accent/furigana).
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes["tnm:settings"]) return;
      loadSettings(READER_SCOPE).then((s) => {
        this.settings = s;
        applyAccentVars(document.documentElement, s.accent || "#ff9345");
        this.applyDisplayFlags();
      });
    });

    // Lines are tokenized once on arrival, so make sure kuromoji is ready BEFORE we
    // connect — otherwise the first lines would render without furigana/lookups.
    this.setConn(false, "loading tokenizer…");
    await initTokenizer(this.settings.targetLang).catch(() => {});

    // Dismiss the popup on outside clicks / Escape (the popup stops its own pointerdown).
    document.addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest?.(".tnm-token")) this.lookup.hide();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.lookup.hide();
    });

    this.wireHeader();
    this.wireSettings();
    window.setInterval(() => this.renderStats(), 1000);

    // Auto-connect to the last-used (or default) source.
    $("connect").click();
  }

  // ------------------------------------------------------------------ header
  private wireHeader(): void {
    const url = $<HTMLInputElement>("ws-url");
    url.value = localStorage.getItem("tnm-reader-ws") || "ws://127.0.0.1:6677";
    $("connect").addEventListener("click", () => {
      localStorage.setItem("tnm-reader-ws", url.value.trim());
      this.wantConnect = true;
      this.connect(url.value.trim());
    });
    $("clear").addEventListener("click", () => {
      this.lines = [];
      this.charCount = 0;
      $("lines").replaceChildren($("empty"));
      $("empty").style.display = "";
      this.renderStats();
    });
    const size = $<HTMLInputElement>("size");
    size.value = localStorage.getItem("tnm-reader-size") || "26";
    const applySize = () => {
      document.documentElement.style.setProperty("--line-size", `${size.value}px`);
      localStorage.setItem("tnm-reader-size", size.value);
    };
    size.addEventListener("input", applySize);
    applySize();
  }

  private setConn(on: boolean, label: string): void {
    $("conn").classList.toggle("-on", on);
    $("conn-label").textContent = label;
  }

  // -------------------------------------------------------- reader settings
  private applyDisplayFlags(): void {
    document.body.classList.toggle("-tnm-furigana", this.settings.showFurigana);
    document.body.classList.toggle("-tnm-show-known-status", this.settings.showKnownStatus);
    document.body.classList.toggle("-show-tr", this.mtOn());
  }

  private mtOn(): boolean {
    return (
      this.settings.showMachineTranslation &&
      !!this.settings.nativeLang &&
      normalizeLang(this.settings.nativeLang) !== normalizeLang(this.settings.targetLang)
    );
  }

  /** ⚙ popover: the reader's own display options (persisted under the "reader" scope). */
  private wireSettings(): void {
    const pop = $("settings-pop");
    $("settings").addEventListener("click", (e) => {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
    });
    pop.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.addEventListener("pointerdown", () => (pop.hidden = true));

    const target = $<HTMLSelectElement>("set-target");
    const native = $<HTMLSelectElement>("set-native");
    for (const [v, t] of LANGS) {
      target.append(new Option(t, v, false, v === this.settings.targetLang));
      native.append(new Option(t, v, false, v === this.settings.nativeLang));
    }
    const furi = $<HTMLInputElement>("set-furi");
    const status = $<HTMLInputElement>("set-status");
    const compound = $<HTMLInputElement>("set-compound");
    const mt = $<HTMLInputElement>("set-mt");
    furi.checked = this.settings.showFurigana;
    status.checked = this.settings.showKnownStatus;
    compound.checked = this.settings.compoundLookup;
    mt.checked = this.settings.showMachineTranslation;
    const reflect = () => ($("set-native-row").style.display = mt.checked ? "" : "none");
    reflect();

    const save = (patch: Partial<Settings>) => {
      this.settings = { ...this.settings, ...patch };
      saveHostSettings(this.settings, READER_SCOPE).catch(() => {});
      this.applyDisplayFlags();
    };
    furi.addEventListener("change", () => save({ showFurigana: furi.checked }));
    status.addEventListener("change", () => save({ showKnownStatus: status.checked }));
    compound.addEventListener("change", () => {
      save({ compoundLookup: compound.checked });
      // Re-segment what's on screen (cached merges make this instant).
      for (const line of this.lines) {
        line.el.querySelector(".tnm-sentence")?.replaceWith(this.renderLine(line));
      }
    });
    mt.addEventListener("change", () => {
      save({ showMachineTranslation: mt.checked });
      reflect();
      if (this.mtOn()) this.translateRecent();
    });
    native.addEventListener("change", () => {
      save({ nativeLang: native.value });
      this.translated = new WeakSet(); // language changed — old translations are stale
      if (this.mtOn()) this.translateRecent();
    });
    target.addEventListener("change", () => {
      save({ targetLang: target.value });
      void this.changeTargetLang(target.value);
    });
  }

  /** New target language: reload known-words + tokenizer; applies to new lines. */
  private async changeTargetLang(lang: string): Promise<void> {
    this.known = new KnownWordsStore(lang);
    await this.known.load();
    this.known.onChange(() => refreshTokenStatuses($("lines"), this.known, (d) => this.mined.hasWord(d)));
    await initTokenizer(lang).catch(() => {});
    this.toast(`Target language: ${lang} (applies to new lines)`);
  }

  // ------------------------------------------------- per-line translation (MT)
  private translated = new WeakSet<Line>();
  private trTimers = new WeakMap<Line, number>();

  /** Debounced: translate once the line stops growing (engines type it out per char). */
  private scheduleTranslate(line: Line): void {
    if (!this.mtOn()) return;
    clearTimeout(this.trTimers.get(line));
    this.trTimers.set(line, window.setTimeout(() => void this.translateLine(line), 1200));
  }

  private translateRecent(): void {
    this.translated = new WeakSet(); // re-translate: language or toggle changed
    for (const line of this.lines.slice(-20)) this.scheduleTranslate(line);
  }

  private async translateLine(line: Line): Promise<void> {
    if (!this.mtOn() || this.translated.has(line)) return;
    this.translated.add(line);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "translate",
        texts: [line.text],
        from: this.settings.targetLang,
        to: this.settings.nativeLang,
      })) as TranslateResponse;
      const txt = res?.ok ? res.texts[0] : "";
      if (!txt) return;
      let tr = line.el.querySelector<HTMLElement>(".line-tr");
      if (!tr) {
        tr = document.createElement("div");
        tr.className = "line-tr";
        line.el.append(tr);
      }
      tr.textContent = txt;
    } catch {
      this.translated.delete(line); // transient failure — allow a retry
    }
  }

  // ------------------------------------------------------------------ socket
  private connect(url: string): void {
    clearTimeout(this.retryTimer);
    try {
      this.ws?.close();
    } catch {
      /* previous socket already dead */
    }
    this.setConn(false, "connecting…");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.setConn(false, "bad URL");
      return;
    }
    this.ws = ws;
    this.hookCapable = false;
    ws.onopen = () => this.setConn(true, "connected");
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onclose = () => {
      if (this.ws !== ws) return; // superseded by a newer connection
      this.setConn(false, "disconnected — retrying…");
      if (this.wantConnect) this.retryTimer = window.setTimeout(() => this.connect(url), 3000);
    };
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let text = raw;
    let time = Date.now() / 1000;
    let process = "";
    let hookKey = "";
    let hookName = "";
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;
      const kind = msg.type;
      if (kind === "hello") {
        const caps = (msg.capabilities as string[]) ?? [];
        this.hookCapable = caps.includes("screenshot") || caps.includes("audio");
        this.setConn(true, `connected · ${String(msg.app ?? "source")}`);
        return;
      }
      if (kind === "media") {
        this.captureWaiters.get(String(msg.id))?.(msg);
        return;
      }
      if (kind === "status") return;
      // {"type":"text"} from tanma-hook, or {"sentence": …} from other plugins.
      const t = (msg.sentence ?? msg.text) as string | undefined;
      if (typeof t !== "string") return;
      text = t;
      if (typeof msg.time === "number") time = msg.time;
      if (typeof msg.process === "string") process = msg.process;
      if (typeof msg.hookKey === "string") hookKey = msg.hookKey;
      if (typeof msg.hook === "string") hookName = msg.hook;
    } catch {
      /* plain-text line (Textractor's plain mode) — use as-is */
    }
    // Defense in depth: never show hooker status messages as game text.
    if (/^(Textractor|vnreng):/.test(text)) return;
    this.trackHook(hookKey, hookName, process);
    this.updateHookPreview(hookKey, text.trim());
    this.addLine(text.trim(), time, process, hookKey);
  }

  /** Register a hook thread; show the pickers once a game emits more than one. */
  private trackHook(hookKey: string, hookName: string, process: string): void {
    if (process && process !== this.currentProcess) {
      this.currentProcess = process;
      this.hookFilter = localStorage.getItem(`tnm-reader-hook:${process}`) ?? "";
      this.nameHook = localStorage.getItem(`tnm-reader-namehook:${process}`) ?? "";
    }
    if (!hookKey || this.hooksSeen.has(hookKey)) return;
    this.hooksSeen.set(hookKey, hookName || `hook ${this.hooksSeen.size + 1}`);

    const sel = $<HTMLSelectElement>("hook-filter");
    sel.replaceChildren(new Option("All hooks", ""));
    for (const [key, name] of this.hooksSeen) {
      const o = new Option(this.hookLabel(key, name), key);
      o.title = this.lastByHook.get(key) || ""; // full latest line on hover
      sel.append(o);
    }
    sel.value = this.hookFilter && this.hooksSeen.has(this.hookFilter) ? this.hookFilter : "";
    sel.style.display = this.hooksSeen.size > 1 ? "" : "none";
    sel.onchange = () => {
      this.hookFilter = sel.value;
      if (this.currentProcess) localStorage.setItem(`tnm-reader-hook:${this.currentProcess}`, sel.value);
      this.applyHookFilter();
    };

    // Which thread carries the speaker name (e.g. 【ムラサメ】 fires just before dialogue).
    const nameSel = $<HTMLSelectElement>("name-hook");
    nameSel.replaceChildren(new Option("Name: (none)", ""));
    for (const [key, name] of this.hooksSeen) {
      const o = new Option(`Name: ${this.hookLabel(key, name)}`, key);
      o.title = this.lastByHook.get(key) || "";
      nameSel.append(o);
    }
    nameSel.value = this.nameHook && this.hooksSeen.has(this.nameHook) ? this.nameHook : "";
    nameSel.style.display = this.hooksSeen.size > 1 ? "" : "none";
    nameSel.onchange = () => {
      this.nameHook = nameSel.value;
      if (this.currentProcess) localStorage.setItem(`tnm-reader-namehook:${this.currentProcess}`, nameSel.value);
    };
  }

  /** "<name> — <latest line preview>" for a hook option (name alone until a line arrives). */
  private hookLabel(key: string, name: string): string {
    const p = (this.lastByHook.get(key) || "").replace(/\s+/g, " ").trim();
    return p ? `${name} — ${p.length > 40 ? p.slice(0, 40) + "…" : p}` : name;
  }

  /** Record a hook's newest line and refresh its picker option's preview (label + hover title). */
  private updateHookPreview(hookKey: string, text: string): void {
    if (!hookKey || !text) return;
    this.lastByHook.set(hookKey, text);
    const name = this.hooksSeen.get(hookKey);
    if (!name) return; // not registered yet — trackHook builds it with the preview
    const base = this.hookLabel(hookKey, name);
    for (const [id, prefix] of [["hook-filter", ""], ["name-hook", "Name: "]] as const) {
      for (const opt of Array.from($<HTMLSelectElement>(id).options)) {
        if (opt.value === hookKey) {
          opt.text = prefix + base;
          opt.title = text;
          break;
        }
      }
    }
  }

  /** Show only the chosen hook's lines (others stay in memory, hidden). */
  private applyHookFilter(): void {
    for (const line of this.lines) {
      line.el.style.display = !this.hookFilter || line.hookKey === this.hookFilter ? "" : "none";
    }
    const list = $("lines");
    list.scrollTop = list.scrollHeight;
  }

  /** Ask tanma-hook for a screenshot and/or an audio slice; resolves null on timeout. */
  private requestCapture(image: boolean, audioFrom: number | null, audioTo: number | null): Promise<Record<string, unknown> | null> {
    if (!this.hookCapable || this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const id = `cap${++this.captureSeq}`;
    this.ws.send(JSON.stringify({ type: "capture", id, image, audioFrom, audioTo }));
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.captureWaiters.delete(id);
        resolve(null);
      }, 10000);
      this.captureWaiters.set(id, (msg) => {
        clearTimeout(timer);
        this.captureWaiters.delete(id);
        resolve(msg);
      });
    });
  }

  // ------------------------------------------------------------------- lines
  private addLine(text: string, time: number, process: string, hookKey: string): void {
    if (!text) return;
    // Lines from the designated NAME thread aren't rows — remember the speaker and
    // attach it to the next dialogue line (VN engines fire name right before dialogue).
    if (this.nameHook && hookKey === this.nameHook) {
      this.lastName = { text: text.replace(/^【|】$/g, ""), time };
      return;
    }
    // The previous line from the SAME hook thread (many engines redraw the whole
    // growing line as each character appears).
    const prev = [...this.lines].reverse().find((l) => l.hookKey === hookKey);
    if (prev && time - prev.time < 30) {
      if (prev.text === text) return; // re-emit of the same line
      if (text.startsWith(prev.text)) {
        // The line GREW — update the existing render in place instead of appending a new
        // row per character. Keep the original timestamp: it anchors the audio slice.
        this.charCount += text.replace(/\s/g, "").length - prev.text.replace(/\s/g, "").length;
        prev.text = text;
        prev.el.querySelector(".tnm-sentence")?.replaceWith(this.renderLine(prev));
        this.translated.delete(prev);
        this.scheduleTranslate(prev); // (re)translate once it stops growing
        this.renderStats();
        return;
      }
      if (prev.text.startsWith(text)) return; // shrunk re-emit (redraw) — ignore
    }

    $("empty").style.display = "none";
    const lineEl = document.createElement("div");
    lineEl.className = "line";
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = new Date(time * 1000).toLocaleTimeString();
    lineEl.append(meta);

    const line: Line = { text, time, process, hookKey, el: lineEl };
    // Attach the speaker if the name thread fired for THIS line (just before it).
    if (this.lastName && time - this.lastName.time < 8) {
      line.speaker = this.lastName.text;
      this.lastName = null;
      const chip = document.createElement("span");
      chip.className = "line-speaker";
      chip.textContent = line.speaker;
      lineEl.append(chip);
    }
    lineEl.append(this.renderLine(line));
    if (this.hookFilter && hookKey !== this.hookFilter) lineEl.style.display = "none";

    this.lines[this.lines.length - 1]?.el.classList.remove("-latest");
    lineEl.classList.add("-latest");
    this.lines.push(line);
    this.charCount += text.replace(/\s/g, "").length;

    const list = $("lines");
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
    list.append(lineEl);
    if (atBottom) list.scrollTop = list.scrollHeight;
    this.scheduleTranslate(line);
    this.renderStats();
  }

  private renderLine(line: Line): HTMLElement {
    const tokens = tokenize(line.text, this.settings.targetLang);
    const sentence = this.renderTokens(tokens, line);
    // Dictionary-assisted merging (魔|族 → 魔族): patch the line once the check resolves.
    if (this.settings.compoundLookup && normalizeLang(this.settings.targetLang) === "ja") {
      mergeCompoundTokens(tokens, (t) => this.hasTerms(t))
        .then(({ tokens: merged, changed }) => {
          if (changed && sentence.isConnected) sentence.replaceWith(this.renderTokens(merged, line));
        })
        .catch(() => {});
    }
    return sentence;
  }

  private async hasTerms(terms: string[]): Promise<{ expression: string; reading: string }[]> {
    const res = (await chrome.runtime.sendMessage({ type: "hasTerms", terms })) as HasTermsResponse;
    return res?.ok ? res.found : [];
  }

  private renderTokens(tokens: Token[], line: Line): HTMLElement {
    return renderSentence(tokens, {
      known: this.known,
      showFurigana: true, // css class on <body> controls visibility
      mined: (dict) => this.mined.hasWord(dict),
      onClick: (token, tokenEl) => this.presentLookup(token, tokenEl, line),
      onMove: (token, tokenEl, ev) => {
        // Hold-to-look-up (Yomitan-style) with the configured modifier.
        if (!this.settings.holdLookup || !this.modHeld(ev)) return;
        if (this.lookupToken?.token === token && this.lookup.isOpen()) return;
        this.presentLookup(token, tokenEl, line);
      },
      onLeave: () => {},
    });
  }

  private modHeld(ev: MouseEvent): boolean {
    const key = (this.settings.keyLookup || "Alt").toLowerCase();
    if (key === "alt") return ev.altKey;
    if (key === "control") return ev.ctrlKey;
    if (key === "shift") return ev.shiftKey;
    if (key === "meta") return ev.metaKey;
    return ev.altKey;
  }

  // ------------------------------------------------------------------ lookup
  private presentLookup(token: Token, tokenEl: HTMLElement, line: Line): void {
    this.lookupToken = { token, line };
    // Multi-word expression candidates (歳+食っちゃい → 歳食う) from the rendered sentence.
    const tctx = this.settings.compoundLookup ? tokenContextOf(tokenEl) : undefined;
    const candidates = tctx ? buildCandidates(tctx.tokens, tctx.index) : [];
    // The headword the popup actually shows (the matched compound once promoted).
    const term = () => this.lookup.currentTerm() || token.dict;
    this.lookup.show({
      term: token.dict,
      reading: token.reading,
      selection: token.surface,
      selectionReading: token.reading,
      status: this.known.get(token.dict),
      anchor: tokenEl.getBoundingClientRect(),
      avoid: line.el.getBoundingClientRect(),
      fetchResult: () => this.fetchLookup(token, candidates),
      fetchOnline: () => this.fetchOnline(token.dict),
      onStatus: (s: KnownStatus) => void this.known.set(term(), s),
      onSpeak: (reading) => void this.playPronunciation(term(), reading || token.reading),
      // Always offer ＋ — the reader IS a mining surface; mineCard guides if Anki isn't set up.
      onMine: () => void this.mineCard(token, line, candidates),
      mined: this.mined.hasWord(token.dict),
      onClose: () => {
        this.lookupToken = null;
      },
    });
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

  private async fetchOnline(term: string): Promise<DictSection | null> {
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "lookupOnline",
        term,
        lang: this.settings.targetLang,
      })) as OnlineResponse;
      return res?.ok ? res.section : null;
    } catch {
      return null;
    }
  }

  private async playPronunciation(term: string, reading: string): Promise<void> {
    if (normalizeLang(this.settings.targetLang) === "ja") {
      try {
        const res = (await chrome.runtime.sendMessage({
          type: "audio",
          term,
          reading,
          lang: this.settings.targetLang,
        })) as AudioResponse;
        if (res?.ok && res.dataUrl) {
          await new Audio(res.dataUrl).play();
          return;
        }
      } catch {
        /* fall through to TTS */
      }
    }
    const u = new SpeechSynthesisUtterance(reading || term);
    u.lang = this.settings.targetLang;
    speechSynthesis.speak(u);
  }

  // ------------------------------------------------------------------ mining
  private async mineCard(token: Token, line: Line, candidates: string[] = []): Promise<void> {
    if (!this.settings.ankiEnabled || !this.settings.ankiDeck || !this.settings.ankiModel) {
      this.toast("Set up Anki mining first: Dashboard → Anki mining (enable + pick deck & note type).");
      return;
    }
    this.toast("Mining…");
    try {
      const result = await this.fetchLookup(token, candidates).catch(() => null);
      const sections = result?.sections ?? [];
      // A matched multi-word expression (歳食う) becomes the card's word.
      const dict = result?.matchedTerm || token.dict;
      const lemmaReading = this.lookup.currentReading() || result?.reading || token.reading;
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

      const stamp = Date.now();
      const media: { filename: string; dataBase64: string }[] = [];

      // Word audio (JapanesePod101, JA only) — same as video mining.
      let wordAudioFilename: string | undefined;
      if (this.settings.ankiCaptureWordAudio && normalizeLang(this.settings.targetLang) === "ja") {
        const res = (await chrome.runtime
          .sendMessage({ type: "audio", term: dict, reading: lemmaReading, lang: this.settings.targetLang })
          .catch(() => null)) as AudioResponse | null;
        const b64 = res?.ok ? res.dataUrl?.split(",")[1] : undefined;
        if (b64) {
          wordAudioFilename = `tnm_w_${stamp}.mp3`;
          media.push({ filename: wordAudioFilename, dataBase64: b64 });
        }
      }

      // Game screenshot + the line's audio, from tanma-hook. The audio window is
      // [line.time − preroll … next line's time], cut from its rolling buffer.
      let pictureHtml: string | undefined;
      let sentenceAudioFilename: string | undefined;
      const wantImage = this.settings.ankiCaptureImage && $<HTMLInputElement>("opt-image").checked;
      const wantAudio = this.settings.ankiCaptureSentenceAudio && $<HTMLInputElement>("opt-audio").checked;
      if (this.hookCapable && (wantImage || wantAudio)) {
        const idx = this.lines.indexOf(line);
        // Bound the audio at the next line from the SAME hook thread (other threads —
        // UI text, other textboxes — don't end this utterance).
        const next = idx >= 0 ? this.lines.slice(idx + 1).find((l) => l.hookKey === line.hookKey) : undefined;
        const from = wantAudio ? line.time - 0.35 : null;
        const to = wantAudio ? Math.min(next?.time ?? line.time + 15, line.time + 15) : null;
        const cap = await this.requestCapture(wantImage, from, to);
        const img = cap?.image as string | undefined;
        if (img) {
          const fn = `tnm_i_${stamp}.jpg`;
          media.push({ filename: fn, dataBase64: img });
          pictureHtml = `<img src="${fn}" style="${MEDIA_STYLE}">`;
        }
        const aud = cap?.audio as string | undefined;
        if (aud) {
          sentenceAudioFilename = `tnm_s_${stamp}.${(cap?.audioExt as string) || "wav"}`;
          media.push({ filename: sentenceAudioFilename, dataBase64: aud });
        }
      }

      // Pitch accent for the card (lapis' PitchPosition/PitchCategories fields).
      const pitchEntry = result?.pitches?.find((pe) => pe.reading === lemmaReading) ?? result?.pitches?.[0];
      const pitch = pitchEntry ? pitchFields(pitchEntry.positions, pitchEntry.reading) : { position: "", categories: "" };

      const fields = buildLapisFields({
        word: dict,
        reading: lemmaReading,
        surface: token.surface,
        sentence: line.text,
        definition,
        glossary,
        frequency,
        freqSort,
        pitchPosition: pitch.position,
        pitchCategories: pitch.categories,
        misc: `${line.speaker ? line.speaker + " · " : ""}${line.process || "game"} · TANMA Reader · ${new Date(line.time * 1000).toLocaleString()}`,
        wordAudioFilename,
        sentenceAudioFilename,
        pictureHtml,
      });

      const res = (await chrome.runtime.sendMessage({
        type: "ankiMine",
        card: { deck: this.settings.ankiDeck, model: this.settings.ankiModel, fields, media, tags: ["tnm", "tnm-reader"] },
      })) as AnkiMineResponse;

      if (res?.ok || res?.error === "duplicate") {
        await this.mined.add(dict, line.text); // also feeds the dashboard's recent-mines
        this.lookup.setMined(true);
        this.minedCount++;
        this.toast(res?.ok ? "✓ Added to Anki" : "Already in Anki (duplicate)");
      } else {
        this.toast("Anki: " + (res?.error ?? "failed"));
      }
    } catch (e) {
      this.toast("Mining failed: " + String((e as Error)?.message ?? e));
    }
    this.renderStats();
  }

  // -------------------------------------------------------------------- misc
  private toastTimer = 0;
  private toast(msg: string): void {
    const t = $("toast");
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.style.display = "none"), 2600);
  }

  private renderStats(): void {
    $("st-lines").textContent = String(this.lines.length);
    $("st-chars").textContent = String(this.charCount);
    $("st-mined").textContent = String(this.minedCount);
    const s = Math.floor((Date.now() - this.startedAt) / 1000);
    $("st-time").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
}

const reader = new Reader();
(window as unknown as { __tnmReader: Reader }).__tnmReader = reader;
reader.start().catch((e) => console.error("[tnm-reader] failed to start:", e));
