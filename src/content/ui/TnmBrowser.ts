import type { Cue } from "../../common/types";
import { el, clear } from "./dom";
import { icons } from "./icons";

export interface BrowserCallbacks {
  onSeek: (time: number) => void;
  onToggleBookmark: (cueId: number) => void;
  /** Align the subtitle timing so this line lands at the current playback position. */
  onSyncOffset: (cueStart: number) => void;
  onClose: () => void;
  isBookmarked: (cueId: number) => boolean;
  /** Whether this line's sentence already has an Anki card (shows a ✓). */
  isMined: (sentence: string) => boolean;
}

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Scrollable list of every cue; click to seek, star to bookmark, search to filter. */
export class TnmBrowser {
  readonly el: HTMLDivElement;
  private listEl: HTMLDivElement;
  private cb: BrowserCallbacks;
  private cues: Cue[] = [];
  private secondaryFor: (cue: Cue) => string = () => "";
  /** Builds an interactive (hover/click-to-lookup) element for a cue's text. */
  private renderContent?: (cue: Cue) => HTMLElement;
  private io?: IntersectionObserver;
  private rows = new Map<number, HTMLElement>();
  private activeId = -1;
  private query = "";
  private onlyBookmarks = false;
  private lastUserScroll = 0;
  /** Fired when the pointer enters/leaves the panel (for pause-on-hover). */
  onHover?: (over: boolean) => void;

