import type { DictSection, KnownStatus, LookupResult } from "../../common/types";
import { el, clear } from "./dom";
import { icons } from "./icons";
import { renderGlossary } from "./structured";
import { furiganaParts, hiraganaToKatakana, type FuriPart } from "../../lib/kana";
import { moraSplit, pitchPattern } from "../../lib/pitch";

export interface LookupOpts {
  /** The dictionary word (lemma), e.g. 思う. */
  term: string;
  /** Best-known reading of the word; refined to the dictionary's reading after lookup. */
  reading: string;
  /** The exact text selected in the sentence (e.g. 思います) — shown as a separate
   *  "Selected" line when it differs from the word. */
  selection?: string;
  /** Reading of the selected text (e.g. おもいます). */
  selectionReading?: string;
  status: KnownStatus;
  /** The word being looked up (for horizontal placement). */
  anchor: DOMRect;
  /** The whole subtitle block/row to keep clear (so adjacent words stay hoverable). */
  avoid?: DOMRect;
  fetchResult: () => Promise<LookupResult>;
  fetchOnline: () => Promise<DictSection | null>;
  onStatus: (status: KnownStatus) => void;
  /** Pronounce the word; receives the reading to speak (the lemma reading). */
  onSpeak: (reading: string) => void;
  onClose: () => void;
  /** Add this word to Anki (shown only when Anki mining is enabled). */
  onMine?: () => void;
  /** Whether the word is already mined / in the Anki deck — shows a ✓ instead of ＋. */
  mined?: boolean;
  /** Add this word+line to the mining queue (batch-mine later). Shown only when Anki is enabled. */
  onQueue?: () => void;
  /** Whether this word+line is already in the queue — shows a filled/checked state. */
  queued?: boolean;
}

/** Build a span of furigana parts (kanji runs get <ruby>, kana stays plain text).
 *  `rt` transforms the displayed reading (e.g. hiragana → katakana display mode). */
function furiEl(cls: string, surface: string, reading: string, rt: (s: string) => string = (s) => s): HTMLElement {
  const wrap = el("span", { class: cls });
  for (const p of furiganaParts(surface, reading) as FuriPart[]) {
    if (p.rt) {
      const ruby = el("ruby");
      ruby.append(el("span", {}, p.text), el("rt", {}, rt(p.rt)));
      wrap.append(ruby);
    } else {
      wrap.append(document.createTextNode(p.text));
    }
  }
  return wrap;
}

/** Bucket a frequency RANK (lower = more common) into a rarity band for colour-coding. */
function freqRarity(value: number): string {
  if (value <= 2000) return "1"; // very common
  if (value <= 5000) return "2"; // common
  if (value <= 10000) return "3"; // moderate
  if (value <= 25000) return "4"; // getting rare
  return "5"; // rare
}

const STATUSES: KnownStatus[] = ["UNKNOWN", "LEARNING", "KNOWN"];
const STATUS_LABEL: Record<string, string> = { UNKNOWN: "Unknown", LEARNING: "Learning", KNOWN: "Known" };

/** Definition card: term + readings + status + 🔊, then frequency badges,
 *  per-dictionary sections (merged), and kanji info. */
export class LookupPopup {
  readonly el: HTMLDivElement;
  private opts: LookupOpts | null = null;
  private reqId = 0;
  private wordEl: HTMLElement | null = null;
  private wordReading = "";
  private mineBtn: HTMLButtonElement | null = null;
  private queueBtn: HTMLButtonElement | null = null;
  /** The reading the user has selected for this word (defaults to the auto-picked one). Drives the
   *  displayed furigana, the 🔊 audio, and what gets mined into ExpressionReading. */
  private chosenReading = "";
  private readingsEl: HTMLElement | null = null;
  private lastReadings: string[] = [];
  private lastPitches: { reading: string; positions: number[] }[] = [];
  private pitchEl: HTMLElement | null = null;
  private selectionEl: HTMLElement | null = null;
  /** Display readings as katakana (internal values stay hiragana — mining is unaffected). */
  private kata = false;
  private kanaBtn: HTMLButtonElement | null = null;
  onHover?: (over: boolean) => void;

