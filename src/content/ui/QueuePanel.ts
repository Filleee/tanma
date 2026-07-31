import { el, clear } from "./dom";
import { icons } from "./icons";

export interface QueueRow {
  id: string;
  word: string;
  reading?: string;
  snippet: string;
}

export interface QueueCallbacks {
  /** Mine every queued item, one by one (seek → screenshot → record → Anki). */
  mineAll: () => void;
  /** Drop one item from the queue. */
  remove: (id: string) => void;
  /** Empty the queue. */
  clear: () => void;
}

/**
 * The mining queue: words the user tagged while watching, mined later in a batch so watching
 * isn't interrupted by the per-line seek/record. Reuses the Jimaku panel's styling.
 */
export class QueuePanel {
  readonly el: HTMLDivElement;
  private cb: QueueCallbacks;
  private body!: HTMLDivElement;
  private status!: HTMLDivElement;
  private mineBtn!: HTMLButtonElement;
  private clearBtn!: HTMLButtonElement;
  private rows: QueueRow[] = [];
  private busy = false;

  constructor(cb: QueueCallbacks) {
    this.cb = cb;
    this.el = el("div", { class: "tnm-jimaku tnm-queue" });
    this.el.style.display = "none";
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.render();
  }

  isOpen(): boolean {
    return this.el.style.display !== "none";
  }
  open(): void {
    this.el.style.display = "";
  }
  close(): void {
    this.el.style.display = "none";
  }
  toggle(): void {
    this.isOpen() ? this.close() : this.open();
  }

  private render(): void {
    clear(this.el);
    const closeBtn = el("button", { class: "tnm-btn -icon" }, icons.close());
    closeBtn.addEventListener("click", () => this.close());
    const head = el(
      "div",
      { class: "tnm-jimaku__head" },
      el("div", { class: "tnm-jimaku__title" }, "Mining queue"),
      closeBtn,
    );

    this.status = el("div", { class: "tnm-jimaku__status" }, "Add words with the queue button in a look-up, then mine them all here.");
    this.body = el("div", { class: "tnm-jimaku__body" });

    this.mineBtn = el("button", { class: "tnm-btn -primary" }, "Mine all → Anki") as HTMLButtonElement;
    this.mineBtn.addEventListener("click", () => this.cb.mineAll());
    this.clearBtn = el("button", { class: "tnm-btn" }, "Clear") as HTMLButtonElement;
    this.clearBtn.addEventListener("click", () => this.cb.clear());
    const foot = el("div", { class: "tnm-queue__foot" }, this.mineBtn, this.clearBtn);

    this.el.append(head, this.status, this.body, foot);
    this.paint();
  }

  /** Replace the shown items + busy/progress state. */
  update(rows: QueueRow[], opts: { busy?: boolean; status?: string } = {}): void {
    this.rows = rows;
    this.busy = !!opts.busy;
    this.paint(opts.status);
  }

  private paint(statusOverride?: string): void {
    clear(this.body);
    const n = this.rows.length;
    if (statusOverride) this.status.textContent = statusOverride;
    else this.status.textContent = n ? `${n} word${n === 1 ? "" : "s"} queued` : "Queue is empty.";
    this.mineBtn.textContent = this.busy ? "Mining…" : n ? `Mine all (${n}) → Anki` : "Mine all → Anki";
    this.mineBtn.toggleAttribute("disabled", this.busy || n === 0);
    this.clearBtn.toggleAttribute("disabled", this.busy || n === 0);

    for (const r of this.rows) {
      const del = el("button", { class: "tnm-btn -icon tnm-queue__row__del", title: "Remove" }, icons.close()) as HTMLButtonElement;
      del.toggleAttribute("disabled", this.busy);
      del.addEventListener("click", () => this.cb.remove(r.id));
      const row = el(
        "div",
        { class: "tnm-jimaku__file tnm-queue__row" },
        el(
          "div",
          { class: "tnm-queue__row__text" },
          el("span", { class: "tnm-queue__row__word" }, r.reading ? `${r.word}（${r.reading}）` : r.word),
          el("span", { class: "tnm-queue__row__snip" }, r.snippet),
        ),
        del,
      );
      this.body.append(row);
    }
  }
}
