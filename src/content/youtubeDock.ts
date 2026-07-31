/**
 * Docks the subtitle browser into YouTube's watch layout:
 * by owning the layout around the player instead of fighting YouTube's sizing.
 *
 * NORMAL layout — wrap `#player` in our own flex row alongside a fixed-width
 * "standin" (in the player's original slot, marked by a Comment for restore):
 *
 *     #primary-inner
 *       └─ .tnm-dock-row (flex)
 *            ├─ #player   (flex: 1, shrinks)
 *            └─ .tnm-dock-standin (flex: 0 0 372px)   ← reserves the gap
 *
 * The standin always gets its width; #player shrinks; injected CSS forces
 * #movie_player to fill the narrower #player. The browser sits over the standin.
 *
 * THEATER layout — YouTube renders the video in a full-width `#full-bleed-container`
 * and leaves `#player` collapsed to 0×0, so there's nothing to wrap. Instead we
 * shrink the full-bleed container via CSS (and force #movie_player to fit), then
 * dock the browser in the gap on its right. If the player refuses to shrink we
 * fall back to floating rather than overlap.
 *
 * Disabled in fullscreen / off-watch / too narrow.
 */
const DOCK_WIDTH = 372;
const GAP = 12;
const STYLE_ID = "tnm-sub-dock-style";
const THEATER_ATTR = "tnm-theater-dock";

export class YoutubeDock {
  private row: HTMLElement | null = null;
  private standin: HTMLElement | null = null;
  private wrapped: HTMLElement | null = null;
  private slot: Comment | null = null;
  private styleInjected = false;
  private docking = false;
  private loggedTheater = false;

  private flexy(): HTMLElement | null {
    return document.querySelector("ytd-watch-flexy") as HTMLElement | null;
  }
  private playerEl(): HTMLElement | null {
    return (this.flexy()?.querySelector("#player") as HTMLElement | null) ?? null;
  }
  private fullBleed(): HTMLElement | null {
    return (this.flexy()?.querySelector("#full-bleed-container") as HTMLElement | null) ?? null;
  }
  private isTheater(): boolean {
    return !!this.flexy()?.hasAttribute("theater");
  }

  canDock(): boolean {
    const f = this.flexy();
    if (!f || f.hasAttribute("fullscreen")) return false;
    return window.innerWidth >= 1000;
  }

  private nudgeResize(): void {
    try {
      window.dispatchEvent(new Event("resize"));
    } catch {
      /* ignore */
    }
  }