  constructor() {
    this.el = el("div", { class: "tnm-lookup" });
    this.el.style.display = "none";
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.el.addEventListener("mouseenter", () => this.onHover?.(true));
    this.el.addEventListener("mouseleave", () => this.onHover?.(false));
    // Restore the katakana display preference (display-only; stored values stay hiragana).
    try {
      chrome.storage.local.get("tnm:lookup-kata").then((got) => {
        this.kata = !!got["tnm:lookup-kata"];
        if (this.isOpen()) this.applyKanaMode();
      });
    } catch {
      /* storage unavailable (tests) — default hiragana */
    }
  }

  /** Display transform for readings: identity (hiragana) or katakana. */
  private k(s: string): string {
    return this.kata ? hiraganaToKatakana(s) : s;
  }

  isOpen(): boolean {
    return this.el.style.display !== "none";
  }

  hide(): void {
    if (!this.isOpen()) return;
    this.el.style.display = "none";
    const cb = this.opts?.onClose;
    this.opts = null;
    cb?.();
  }

  async show(opts: LookupOpts): Promise<void> {
    this.opts = opts;
    this.renderShell();
    this.el.style.display = "";
    this.position();

    const id = ++this.reqId;
    const body = this.el.querySelector(".tnm-lookup__body") as HTMLElement;
    const freqRow = this.el.querySelector(".tnm-lookup__freq") as HTMLElement;
    let rendered = 0;
    try {
      const result = await opts.fetchResult(); // offline — fast
      if (id !== this.reqId) return;
      // Refine the word's reading to the dictionary's (思う→おもう / contextual 港→こう),
      // not the conjugated surface reading the token carried.
      // A longer multi-word expression matched (歳+食っちゃい → 歳食う): promote it to
      // the headword. Status/mining then track the expression, not the clicked token.
      if (result.matchedTerm && result.matchedTerm !== opts.term) this.setTerm(result.matchedTerm);
      if (result.reading) this.setWordReading(result.reading);
      this.chosenReading = result.reading || result.readings?.[0] || "";
      this.lastReadings = result.readings ?? [];
      this.renderReadings(this.lastReadings, this.chosenReading);
      this.lastPitches = result.pitches ?? [];
      this.renderPitch();
      this.renderFreq(freqRow, result);
      rendered = this.renderBody(body, result);
      this.position();
    } catch {
      if (id !== this.reqId) return;
    }

    // Online source (Jisho/Wiktionary) streams in after the instant offline render.
    const online = el("div", { class: "tnm-lookup__online" }, el("div", { class: "tnm-lookup__loading" }, "Searching online…"));
    body.append(online);
    this.position(); // the loader grows the popup — keep it clear of the row/word
    try {
      const section = await opts.fetchOnline();
      if (id !== this.reqId) return;
      online.remove();
      if (section && section.entries.length) {
        body.append(this.renderSection(section, this.opts!.reading));
        rendered++;
      }
    } catch {
      if (id === this.reqId) online.remove();
    }
    if (id === this.reqId && rendered === 0) {
      body.append(el("div", { class: "tnm-lookup__error" }, "No dictionary results."));
    }
    if (id === this.reqId) this.position();
  }

  /** Reflect the current mined state on the ＋/✓ button. */
  private renderMineBtn(): void {
    if (!this.mineBtn) return;
    const mined = !!this.opts?.mined;
    clear(this.mineBtn);
    this.mineBtn.append(mined ? icons.check() : icons.plus());
    this.mineBtn.classList.toggle("-mined", mined);
    this.mineBtn.setAttribute("data-tip", mined ? "Already in Anki" : "Add to Anki (now)");
  }

  /** Reflect whether this word+line is already queued on the queue button. */
  private renderQueueBtn(): void {
    if (!this.queueBtn) return;
    const queued = !!this.opts?.queued;
    this.queueBtn.classList.toggle("-mined", queued);
    this.queueBtn.setAttribute("data-tip", queued ? "In mining queue" : "Add to mining queue");
  }

  /** Flip the button to ✓ (e.g. right after a successful mine). */
  setMined(mined: boolean): void {
    if (!this.opts) return;
    this.opts.mined = mined;
    this.renderMineBtn();
  }

  /** Reflect a just-queued state on the queue button. */
  setQueued(queued: boolean): void {
    if (!this.opts) return;
    this.opts.queued = queued;
    this.renderQueueBtn();
  }

  /** Re-evaluate the mined state from a predicate (e.g. after an Anki sync) for the open word. */
  refreshMined(isMined: (term: string) => boolean): void {
    if (this.opts) this.setMined(isMined(this.opts.term));
  }