  constructor(cb: BrowserCallbacks) {
    this.cb = cb;

    const title = el("div", { class: "TnmBrowser__header__title" }, "Subtitles");
    const bmFilter = el("button", { class: "tnm-btn -icon tnm-tip", "data-tip": "Only bookmarks" }, icons.star());
    bmFilter.addEventListener("click", () => {
      this.onlyBookmarks = !this.onlyBookmarks;
      bmFilter.classList.toggle("-active", this.onlyBookmarks);
      this.rebuild();
    });
    const closeBtn = el("button", { class: "tnm-btn -icon" }, icons.close());
    closeBtn.addEventListener("click", () => cb.onClose());
    const header = el(
      "div",
      { class: "TnmBrowser__header" },
      title,
      el("div", { style: "display:flex;gap:4px" }, bmFilter, closeBtn),
    );

    const search = el("input", { type: "text", placeholder: "Search subtitles…" }) as HTMLInputElement;
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      this.rebuild();
    });
    const filters = el("div", { class: "TnmBrowser__filters" }, search);

    this.listEl = el("div", { class: "TnmBrowser__list" });
    this.listEl.addEventListener("scroll", () => (this.lastUserScroll = performance.now()));

    this.el = el("div", { class: "TnmBrowser" }, header, filters, this.listEl);
    this.el.addEventListener("mouseenter", () => this.onHover?.(true));
    this.el.addEventListener("mouseleave", () => this.onHover?.(false));
  }

  setTrack(cues: Cue[], secondaryFor: (cue: Cue) => string, renderContent?: (cue: Cue) => HTMLElement): void {
    this.cues = cues;
    this.secondaryFor = secondaryFor;
    this.renderContent = renderContent;
    this.rebuild();
  }

  refreshBookmarks(): void {
    for (const [id, row] of this.rows) {
      const star = row.querySelector(".TnmBrowser__list__item__bookmark");
      star?.classList.toggle("-on", this.cb.isBookmarked(id));
    }
  }

  /** Toggle the ✓ "mined" marker on rows (called when the mined set changes). */
  refreshMined(isMined: (sentence: string) => boolean): void {
    for (const cue of this.cues) {
      const row = this.rows.get(cue.id);
      if (row) row.classList.toggle("-mined", isMined(cue.text));
    }
  }

  /** Dock the panel into a specific box (between video & chat), or null to revert
   *  to the floating-right CSS placement. */
  dock(rect: DOMRect | null): void {
    const s = this.el.style;
    if (rect) {
      s.left = `${rect.left}px`;
      s.top = `${rect.top}px`;
      s.width = `${rect.width}px`;
      s.height = `${rect.height}px`;
      s.right = "auto";
    } else if (s.left) {
      s.left = s.top = s.width = s.height = s.right = "";
    }
  }

  setActive(cueId: number): void {
    if (cueId === this.activeId) return;
    this.rows.get(this.activeId)?.classList.remove("-active");
    this.activeId = cueId;
    const row = this.rows.get(cueId);
    if (!row) return;
    row.classList.add("-active");
    // Auto-scroll unless the user scrolled recently.
    if (performance.now() - this.lastUserScroll > 4000) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  private rebuild(): void {
    clear(this.listEl);
    this.rows.clear();
    this.io?.disconnect();
    // Words become interactive only when a row scrolls into view, so a 2-hour
    // stream with thousands of cues doesn't tokenize everything up front.
    this.io = this.renderContent
      ? new IntersectionObserver(
          (entries) => entries.forEach((e) => e.isIntersecting && this.hydrate(e.target as HTMLElement)),
          { root: this.listEl, rootMargin: "300px 0px" },
        )
      : undefined;

    const matches = this.cues.filter((c) => {
      if (this.onlyBookmarks && !this.cb.isBookmarked(c.id)) return false;
      if (this.query && !c.text.toLowerCase().includes(this.query)) return false;
      return true;
    });

    if (matches.length === 0) {
      this.listEl.append(
        el("div", { class: "TnmBrowser__empty" }, this.cues.length ? "No matching lines." : "No subtitles loaded. Use the toolbar to import a file."),
      );
      return;
    }

    for (const cue of matches) {
      const target = el("span", { class: "TnmBrowser__list__item__target" }, cue.text);
      const content = el("div", { class: "TnmBrowser__list__item__content" }, target);
      const sec = this.secondaryFor(cue);
      if (sec) content.append(el("span", { class: "sec" }, sec));
      (content as any)._cue = cue; // for lazy hydration

      const star = el("button", { class: "TnmBrowser__list__item__bookmark" }, "★");
      if (this.cb.isBookmarked(cue.id)) star.classList.add("-on");
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cb.onToggleBookmark(cue.id);
        star.classList.toggle("-on", this.cb.isBookmarked(cue.id));
      });

      const sync = el(
        "button",
        { class: "TnmBrowser__list__item__sync", title: "Sync subtitles: align this line to the current playback time" },
        icons.sync(),
      );
      sync.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cb.onSyncOffset(cue.start);
      });

      const row = el(
        "div",
        {
          class: "TnmBrowser__list__item" + (cue.id === this.activeId ? " -active" : "") + (this.cb.isMined(cue.text) ? " -mined" : ""),
          "data-cue-id": String(cue.id),
        },
        el("div", { class: "TnmBrowser__list__item__time" }, fmtTime(cue.start)),
        content,
        sync,
        star,
      );
      // Clicking a word looks it up; clicking elsewhere on the row seeks — unless this
      // click is the end of a drag-selection (then leave the playhead alone).
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".tnm-token.-tnm-word")) return;
        const root = this.listEl.getRootNode() as unknown as { getSelection?: () => Selection | null };
        const sel = root.getSelection?.() ?? window.getSelection?.();
        if (sel && !sel.isCollapsed && sel.toString().trim()) return;
        this.cb.onSeek(cue.start + 0.01);
      });
      this.rows.set(cue.id, row);
      this.listEl.append(row);
      this.io?.observe(content);
    }
  }

  /** Replace a row's plain text with the interactive (tokenized) version, once. */
  private hydrate(content: HTMLElement): void {
    const cue: Cue | undefined = (content as any)._cue;
    if (!cue || (content as any)._hydrated || !this.renderContent) return;
    (content as any)._hydrated = true;
    this.io?.unobserve(content);
    const target = content.querySelector(".TnmBrowser__list__item__target");
    if (target) target.replaceWith(this.renderContent(cue));
  }
}
