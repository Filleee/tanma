import { el, clear } from "./dom";

type ObscureMode = "off" | "blur" | "hide";

/**
 * Renders the active cue over the video: a target-language block (interactive
 * word elements supplied by the app) and an optional secondary translation.
 * Handles placement within the video rect, obscure modes, and vertical drag.
 */
export class TnmSubs {
  readonly el: HTMLDivElement;
  private container: HTMLDivElement;
  private targetEl: HTMLDivElement;
  private secondaryEl: HTMLDivElement;
  private posFraction: number;
  onReposition?: (fraction: number) => void;
  /** Fired when the pointer enters/leaves the subtitle text (for pause-on-hover). */
  onHover?: (over: boolean) => void;

  constructor(initialPosition: number) {
    this.posFraction = initialPosition;
    this.targetEl = el("div", { class: "TnmSubs__targetSubs" });
    this.secondaryEl = el("div", { class: "TnmSubs__secondarySubs" });
    this.container = el(
      "div",
      { class: "TnmSubs__container" },
      this.targetEl,
      this.secondaryEl,
    );
    this.el = el("div", { class: "TnmSubs" }, this.container);
    for (const node of [this.targetEl, this.secondaryEl]) {
      node.addEventListener("mouseenter", () => this.onHover?.(true));
      node.addEventListener("mouseleave", () => this.onHover?.(false));
    }
    this.enableDrag();
  }

  /** Replace the target-language lines (each is a `.tnm-sentence`). */
  setTarget(lines: HTMLElement[]): void {
    clear(this.targetEl);
    for (const line of lines) {
      this.targetEl.append(el("div", { class: "TnmSubs__targetSubs__line" }, line));
    }
    this.targetEl.style.display = lines.length ? "" : "none";
  }

  setSecondary(lines: string[]): void {
    clear(this.secondaryEl);
    for (const text of lines) {
      this.secondaryEl.append(
        el("div", { class: "TnmSubs__secondarySubs__line" }, el("span", { class: "TnmSubs__secondarySubs__text" }, text)),
      );
    }
    this.secondaryEl.style.display = lines.length ? "" : "none";
  }

  setObscure(target: ObscureMode, secondary: ObscureMode): void {
    this.targetEl.classList.toggle("-tnm-blur", target === "blur");
    this.targetEl.classList.toggle("-tnm-hide", target === "hide");
    this.secondaryEl.classList.toggle("-tnm-blur", secondary === "blur");
    this.secondaryEl.classList.toggle("-tnm-hide", secondary === "hide");
  }

  setSize(mult: number): void {
    this.el.style.setProperty("--tnm-size", String(mult));
  }

  /** Text shadow/outline strength (0–2) and background-plate opacity (0–1). */
  setContrast(shadow: number, background: number): void {
    this.el.style.setProperty("--tnm-sub-shadow", String(shadow));
    this.el.style.setProperty("--tnm-sub-bg", String(background));
  }

  setPosition(fraction: number): void {
    this.posFraction = Math.min(0.98, Math.max(0.05, fraction));
  }

  /** Position the overlay to cover the video and place subs at the saved height. */
  place(rect: DOMRect): void {
    const s = this.el.style;
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    // distance of the sub block from the bottom of the video
    s.paddingBottom = `${(1 - this.posFraction) * rect.height}px`;
    // scale base font with video height so subs look right at any size
    s.fontSize = `${Math.max(12, rect.height * 0.026)}px`;
  }

  private enableDrag(): void {
    let dragging = false;
    let height = 1;
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const rect = this.el.getBoundingClientRect();
      height = rect.height || 1;
      const fromTop = (e.clientY - rect.top) / height;
      this.setPosition(fromTop);
      this.onReposition?.(this.posFraction);
    };
    const start = (e: PointerEvent) => {
      // only drag from empty area / the block itself, left button
      if (e.button !== 0) return;
      dragging = true;
      this.container.setPointerCapture?.(e.pointerId);
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener(
        "pointerup",
        () => {
          dragging = false;
          window.removeEventListener("pointermove", onMove, true);
        },
        { once: true, capture: true },
      );
    };
    // Dragging starts on the sub blocks but not when clicking a word token.
    this.container.addEventListener("pointerdown", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".tnm-token.-tnm-word")) return;
      start(e);
    });
  }
}