  /** The reading currently chosen for this word — used for mining (ExpressionReading + audio).
   *  Always hiragana, regardless of the katakana DISPLAY toggle. */
  currentReading(): string {
    return this.chosenReading || this.wordReading || this.opts?.reading || "";
  }

  /** The headword this popup currently shows — the matched expression when a compound
   *  was promoted (歳食う), else the clicked token's lemma. Mining/status use this. */
  currentTerm(): string {
    return this.opts?.term ?? "";
  }

  /** Promote the headword (compound expression match) and re-render the word. */
  private setTerm(term: string): void {
    if (!this.opts || term === this.opts.term) return;
    this.opts.term = term;
    this.wordReading = ""; // stale single-word reading — setWordReading follows with the compound's
    this.renderWord();
  }

  /** ア when showing hiragana (click → katakana); あ when showing katakana. */
  private renderKanaBtn(): void {
    if (!this.kanaBtn) return;
    this.kanaBtn.textContent = this.kata ? "あ" : "ア";
    this.kanaBtn.setAttribute("data-tip", this.kata ? "Show readings in hiragana" : "Show readings in katakana");
  }

  /** Re-render every displayed reading in the current kana mode (values stay hiragana). */
  private applyKanaMode(): void {
    this.renderKanaBtn();
    this.renderWord();
    this.renderReadings(this.lastReadings, this.chosenReading);
    if (this.selectionEl && this.opts?.selection) {
      const next = furiEl("tnm-lookup__selection__text", this.opts.selection, this.opts.selectionReading || "", (s) => this.k(s));
      this.selectionEl.replaceWith(next);
      this.selectionEl = next;
    }
    this.renderPitch();
    // Per-entry readings keep their original (hiragana) value in data-kana.
    this.el.querySelectorAll<HTMLElement>("[data-kana]").forEach((n) => {
      n.textContent = this.k(n.dataset.kana ?? "");
    });
  }

  /** Show one chip per candidate reading; the selected one drives furigana/audio/mining. */
  private renderReadings(readings: string[], current: string): void {
    const row = this.readingsEl;
    if (!row) return;
    clear(row);
    if (!readings || readings.length <= 1) {
      row.style.display = "none";
      return;
    }
    row.style.display = "";
    row.append(el("span", { class: "tnm-lookup__readings__label" }, "Reading"));
    for (const r of readings) {
      // Label follows the kana display mode; data-r keeps the hiragana value for mining.
      const chip = el("button", { class: "tnm-btn -reading" + (r === current ? " -sel" : ""), "data-r": r }, this.k(r));
      chip.addEventListener("click", () => this.chooseReading(r));
      row.append(chip);
    }
  }

  private chooseReading(r: string): void {
    this.chosenReading = r;
    this.setWordReading(r); // re-render the word's furigana for the chosen reading
    this.readingsEl?.querySelectorAll<HTMLElement>(".tnm-btn").forEach((b) => b.classList.toggle("-sel", b.dataset.r === r));
    this.renderPitch();
  }

  /** Pitch-accent pattern(s) for the current reading: moras with the high segment
   *  overlined and a notch after the downstep, plus the numeric [n] chip. */
  private renderPitch(): void {
    const box = this.pitchEl;
    if (!box) return;
    clear(box);
    const entry =
      this.lastPitches.find((pe) => pe.reading === this.currentReading()) ?? this.lastPitches[0];
    if (!entry || !entry.positions.length) {
      box.style.display = "none";
      return;
    }
    box.style.display = "";
    box.append(el("span", { class: "tnm-lookup__pitch__label" }, "Pitch"));
    const moras = moraSplit(entry.reading);
    for (const pos of entry.positions.slice(0, 3)) {
      const graph = el("span", { class: "tnm-pitch" });
      const highs = pitchPattern(pos, moras.length);
      moras.forEach((m, i) => {
        const cls = "m" + (highs[i] ? " -h" : "") + (pos >= 1 && i === pos - 1 ? " -d" : "");
        graph.append(el("span", { class: cls }, this.k(m)));
      });
      graph.append(el("span", { class: "n" }, `[${pos}]`));
      box.append(graph);
    }
  }

