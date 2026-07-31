// Standalone "TANMA! Player" page: play a local video/audio file with a custom (Netflix-style)
// control bar, and load a subtitle — sidecar or extracted from an .mkv — into the same
// interactive overlay (furigana, look-ups, mining, browser). Reuses the content App, whose
// VideoManager attaches the overlay to this page's <video>.
import { App } from "../../content/app";
import { extractMkvSubtitles, pickBestSubtitleTrack, type MkvSubtitleTrack } from "../../lib/parsers/mkv";
import { loadSettings } from "../../lib/storage";
import { applyAccentVars } from "../../lib/theme";

// Apply the user's accent colour to the player chrome (the overlay applies it itself).
loadSettings().then((s) => applyAccentVars(document.documentElement, s.accent || "#ff9345")).catch(() => {});

const VIDEO_RE = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|ts|mpe?g)$/i;
const AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|oga|opus)$/i;
const SUB_RE = /\.(srt|vtt|ass|ssa|txt)$/i;
const MATROSKA_RE = /\.(mkv|mka)$/i; // try embedded-subtitle extraction for these (webm is almost always just video)
const isMedia = (name: string) => VIDEO_RE.test(name) || AUDIO_RE.test(name);

const app = new App();
(window as unknown as { __tnmApp: App }).__tnmApp = app;
app.start().catch((e) => console.error("[tnm-player] failed to start:", e));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("tnm-player");
const drop = $<HTMLDivElement>("drop");
const dragmask = $<HTMLDivElement>("dragmask");
const videoInput = $<HTMLInputElement>("video-input");
const subInput = $<HTMLInputElement>("sub-input");
const subSelector = $<HTMLDivElement>("sub-selector");
const subTrackSel = $<HTMLSelectElement>("sub-track");

// ---- SVG icons for the control bar ----
const ICONS = {
  play: '<path fill="currentColor" d="M8 5v14l11-7z"/>',
  pause: '<path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
  back: '<path fill="currentColor" d="M11 6v12l-8.5-6zM20 6v12l-8.5-6z"/>',
  fwd: '<path fill="currentColor" d="M13 6v12l8.5-6zM4 6v12l8.5-6z"/>',
  vol: '<path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 8.5a4.5 4.5 0 0 1 0 7M18.7 6a8 8 0 0 1 0 12"/>',
  mute: '<path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9.5l5 5M21 9.5l-5 5"/>',
  fs: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  fsExit: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
};
function icon(html: string): SVGSVGElement {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.innerHTML = html;
  return s;
}

// Small status toast for extraction progress / errors (the App shows its own "Loaded N lines").
const statusEl = document.createElement("div");
statusEl.id = "player-status";
statusEl.style.cssText =
  "position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:2250;display:none;max-width:80vw;text-align:center;" +
  "background:rgba(20,22,28,.94);color:#f3f3f7;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:8px 14px;" +
  "font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);";
document.body.append(statusEl);
let statusTimer = 0;
function status(msg: string, sticky = false): void {
  statusEl.textContent = msg;
  statusEl.style.display = "";
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = window.setTimeout(hideStatus, 4500);
}
function hideStatus(): void {
  statusEl.style.display = "none";
}

// ---- embedded-subtitle track selector ----
const LANG_NAMES: Record<string, string> = {
  jpn: "Japanese", ja: "Japanese", jp: "Japanese", eng: "English", en: "English", kor: "Korean", ko: "Korean",
  chi: "Chinese", zho: "Chinese", zh: "Chinese", spa: "Spanish", es: "Spanish", fre: "French", fra: "French", fr: "French",
  ger: "German", deu: "German", de: "German", por: "Portuguese", pt: "Portuguese", ita: "Italian", it: "Italian",
  rus: "Russian", ru: "Russian", ara: "Arabic", ar: "Arabic", dut: "Dutch", nld: "Dutch", nl: "Dutch",
  pol: "Polish", pl: "Polish", tur: "Turkish", tr: "Turkish", vie: "Vietnamese", vi: "Vietnamese",
  tha: "Thai", th: "Thai", ind: "Indonesian", id: "Indonesian", msa: "Malay", may: "Malay", ms: "Malay",
  hin: "Hindi", hi: "Hindi", hun: "Hungarian", hu: "Hungarian", ces: "Czech", cze: "Czech", cs: "Czech",
  swe: "Swedish", sv: "Swedish", dan: "Danish", da: "Danish", fin: "Finnish", fi: "Finnish",
  nor: "Norwegian", nob: "Norwegian", no: "Norwegian", nb: "Norwegian", ell: "Greek", gre: "Greek", el: "Greek",
  heb: "Hebrew", he: "Hebrew", ukr: "Ukrainian", uk: "Ukrainian", ron: "Romanian", rum: "Romanian", ro: "Romanian",
  bul: "Bulgarian", bg: "Bulgarian", hrv: "Croatian", hr: "Croatian", srp: "Serbian", sr: "Serbian",
  slo: "Slovak", slk: "Slovak", sk: "Slovak", slv: "Slovenian", sl: "Slovenian", fil: "Filipino", tgl: "Tagalog",
};
const LANG_VALUES = [...new Set(Object.values(LANG_NAMES))];

