import type { LrclibHit } from "../../common/types";
import { guessSong } from "../../lib/lyrics/song";
import { el, clear } from "./dom";
import { icons } from "./icons";

export interface LyricsCallbacks {
  search: (opts: { q?: string; trackName?: string; artistName?: string }) => Promise<LrclibHit[]>;
  pick: (hit: LrclibHit) => void;
  /** Guess artist/track + read the current video duration from the page. */
  guess: () => { query: string; artistName?: string; trackName?: string; duration?: number };
}

function fmtDur(sec?: number): string {
  if (!sec || !isFinite(sec)) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Search LRCLIB for time-synced song lyrics and load the picked track. Reuses the Jimaku
 *  panel's styling (same class names). */
export class LyricsPanel {
  readonly el: HTMLDivElement;
  private cb: LyricsCallbacks;
  private input!: HTMLInputElement;
  private body!: HTMLDivElement;
  private status!: HTMLDivElement;
  private busy = false;
  private videoDuration = 0;
  private loadedId = -1;

  constructor(cb: LyricsCallbacks) {
    this.cb = cb;
    this.el = el("div", { class: "tnm-jimaku tnm-lyrics" });
    this.el.style.display = "none";
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.render();
  }

  isOpen(): boolean {
    return this.el.style.display !== "none";
  }
  open(): void {
    this.el.style.display = "";
    this.input.focus();
    if (!this.input.value.trim()) this.autoFromPage(true).catch(() => {});
  }
  close(): void {
    this.el.style.display = "none";
  }
  toggle(): void {
    this.isOpen() ? this.close() : this.open();
  }

  private render(): void {
    clear(this.el);
    const detectBtn = el("button", { class: "tnm-btn -icon", title: "Guess the song from this page" }, icons.refresh());
    detectBtn.addEventListener("click", () => this.autoFromPage(false));
    const closeBtn = el("button", { class: "tnm-btn -icon" }, icons.close());
    closeBtn.addEventListener("click", () => this.close());
    const head = el(
      "div",
      { class: "tnm-jimaku__head" },
      el("div", { class: "tnm-jimaku__title" }, "Song lyrics (LRCLIB)"),
      detectBtn,
      closeBtn,
    );

    this.input = el("input", { type: "text", placeholder: "Artist – title…", class: "tnm-jimaku__search" }) as HTMLInputElement;
    this.input.addEventListener("keydown", (e) => { if (e.key === "Enter") this.runSearch(); });
    const searchBtn = el("button", { class: "tnm-btn -primary" }, "Search");
    searchBtn.addEventListener("click", () => this.runSearch());
    const searchRow = el("div", { class: "tnm-jimaku__searchrow" }, this.input, searchBtn);

    this.status = el("div", { class: "tnm-jimaku__status" }, "Open this on a song/MV to auto-fill, or type artist – title.");
    this.body = el("div", { class: "tnm-jimaku__body" });
    this.el.append(head, searchRow, this.status, this.body);
  }

  /** Prefill from the page (title + duration), then search. */
  private async autoFromPage(auto: boolean): Promise<void> {
    const g = this.cb.guess();
    this.videoDuration = g.duration ?? 0;
    if (g.query && !this.input.value.trim()) this.input.value = g.query;
    if (!this.input.value.trim()) {
      this.status.textContent = auto ? "Couldn't read a title here — type artist – title." : "No title found on this page.";
      return;
    }
    await this.runSearch(true);
  }

  private async runSearch(auto = false): Promise<void> {
    if (this.busy) return;
    const text = this.input.value.trim();
    if (!text) return;
    this.busy = true;
    this.status.textContent = "Searching LRCLIB…";
    clear(this.body);
    try {
      const g = guessSong(text);
      const structured = g.trackName && g.artistName ? { trackName: g.trackName, artistName: g.artistName } : null;
      let hits = await this.cb.search(structured ?? { q: text });
      if (!hits.length && structured) hits = await this.cb.search({ q: text }); // structured miss → free-text
      hits = this.rank(hits);
      if (!hits.length) {
        this.status.textContent = "No lyrics found — try adjusting the artist / title.";
        return;
      }
      const top = hits[0];
      // Auto-load a confident synced match when opened from the page (duration within 3s).
      if (auto && top.syncedLyrics && this.videoDuration && top.duration && Math.abs(top.duration - this.videoDuration) <= 3) {
        this.loadedId = top.id;
        this.cb.pick(top);
      }
      this.renderHits(hits);
    } catch (e) {
      this.status.textContent = String((e as Error)?.message ?? e);
    } finally {
      this.busy = false;
    }
  }

  /** Synced results first, then closest to the video's duration. */
  private rank(hits: LrclibHit[]): LrclibHit[] {
    const d = this.videoDuration;
    return [...hits].sort((a, b) => {
      const as = a.syncedLyrics ? 0 : 1;
      const bs = b.syncedLyrics ? 0 : 1;
      if (as !== bs) return as - bs;
      if (d && a.duration && b.duration) return Math.abs(a.duration - d) - Math.abs(b.duration - d);
      return 0;
    });
  }

  private renderHits(hits: LrclibHit[]): void {
    clear(this.body);
    const synced = hits.filter((h) => h.syncedLyrics).length;
    this.status.textContent = this.loadedId >= 0
      ? "Loaded the best match — click another to switch."
      : `${hits.length} result(s), ${synced} synced — click a synced one to load.`;
    for (const h of hits) {
      const hasSync = !!h.syncedLyrics;
      const row = el(
        "div",
        { class: "tnm-jimaku__file" + (hasSync ? "" : " -disabled") + (h.id === this.loadedId ? " -loaded" : "") },
        el("span", { class: "tnm-jimaku__file__name" }, `${h.trackName} — ${h.artistName}`),
        el("span", { class: "tnm-jimaku__file__size" }, hasSync ? fmtDur(h.duration) : "plain only"),
      );
      if (hasSync) row.addEventListener("click", () => { this.loadedId = h.id; this.cb.pick(h); this.close(); });
      this.body.append(row);
    }
  }
}
