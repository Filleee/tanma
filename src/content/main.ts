import { initFrameBus, setFrameHandler, isTopFrame, type FrameMsg } from "./frameBus";

// The content script runs in every frame (all_frames), so a site that hosts its <video> in a
// nested cross-origin iframe (miruro → …/embed → strm.cx) still gets the overlay. To keep the
// cost sane, only the TOP frame and any sub-frame that actually contains a <video> boot the
// full app; every other frame just installs the message listener (near-zero) so it isn't
// running the heavy overlay in every ad/tracker iframe.

initFrameBus();

let app: { onFrameMessage(m: FrameMsg, source: Window | null): void } | null = null;
setFrameHandler((msg, source) => app?.onFrameMessage(msg, source));

let booting = false;
async function bootApp(): Promise<void> {
  if (app || booting || (window as any).__tnmApp) return;
  booting = true;
  const { App } = await import("./app"); // lazy: video-less frames never load the heavy bundle
  const instance = new App();
  app = instance as unknown as { onFrameMessage(m: FrameMsg, source: Window | null): void };
  (window as any).__tnmApp = instance;
  await instance.start().catch((e: unknown) => console.error("[tnm] failed to start:", e));
}

if (isTopFrame()) {
  bootApp();
} else if (document.querySelector("video")) {
  bootApp();
} else {
  // Sub-frame with no <video> yet: it may be the player frame before its element mounts.
  // Watch for one, then boot; give up after a while so idle ad/tracker frames don't keep an
  // observer around forever.
  const check = (): boolean => {
    if (document.querySelector("video")) {
      obs.disconnect();
      clearInterval(poll);
      bootApp();
      return true;
    }
    return false;
  };
  const obs = new MutationObserver(() => check());
  try {
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* documentElement not ready — the poll below still covers it */
  }
  let tries = 0;
  const poll = setInterval(() => {
    if (check() || ++tries > 40) {
      clearInterval(poll);
      obs.disconnect();
    }
  }, 500);
}