/** Human label for a track: map the language code (also the BCP-47 primary subtag, e.g. "pt-BR"
 *  → Portuguese); if unknown, infer from the track name ("CR_English" → English); else the code. */
function trackLangLabel(lang: string, name: string): string {
  const l = lang.toLowerCase();
  const direct = LANG_NAMES[l] ?? LANG_NAMES[l.split(/[-_]/)[0]];
  if (direct) return direct;
  const n = name.toLowerCase();
  const fromName = LANG_VALUES.find((v) => n.includes(v.toLowerCase()));
  if (fromName) return fromName;
  return l && l !== "und" ? lang.toUpperCase() : "Unknown";
}

let extractedTracks: MkvSubtitleTrack[] = [];
let extractedBase = "subtitles";

function showTrackSelector(tracks: MkvSubtitleTrack[], selectedIndex: number): void {
  extractedTracks = tracks;
  subTrackSel.innerHTML = "";
  tracks.forEach((t, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    const parts = [trackLangLabel(t.lang, t.name), t.ext.toUpperCase(), `${t.cueCount} lines`];
    if (t.name) parts.push(t.name);
    opt.textContent = parts.join(" · ");
    subTrackSel.append(opt);
  });
  subTrackSel.value = String(selectedIndex);
  subSelector.classList.add("-show");
}
function hideTrackSelector(): void {
  subSelector.classList.remove("-show");
  extractedTracks = [];
}

// Track whether the active subtitle came from THIS selector (an embedded track) vs. an
// external source (Jimaku / imported file via the App's own UI). When an external source
// takes over, show it as the selected option so re-picking an embedded track is a real
// change event — otherwise the <select> sits on its old value and won't switch back.
let loadingEmbedded = false;
function removeExternalOption(): void {
  subTrackSel.querySelector('option[value="ext"]')?.remove();
}
function showExternalOption(track: { source?: string; label?: string } | null): void {
  if (!extractedTracks.length) return; // nothing to switch back to
  let opt = subTrackSel.querySelector<HTMLOptionElement>('option[value="ext"]');
  if (!opt) {
    opt = document.createElement("option");
    opt.value = "ext";
    subTrackSel.append(opt);
  }
  opt.textContent = `${track?.source === "jimaku" ? "Jimaku" : "File"} · ${track?.label ?? "subtitles"}`;
  subTrackSel.value = "ext";
}
async function loadTrack(i: number): Promise<boolean> {
  const t = extractedTracks[i];
  if (!t) return false;
  subTrackSel.value = String(i);
  removeExternalOption();
  loadingEmbedded = true;
  try {
    return await app.loadSubtitleFile(new File([t.toText()], `${extractedBase}.${t.ext}`, { type: "text/plain" }));
  } finally {
    loadingEmbedded = false;
  }
}
subTrackSel.addEventListener("change", () => {
  if (subTrackSel.value !== "ext") loadTrack(Number(subTrackSel.value));
});
// Reflect external subtitle sources (Jimaku/import) taking over the active track.
app.onTrackChange = (track) => {
  if (loadingEmbedded) return; // our own embedded load — the selector already reflects it
  showExternalOption(track);
};

// ---- media loading ----
let mediaUrl = "";
let audioWarned = false; // one-shot "no audio decoding" hint (see the timeupdate listener)
function loadMedia(file: File): void {
  hideTrackSelector(); // a new media source supersedes any previous embedded-track list
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = URL.createObjectURL(file);
  video.src = mediaUrl;
  video.muted = false; // never start muted (so audio plays once the user hits play)
  audioWarned = false;
  // Autoplay WITH sound is allowed because this runs inside the drop/pick gesture; if a
  // browser still blocks it, the video stays paused and the big play button prompts a click.
  video.play().catch(() => {});
  document.title = `${file.name} — TANMA! Player`;
  drop.classList.add("-hidden");
  showUi();
}

