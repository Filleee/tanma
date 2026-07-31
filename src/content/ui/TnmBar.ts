import { el } from "./dom";
import { icons } from "./icons";

export interface TnmBarCallbacks {
  onToggleEnabled: () => void;
  onPrev: () => void;
  onReplay: () => void;
  onPlayPause: () => void;
  onNext: () => void;
  onToggleBrowser: () => void;
  onToggleSettings: () => void;
  onToggleHide: () => void;
  onImport: () => void;
  onJimaku: () => void;
  onLyrics: () => void;
  onToggleQueue: () => void;
  onSetOffset: (value: number) => void;
}

const OFFSET_MAX = 60;

function btn(icon: SVGElement, tip: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", { class: "tnm-btn -icon tnm-tip", "data-tip": tip }, icon) as HTMLButtonElement;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Docked toolbar: a full-width bar across the top of the video
 * (left = status, right = controls), positioned by the sync loop and auto-hidden
 * while watching.
 */
export class TnmBar {
  readonly el: HTMLDivElement;
  private playBtn: HTMLButtonElement;
  private browserBtn: HTMLButtonElement;
  private settingsBtn: HTMLButtonElement;
  private hideBtn: HTMLButtonElement;
  private powerBtn: HTMLButtonElement;
  private queueBtn!: HTMLButtonElement;
  private queueCountEl!: HTMLSpanElement;
  private knownEl: HTMLDivElement;
  private offsetInput!: HTMLInputElement;
  private offset = 0;
  private cb: TnmBarCallbacks;

  constructor(cb: TnmBarCallbacks) {
    this.cb = cb;

    this.powerBtn = btn(icons.power(), "Enable / disable", cb.onToggleEnabled);
    this.knownEl = el("div", { class: "TnmBar__knownWords tnm-tip", "data-tip": "Known words (this language)" });
    const brand = el("div", { class: "TnmBar__brand" }, "TANMA!");

    const prevBtn = btn(icons.prev(), "Previous line (A)", cb.onPrev);
    const replayBtn = btn(icons.replay(), "Replay line (S)", cb.onReplay);
    this.playBtn = btn(icons.pause(), "Play / pause", cb.onPlayPause);
    const nextBtn = btn(icons.next(), "Next line (D)", cb.onNext);

    this.queueBtn = this.buildQueueBtn(cb.onToggleQueue);
    this.browserBtn = btn(icons.list(), "Subtitle browser", cb.onToggleBrowser);
    this.hideBtn = btn(icons.eye(), "Hide subtitles (listening mode)", cb.onToggleHide);
    const importBtn = btn(icons.upload(), "Import subtitle file (.srt/.vtt/.ass)", cb.onImport);
    const jimakuBtn = btn(icons.jimaku(), "Find subtitles on jimaku.cc", cb.onJimaku);
    const lyricsBtn = btn(icons.lyrics(), "Find song lyrics (LRCLIB)", cb.onLyrics);
    this.settingsBtn = btn(icons.gear(), "Settings", cb.onToggleSettings);

    const left = el("div", { class: "TnmBar__leftSide" }, this.powerBtn, brand, this.knownEl);
    const right = el(
      "div",
      { class: "TnmBar__rightSide" },
      prevBtn, replayBtn, this.playBtn, nextBtn,
      sep(),
      this.buildOffset(),
      sep(),
      this.queueBtn, this.browserBtn, this.hideBtn, importBtn, jimakuBtn, lyricsBtn, this.settingsBtn,
    );

    this.el = el("div", { class: "TnmBar -hidden" }, left, right);
  }

  /** Position the bar across the top of the video. */
  place(rect: DOMRect): void {
    const s = this.el.style;
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
  }

  setVisible(visible: boolean): void {
    this.el.classList.toggle("-hidden", !visible);
  }

  /** Real-time subtitle timing offset: −/+ nudge, or type an exact value into the box
   *  (±60s). The full slider lives in the Settings panel (a wide slider across the video
   *  top got dragged by accident when clicking the player, and could drift out of sync). */
  private buildOffset(): HTMLElement {
    const minus = el("button", { class: "tnm-btn -icon tnm-tip", "data-tip": "Subtitles earlier" }, "−") as HTMLButtonElement;
    const plus = el("button", { class: "tnm-btn -icon tnm-tip", "data-tip": "Subtitles later" }, "+") as HTMLButtonElement;
    this.offsetInput = el("input", {
      type: "number", step: "0.1", min: String(-OFFSET_MAX), max: String(OFFSET_MAX),
      class: "TnmBar__offset__val tnm-tip", "data-tip": "Subtitle timing offset in seconds — type a value (0 = none)",
    }) as HTMLInputElement;

    const commit = (v: number) => {
      if (Number.isNaN(v)) return;
      this.offset = Math.max(-OFFSET_MAX, Math.min(OFFSET_MAX, Math.round(v * 10) / 10));
      this.reflectOffset();
      this.cb.onSetOffset(this.offset);
    };
    minus.addEventListener("click", () => commit(this.offset - 0.1));
    plus.addEventListener("click", () => commit(this.offset + 0.1));
    this.offsetInput.addEventListener("input", () => commit(parseFloat(this.offsetInput.value)));
    this.offsetInput.addEventListener("change", () => commit(parseFloat(this.offsetInput.value)));
    this.offsetInput.addEventListener("keydown", (e) => { if (e.key === "Enter") this.offsetInput.blur(); });

    return el("div", { class: "TnmBar__offset" }, minus, this.offsetInput, el("span", { class: "TnmBar__offset__unit" }, "s"), plus);
  }

  setOffsetValue(v: number): void {
    this.offset = v;
    this.reflectOffset();
  }
  private reflectOffset(): void {
    // Don't clobber the box while the user is actively typing into it.
    const root = this.offsetInput.getRootNode() as Document | ShadowRoot;
    if (root.activeElement !== this.offsetInput) this.offsetInput.value = this.offset.toFixed(1);
    this.offsetInput.classList.toggle("-active", this.offset !== 0);
  }

  /** Queue button carries a small count badge (hidden at 0). */
  private buildQueueBtn(onClick: () => void): HTMLButtonElement {
    const b = el("button", { class: "tnm-btn -icon tnm-tip TnmBar__queue", "data-tip": "Mining queue" }, icons.stack()) as HTMLButtonElement;
    this.queueCountEl = el("span", { class: "TnmBar__queue__badge" }) as HTMLSpanElement;
    b.append(this.queueCountEl);
    b.addEventListener("click", onClick);
    return b;
  }

  setQueueCount(n: number): void {
    this.queueCountEl.textContent = n > 0 ? String(n) : "";
    this.queueBtn.classList.toggle("-has", n > 0);
  }
  setQueueActive(on: boolean): void {
    this.queueBtn.classList.toggle("-active", on);
  }

  setPlaying(playing: boolean): void {
    this.playBtn.replaceChildren(playing ? icons.pause() : icons.play());
  }
  setEnabled(on: boolean): void {
    this.powerBtn.classList.toggle("-active", on);
  }
  setBrowserActive(on: boolean): void {
    this.browserBtn.classList.toggle("-active", on);
  }
  setSettingsActive(on: boolean): void {
    this.settingsBtn.classList.toggle("-active", on);
  }
  setHideActive(on: boolean): void {
    this.hideBtn.replaceChildren(on ? icons.eyeOff() : icons.eye());
    this.hideBtn.classList.toggle("-active", on);
  }
  setKnownCount(n: number): void {
    const b = document.createElement("b");
    b.textContent = n.toLocaleString();
    this.knownEl.replaceChildren(b, document.createTextNode(" known"));
  }

  get settingsAnchor(): DOMRect {
    return this.settingsBtn.getBoundingClientRect();
  }
}

function sep(): HTMLElement {
  return el("div", { class: "TnmBar__sep" });
}
