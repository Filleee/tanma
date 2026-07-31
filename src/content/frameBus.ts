// Cross-frame messaging. Some players host the <video> in a nested cross-origin iframe
// (miruro → theanimecommunity.com/embed → strm.cx) while the page that knows the show —
// and loads the subtitle — is the TOP frame. Rather than relay hop-by-hop through every
// intermediate frame (fragile: a sandboxed/CSP'd middle frame may not run our script),
// each frame talks DIRECTLY to window.top, and the top replies DIRECTLY to the requester
// via the message's `event.source`. That needs nothing from the frames in between.
//
// The content script runs in every frame (all_frames) purely so the frame that owns the
// <video> boots the app and can register with the top; frames without a video do nothing.

export interface FrameMsg {
  __tnm: "frame";
  kind: string;
  [k: string]: unknown;
}

type Handler = (msg: FrameMsg, source: Window | null) => void;

let handler: Handler = () => {};

export function setFrameHandler(h: Handler): void {
  handler = h;
}

export function initFrameBus(): void {
  window.addEventListener("message", (e) => {
    const d = e.data as FrameMsg | undefined;
    if (!d || d.__tnm !== "frame" || typeof d.kind !== "string") return;
    try {
      handler(d, (e.source as Window) ?? null);
    } catch {
      /* handler errors are the app's problem, not the bus's */
    }
  });
}

/** Post a message to a specific window (the top frame, or a requester's event.source). */
export function frameSend(target: Window | null | undefined, kind: string, payload: Record<string, unknown> = {}): void {
  if (!target) return;
  try {
    target.postMessage({ __tnm: "frame", kind, ...payload }, "*");
  } catch {
    /* dead/detached window — ignore */
  }
}

export function topWindow(): Window | null {
  try {
    return window.top;
  } catch {
    return null;
  }
}

export function isTopFrame(): boolean {
  try {
    return window.top === window.self;
  } catch {
    return false; // cross-origin ancestor → definitely a sub-frame
  }
}
