import { type Settings } from "../common/types";
import { loadSettings, saveHostSettings, migrateLegacyKeys } from "../lib/storage";
import { applyAccentVars } from "../lib/theme";

/** Host of the tab the popup was opened over — Enabled/Target language are per-site. */
async function activeHost(): Promise<string | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) return new URL(tab.url).hostname;
  } catch { /* no tabs permission / internal page */ }
  return undefined;
}

const LANGS: [string, string][] = [
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["ru", "Russian"],
];

const STYLE = `
  :root { color-scheme: dark; --accent: #ff9345; }
  body { margin: 0; width: 300px; font-family: "Inter", system-ui, sans-serif;
    background: #1c1d22; color: #f3f3f7; font-size: 13px; }
  .hd { display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid rgba(255,255,255,.1); }
  .hd img { width:28px; height:28px; }
  .hd b { font-size:14px; }
  .hd span { color:#9a9bab; font-size:11px; display:block; }
  .row { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; }
  .row + .row { border-top:1px solid rgba(255,255,255,.08); }
  select { background:#26272e; color:#f3f3f7; border:1px solid rgba(255,255,255,.12);
    border-radius:8px; padding:5px 8px; font-size:13px; }
  .switch { position:relative; width:42px; height:24px; }
  .switch input { opacity:0; width:100%; height:100%; margin:0; cursor:pointer; }
  .switch .tk { position:absolute; inset:0; border-radius:999px; background:#32333c; transition:.15s; pointer-events:none; }
  .switch .th { position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:#fff; transition:.15s; pointer-events:none; }
  .switch input:checked ~ .tk { background:var(--accent); }
  .switch input:checked ~ .th { transform:translateX(18px); }
  .help { padding:12px 16px; color:#9a9bab; border-top:1px solid rgba(255,255,255,.08); line-height:1.6; }
  .help b { color:#f3f3f7; }
  kbd { background:#32333c; border-radius:4px; padding:1px 5px; font-family:monospace; color:#f3f3f7; }
  .linkbtn { background:#26272e; color:var(--accent); border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:5px 10px; font-size:13px; font-weight:600; cursor:pointer; }
  .update { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 16px;
    background:var(--accent); color:#1a1206; font-weight:700; font-size:12.5px; text-decoration:none; cursor:pointer; }
  .update:hover { filter:brightness(1.06); }
  .update__go { font-weight:800; white-space:nowrap; }
`;

async function render(): Promise<void> {
  await migrateLegacyKeys();
  const root = document.getElementById("popup-root")!;
  const host = await activeHost();
  const load = (): Promise<Settings> => loadSettings(host);
  const save = (s: Settings): Promise<void> => saveHostSettings(s, host);
  const settings = await load();

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  applyAccentVars(document.documentElement, settings.accent || "#ff9345");

  const siteLabel = host ? host.replace(/^www\./, "") : "this site";
  root.innerHTML = `
    <a id="update-banner" class="update" href="#" style="display:none">
      <span>✨ Update available <b id="update-ver"></b></span>
      <span class="update__go">Get it →</span>
    </a>
    <div class="hd">
      <img src="icons/icon-48.png" alt="" />
      <div><b>TANMA! Subtitles</b><span>learning overlay</span></div>
    </div>
    <div class="row">
      <span>Enabled <small style="color:#9a9bab;display:block;font-size:10px">on ${siteLabel}</small></span>
      <label class="switch"><input id="enabled" type="checkbox"><span class="tk"></span><span class="th"></span></label>
    </div>
    <div class="row">
      <span>Target language <small style="color:#9a9bab;display:block;font-size:10px">on ${siteLabel}</small></span>
      <select id="lang"></select>
    </div>
    <div class="row">
      <span>Dashboard &amp; settings <small style="color:#9a9bab;display:block;font-size:10px">dictionaries, Anki, keybinds, Jimaku</small></span>
      <button id="dashboard" class="linkbtn">Open →</button>
    </div>
    <div class="row">
      <span>Local media player <small style="color:#9a9bab;display:block;font-size:10px">drop a video + subtitle file</small></span>
      <button id="player" class="linkbtn">Open ↗</button>
    </div>
    <div class="row">
      <span>Game / VN reader <small style="color:#9a9bab;display:block;font-size:10px">texthooker via tanma-hook / Textractor</small></span>
      <button id="reader" class="linkbtn">Open ↗</button>
    </div>
    <div class="help">
      <b>How to use</b><br/>
      • Open a video. On YouTube, subtitles load automatically.<br/>
      • For a local file, open the <b>player</b> above and drop a video + subtitle.<br/>
      • Anywhere else, click the <b>⬆ import</b> button on the in-page toolbar to load an <b>.srt / .vtt / .ass</b> file.<br/>
      • Click any word for a definition &amp; to mark it Known / Learning.<br/>
      • <kbd>A</kbd>/<kbd>D</kbd> prev/next line, <kbd>S</kbd> replay line.
    </div>
  `;

  const enabled = root.querySelector<HTMLInputElement>("#enabled")!;
  enabled.checked = settings.enabled;
  enabled.addEventListener("change", async () => {
    const s = await load();
    await save({ ...s, enabled: enabled.checked });
  });

  const lang = root.querySelector<HTMLSelectElement>("#lang")!;
  for (const [v, t] of LANGS) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = t;
    if (v === settings.targetLang) opt.selected = true;
    lang.append(opt);
  }
  lang.addEventListener("change", async () => {
    const s = await load();
    await save({ ...s, targetLang: lang.value });
  });

  root.querySelector<HTMLButtonElement>("#dashboard")!.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  root.querySelector<HTMLButtonElement>("#player")!.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("player.html") });
  });

  root.querySelector<HTMLButtonElement>("#reader")!.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("reader.html") });
  });

  // "Update available" banner: the background compares the installed version to the repo's latest
  // GitHub release (cached). If a newer one exists, reveal the banner → clicking opens the release.
  const banner = root.querySelector<HTMLAnchorElement>("#update-banner")!;
  chrome.runtime
    .sendMessage({ type: "checkUpdate" })
    .then((r: { ok?: boolean; updateAvailable?: boolean; latest?: string | null; url?: string }) => {
      if (!r?.ok || !r.updateAvailable || !r.latest) return;
      root.querySelector("#update-ver")!.textContent = r.latest;
      banner.href = r.url || "#";
      banner.style.display = "flex";
      banner.addEventListener("click", (e) => {
        e.preventDefault();
        if (r.url) chrome.tabs.create({ url: r.url });
      });
    })
    .catch(() => {
      /* background asleep / offline */
    });
}

render();