function handleFiles(files: FileList | File[]): void {
  const arr = Array.from(files);
  const media = arr.find((f) => isMedia(f.name));
  const sub = arr.find((f) => SUB_RE.test(f.name));
  if (media) loadMedia(media);
  if (sub) {
    // An explicit subtitle file wins; onTrackChange marks it as the active source in the
    // selector (so you can still switch back to an embedded track).
    app.loadSubtitleFile(sub);
  } else if (media && MATROSKA_RE.test(media.name)) {
    extractEmbeddedSubs(media); // mkv/webm with no sidecar → pull subs out of the container
  } else if (!media && arr.length) {
    app.loadSubtitleFile(arr[0]); // unknown type → let the App report "couldn't parse"
  }
}

/** Pull the embedded subtitle tracks out of a Matroska file. Auto-loads the best one and shows
 *  the track selector so the user can switch (works even when the video codec can't be played). */
async function extractEmbeddedSubs(file: File): Promise<void> {
  status("Extracting embedded subtitles…", true);
  try {
    const tracks = await extractMkvSubtitles(file);
    if (!tracks.length) {
      status("No embedded subtitles found in this file.");
      return;
    }
    extractedBase = file.name.replace(/\.[^.]+$/, "");
    const bestIndex = Math.max(0, tracks.indexOf(pickBestSubtitleTrack(tracks)!));
    showTrackSelector(tracks, bestIndex);
    hideStatus();
    if (!(await loadTrack(bestIndex))) status("Couldn't parse the embedded subtitles.");
    else if (tracks.length > 1) status(`${tracks.length} embedded subtitle tracks — choose one in the bottom bar.`);
  } catch (e) {
    console.warn("[tnm-player] subtitle extraction failed:", e);
    status("Couldn't read embedded subtitles from this file.");
  }
}

// ---- file pickers + drag-and-drop ----
$<HTMLButtonElement>("pick-video").addEventListener("click", () => videoInput.click());
$<HTMLButtonElement>("pick-sub").addEventListener("click", () => subInput.click());
videoInput.addEventListener("change", () => videoInput.files && handleFiles(videoInput.files));
subInput.addEventListener("change", () => subInput.files && handleFiles(subInput.files));

let dragDepth = 0;
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dragmask.classList.add("-show");
});
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dragmask.classList.remove("-show"); } });
window.addEventListener("drop", (e) => {
  dragDepth = 0;
  dragmask.classList.remove("-show");
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  handleFiles(e.dataTransfer.files);
}, true);

// ================================================================= custom controls
const ui = $<HTMLDivElement>("player-ui");
const bigPlay = $<HTMLDivElement>("big-play");
const playBtn = $<HTMLButtonElement>("c-play");
const backBtn = $<HTMLButtonElement>("c-back");
const fwdBtn = $<HTMLButtonElement>("c-fwd");
const muteBtn = $<HTMLButtonElement>("c-mute");
const volSlider = $<HTMLInputElement>("c-vol");
const timeEl = $<HTMLSpanElement>("c-time");
const fsBtn = $<HTMLButtonElement>("c-fs");
const scrubber = $<HTMLDivElement>("scrubber");
const sbBuffered = $<HTMLDivElement>("sb-buffered");
const sbPlayed = $<HTMLDivElement>("sb-played");
const sbThumb = $<HTMLDivElement>("sb-thumb");

backBtn.append(icon(ICONS.back));
fwdBtn.append(icon(ICONS.fwd));
const bigCircle = document.createElement("div");
bigCircle.className = "circle";
bigCircle.append(icon(ICONS.play));
bigPlay.append(bigCircle);

const fmt = (t: number): string => {
  if (!isFinite(t) || t < 0) t = 0;
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return `${h ? h + ":" : ""}${mm}:${String(s).padStart(2, "0")}`;
};

function togglePlay(): void {
  if (!video.src) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}
function reflectPlayState(): void {
  playBtn.replaceChildren(icon(video.paused ? ICONS.play : ICONS.pause));
  bigPlay.classList.toggle("-show", video.paused && !!video.src);
}
function reflectProgress(): void {
  const d = video.duration || 0, c = video.currentTime || 0;
  const pct = d ? (c / d) * 100 : 0;
  sbPlayed.style.width = `${pct}%`;
  sbThumb.style.left = `${pct}%`;
  let buf = 0;
  try { if (video.buffered.length) buf = video.buffered.end(video.buffered.length - 1); } catch { /* not ready */ }
  sbBuffered.style.width = `${d ? (buf / d) * 100 : 0}%`;
  timeEl.textContent = `${fmt(c)} / ${fmt(d)}`;
}
function reflectVolume(): void {
  volSlider.value = String(video.muted ? 0 : video.volume);
  muteBtn.replaceChildren(icon(video.muted || video.volume === 0 ? ICONS.mute : ICONS.vol));
}
function setVolume(v: number): void {
  video.volume = Math.max(0, Math.min(1, v));
  video.muted = video.volume === 0;
}