  setStatus(status: KnownStatus): void {
    if (!this.opts) return;
    this.opts.status = status;
    this.el.querySelectorAll<HTMLElement>(".tnm-lookup__status .tnm-btn").forEach((b) => {
      b.classList.toggle("-sel", b.dataset.s === status);
    });
  }

  private renderShell(): void {
    const o = this.opts!;
    clear(this.el);
    // If the selection is a conjugated/compound form, o.reading is its (surface) reading,
    // not the word's — start with no furigana and fill the lemma reading after lookup.
    this.wordReading = o.selection && o.selection !== o.term ? "" : o.reading || "";
    this.chosenReading = o.reading || "";

    const speakBtn = el("button", { class: "tnm-btn -icon tnm-lookup__speak tnm-tip", "data-tip": "Pronounce word" }, icons.sound());
    speakBtn.addEventListener("click", () => o.onSpeak(this.wordReading || o.selectionReading || ""));

    // Kana display toggle: readings as hiragana ⇄ katakana (LOOK-UP display only —
    // mining/audio keep the hiragana values).
    this.kanaBtn = el("button", { class: "tnm-btn -icon tnm-lookup__kana tnm-tip" }) as HTMLButtonElement;
    this.renderKanaBtn();
    this.kanaBtn.addEventListener("click", () => {
      this.kata = !this.kata;
      try {
        chrome.storage.local.set({ "tnm:lookup-kata": this.kata });
      } catch {
        /* storage unavailable */
      }
      this.applyKanaMode();
    });

    this.mineBtn = null;
    if (o.onMine) {
      this.mineBtn = el("button", { class: "tnm-btn -icon tnm-lookup__mine tnm-tip" }) as HTMLButtonElement;
      this.mineBtn.addEventListener("click", () => o.onMine!());
      this.renderMineBtn(); // ＋ or ✓ depending on mined state
    }

    this.queueBtn = null;
    if (o.onQueue) {
      this.queueBtn = el("button", { class: "tnm-btn -icon tnm-lookup__queue tnm-tip" }, icons.queue()) as HTMLButtonElement;
      this.queueBtn.addEventListener("click", () => o.onQueue!());
      this.renderQueueBtn();
    }

    // The WORD (lemma) — furigana fills in once the dictionary reading resolves.
    this.wordEl = el("span", { class: "tnm-lookup__word" });
    this.renderWord();
    const head = el("div", { class: "tnm-lookup__head" }, this.wordEl, speakBtn, this.kanaBtn, this.queueBtn, this.mineBtn);
    this.el.append(head);

    // Manual reading switcher — filled after the look-up resolves; hidden when there's only one.
    this.readingsEl = el("div", { class: "tnm-lookup__readings" });
    this.readingsEl.style.display = "none";
    this.lastReadings = [];
    this.el.append(this.readingsEl);

    // Pitch-accent line (filled after the look-up resolves; hidden without pitch data).
    this.pitchEl = el("div", { class: "tnm-lookup__pitch" });
    this.pitchEl.style.display = "none";
    this.lastPitches = [];
    this.el.append(this.pitchEl);

    // The SELECTED text from the sentence, when it differs from the word (conjugated /
    // compound) — so it's clear what the actual word is vs. what was selected.
    this.selectionEl = null;
    if (o.selection && o.selection !== o.term) {
      this.selectionEl = furiEl("tnm-lookup__selection__text", o.selection, o.selectionReading || "", (s) => this.k(s));
      this.el.append(
        el(
          "div",
          { class: "tnm-lookup__selection" },
          el("span", { class: "tnm-lookup__selection__label" }, "Selected"),
          this.selectionEl,
        ),
      );
    }

    const freqRow = el("div", { class: "tnm-lookup__freq" });

    const status = el("div", { class: "tnm-lookup__status" });
    for (const s of STATUSES) {
      const btn = el("button", { class: "tnm-btn" + (s === o.status ? " -sel" : ""), "data-s": s }, STATUS_LABEL[s]);
      btn.addEventListener("click", () => {
        o.onStatus(s);
        this.setStatus(s);
      });
      status.append(btn);
    }

    const body = el("div", { class: "tnm-lookup__body" }, el("div", { class: "tnm-lookup__loading" }, "Looking up…"));
    this.el.append(freqRow, status, body); // head + selection already appended above
  }

