import css from "./overlay.css?inline";

/**
 * Owns the shadow-DOM host that all UI renders into. Lives in a fixed,
 * pointer-events:none layer covering the viewport. On fullscreen it reparents
 * into the fullscreen element (otherwise the browser would paint it underneath).
 */
export class ShadowHost {
  readonly host: HTMLDivElement;
  readonly shadow: ShadowRoot;
  readonly root: HTMLDivElement;
  readonly layer: HTMLDivElement;

  constructor() {
    this.host = document.createElement("div");
    this.host.id = "tnm-root";
    this.host.style.cssText = "all: initial;";
    this.shadow = this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = css;
    this.shadow.append(style);

    this.root = document.createElement("div");
    this.root.className = "tnm-root";
    this.layer = document.createElement("div");
    this.layer.className = "tnm-layer";
    this.root.append(this.layer);
    this.shadow.append(this.root);

    document.documentElement.append(this.host);
    document.addEventListener("fullscreenchange", this.onFullscreen, true);
    document.addEventListener("webkitfullscreenchange", this.onFullscreen as any, true);

    // Keystrokes typed into OUR shadow-DOM inputs (search boxes) must not leak to the
    // page: the site's player can't tell focus is in our input (document.activeElement is
    // the shadow host, not the field), so it fires its own keyboard shortcuts (play/pause,
    // seek). This matters most when our UI runs INSIDE the player's own frame (nested-iframe
    // players). A capture-phase listener on `window` — the very first node in the event's
    // path — beats the player's document/element handler (capture or bubble) and stops the
    // event before it can reach it. We only stopPropagation (never preventDefault), so the
    // character still types.
    const swallow = (e: Event): void => {
      const path = (e as Event & { composedPath?: () => EventTarget[] }).composedPath?.();
      const t = path?.[0] as HTMLElement | undefined;
      const tag = t?.tagName;
      const editable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!t?.isContentEditable;
      if (!editable || !path?.includes(this.shadow)) return;
      // Let Enter through so a field's own submit handler (e.g. search-on-Enter) still fires;
      // swallow everything else so player shortcuts (space, f, m, k/j/l, arrows…) don't run
      // while typing. stopImmediatePropagation (never preventDefault) so the character types.
      if ((e as KeyboardEvent).key !== "Enter") e.stopImmediatePropagation();
    };
    for (const type of ["keydown", "keyup", "keypress"]) {
      window.addEventListener(type, swallow, true); // capture: runs before the page's handlers
    }
  }

  private onFullscreen = () => {
    const fs =
      document.fullscreenElement ?? (document as any).webkitFullscreenElement ?? null;
    const parent = (fs as HTMLElement | null) ?? document.documentElement;
    if (this.host.parentElement !== parent) parent.append(this.host);
  };

  setThemeFlags(flags: { furigana: boolean; knownStatus: boolean }) {
    this.root.classList.toggle("-tnm-furigana", flags.furigana);
    this.root.classList.toggle("-tnm-show-known-status", flags.knownStatus);
  }

  destroy() {
    document.removeEventListener("fullscreenchange", this.onFullscreen, true);
    document.removeEventListener("webkitfullscreenchange", this.onFullscreen as any, true);
    this.host.remove();
  }
}