playBtn.addEventListener("click", togglePlay);
bigCircle.addEventListener("click", togglePlay);
video.addEventListener("click", togglePlay);
video.addEventListener("dblclick", () => toggleFullscreen());
backBtn.addEventListener("click", () => (video.currentTime = Math.max(0, video.currentTime - 10)));
fwdBtn.addEventListener("click", () => (video.currentTime = Math.min(video.duration || 0, video.currentTime + 10)));
muteBtn.addEventListener("click", () => (video.muted = !video.muted));
volSlider.addEventListener("input", () => setVolume(parseFloat(volSlider.value)));
video.addEventListener("play", () => { reflectPlayState(); showUi(); });
video.addEventListener("pause", () => { reflectPlayState(); showUi(); });
video.addEventListener("timeupdate", reflectProgress);
video.addEventListener("durationchange", reflectProgress);
video.addEventListener("progress", reflectProgress);
video.addEventListener("volumechange", reflectVolume);
video.addEventListener("error", () => {
  if (video.src) status("This file's video codec can't be played by the browser (subtitles still load).");
});
// Detect "video plays but silent": Chrome can't decode AC3 / DTS / TrueHD / FLAC audio (very
// common in anime releases), so the picture plays with no sound. Warn once if no audio decodes.
video.addEventListener("timeupdate", () => {
  if (audioWarned || video.muted || video.currentTime < 3) return;
  const decoded = (video as unknown as { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount;
  if (typeof decoded === "number" && decoded === 0) {
    audioWarned = true;
    status("No audio is playing — if this file should have sound, Chrome likely can't decode its audio codec (AC3 / DTS / TrueHD / FLAC). Re-encode the audio to AAC.");
  }
});
reflectPlayState();
reflectVolume();

// Scrubber: click + drag to seek.
function seekToClientX(x: number): void {
  if (!video.duration) return;
  const r = scrubber.getBoundingClientRect();
  video.currentTime = Math.max(0, Math.min(1, (x - r.left) / r.width)) * video.duration;
}
let scrubbing = false;
scrubber.addEventListener("mousedown", (e) => { scrubbing = true; scrubber.classList.add("-active"); seekToClientX(e.clientX); e.preventDefault(); });
window.addEventListener("mousemove", (e) => { if (scrubbing) seekToClientX(e.clientX); });
window.addEventListener("mouseup", () => { scrubbing = false; scrubber.classList.remove("-active"); });

// Fullscreen the whole PAGE (not the bare <video>, which would hide the overlay/browser).
function toggleFullscreen(): void {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}
fsBtn.addEventListener("click", toggleFullscreen);
fsBtn.append(icon(ICONS.fs));
document.addEventListener("fullscreenchange", () => fsBtn.replaceChildren(icon(document.fullscreenElement ? ICONS.fsExit : ICONS.fs)));

// Auto-hide the bar (and the cursor) while playing; always show when paused / on mouse move.
let hideTimer = 0;
function showUi(): void {
  if (!video.src) return;
  ui.classList.remove("-hidden");
  document.body.style.cursor = "";
  clearTimeout(hideTimer);
  if (!video.paused) hideTimer = window.setTimeout(() => { ui.classList.add("-hidden"); document.body.style.cursor = "none"; }, 3000);
}
window.addEventListener("mousemove", () => { if (!scrubbing) showUi(); });

// Keep the bar clear of the subtitle browser panel when it's open (it docks on the right).
function syncPanelInset(): void {
  const panel = document.getElementById("tnm-root")?.shadowRoot?.querySelector(".TnmBrowser");
  let inset = 0;
  if (panel) {
    const r = panel.getBoundingClientRect();
    if (r.width > 1 && r.left < window.innerWidth - 1 && r.right > window.innerWidth - 2) inset = Math.round(window.innerWidth - r.left);
  }
  ui.style.right = `${inset}px`;
}
window.setInterval(syncPanelInset, 400);

// Player keyboard shortcuts (ignored while typing in a field; the App keeps a/d/s for line-nav).
window.addEventListener("keydown", (e) => {
  const t = (e.composedPath?.()[0] as HTMLElement) ?? (e.target as HTMLElement);
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (!video.src || e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case " ": case "k": togglePlay(); e.preventDefault(); break;
    case "ArrowLeft": video.currentTime = Math.max(0, video.currentTime - 5); break;
    case "ArrowRight": video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); break;
    case "ArrowUp": setVolume(video.volume + 0.1); break;
    case "ArrowDown": setVolume(video.volume - 0.1); break;
    case "m": video.muted = !video.muted; break;
    case "f": toggleFullscreen(); break;
  }
});
