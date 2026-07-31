import type { JimakuEntry, JimakuFile, MediaHint } from "../../common/types";
import { episodeFromFilename as fileEpisode, isBatchFile, bestEpisodeFile, searchAttempts } from "../../lib/jimaku/episode";
import { el, clear } from "./dom";
import { icons } from "./icons";

export interface JimakuCallbacks {
  /** Search by AniList id (exact) or a title query. */
  search: (opts: { query?: string; anilistId?: number }) => Promise<JimakuEntry[]>;
  files: (entryId: number) => Promise<JimakuFile[]>;
  pick: (entry: JimakuEntry, file: JimakuFile) => void;
  /** Scrape the host page for AniList/MAL id, title and episode. */
  detect: () => Promise<MediaHint>;
}

/** Direct subtitle files we can load (archives aren't handled yet). */
const SUB_EXT = /\.(srt|ass|ssa|vtt)$/i;

function fmtSize(n?: number): string {
  if (!n) return "";
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Search jimaku.cc → pick an entry → pick one of its subtitle files → load it.
 *  Can auto-detect the show (AniList/MAL id) and episode from the host page. */
export class JimakuPanel {
  readonly el: HTMLDivElement;
  private cb: JimakuCallbacks;
  private input!: HTMLInputElement;
  private episodeInput!: HTMLInputElement;
  private body!: HTMLDivElement;
  private status!: HTMLDivElement;
  private lastEntries: JimakuEntry[] = [];
  private openEntryRef: JimakuEntry | null = null;
  private lastFiles: JimakuFile[] = [];
  private loadedFileName = "";
  private showAll = false;
  private busy = false;

  constructor(cb: JimakuCallbacks) {
    this.cb = cb;
    this.el = el("div", { class: "tnm-jimaku tnm-jimaku-anime" });
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
    // Auto-detect the show/episode from the page the first time it's opened.
    if (!this.lastEntries.length && !this.openEntryRef) this.autoDetect(true).catch(() => {});
  }
  close(): void {
    this.el.style.display = "none";
  }
  toggle(): void {
    this.isOpen() ? this.close() : this.open();
  }

  private render(): void {
    clear(this.el);
    const detectBtn = el("button", { class: "tnm-btn -icon", title: "Auto-detect show & episode from this page" }, icons.refresh());
    detectBtn.addEventListener("click", () => this.autoDetect(false));
    const closeBtn = el("button", { class: "tnm-btn -icon" }, icons.close());
    closeBtn.addEventListener("click", () => this.close());
    const head = el(
      "div",
      { class: "tnm-jimaku__head" },
      el("div", { class: "tnm-jimaku__title" }, "Jimaku subtitles"),
      detectBtn,
      closeBtn,
    );

    this.input = el("input", { type: "text", placeholder: "Search anime title…", class: "tnm-jimaku__search" }) as HTMLInputElement;
    this.input.addEventListener("keydown", (e) => { if (e.key === "Enter") this.runSearch(); });

    this.episodeInput = el("input", {
      type: "number", min: "0", placeholder: "Ep", class: "tnm-jimaku__ep", title: "Episode (filters files)",
    }) as HTMLInputElement;
    this.episodeInput.addEventListener("input", () => { this.showAll = false; if (this.openEntryRef) this.renderFiles(); });
    this.episodeInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      this.openEntryRef ? this.renderFiles() : this.runSearch();
    });

    const searchBtn = el("button", { class: "tnm-btn -primary" }, "Search");
    searchBtn.addEventListener("click", () => this.runSearch());
    const searchRow = el("div", { class: "tnm-jimaku__searchrow" }, this.input, this.episodeInput, searchBtn);

    this.status = el("div", { class: "tnm-jimaku__status" }, "Open this on an anime page to auto-detect, or search a title.");
    this.body = el("div", { class: "tnm-jimaku__body" });
    this.el.append(head, searchRow, this.status, this.body);
  }

  private episodeValue(): number | null {
    const v = this.episodeInput.value.trim();
    return /^\d+$/.test(v) ? Number(v) : null;
  }

  /** Scrape the page for show id + episode, then search and (if unambiguous) load. */
  private async autoDetect(auto: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.openEntryRef = null;
    this.status.textContent = "Detecting show from page…";
    try {
      const hint = await this.cb.detect();
      if (hint.episode != null) this.episodeInput.value = String(hint.episode);
      // Prefer the official romaji title for the box (NOT the page title, which can be the
      // bare site name like "Miruro"); only fall back to the page title if AniList gave none.
      const display = hint.titles?.[0] ?? hint.title;
      if (display && !this.input.value.trim()) this.input.value = display;

      const attempts = searchAttempts(hint);
      const epLabel = hint.episode != null ? ` · ep ${hint.episode}` : "";
      const idLabel = hint.anilistId ? `AniList #${hint.anilistId}` : display ? `"${display}"` : "";

      if (!attempts.length) {
        this.status.textContent = auto
          ? "No AniList/MAL link or title on this page — type a title to search."
          : "Couldn't find an AniList/MAL link or title on this page.";
        return;
      }

      this.status.textContent = `Detected ${idLabel}${epLabel} — searching…`;
      clear(this.body);

      // Try each attempt (anilist_id → titles) in order; stop at the first that returns entries.
      this.lastEntries = [];
      for (const a of attempts) {
        this.status.textContent = a.anilistId ? `Searching AniList #${a.anilistId}${epLabel}…` : `Searching "${a.query}"${epLabel}…`;
        this.lastEntries = await this.cb.search(a);
        if (this.lastEntries.length) {
          if (a.query) this.input.value = a.query; // show what actually matched
          break;
        }
      }

      if (!this.lastEntries.length) {
        this.status.textContent = `No Jimaku subtitles found for ${idLabel}${epLabel}.`;
        return;
      }
      this.renderEntries();
      if (this.lastEntries.length === 1) {
        await this.openEntry(this.lastEntries[0], true); // auto-load when one episode file matches
      } else {
        this.status.textContent = `${this.lastEntries.length} entries${epLabel} — pick one`;
      }
    } catch (e) {
      this.status.textContent = String((e as Error)?.message ?? e);
    } finally {
      this.busy = false;
    }
  }

  private async runSearch(): Promise<void> {
    const q = this.input.value.trim();
    if (!q) { this.autoDetect(false); return; } // empty box → detect from page
    this.openEntryRef = null;
    this.status.textContent = "Searching…";
    clear(this.body);
    try {
      this.lastEntries = await this.cb.search({ query: q });
      this.status.textContent = this.lastEntries.length ? `${this.lastEntries.length} result(s)` : "No results.";
      this.renderEntries();
    } catch (e) {
      this.status.textContent = String((e as Error)?.message ?? e);
    }
  }

  private renderEntries(): void {
    clear(this.body);
    for (const en of this.lastEntries) {
      const alt = [en.english_name, en.japanese_name].filter((n) => n && n !== en.name).join(" · ");
      const row = el(
        "div",
        { class: "tnm-jimaku__item" },
        el("div", { class: "tnm-jimaku__item__name" }, en.name || `Entry ${en.id}`),
        alt ? el("div", { class: "tnm-jimaku__item__sub" }, alt) : null,
      );
      row.addEventListener("click", () => this.openEntry(en, false));
      this.body.append(row);
    }
  }

  private async openEntry(entry: JimakuEntry, autoLoad: boolean): Promise<void> {
    this.openEntryRef = entry;
    this.showAll = false;
    clear(this.body);
    this.status.textContent = `Loading files for ${entry.name}…`;
    try {
      this.lastFiles = await this.cb.files(entry.id);
      this.renderFiles(autoLoad);
    } catch (e) {
      this.status.textContent = String((e as Error)?.message ?? e);
    }
  }

  /** Render the open entry's files, filtered to the chosen episode when set. When autoLoad,
   *  pick the best matching file and load it: if it's the only match, close; if several match,
   *  load the best but keep the list open so the user can switch release. */
  private renderFiles(autoLoad = false): void {
    const entry = this.openEntryRef;
    if (!entry) return;
    clear(this.body);

    const back = el("button", { class: "tnm-jimaku__back" }, "← back to results");
    back.addEventListener("click", () => this.renderEntries());
    this.body.append(back);

    const ep = this.episodeValue();
    const subs = this.lastFiles.filter((f) => SUB_EXT.test(f.name));
    const matched = ep != null ? subs.filter((f) => fileEpisode(f.name) === ep) : [];
    const batches = ep != null ? subs.filter((f) => isBatchFile(f.name)) : [];

    // Auto-pick the single best match. Exactly one → load and close; otherwise load it but
    // leave the list up so the user can pick a different group/format.
    const best = autoLoad ? bestEpisodeFile(this.lastFiles, ep) : null;
    if (best && matched.length <= 1) {
      this.cb.pick(entry, best);
      this.close();
      return;
    }
    if (best) {
      this.loadedFileName = best.name;
      this.cb.pick(entry, best);
    }

    let toShow = this.lastFiles;
    if (ep != null && matched.length && !this.showAll) {
      toShow = [...matched, ...batches];
      const others = this.lastFiles.length - toShow.length;
      this.status.textContent = best
        ? `ep ${ep}: loaded ${best.name} · ${matched.length} matches — click another to switch`
        : `ep ${ep}: ${matched.length} match${matched.length > 1 ? "es" : ""}${batches.length ? ` (+${batches.length} batch)` : ""} — click to load`;
      if (others > 0) this.body.append(this.showAllLink(others));
    } else if (ep != null && !matched.length) {
      this.status.textContent = `No file clearly matched ep ${ep} — showing all ${subs.length}.`;
    } else {
      const subCount = subs.length;
      this.status.textContent = subCount
        ? `${subCount} subtitle file(s) — click one to load`
        : "No .srt/.ass/.vtt files here (archives aren't supported yet).";
    }

    for (const f of toShow) {
      const isSub = SUB_EXT.test(f.name);
      const fe = isSub ? fileEpisode(f.name) : null;
      const isMatch = ep != null && fe === ep;
      const isLoaded = f.name === this.loadedFileName;
      const row = el(
        "div",
        { class: "tnm-jimaku__file" + (isSub ? "" : " -disabled") + (isMatch ? " -match" : "") + (isLoaded ? " -loaded" : "") },
        el("span", { class: "tnm-jimaku__file__name" }, f.name),
        el("span", { class: "tnm-jimaku__file__size" }, isSub ? fmtSize(f.size) : "archive"),
      );
      if (isSub) row.addEventListener("click", () => { this.loadedFileName = f.name; this.cb.pick(entry, f); this.close(); });
      this.body.append(row);
    }
  }

  private showAllLink(others: number): HTMLElement {
    const link = el("button", { class: "tnm-jimaku__showall" }, `Show all files (+${others})`);
    link.addEventListener("click", () => { this.showAll = true; this.renderFiles(); });
    return link;
  }
}