  private ensureStyle(): void {
    if (this.styleInjected || document.getElementById(STYLE_ID)) {
      this.styleInjected = true;
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* normal layout: wrap + shrink #player, force the player to fill it */
      .tnm-dock-row{display:flex!important;align-items:flex-start;gap:${GAP}px;width:100%;}
      .tnm-dock-row>#player{flex:1 1 auto!important;min-width:0!important;width:auto!important;position:relative;aspect-ratio:16/9;height:auto!important;overflow:hidden;}
      .tnm-dock-row #movie_player{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;}
      .tnm-dock-row #movie_player .html5-video-container,
      .tnm-dock-row #movie_player video.html5-main-video{width:100%!important;height:100%!important;left:0!important;top:0!important;}
      .tnm-dock-row #movie_player .ytp-chrome-bottom{left:12px!important;right:12px!important;width:auto!important;}
      .tnm-dock-row #movie_player .ytp-gradient-bottom,
      .tnm-dock-row #movie_player .ytp-gradient-top,
      .tnm-dock-row #movie_player .ytp-chrome-top{left:0!important;right:0!important;width:auto!important;}
      .tnm-dock-standin{flex:0 0 ${DOCK_WIDTH}px;align-self:stretch;pointer-events:none;}

      /* theater layout: the full-bleed player spans the whole width (video
         letterboxed inside), so pad the container's right edge (box-sizing keeps
         the outer box, shrinking the content) and force the whole player chain to
         fit — leaving a real gap on the right for the dock. */
      ytd-watch-flexy[${THEATER_ATTR}] #full-bleed-container{box-sizing:border-box!important;padding-right:${DOCK_WIDTH + GAP}px!important;}
      ytd-watch-flexy[${THEATER_ATTR}] #full-bleed-container #player-full-bleed-container,
      ytd-watch-flexy[${THEATER_ATTR}] #full-bleed-container #player-container,
      ytd-watch-flexy[${THEATER_ATTR}] #full-bleed-container ytd-player,
      ytd-watch-flexy[${THEATER_ATTR}] #full-bleed-container #movie_player{width:100%!important;left:0!important;}
      ytd-watch-flexy[${THEATER_ATTR}] #full-bleed-container #movie_player .html5-video-container,
      ytd-watch-flexy[${THEATER_ATTR}] #full-bleed-container #movie_player video.html5-main-video{width:100%!important;left:0!important;}
      ytd-watch-flexy[${THEATER_ATTR}] #full-bleed-container #movie_player .ytp-chrome-bottom{left:12px!important;right:12px!important;width:auto!important;}
      ytd-watch-flexy[${THEATER_ATTR}] #full-bleed-container #movie_player .ytp-gradient-bottom,
      ytd-watch-flexy[${THEATER_ATTR}] #full-bleed-container #movie_player .ytp-gradient-top,
      ytd-watch-flexy[${THEATER_ATTR}] #full-bleed-container #movie_player .ytp-chrome-top{left:0!important;right:0!important;width:auto!important;}
    `;
    (document.head || document.documentElement).appendChild(style);
    this.styleInjected = true;
  }

  /** Reserve the gap and return the box the browser should fill, or null to float. */
  dockBox(): DOMRect | null {
    if (!this.canDock()) {
      this.remove();
      return null;
    }
    this.logTheaterDebug();
    this.ensureStyle();
    return this.isTheater() ? this.dockTheater() : this.dockNormal();
  }

  // ---- normal layout: wrap #player ----
  private dockNormal(): DOMRect | null {
    this.flexy()?.removeAttribute(THEATER_ATTR);
    if (!this.ensureWrap() || !this.standin) {
      this.removeWrap();
      return null;
    }
    const r = this.standin.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) return null; // not settled yet
    this.markDocked();
    return r;
  }

  // ---- theater layout: dock in the player's right-hand letterbox margin ----
  private dockTheater(): DOMRect | null {
    this.removeWrap(); // no normal wrap in theater
    const f = this.flexy();
    const fb = this.fullBleed();
    if (!f || !fb) {
      this.remove();
      return null;
    }
    f.setAttribute(THEATER_ATTR, ""); // pin the player left
    const mp = fb.querySelector("#movie_player") as HTMLElement | null;
    const mpr = mp?.getBoundingClientRect();
    if (!mpr || mpr.height < 50) return null; // not settled
    const width = DOCK_WIDTH - GAP;
    const left = mpr.right + GAP;
    // The (height-constrained) player leaves a margin; dock there if it fits,
    // otherwise float rather than cover the video. Keep the attr either way so we
    // don't thrash the layout frame-to-frame.
    if (left + width > window.innerWidth - 4) return null;
    this.markDocked();
    return new DOMRect(left, mpr.top, width, mpr.height);
  }

  private markDocked(): void {
    if (!this.docking) {
      this.docking = true;
      console.info(`[tnm] subtitle browser docked (${this.isTheater() ? "theater" : "normal"})`);
    }
  }

  /** Wrap #player + standin in a flex row at #player's slot (idempotent). */
  private ensureWrap(): boolean {
    const player = this.playerEl();
    if (!player || !player.parentElement) return false;
    if (this.row && this.row.contains(player) && this.row.isConnected) return true;
    if (this.row) this.discardWrapper(); // stale (player moved/replaced) — drop orphan, re-wrap

    this.slot = document.createComment("tnm-player-slot");
    player.parentElement.insertBefore(this.slot, player);
    this.row = document.createElement("div");
    this.row.className = "tnm-dock-row";
    this.standin = document.createElement("div");
    this.standin.className = "tnm-dock-standin";
    this.row.appendChild(player);
    this.row.appendChild(this.standin);
    this.slot.parentElement!.insertBefore(this.row, this.slot);
    this.wrapped = player;
    this.nudgeResize();
    return true;
  }

  private discardWrapper(): void {
    this.slot?.remove();
    this.row?.remove();
    this.slot = null;
    this.row = null;
    this.standin = null;
    this.wrapped = null;
  }

  /** Restore #player to its slot (normal-mode wrap) and remove our wrapper. */
  private removeWrap(): void {
    const had = !!this.row;
    if (this.wrapped && this.row?.contains(this.wrapped)) {
      const ref = this.slot?.parentElement ? this.slot : this.row;
      ref.parentElement?.insertBefore(this.wrapped, ref);
    }
    this.discardWrapper();
    if (had) this.nudgeResize();
  }

  /** Full teardown: undo both layouts. */
  remove(): void {
    this.removeWrap();
    const f = this.flexy();
    if (f?.hasAttribute(THEATER_ATTR)) {
      f.removeAttribute(THEATER_ATTR);
      this.nudgeResize();
    }
    if (this.docking) {
      this.docking = false;
      console.info("[tnm] subtitle browser undocked");
    }
  }

  // One-shot dump of theater's real DOM (can't be reproduced headlessly).
  private logTheaterDebug(): void {
    const f = this.flexy();
    if (!f || !f.hasAttribute("theater")) {
      this.loggedTheater = false;
      return;
    }
    if (this.loggedTheater) return;
    this.loggedTheater = true;
    const desc = (e: Element | null) =>
      e ? `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.classList.length ? "." + [...e.classList].slice(0, 2).join(".") : ""}` : "null";
    const round = (r: DOMRect) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    const fb = this.fullBleed();
    const mp = (fb?.querySelector("#movie_player") ?? f.querySelector("#movie_player")) as HTMLElement | null;
    const chain: string[] = [];
    for (let cur: HTMLElement | null = mp; cur && cur !== f && chain.length < 8; cur = cur.parentElement) chain.push(desc(cur));
    const pfb = fb?.querySelector("#player-full-bleed-container") as HTMLElement | null;
    console.info(
      "[tnm][theater-debug] copy this whole line to the developer:",
      JSON.stringify({
        moviePlayerChain: chain,
        moviePlayerPosition: mp ? getComputedStyle(mp).position : null,
        moviePlayerRect: mp ? round(mp.getBoundingClientRect()) : null,
        fullBleedPosition: fb ? getComputedStyle(fb).position : null,
        fullBleedRect: fb ? round(fb.getBoundingClientRect()) : null,
        playerFullBleedPosition: pfb ? getComputedStyle(pfb).position : null,
        playerFullBleedRect: pfb ? round(pfb.getBoundingClientRect()) : null,
        innerWidth: window.innerWidth,
      }),
    );
  }
}