  /** (Re)render the word with okurigana-aware furigana from the current reading. */
  private renderWord(): void {
    if (!this.wordEl || !this.opts) return;
    clear(this.wordEl);
    for (const p of furiganaParts(this.opts.term, this.wordReading) as FuriPart[]) {
      if (p.rt) {
        const ruby = el("ruby");
        ruby.append(el("span", {}, p.text), el("rt", {}, this.k(p.rt)));
        this.wordEl.append(ruby);
      } else {
        this.wordEl.append(document.createTextNode(p.text));
      }
    }
  }

  private setWordReading(reading: string): void {
    if (this.opts) this.opts.reading = reading; // keep entry-reading dedup consistent
    if (reading === this.wordReading) return;
    this.wordReading = reading;
    this.renderWord();
  }

  private renderFreq(row: HTMLElement, result: LookupResult): void {
    clear(row);
    for (const f of result.frequencies) {
      row.append(
        el(
          "span",
          { class: "tnm-freq tnm-tip", "data-tip": f.dict, "data-rarity": freqRarity(f.value) },
          `${f.dict.split(/[\s(]/)[0]}: ${f.display}`,
        ),
      );
    }
  }

  /** Render offline sections + kanji. Returns how many sections were rendered. */
  private renderBody(body: HTMLElement, result: LookupResult): number {
    clear(body);
    let count = 0;
    for (const section of result.sections) {
      if (!section.entries.length) continue;
      body.append(this.renderSection(section, result.reading));
      count++;
    }
    if (result.kanji.length) {
      const sec = el("div", { class: "tnm-lookup__section" });
      sec.append(el("div", { class: "tnm-lookup__section__title" }, "Kanji"));
      for (const k of result.kanji) {
        const row = el("div", { class: "tnm-kanji" });
        row.append(el("span", { class: "tnm-kanji__char" }, k.character));
        const info = el("div", { class: "tnm-kanji__info" });
        if (k.onyomi.length) info.append(el("div", {}, "On: " + k.onyomi.join("、")));
        if (k.kunyomi.length) info.append(el("div", {}, "Kun: " + k.kunyomi.join("、")));
        if (k.meanings.length) info.append(el("div", { class: "tnm-kanji__mean" }, k.meanings.join(", ")));
        row.append(info);
        sec.append(row);
      }
      body.append(sec);
      count++;
    }
    return count;
  }

  /** Media resolver for a section's dictionary-bundled images (imported dicts only). */
  private mediaResolver(section: DictSection): ((path: string) => Promise<string | null>) | undefined {
    const dictId = section.dictId;
    if (dictId == null) return undefined;
    return async (path: string) => {
      try {
        const res = (await chrome.runtime.sendMessage({ type: "dictMedia", dictId, path })) as
          | { ok: true; dataUrl: string | null }
          | { ok: false };
        return res && res.ok ? res.dataUrl : null;
      } catch {
        return null;
      }
    };
  }

  private renderSection(section: DictSection, resultReading: string): HTMLElement {
    const sec = el("div", { class: "tnm-lookup__section" });
    sec.append(el("div", { class: "tnm-lookup__section__title" }, section.dictTitle));
    for (const entry of section.entries) {
      const entryEl = el("div", { class: "tnm-lookup__entry" });
      if (entry.reading && entry.reading !== resultReading) {
        entryEl.append(el("div", { class: "tnm-lookup__reading", "data-kana": entry.reading }, this.k(entry.reading)));
      }
      if (entry.tags.length) {
        const tags = el("div", { class: "tnm-lookup__tags" });
        for (const t of entry.tags) tags.append(el("span", { class: "tnm-tag" }, t));
        entryEl.append(tags);
      }
      entryEl.append(renderGlossary(entry.glossary, this.mediaResolver(section)));
      sec.append(entryEl);
    }
    return sec;
  }

  private position(): void {
    if (!this.opts) return;
    const { anchor, avoid } = this.opts;
    const w = this.el.offsetWidth || 340;
    const h = this.el.offsetHeight || 220;
    // Center horizontally on the word…
    let left = anchor.left + anchor.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    // …but place vertically clear of the WHOLE subtitle block/row, so neighbouring
    // words stay uncovered and you can glide along the line to look them up.
    const box = avoid ?? anchor;
    const gap = 12;
    let top = box.top - h - gap; // above the block
    if (top < 8) top = box.bottom + gap; // no room above → below it
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }
}
