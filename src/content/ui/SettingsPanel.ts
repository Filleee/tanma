import type { Settings } from "../../common/types";
import { normalizeLang } from "../../lib/tokenizer";
import { el, clear } from "./dom";

type Patch = Partial<Settings>;

const langLabel = (code: string): string => LANGS.find(([v]) => v === code)?.[1] ?? code;

const LANGS: [string, string][] = [
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["en", "English"],
  ["id", "Indonesian"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["ru", "Russian"],
];

/** Subtitle display-options popover. */
export class SettingsPanel {
  readonly el: HTMLDivElement;
  private settings: Settings;
  private onChange: (patch: Patch) => void;
  /** Normalized languages with an official translation track for the current video (drives the
   *  grey-out of "Show translation when available"). Updated by the content app per video. */
  private availableSecondary: string[] = [];

  constructor(settings: Settings, onChange: (patch: Patch) => void) {
    this.settings = settings;
    this.onChange = onChange;
    this.el = el("div", { class: "tnm-popover" });
    this.el.style.display = "none";
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.render();
  }

  isOpen(): boolean {
    return this.el.style.display !== "none";
  }
  open(): void {
    this.render();
    this.el.style.display = "";
  }
  close(): void {
    this.el.style.display = "none";
  }
  toggle(): void {
    this.isOpen() ? this.close() : this.open();
  }

  update(settings: Settings): void {
    this.settings = settings;
    if (this.isOpen()) this.render();
  }

  /** Tell the panel which languages have an official translation track for the current video. */
  setAvailableSecondary(langs: string[]): void {
    const next = langs.map(normalizeLang).sort().join(",");
    if (next === this.availableSecondary.slice().sort().join(",")) return;
    this.availableSecondary = langs.map(normalizeLang);
    if (this.isOpen()) this.render();
  }

  private set(patch: Patch): void {
    this.settings = { ...this.settings, ...patch };
    this.onChange(patch);
    // These change the set of visible fields; re-rendering on every slider/switch
    // tick would otherwise rebuild the control the user is interacting with.
    if (
      "pauseMode" in patch ||
      "showSecondary" in patch ||
      "showMachineTranslation" in patch ||
      "nativeLang" in patch ||
      "targetLang" in patch
    ) {
      this.render();
    }
  }

  private slider(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, key: keyof Settings): HTMLElement {
    const valEl = el("span", { class: "val" }, fmt(value));
    const input = el("input", { type: "range", min, max, step, value }) as HTMLInputElement;
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      valEl.textContent = fmt(v);
      this.set({ [key]: v } as Patch);
    });
    return el(
      "div",
      { class: "tnm-field" },
      el("div", { class: "tnm-field__label" }, el("span", {}, label), valEl),
      input,
    );
  }

  /** Like `slider`, but the readout is an editable number box (with an "s" suffix) so a
   *  precise value can be typed. Slider and box stay in sync; both clamp to [min,max]. */
  private numberSlider(label: string, value: number, min: number, max: number, step: number, key: keyof Settings): HTMLElement {
    const num = el("input", { type: "number", min, max, step, value: value.toFixed(1), class: "num" }) as HTMLInputElement;
    const slider = el("input", { type: "range", min, max, step, value }) as HTMLInputElement;
    const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v * 10) / 10));
    const commit = (raw: number, from: "num" | "slider") => {
      if (Number.isNaN(raw)) return;
      const v = clamp(raw);
      if (from !== "num") num.value = v.toFixed(1);
      if (from !== "slider") slider.value = String(v);
      this.set({ [key]: v } as Patch);
    };
    slider.addEventListener("input", () => commit(parseFloat(slider.value), "slider"));
    num.addEventListener("input", () => commit(parseFloat(num.value), "num"));
    num.addEventListener("change", () => { num.value = clamp(parseFloat(num.value) || 0).toFixed(1); });
    return el(
      "div",
      { class: "tnm-field" },
      el("div", { class: "tnm-field__label" }, el("span", {}, label), el("span", { class: "tnm-numbox" }, num, el("span", { class: "suffix" }, "s"))),
      slider,
    );
  }

  private switchRow(label: string, value: boolean, key: keyof Settings, mutedTip?: string): HTMLElement {
    const input = el("input", { type: "checkbox" }) as HTMLInputElement;
    input.checked = value;
    input.addEventListener("change", () => this.set({ [key]: input.checked } as Patch));
    const sw = el("label", { class: "tnm-switch" }, input, el("span", { class: "track" }), el("span", { class: "thumb" }));
    const row = el("div", { class: "tnm-row" }, el("span", {}, label), sw);
    if (mutedTip) {
      row.style.opacity = "0.55"; // greyed: the preference is on but ineffective for this video
      row.title = mutedTip; // hover tooltip explaining why
    }
    return row;
  }

  private note(text: string): HTMLElement {
    return el("div", { class: "tnm-note", style: "font-size:11px;opacity:0.7;margin:-2px 2px 4px;line-height:1.3" }, text);
  }

  private selectRow(label: string, value: string, options: [string, string][], key: keyof Settings): HTMLElement {
    const sel = el("select") as HTMLSelectElement;
    for (const [v, t] of options) {
      const opt = el("option", { value: v }, t) as HTMLOptionElement;
      if (v === value) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener("change", () => this.set({ [key]: sel.value } as Patch));
    return el("div", { class: "tnm-row" }, el("span", {}, label), sel);
  }

  private render(): void {
    const s = this.settings;
    clear(this.el);
    this.el.append(el("h3", {}, "Subtitle settings"));

    this.el.append(this.selectRow("Target language", s.targetLang, LANGS, "targetLang"));
    this.el.append(this.slider("Subtitle size", s.subtitleSize, 0.5, 2.5, 0.05, (v) => `${Math.round(v * 100)}%`, "subtitleSize"));
    this.el.append(this.slider("Subtitle shadow", s.subtitleShadow, 0, 2, 0.05, (v) => `${Math.round(v * 100)}%`, "subtitleShadow"));
    this.el.append(this.slider("Background plate", s.subtitleBackground, 0, 1, 0.05, (v) => (v === 0 ? "off" : `${Math.round(v * 100)}%`), "subtitleBackground"));
    this.el.append(this.numberSlider("Timing offset", s.subOffset, -60, 60, 0.1, "subOffset"));

    this.el.append(el("div", { style: "height:6px" }));
    this.el.append(this.switchRow("Furigana (readings)", s.showFurigana, "showFurigana"));

    // Two translation sources: a real/official track (when the video has one in your language),
    // and a machine translation (works anywhere). A shared language dropdown picks the language.
    const native = normalizeLang(s.nativeLang);
    const sameAsTarget = native === normalizeLang(s.targetLang);
    const officialHere = !!native && !sameAsTarget && this.availableSecondary.includes(native);
    const noOfficialHere = !sameAsTarget && !officialHere;
    this.el.append(
      this.switchRow(
        "Show translation (when available)",
        s.showSecondary,
        "showSecondary",
        noOfficialHere ? `No official ${langLabel(s.nativeLang)} subtitles for this video.` : undefined,
      ),
    );
    if (s.showSecondary && noOfficialHere) {
      this.el.append(this.note(`No official ${langLabel(s.nativeLang)} track here — turn on “Show machine translation”.`));
    }
    this.el.append(this.switchRow("Show machine translation", s.showMachineTranslation, "showMachineTranslation"));
    if (s.showSecondary || s.showMachineTranslation) {
      this.el.append(this.selectRow("Translation language", s.nativeLang, LANGS, "nativeLang"));
    }
    this.el.append(this.switchRow("Color word status", s.showKnownStatus, "showKnownStatus"));
    this.el.append(this.switchRow("Hover to look up", s.hoverLookup, "hoverLookup"));
    this.el.append(this.switchRow("Match multi-word expressions", s.compoundLookup, "compoundLookup"));

    this.el.append(el("div", { style: "height:6px" }));
    this.el.append(
      this.selectRow(
        "Pause mode",
        s.pauseMode,
        [
          ["off", "Off"],
          ["eachLine", "Pause each line"],
          ["onLookup", "Pause on lookup"],
        ],
        "pauseMode",
      ),
    );
    if (s.pauseMode === "eachLine") {
      this.el.append(this.slider("Auto-resume after", s.autoResume, 0, 10, 0.5, (v) => (v === 0 ? "manual" : `${v.toFixed(1)}s`), "autoResume"));
    }

    this.el.append(el("div", { style: "height:6px" }));
    const obscureOpts: [string, string][] = [
      ["off", "Show"],
      ["blur", "Blur (reveal on hover)"],
      ["hide", "Hide (reveal on hover)"],
    ];
    this.el.append(this.selectRow("Target subs", s.hideTarget, obscureOpts, "hideTarget"));
    this.el.append(this.selectRow("Translation", s.hideSecondary, obscureOpts, "hideSecondary"));
  }
}
