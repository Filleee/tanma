type Cb = (video: HTMLVideoElement | null) => void;

/**
 * Finds and tracks the page's primary <video>. Streaming sites add/replace the
 * element on navigation, so we re-scan on DOM mutations and on a slow interval,
 * and prefer the largest visible (ideally playing) video.
 */
export class VideoManager {
  private _current: HTMLVideoElement | null = null;
  private listeners = new Set<Cb>();
  private observer: MutationObserver;
  private interval: number;

  constructor() {
    this.observer = new MutationObserver(() => this.rescan());
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    this.interval = window.setInterval(() => this.rescan(), 1500);
    this.rescan();
  }

  get current(): HTMLVideoElement | null {
    return this._current;
  }

  onChange(cb: Cb): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private rescan() {
    const next = this.pickBest();
    // If the current one is gone from the DOM, drop it.
    if (this._current && !this._current.isConnected) this._current = null;
    if (next && next !== this._current) {
      this._current = next;
      this.emit();
    } else if (!next && this._current && !this._current.isConnected) {
      this._current = null;
      this.emit();
    }
  }

  private pickBest(): HTMLVideoElement | null {
    const videos = Array.from(document.querySelectorAll("video")) as HTMLVideoElement[];
    let best: HTMLVideoElement | null = null;
    let bestScore = -1;
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area < 120 * 90) continue; // ignore thumbnails / hidden players
      const visible = rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0;
      if (!visible) continue;
      let score = area;
      if (!v.paused) score *= 3; // strongly prefer the one that's playing
      if (v.currentTime > 0) score *= 1.2;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  private emit() {
    for (const cb of this.listeners) cb(this._current);
  }

  destroy() {
    this.observer.disconnect();
    clearInterval(this.interval);
    this.listeners.clear();
  }
}
