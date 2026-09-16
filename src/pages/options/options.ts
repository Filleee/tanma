import { unzip } from "fflate";
import {
  createDictionary,
  updateDictionary,
  listDictionaries,
  deleteDictionary,
  bulkPut,
  STORES,
  putMedia,
} from "../../lib/yomitan/db";
import {
  parseIndex,
  parseTermBank,
  parseTermMetaBank,
  parseKanjiBank,
  parseKanjiMetaBank,
  parseTagBank,
} from "../../lib/yomitan/parse";
import type { DictionaryMeta } from "../../lib/yomitan/types";
import { CATALOG, githubRepo, type CatalogEntry } from "./catalog";
import { loadSettings, saveSettings, mergeMined, clearMined, KnownWordsStore, MinedStore, loadRecentMined, migrateLegacyKeys } from "../../lib/storage";
import { ACCENTS, applyAccentVars } from "../../lib/theme";
import type { Settings, ActivationRule, GeminiModelsResponse } from "../../common/types";
import { CANNED_PROMPT } from "../../lib/prompt";

const STYLE = `
  :root { color-scheme: dark; --accent:#ff9345; --good:#36c275; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:"Inter",system-ui,sans-serif; background:#15161a; color:#f3f3f7; font-size:14px; }
  .app { display:flex; align-items:stretch; min-height:100vh; }

  /* left nav */
  .nav { flex:0 0 232px; width:232px; background:#17181d; border-right:1px solid rgba(255,255,255,.08);
    position:sticky; top:0; height:100vh; display:flex; flex-direction:column; padding:18px 12px; }
  .brand { display:flex; align-items:center; gap:10px; padding:4px 8px 16px; }
  .brand img { width:30px; height:30px; }
  .brand b { font-size:15px; display:block; }
  .brand span { color:#9a9bab; font-size:11px; }
  .nav__links { display:flex; flex-direction:column; gap:2px; }
  .nav__link { display:flex; align-items:center; gap:10px; width:100%; text-align:left; background:none; border:none;
    color:#cfd0db; font:inherit; font-weight:600; padding:9px 11px; border-radius:9px; cursor:pointer; }
  .nav__link:hover { background:#22232b; color:#fff; }
  .nav__link.-active { background:color-mix(in srgb, var(--accent) 16%, transparent); color:var(--accent); }
  .nav__link .ic { width:18px; text-align:center; opacity:.9; }
  .nav__foot { margin-top:auto; padding-top:12px; }
  .btn-ghost.full { width:100%; justify-content:center; display:flex; }

  /* content */
  .content { flex:1; min-width:0; padding:28px 28px 60px; }
  .panel { max-width:840px; }
  .panel[hidden] { display:none; }
  .wrap { max-width:840px; }
  h1 { font-size:21px; margin:0 0 4px; }
  .sub { color:#9a9bab; margin:0 0 22px; }

  /* overview */
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:18px; }
  .stat { background:#1c1d22; border:1px solid rgba(255,255,255,.1); border-radius:14px; padding:16px 18px; }
  .stat__num { font-size:26px; font-weight:800; font-variant-numeric:tabular-nums; line-height:1.1; }
  .stat__num.-accent { color:var(--accent); }
  .stat__label { color:#9a9bab; font-size:12px; margin-top:4px; }
  .check { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px; }
  .check li { display:flex; align-items:center; gap:11px; padding:9px 2px; border-bottom:1px solid rgba(255,255,255,.06); }
  .check li:last-child { border-bottom:none; }
  .check .dot { flex:0 0 22px; width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center;
    font-size:13px; font-weight:800; background:#2a2b33; color:#75768a; }
  .check li.-done .dot { background:rgba(54,194,117,.18); color:var(--good); }
  .check .cmain { flex:1; min-width:0; }
  .check .ctitle { font-weight:600; }
  .check .cdesc { color:#9a9bab; font-size:12px; margin-top:1px; }
  .check .clink { background:none; border:none; color:var(--accent); cursor:pointer; font:inherit; font-weight:600; white-space:nowrap; padding:4px; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; }

  .card { background:#1c1d22; border:1px solid rgba(255,255,255,.1); border-radius:14px; padding:18px; margin-bottom:18px; }
  .card h2 { font-size:15px; margin:0 0 4px; }
  .card .note { color:#9a9bab; font-size:12px; margin:0 0 14px; }
  button { font:inherit; cursor:pointer; border:none; border-radius:9px; padding:9px 14px; font-weight:600; }
  .btn-primary { background:var(--accent); color:#1c1209; }
  .btn-primary:disabled { opacity:.45; cursor:default; }
  .btn-ghost { background:#2a2b33; color:#f3f3f7; }
  .btn-danger { background:transparent; color:#ff7a7a; padding:6px 8px; }
  .drop { border:2px dashed rgba(255,255,255,.18); border-radius:12px; padding:18px; text-align:center; color:#9a9bab; transition:.15s; }
  .drop.-over { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 7%, transparent); color:#f3f3f7; }
  .progress { margin-top:14px; display:none; }
  .bar { height:8px; background:#2a2b33; border-radius:99px; overflow:hidden; }
  .bar > i { display:block; height:100%; width:0; background:var(--accent); transition:width .12s; }
  .status { color:#9a9bab; font-size:12px; margin-top:6px; min-height:16px; }
  .cat { display:flex; align-items:center; gap:12px; padding:11px 4px; border-bottom:1px solid rgba(255,255,255,.07); }
  .cat:last-child { border-bottom:none; }
  .cat__main { flex:1; min-width:0; }
  .cat__title { font-weight:700; }
  .cat__title .badge { margin-left:6px; }
  .cat__desc { color:#9a9bab; font-size:12px; margin-top:2px; }
  .cat__size { color:#75768a; font-size:11px; margin-top:2px; }
  .badge { font-size:10px; font-weight:700; padding:2px 6px; border-radius:6px; background:#32333c; color:#cfd0db; }
  .badge.-terms{background:#2b3a52;color:#9fc7ff}.badge.-freq{background:#3a3320;color:#ffd479}.badge.-kanji{background:#243a2c;color:#86e5ad}.badge.-names{background:#3a2a3f;color:#e3a9f0}.badge.-pitch{background:#3a2436;color:#ff9ec9}
  .installed-chip { color:#36c275; font-weight:700; font-size:13px; white-space:nowrap; }
  table { width:100%; border-collapse:collapse; }
  td,th { text-align:left; padding:9px 8px; border-bottom:1px solid rgba(255,255,255,.07); vertical-align:middle; }
  th { color:#9a9bab; font-weight:600; font-size:12px; }
  .title { font-weight:700; }
  .badges { display:flex; gap:5px; flex-wrap:wrap; margin-top:3px; }
  .count { color:#9a9bab; font-variant-numeric:tabular-nums; font-size:12px; }
  .switch { position:relative; width:42px; height:24px; display:inline-block; }
  .switch input { opacity:0; width:100%; height:100%; margin:0; cursor:pointer; }
  .switch .tk { position:absolute; inset:0; border-radius:99px; background:#32333c; transition:.15s; pointer-events:none; }
  .switch .th { position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:#fff; transition:.15s; pointer-events:none; }
  .switch input:checked ~ .tk { background:#36c275; }
  .switch input:checked ~ .th { transform:translateX(18px); }
  .ord { background:#2a2b33; color:#f3f3f7; border-radius:6px; width:26px; height:24px; padding:0; font-weight:700; }
  .empty { color:#9a9bab; text-align:center; padding:18px; }
  a { color:var(--accent); }
  .row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; }
  .row > span:first-child { color:#cfd0db; }
  select { font:inherit; background:#2a2b33; color:#f3f3f7; border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:7px 10px; min-width:260px; }
  #anki-config.-off, #kb-config.-off { opacity:.4; pointer-events:none; }
  .keycap { font:inherit; width:48px; text-align:center; text-transform:lowercase; background:#2a2b33; color:#f3f3f7; border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:7px 0; }
  #jimaku-key { font:inherit; min-width:260px; background:#2a2b33; color:#f3f3f7; border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:7px 10px; }
  .combo { position:relative; min-width:260px; }
  .combo__field { width:100%; text-align:left; font:inherit; background:#2a2b33; color:#f3f3f7; border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:7px 10px; cursor:pointer; display:flex; justify-content:space-between; gap:8px; }
  .combo__field .caret { color:#9a9bab; }
  .combo__menu { position:absolute; top:calc(100% + 4px); left:0; right:0; z-index:20; background:#26272e; border:1px solid rgba(255,255,255,.14); border-radius:10px; box-shadow:0 12px 30px rgba(0,0,0,.5); padding:8px; }
  .combo__menu[hidden] { display:none; }
  .combo__search { width:100%; box-sizing:border-box; font:inherit; background:#1c1d22; color:#f3f3f7; border:1px solid rgba(255,255,255,.12); border-radius:7px; padding:6px 9px; margin-bottom:6px; }
  .combo__list { max-height:220px; overflow-y:auto; display:flex; flex-direction:column; }
  .combo__item { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:6px; cursor:pointer; }
  .combo__item:hover { background:#32333c; }
  .combo__item input { margin:0; accent-color:var(--accent); }
  .combo__item span { word-break:break-all; }
  .combo__empty { color:#9a9bab; font-size:12px; padding:8px; }

  /* accent swatches */
  .swatches { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .swatch { width:30px; height:30px; border-radius:50%; border:2px solid transparent; cursor:pointer; padding:0; }
  .swatch.-on { border-color:#fff; box-shadow:0 0 0 2px #15161a inset; }
  .swatch.custom { background:#2a2b33; display:flex; align-items:center; justify-content:center; color:#9a9bab; font-size:14px; position:relative; overflow:hidden; }
  .swatch.custom input { position:absolute; inset:0; opacity:0; cursor:pointer; }
  /* recent mines + per-site list */
  .feed { display:flex; flex-direction:column; }
  .feed__row { display:flex; align-items:baseline; gap:10px; padding:8px 2px; border-bottom:1px solid rgba(255,255,255,.06); }
  .feed__row:last-child { border-bottom:none; }
  .feed__word { font-weight:700; }
  .feed__sent { color:#9a9bab; font-size:12px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .feed__time { color:#75768a; font-size:11px; white-space:nowrap; }
  .site { display:flex; align-items:center; gap:10px; padding:9px 2px; border-bottom:1px solid rgba(255,255,255,.06); }
  .site:last-child { border-bottom:none; }
  .site__main { flex:1; min-width:0; }
  .site__host { font-weight:700; }
  .site__keys { color:#9a9bab; font-size:12px; margin-top:1px; word-break:break-word; }
  .danger { border-color:rgba(255,122,122,.35); }
  .danger h2 { color:#ff9a9a; }
  /* activation rules */
  .act-row { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
  .act-host { flex:0 0 190px; }
  .act-pat { flex:1; min-width:0; }
  .act-row input { font:inherit; background:#2a2b33; color:#f3f3f7; border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:7px 10px; }
  .act-empty { color:#9a9bab; font-size:12px; padding:4px 0 8px; }
`;

let busy = false;

async function main() {
  await migrateLegacyKeys();
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);

  const root = document.getElementById("options-root")!;
  root.innerHTML = `
   <div class="app">
    <aside class="nav">
      <div class="brand"><img src="icons/icon-48.png" alt=""/><div><b>TANMA!</b><span>dashboard</span></div></div>
      <nav class="nav__links">
        <button class="nav__link -active" data-tab="overview"><span class="ic">📊</span> Overview</button>
        <button class="nav__link" data-tab="dicts"><span class="ic">📚</span> Dictionaries</button>
        <button class="nav__link" data-tab="anki"><span class="ic">🗂️</span> Anki mining</button>
        <button class="nav__link" data-tab="keys"><span class="ic">⌨️</span> Look-up &amp; keys</button>
        <button class="nav__link" data-tab="jimaku"><span class="ic">🔎</span> Jimaku</button>
        <button class="nav__link" data-tab="translate"><span class="ic">🌐</span> Translation</button>
      </nav>
      <div class="nav__foot">
        <button id="open-player" class="btn-ghost full">▶ Open local player</button>
        <button id="open-reader" class="btn-ghost full" style="margin-top:6px">📖 Open game/VN reader</button>
      </div>
    </aside>
    <main class="content">

      <section class="panel" data-panel="overview">
        <h1>Overview</h1>
        <p class="sub">Your learning setup at a glance.</p>
        <div class="stats">
          <div class="stat"><div class="stat__num -accent" id="ov-known">–</div><div class="stat__label">Known words</div></div>
          <div class="stat"><div class="stat__num" id="ov-learning">–</div><div class="stat__label">Learning</div></div>
          <div class="stat"><div class="stat__num" id="ov-mined">–</div><div class="stat__label">Mined words</div></div>
          <div class="stat"><div class="stat__num" id="ov-dicts">–</div><div class="stat__label">Dictionaries</div></div>
        </div>
        <div class="card">
          <h2>Getting started</h2>
          <p class="note">A quick checklist to get the most out of the extension.</p>
          <ul class="check" id="ov-checklist"></ul>
        </div>
        <div class="card">
          <h2>Recently mined</h2>
          <p class="note">Your latest Anki mines from the word pop-up.</p>
          <div class="feed" id="ov-recent"></div>
        </div>
        <div class="card">
          <h2>Appearance</h2>
          <p class="note">Accent colour — applies to the in-page overlay, this dashboard, the popup and the player.</p>
          <div class="swatches" id="ov-accent"></div>
        </div>
        <div class="card">
          <h2>Quick actions</h2>
          <div class="actions">
            <button id="ov-player" class="btn-primary">▶ Open local player</button>
            <button class="btn-ghost" data-go="dicts">Add dictionaries</button>
            <button class="btn-ghost" data-go="anki">Set up Anki</button>
            <button class="btn-ghost" data-go="jimaku">Jimaku key</button>
          </div>
        </div>
        <div class="card">
          <h2>Per-site settings</h2>
          <p class="note">Sites where you've changed the toolbar / subtitle options (target language, size, pause mode…).
            Reset a site to fall back to your global defaults. (The timing offset is per-video and isn't shown here.)</p>
          <div id="ov-sites"></div>
        </div>
        <div class="card">
          <h2>Where the overlay activates</h2>
          <p class="note">Limit the overlay to real video pages on a site, so it doesn't show on home/feed pages with
            autoplay previews. The overlay shows only when the URL contains one of the patterns (leave patterns empty
            for "everywhere on that host"). Default: <code>youtube.com</code> → <code>/watch, /shorts/, …</code></p>
          <div id="ov-activation"></div>
          <button id="act-add" class="btn-ghost" style="margin-top:6px">+ Add site rule</button>
        </div>
        <div class="card">
          <h2>Backup &amp; restore</h2>
          <p class="note">Your known words, mined tracking and settings live in <b>this browser only</b> (Chrome's local
            storage isn't synced). Export a backup to move them to another browser/device, then import it there.
            Dictionaries aren't included — re-add them with one click on the Dictionaries tab.</p>
          <div class="actions">
            <button id="bk-export" class="btn-ghost">⬇ Export backup</button>
            <button id="bk-import" class="btn-ghost">⬆ Import backup</button>
            <input id="bk-file" type="file" accept=".json,application/json" style="display:none" />
          </div>
          <div id="bk-status" class="status"></div>
        </div>
        <div class="card danger">
          <h2>Danger zone</h2>
          <p class="note">Reset <b>everything</b> this extension saved in this browser — known/learning words, mined
            tracking, all settings (global + per-site) and per-video offsets. Your <b>Anki cards are NOT affected</b>.
            This can't be undone — export a backup first.</p>
          <label class="row" style="justify-content:flex-start;gap:10px;padding-top:0"><input type="checkbox" id="rst-dicts"/> <span>Also delete imported dictionaries</span></label>
          <button id="rst-all" class="btn-ghost" style="border:1px solid rgba(255,122,122,.45);color:#ff9a9a">Reset all data…</button>
          <div id="rst-status" class="status"></div>
        </div>
      </section>

      <section class="panel" data-panel="dicts" hidden>
        <h1>Dictionaries</h1>
        <p class="sub">Jisho is used by default (online, no setup). Add extra offline dictionaries below — one click to download, just like Yomitan.</p>

      <div class="card">
        <h2>Add dictionaries</h2>
        <p class="note">Downloaded once and stored locally for instant offline lookups.</p>
        <div id="catalog"></div>
        <div class="progress">
          <div class="bar"><i></i></div>
          <div class="status"></div>
        </div>
      </div>

      <div class="card">
        <h2>Installed</h2>
        <div id="list"></div>
      </div>

      <div class="card">
        <h2>Import a file</h2>
        <p class="note">Have another Yomitan <b>.zip</b> (e.g. Jiten frequency from jiten.moe)? Import it here.</p>
        <div id="drop" class="drop">
          Drop a <b>.zip</b> here, or
          <button id="pick" class="btn-ghost" style="margin-left:6px">Choose file…</button>
          <input id="file" type="file" accept=".zip" style="display:none" />
        </div>
      </div>
      </section>

      <section class="panel" data-panel="anki" hidden>
        <h1>Anki sentence mining</h1>
        <p class="sub">Mine words straight to Anki cards from the word pop-up.</p>
      <div class="card">
        <h2>Anki sentence mining</h2>
        <p class="note">Mine words to Anki via AnkiConnect. Anki must be open with the
          <a href="https://ankiweb.net/shared/info/2055492159" target="_blank">AnkiConnect add-on</a> installed, and this
          extension's origin added to AnkiConnect's <code>webCorsOriginList</code> (the Test button tells you the exact value).</p>
        <p class="note"><b>Note type:</b> this extension mines into the
          <a href="https://github.com/friedrich-de/lapis-simplified/releases" target="_blank">lapis-simplified</a>
          card format. Download the latest release, import it into Anki (<i>File → Import</i>), then select it as the
          <b>Note type</b> below. Its fields (Expression, Sentence, MainDefinition, Picture, SentenceAudio, ExpressionAudio)
          are filled automatically.</p>
        <label class="row"><span>Enable mining (＋ button on word popups)</span>
          <span class="switch"><input id="anki-enabled" type="checkbox"/><span class="tk"></span><span class="th"></span></span></label>
        <div id="anki-config">
          <div class="row"><span>Deck</span><select id="anki-deck"></select></div>
          <div class="row"><span>Note type (lapis-simplified)</span><select id="anki-model"></select></div>
          <div class="row"><span>Main definition dictionary</span><select id="anki-maindict"></select></div>
          <label class="row"><span>Capture screenshot → Picture</span>
            <span class="switch"><input id="anki-image" type="checkbox"/><span class="tk"></span><span class="th"></span></span></label>
          <label class="row"><span>Capture sentence audio → SentenceAudio</span>
            <span class="switch"><input id="anki-saudio" type="checkbox"/><span class="tk"></span><span class="th"></span></span></label>
          <label class="row"><span>Word audio (JapanesePod101) → ExpressionAudio</span>
            <span class="switch"><input id="anki-waudio" type="checkbox"/><span class="tk"></span><span class="th"></span></span></label>
          <label class="row"><span>Animated picture (looping clip — bigger cards)</span>
            <span class="switch"><input id="anki-anim" type="checkbox"/><span class="tk"></span><span class="th"></span></span></label>
          <div class="row" style="align-items:flex-start"><span>Sync mined from these decks<br>
            <small style="color:#9a9bab;font-weight:400">Test connection to load, then pick one or more</small></span>
            <div id="anki-sync-decks"></div></div>
          <label class="row"><span>Auto-sync on startup<br>
            <small style="color:#9a9bab;font-weight:400">Pull tracking from those decks each launch — keeps browsers in sync via Anki</small></span>
            <span class="switch"><input id="anki-autosync" type="checkbox"/><span class="tk"></span><span class="th"></span></span></label>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:12px">
          <button id="anki-test" class="btn-ghost">Test connection</button>
          <button id="anki-sync-mined" class="btn-ghost">Sync mined from selected decks</button>
          <button id="anki-reset-mined" class="btn-ghost">Reset tracking</button>
          <span id="anki-status" class="status" style="margin-top:0"></span>
        </div>
      </div>
      </section>

      <section class="panel" data-panel="keys" hidden>
        <h1>Look-up &amp; keybindings</h1>
        <p class="sub">How words are looked up, and the navigation keys.</p>
      <div class="card">
        <h2>Look-up &amp; keybindings</h2>
        <p class="note">Hold a key and hover a word to look it up — no click needed. Hover the start of a word
          for the whole word; hover further in (or drag-select) to grab a sub-piece from the cursor (e.g. 疲れ
          inside お疲れ様). Clicking a word still looks up the whole word.</p>
        <label class="row"><span>Hold-to-look-up (hover while holding a key)</span>
          <span class="switch"><input id="kb-hold" type="checkbox"/><span class="tk"></span><span class="th"></span></span></label>
        <div id="kb-config">
          <div class="row"><span>Look-up key — hold while hovering</span>
            <select id="kb-key"><option value="Control">Ctrl</option><option value="Alt">Alt</option><option value="Shift">Shift</option><option value="Meta">Meta / ⌘</option></select></div>
          <label class="row"><span>Also on the video overlay (not just the browser)</span>
            <span class="switch"><input id="kb-overlay" type="checkbox"/><span class="tk"></span><span class="th"></span></span></label>
        </div>
        <p class="note" style="margin-top:14px">Line-navigation keys (single key, no modifier):</p>
        <div class="row"><span>Previous line</span><input id="kb-prev" class="keycap" maxlength="1"/></div>
        <div class="row"><span>Next line</span><input id="kb-next" class="keycap" maxlength="1"/></div>
        <div class="row"><span>Replay line</span><input id="kb-replay" class="keycap" maxlength="1"/></div>
      </div>
      <div class="card">
        <h2>Word audio (🔊 / ExpressionAudio)</h2>
        <p class="note">Sources are tried top to bottom; the first hit wins. The custom URL may use
          <code>{term}</code> and <code>{reading}</code> placeholders and must return an audio file.</p>
        <label class="row"><span>JapanesePod101 (human recordings, JA)</span>
          <span class="switch"><input id="au-jpod" type="checkbox"/><span class="tk"></span><span class="th"></span></span></label>
        <div class="row"><span>Custom URL</span><input id="au-custom" placeholder="https://example.com/audio?k={term}&r={reading}" style="width:320px"/></div>
        <label class="row"><span>Google TTS fallback (neural)</span>
          <span class="switch"><input id="au-tts" type="checkbox"/><span class="tk"></span><span class="th"></span></span></label>
      </div>
      </section>

      <section class="panel" data-panel="jimaku" hidden>
        <h1>Jimaku subtitles</h1>
        <p class="sub">Find Japanese subtitles for anime from jimaku.cc.</p>
      <div class="card">
        <h2>Jimaku (jimaku.cc subtitles)</h2>
        <p class="note">Search Japanese subtitles from <a href="https://jimaku.cc" target="_blank">jimaku.cc</a>
          via the 🔎 button on the in-page toolbar. Paste your API key from
          <a href="https://jimaku.cc/profile" target="_blank">jimaku.cc/profile</a> (free account).</p>
        <div class="row"><span>API key</span><input id="jimaku-key" type="password" placeholder="paste your jimaku.cc API key" /></div>
        <label class="row"><span>Auto-load subtitles on anime pages<br>
          <small style="color:#9a9bab;font-weight:400">Detect the show + episode from the page and load the matching subtitle automatically (needs the API key)</small></span>
          <span class="switch"><input id="jimaku-autoload" type="checkbox"/><span class="tk"></span><span class="th"></span></span></label>
      </div>
      </section>

      <section class="panel" data-panel="translate" hidden>
        <h1>Machine translation</h1>
        <p class="sub">Powers the “Show machine translation” line when a video has no official translation.</p>
      <div class="card">
        <h2>Provider</h2>
        <p class="note">Turn the translation line on per-video from the in-page ⚙ settings. On YouTube with
          Google selected, YouTube's own (free) auto-translate is used; everywhere else — and for DeepL —
          your chosen provider is used. Subtitle text is sent to the provider to translate.</p>
        <div class="row"><span>Provider</span>
          <select id="mt-provider">
            <option value="google">Google Translate (free, no key)</option>
            <option value="deepl">DeepL (API key)</option>
          </select>
        </div>
        <div class="row" id="mt-key-row">
          <span>DeepL API key<br>
            <small style="color:#9a9bab;font-weight:400">From <a href="https://www.deepl.com/your-account/keys" target="_blank">deepl.com</a> — the free tier works (keys end in “:fx”)</small></span>
          <input id="mt-key" type="password" placeholder="paste your DeepL API key" />
        </div>
      </div>

      <div class="card">
        <h2>Mined-card translation</h2>
        <p class="note">Translate the mined line and write it into an Anki field (Kiku's
          <code>SentenceTranslation</code>). This runs <b>once per mined card</b>, not while you watch, so it can
          afford an LLM with the surrounding dialogue as context. The live translation line above is unaffected.</p>
        <label class="row"><span>Translate mined sentences</span>
          <span class="switch"><input id="tr-enabled" type="checkbox"/><span class="tk"></span><span class="th"></span></span></label>
        <div id="tr-config">
          <div class="row"><span>Anki field<br>
            <small style="color:#9a9bab;font-weight:400">Skipped automatically if your note type has no such field</small></span>
            <select id="tr-field"></select></div>
          <div class="row"><span>Provider</span>
            <select id="tr-provider">
              <option value="google">Google Translate (free, no key)</option>
              <option value="deepl">DeepL (API key)</option>
              <option value="openai">OpenAI-compatible</option>
              <option value="gemini">Gemini</option>
            </select></div>
          <div id="tr-openai">
            <div class="row"><span>API URL</span><input id="tr-openai-url" type="text" placeholder="https://api.openai.com/v1" /></div>
            <div class="row"><span>Model</span><input id="tr-openai-model" type="text" placeholder="gpt-4o-mini" /></div>
            <div class="row"><span>Backup model<br>
              <small style="color:#9a9bab;font-weight:400">Tried if the primary model errors</small></span>
              <input id="tr-openai-backup" type="text" placeholder="(optional)" /></div>
            <div class="row"><span>API key</span><input id="tr-openai-key" type="password" placeholder="paste your API key" /></div>
          </div>
          <div id="tr-gemini">
            <div class="row"><span>API key</span><input id="tr-gemini-key" type="password" placeholder="paste your Gemini API key" /></div>
            <div class="row"><span>Model</span>
              <span style="display:flex;gap:6px;align-items:center">
                <select id="tr-gemini-model"></select>
                <button id="tr-gemini-refresh" class="btn-ghost" title="Fetch available models">⟳</button>
              </span></div>
          </div>
          <div id="tr-llm">
            <div class="row"><span>Context lines before</span><input id="tr-before" type="number" min="0" max="50" /></div>
            <div class="row"><span>Context lines after<br>
              <small style="color:#9a9bab;font-weight:400">tanma holds the whole track, so it can look ahead — Japanese often
                resolves dropped subjects in the next line</small></span>
              <input id="tr-after" type="number" min="0" max="50" /></div>
            <div class="row"><span>Temperature</span><input id="tr-temp" type="number" min="0" max="2" step="0.1" /></div>
            <div class="row"><span>Max output tokens</span><input id="tr-maxtok" type="number" min="16" max="32768" /></div>
            <div class="row"><span>Top P</span><input id="tr-topp" type="number" min="0" max="1" step="0.05" /></div>
            <div class="row" style="align-items:flex-start"><span>Prompt<br>
              <small style="color:#9a9bab;font-weight:400">Empty = built-in prompt. Placeholders:
                {sentence} {context} {word} {title} {target_lang} {native_lang}</small></span>
              <span style="display:flex;flex-direction:column;gap:6px;flex:1;max-width:60%">
                <textarea id="tr-prompt" rows="8" placeholder="(using the built-in prompt)"
                  style="background:#15161a;color:#f3f3f7;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px;font:12px/1.5 ui-monospace,monospace;resize:vertical"></textarea>
                <span style="display:flex;gap:6px">
                  <button id="tr-prompt-load" class="btn-ghost">Load built-in prompt</button>
                  <button id="tr-prompt-clear" class="btn-ghost">Reset to built-in</button>
                </span>
              </span></div>
          </div>
          <span id="tr-status" class="status"></span>
        </div>
      </div>
      </section>

    </main>
   </div>
  `;

  const fileInput = root.querySelector<HTMLInputElement>("#file")!;
  const drop = root.querySelector<HTMLDivElement>("#drop")!;
  root.querySelector("#pick")!.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => fileInput.files?.[0] && importFile(fileInput.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("-over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("-over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("-over");
    const f = e.dataTransfer?.files?.[0];
    if (f) importFile(f);
  });

  setupTabs(root);
  setupBackup(root);
  setupReset(root);
  await setupActivation(root);
  await setupAppearance(root); // applies the saved accent + renders swatches
  const openPlayer = () => chrome.tabs.create({ url: chrome.runtime.getURL("player.html") });
  root.querySelector("#open-player")!.addEventListener("click", openPlayer);
  root.querySelector("#ov-player")!.addEventListener("click", openPlayer);
  root.querySelector("#open-reader")!.addEventListener("click", () =>
    chrome.tabs.create({ url: chrome.runtime.getURL("reader.html") }),
  );

  await refresh();
  await setupAnki(root);
  await setupKeybinds(root);
  await setupJimaku(root);
  await setupTranslation(root);
  await setupMinedTranslation(root);
  await loadOverview(root); // after the others so it can reflect installed dicts / settings
}

// ----------------------------------------------------------- appearance (accent)
async function setupAppearance(root: HTMLElement): Promise<void> {
  const host = root.querySelector<HTMLElement>("#ov-accent")!;
  let current = (await loadSettings()).accent || "#ff9345";
  applyAccentVars(document.documentElement, current);

  const pick = async (hex: string) => {
    current = hex;
    applyAccentVars(document.documentElement, hex);
    render();
    const cur = await loadSettings();
    await saveSettings({ ...cur, accent: hex });
  };
  const render = () => {
    host.innerHTML = "";
    const isPreset = ACCENTS.some((a) => a.hex.toLowerCase() === current.toLowerCase());
    for (const a of ACCENTS) {
      const b = document.createElement("button");
      b.className = "swatch" + (a.hex.toLowerCase() === current.toLowerCase() ? " -on" : "");
      b.style.background = a.hex;
      b.title = a.name;
      b.addEventListener("click", () => pick(a.hex));
      host.append(b);
    }
    const custom = document.createElement("label");
    custom.className = "swatch custom" + (isPreset ? "" : " -on");
    custom.title = "Custom colour";
    custom.append(document.createTextNode("🎨"));
    const input = document.createElement("input");
    input.type = "color";
    input.value = /^#[0-9a-f]{6}$/i.test(current) ? current : "#ff9345";
    input.addEventListener("input", () => pick(input.value));
    custom.append(input);
    host.append(custom);
  };
  render();
}

// ----------------------------------------------------------- activation rules
async function setupActivation(root: HTMLElement): Promise<void> {
  const host = root.querySelector<HTMLElement>("#ov-activation")!;
  const addBtn = root.querySelector<HTMLButtonElement>("#act-add")!;
  let t = 0;
  const collect = (): ActivationRule[] =>
    [...host.querySelectorAll<HTMLElement>(".act-row")]
      .map((row) => ({
        host: row.querySelector<HTMLInputElement>(".act-host")!.value.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
        patterns: row.querySelector<HTMLInputElement>(".act-pat")!.value.split(",").map((s) => s.trim()).filter(Boolean),
      }))
      .filter((r) => r.host);
  const save = () => {
    clearTimeout(t);
    t = window.setTimeout(async () => {
      const cur = await loadSettings();
      await saveSettings({ ...cur, activationRules: collect() });
    }, 400);
  };
  const empty = () => {
    if (!host.querySelector(".act-row")) host.innerHTML = `<div class="act-empty">No rules — the overlay shows on every page. Add one to restrict a site.</div>`;
  };
  const addRow = (rule: ActivationRule = { host: "", patterns: [] }) => {
    host.querySelector(".act-empty")?.remove();
    const row = document.createElement("div");
    row.className = "act-row";
    row.innerHTML = `<input class="act-host" placeholder="host (e.g. youtube.com)" value="${escapeHtml(rule.host)}"/>
      <input class="act-pat" placeholder="patterns, comma-separated (e.g. /watch, /shorts/)" value="${escapeHtml(rule.patterns.join(", "))}"/>
      <button class="btn-danger act-del">Remove</button>`;
    row.querySelector(".act-del")!.addEventListener("click", () => { row.remove(); empty(); save(); });
    row.querySelectorAll("input").forEach((i) => i.addEventListener("input", save));
    host.append(row);
  };
  const rules = (await loadSettings()).activationRules ?? [];
  rules.forEach((r) => addRow(r));
  empty();
  addBtn.addEventListener("click", () => addRow());
}

// ----------------------------------------------------------- danger zone (reset all)
function setupReset(root: HTMLElement): void {
  const btn = root.querySelector<HTMLButtonElement>("#rst-all")!;
  const alsoDicts = root.querySelector<HTMLInputElement>("#rst-dicts")!;
  const status = root.querySelector<HTMLElement>("#rst-status")!;
  btn.addEventListener("click", async () => {
    const msg =
      "Reset ALL extension data in this browser?\n\nThis removes your known/learning words, mined tracking, " +
      "and all settings (global + per-site)" + (alsoDicts.checked ? ", and DELETES your imported dictionaries" : "") +
      ".\nYour Anki cards are NOT affected. This cannot be undone.";
    if (!confirm(msg)) return;
    status.style.color = "#9a9bab";
    status.textContent = "Resetting…";
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith("tnm:") || k.startsWith("mgk:")); // incl. any legacy keys
      if (keys.length) await chrome.storage.local.remove(keys);
      if (alsoDicts.checked) {
        for (const d of await listDictionaries().catch(() => [])) await deleteDictionary(d.id);
      }
      status.style.color = "#36c275";
      status.textContent = "All data reset. Reloading…";
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      status.style.color = "#e0683f";
      status.textContent = "Reset failed: " + String((e as Error)?.message ?? e);
    }
  });
}

function relTime(at: number): string {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ----------------------------------------------------------- dashboard tabs
function setupTabs(root: HTMLElement): void {
  const links = [...root.querySelectorAll<HTMLButtonElement>(".nav__link")];
  const panels = [...root.querySelectorAll<HTMLElement>(".panel")];
  const tabs = new Set(links.map((l) => l.dataset.tab));
  const show = (tab: string) => {
    if (!tabs.has(tab)) tab = "overview";
    links.forEach((l) => l.classList.toggle("-active", l.dataset.tab === tab));
    panels.forEach((p) => (p.hidden = p.dataset.panel !== tab));
    if (location.hash.slice(1) !== tab) history.replaceState(null, "", `#${tab}`);
    window.scrollTo({ top: 0 });
  };
  links.forEach((l) => l.addEventListener("click", () => show(l.dataset.tab!)));
  // Quick-action buttons that jump to a tab.
  root.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) => b.addEventListener("click", () => show(b.dataset.go!)));
  show(location.hash.slice(1) || "overview"); // deep-link via #anki etc.
}

// ----------------------------------------------------------- overview (stats + checklist)
async function loadOverview(root: HTMLElement): Promise<void> {
  const s = await loadSettings();
  const known = new KnownWordsStore(s.targetLang);
  const mined = new MinedStore();
  await Promise.all([known.load(), mined.load()]);
  const dicts = await listDictionaries().catch(() => []);

  const num = (id: string, v: number) => (root.querySelector<HTMLElement>(id)!.textContent = v.toLocaleString());
  num("#ov-known", known.countKnown());
  num("#ov-learning", known.countLearning());
  num("#ov-mined", mined.count());
  num("#ov-dicts", dicts.length);

  const LANG: Record<string, string> = { ja: "Japanese", ko: "Korean", zh: "Chinese", en: "English" };
  type ChecklistItem = { done: boolean; title: string; desc: string; go?: string; href?: string; linkLabel?: string };
  const items: ChecklistItem[] = [
    {
      done: dicts.length > 0,
      title: dicts.length ? `${dicts.length} offline dictionary${dicts.length > 1 ? "ies" : ""} installed` : "Add an offline dictionary",
      desc: dicts.length ? "Faster, richer look-ups than the online fallback." : "Jisho (online) works out of the box; add one for offline + frequency.",
      go: "dicts",
    },
    {
      done: s.ankiEnabled && !!s.ankiDeck,
      title: s.ankiEnabled ? (s.ankiDeck ? `Anki mining → “${s.ankiDeck}”` : "Anki on — pick a deck") : "Set up Anki mining",
      desc: "Mine words to Anki cards (definition, audio, screenshot) from the word pop-up.",
      go: "anki",
    },
    {
      done: /lapis/i.test(s.ankiModel || ""),
      title: /lapis/i.test(s.ankiModel || "") ? "lapis-simplified note type ready" : "Install the lapis-simplified note type",
      desc: "The Anki card format this extension mines into. Download the latest release, import it into Anki (File → Import), then pick it as the Note type on the Anki tab.",
      href: "https://github.com/friedrich-de/lapis-simplified/releases",
      linkLabel: "Download",
    },
    {
      done: !!s.jimakuApiKey,
      title: s.jimakuApiKey ? "Jimaku API key set" : "Add your Jimaku API key",
      desc: "Find Japanese subtitles for anime automatically.",
      go: "jimaku",
    },
  ];
  const ul = root.querySelector<HTMLUListElement>("#ov-checklist")!;
  ul.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.className = it.done ? "-done" : "";
    li.innerHTML = `<span class="dot">${it.done ? "✓" : "•"}</span>
      <div class="cmain"><div class="ctitle">${escapeHtml(it.title)}</div><div class="cdesc">${escapeHtml(it.desc)}</div></div>`;
    if (it.href) {
      const a = document.createElement("a");
      a.className = "clink";
      a.href = it.href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = `${it.linkLabel ?? "Open"} ↗`;
      li.append(a);
    } else if (!it.done && it.go) {
      const b = document.createElement("button");
      b.className = "clink";
      b.dataset.go = it.go;
      b.textContent = "Set up →";
      b.addEventListener("click", () => root.querySelector<HTMLButtonElement>(`.nav__link[data-tab="${it.go}"]`)!.click());
      li.append(b);
    }
    ul.append(li);
  }
  const target = root.querySelector<HTMLElement>("#ov-known")!.closest(".stat")!.querySelector<HTMLElement>(".stat__label")!;
  target.textContent = `Known words · ${LANG[normalizeLangCode(s.targetLang)] ?? s.targetLang}`;

  // Recently mined (activity feed).
  const recent = await loadRecentMined();
  const feed = root.querySelector<HTMLElement>("#ov-recent")!;
  feed.innerHTML = "";
  if (!recent.length) {
    feed.innerHTML = `<div class="empty">No mines yet — hit the ＋ button on a word look-up to mine it.</div>`;
  } else {
    for (const r of recent.slice(0, 12)) {
      const row = document.createElement("div");
      row.className = "feed__row";
      row.innerHTML = `<span class="feed__word">${escapeHtml(r.word)}</span><span class="feed__sent">${escapeHtml(r.sentence || "")}</span><span class="feed__time">${relTime(r.at)}</span>`;
      feed.append(row);
    }
  }

  await renderSites(root);
}

/** List sites with per-site overrides (tnm:settings:<host>) + a per-site reset. */
async function renderSites(root: HTMLElement): Promise<void> {
  const host = root.querySelector<HTMLElement>("#ov-sites")!;
  const all = await chrome.storage.local.get(null);
  const sites = Object.keys(all)
    .filter((k) => k.startsWith("tnm:settings:"))
    .map((k) => ({ key: k, host: k.slice("tnm:settings:".length), keys: Object.keys((all[k] as object) ?? {}) }))
    .sort((a, b) => a.host.localeCompare(b.host));
  host.innerHTML = "";
  if (!sites.length) {
    host.innerHTML = `<div class="empty">No per-site overrides yet. Change a toolbar/subtitle option on a site and it'll show here.</div>`;
    return;
  }
  for (const s of sites) {
    const row = document.createElement("div");
    row.className = "site";
    row.innerHTML = `<div class="site__main"><div class="site__host">${escapeHtml(s.host)}</div>
      <div class="site__keys">${s.keys.length ? escapeHtml(s.keys.join(", ")) : "no overrides"}</div></div>`;
    const reset = document.createElement("button");
    reset.className = "btn-danger";
    reset.textContent = "Reset";
    reset.addEventListener("click", async () => {
      if (!confirm(`Reset settings for ${s.host}? It will use your global defaults.`)) return;
      await chrome.storage.local.remove(s.key);
      await renderSites(root);
    });
    row.append(reset);
    host.append(row);
  }
}

function normalizeLangCode(l: string): string {
  return (l || "").slice(0, 2).toLowerCase();
}

// ----------------------------------------------------------- backup & restore
function setupBackup(root: HTMLElement): void {
  const status = root.querySelector<HTMLElement>("#bk-status")!;
  const fileInput = root.querySelector<HTMLInputElement>("#bk-file")!;
  const say = (msg: string, color = "#9a9bab") => { status.style.color = color; status.textContent = msg; };

  root.querySelector("#bk-export")!.addEventListener("click", async () => {
    const all = await chrome.storage.local.get(null);
    const data: Record<string, unknown> = {};
    for (const k of Object.keys(all)) if (k.startsWith("tnm:")) data[k] = all[k];
    const blob = new Blob([JSON.stringify({ _tanma: 1, exportedAt: new Date().toISOString(), data }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tnm-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    say(`Exported ${Object.keys(data).length} item(s). Import this file in your other browser.`, "#36c275");
  });

  root.querySelector("#bk-import")!.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const data = (parsed?.data ?? parsed) as Record<string, unknown>;
      const keys = Object.keys(data).filter((k) => k.startsWith("tnm:"));
      if (!keys.length) throw new Error("Not a TANMA! backup file.");
      const cur = await chrome.storage.local.get(keys);
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (k === "tnm:mined") {
          // Merge mined sets (union) so importing never drops existing tracking.
          const a = (cur[k] ?? {}) as { words?: string[]; sentences?: string[] };
          const b = (data[k] ?? {}) as { words?: string[]; sentences?: string[] };
          out[k] = { words: [...new Set([...(a.words ?? []), ...(b.words ?? [])])], sentences: [...new Set([...(a.sentences ?? []), ...(b.sentences ?? [])])] };
        } else if (/^tnm:known:/.test(k)) {
          out[k] = { ...((cur[k] as object) ?? {}), ...(data[k] as object) }; // merge word→status maps
        } else {
          out[k] = data[k]; // settings / offsets / bookmarks → overwrite
        }
      }
      await chrome.storage.local.set(out);
      say(`Imported ${keys.length} item(s). Reloading…`, "#36c275");
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      say("Import failed: " + String((e as Error)?.message ?? e), "#e0683f");
    }
  });
}

// ----------------------------------------------------------- jimaku api key
async function setupJimaku(root: HTMLElement): Promise<void> {
  const key = root.querySelector<HTMLInputElement>("#jimaku-key")!;
  const autoload = root.querySelector<HTMLInputElement>("#jimaku-autoload")!;
  const s = await loadSettings();
  key.value = s.jimakuApiKey;
  autoload.checked = s.jimakuAutoLoad;
  let t = 0;
  key.addEventListener("input", () => {
    clearTimeout(t);
    t = window.setTimeout(async () => {
      const cur = await loadSettings();
      await saveSettings({ ...cur, jimakuApiKey: key.value.trim() });
    }, 300);
  });
  autoload.addEventListener("change", async () => {
    const cur = await loadSettings();
    await saveSettings({ ...cur, jimakuAutoLoad: autoload.checked });
  });
}

// ----------------------------------------------------------- machine translation
async function setupTranslation(root: HTMLElement): Promise<void> {
  const provider = root.querySelector<HTMLSelectElement>("#mt-provider")!;
  const keyRow = root.querySelector<HTMLDivElement>("#mt-key-row")!;
  const key = root.querySelector<HTMLInputElement>("#mt-key")!;
  const s = await loadSettings();
  provider.value = s.mtProvider === "deepl" ? "deepl" : "google";
  key.value = s.mtApiKey;
  const reflect = () => (keyRow.style.display = provider.value === "deepl" ? "" : "none");
  reflect();
  provider.addEventListener("change", async () => {
    reflect();
    const cur = await loadSettings();
    await saveSettings({ ...cur, mtProvider: provider.value === "deepl" ? "deepl" : "google" });
  });
  let t = 0;
  key.addEventListener("input", () => {
    clearTimeout(t);
    t = window.setTimeout(async () => {
      const cur = await loadSettings();
      await saveSettings({ ...cur, mtApiKey: key.value.trim() });
    }, 300);
  });
}

/**
 * Mined-card translation: one call per mined card (not per subtitle line), so it can afford an LLM
 * with surrounding dialogue as context. Off by default; independent of the live-line provider above.
 */
async function setupMinedTranslation(root: HTMLElement): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(id)!;
  const enabled = $<HTMLInputElement>("#tr-enabled");
  const config = $<HTMLDivElement>("#tr-config");
  const field = $<HTMLSelectElement>("#tr-field");
  const provider = $<HTMLSelectElement>("#tr-provider");
  const openai = $<HTMLDivElement>("#tr-openai");
  const gemini = $<HTMLDivElement>("#tr-gemini");
  const llm = $<HTMLDivElement>("#tr-llm");
  const status = $<HTMLSpanElement>("#tr-status");
  const oaUrl = $<HTMLInputElement>("#tr-openai-url");
  const oaModel = $<HTMLInputElement>("#tr-openai-model");
  const oaBackup = $<HTMLInputElement>("#tr-openai-backup");
  const oaKey = $<HTMLInputElement>("#tr-openai-key");
  const gmKey = $<HTMLInputElement>("#tr-gemini-key");
  const gmModel = $<HTMLSelectElement>("#tr-gemini-model");
  const gmRefresh = $<HTMLButtonElement>("#tr-gemini-refresh");
  const before = $<HTMLInputElement>("#tr-before");
  const after = $<HTMLInputElement>("#tr-after");
  const temp = $<HTMLInputElement>("#tr-temp");
  const maxTok = $<HTMLInputElement>("#tr-maxtok");
  const topP = $<HTMLInputElement>("#tr-topp");
  const promptBox = $<HTMLTextAreaElement>("#tr-prompt");
  const promptLoad = $<HTMLButtonElement>("#tr-prompt-load");
  const promptClear = $<HTMLButtonElement>("#tr-prompt-clear");

  const s = await loadSettings();
  const save = async (patch: Partial<Settings>) => {
    const cur = await loadSettings();
    await saveSettings({ ...cur, ...patch });
  };

  enabled.checked = s.trEnabled;
  provider.value = s.trProvider;
  oaUrl.value = s.trOpenaiUrl;
  oaModel.value = s.trOpenaiModel;
  oaBackup.value = s.trOpenaiBackupModel;
  oaKey.value = s.trOpenaiKey;
  gmKey.value = s.trGeminiKey;
  before.value = String(s.trContextBefore);
  after.value = String(s.trContextAfter);
  temp.value = String(s.trTemperature);
  maxTok.value = String(s.trMaxTokens);
  topP.value = String(s.trTopP);
  promptBox.value = s.trPrompt;

  // Field list from the configured note type when Anki is reachable; otherwise just what's saved
  // (addCard filters unknown fields anyway, so a stale value can't break mining).
  const names = new Set<string>(["SentenceTranslation"]);
  if (s.trField) names.add(s.trField);
  try {
    for (const n of (await anki("modelFieldNames", { modelName: s.ankiModel })) as string[]) names.add(n);
  } catch {
    /* Anki closed — keep the saved value selectable */
  }
  for (const n of names) field.append(new Option(n, n));
  field.value = s.trField || "SentenceTranslation";

  const reflect = () => {
    config.classList.toggle("-off", !enabled.checked);
    const llmish = provider.value === "openai" || provider.value === "gemini";
    openai.style.display = provider.value === "openai" ? "" : "none";
    gemini.style.display = provider.value === "gemini" ? "" : "none";
    llm.style.display = llmish ? "" : "none"; // context/sampling/prompt only apply to an LLM
  };
  reflect();

  enabled.addEventListener("change", () => {
    reflect();
    save({ trEnabled: enabled.checked });
  });
  provider.addEventListener("change", () => {
    reflect();
    save({ trProvider: provider.value as Settings["trProvider"] });
  });
  field.addEventListener("change", () => save({ trField: field.value }));
  gmModel.addEventListener("change", () => save({ trGeminiModel: gmModel.value }));

  const debounce = (el: HTMLElement, run: () => void) => {
    let t = 0;
    el.addEventListener("input", () => {
      clearTimeout(t);
      t = window.setTimeout(run, 300);
    });
  };
  debounce(oaUrl, () => save({ trOpenaiUrl: oaUrl.value.trim() }));
  debounce(oaModel, () => save({ trOpenaiModel: oaModel.value.trim() }));
  debounce(oaBackup, () => save({ trOpenaiBackupModel: oaBackup.value.trim() }));
  debounce(oaKey, () => save({ trOpenaiKey: oaKey.value.trim() }));
  debounce(gmKey, () => save({ trGeminiKey: gmKey.value.trim() }));
  debounce(promptBox, () => save({ trPrompt: promptBox.value }));
  const num = (el: HTMLInputElement, key: string, min: number, max: number) =>
    debounce(el, () => {
      const v = Math.min(max, Math.max(min, Number(el.value) || 0));
      save({ [key]: v } as unknown as Partial<Settings>);
    });
  num(before, "trContextBefore", 0, 50);
  num(after, "trContextAfter", 0, 50);
  num(temp, "trTemperature", 0, 2);
  num(maxTok, "trMaxTokens", 16, 32768);
  num(topP, "trTopP", 0, 1);

  if (s.trGeminiModel) gmModel.append(new Option(s.trGeminiModel, s.trGeminiModel));
  gmModel.value = s.trGeminiModel;
  gmRefresh.addEventListener("click", async () => {
    const key = gmKey.value.trim();
    if (!key) {
      status.textContent = "Enter a Gemini API key first.";
      return;
    }
    status.textContent = "Fetching models…";
    const res = (await chrome.runtime
      .sendMessage({ type: "geminiModels", key })
      .catch(() => null)) as GeminiModelsResponse | null;
    if (!res?.ok) {
      status.textContent = "Models: " + (res?.error ?? "failed");
      return;
    }
    const keep = gmModel.value;
    gmModel.replaceChildren();
    for (const m of res.models) gmModel.append(new Option(m, m));
    if (keep && !res.models.includes(keep)) gmModel.append(new Option(keep, keep));
    gmModel.value = keep || res.models[0] || "";
    if (gmModel.value) save({ trGeminiModel: gmModel.value });
    status.textContent = `Loaded ${res.models.length} models ✓`;
  });

  promptLoad.addEventListener("click", () => {
    promptBox.value = CANNED_PROMPT;
    save({ trPrompt: CANNED_PROMPT });
  });
  promptClear.addEventListener("click", () => {
    promptBox.value = "";
    save({ trPrompt: "" });
  });
}

// ----------------------------------------------------------- look-up & keybindings
async function setupKeybinds(root: HTMLElement): Promise<void> {
  {
    const jpod = root.querySelector<HTMLInputElement>("#au-jpod")!;
    const custom = root.querySelector<HTMLInputElement>("#au-custom")!;
    const tts = root.querySelector<HTMLInputElement>("#au-tts")!;
    const s0 = await loadSettings();
    jpod.checked = s0.audioJpod101 !== false;
    custom.value = s0.audioCustomUrl ?? "";
    tts.checked = s0.audioGoogleTts !== false;
    const save = async (patch: Record<string, unknown>) => {
      const cur = await loadSettings();
      await saveSettings({ ...cur, ...patch });
    };
    jpod.addEventListener("change", () => void save({ audioJpod101: jpod.checked }));
    tts.addEventListener("change", () => void save({ audioGoogleTts: tts.checked }));
    let t = 0;
    custom.addEventListener("input", () => {
      clearTimeout(t);
      t = window.setTimeout(() => void save({ audioCustomUrl: custom.value.trim() }), 300);
    });
  }

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(id)!;
  const hold = $<HTMLInputElement>("#kb-hold");
  const config = $<HTMLDivElement>("#kb-config");
  const key = $<HTMLSelectElement>("#kb-key");
  const overlay = $<HTMLInputElement>("#kb-overlay");
  const prev = $<HTMLInputElement>("#kb-prev");
  const next = $<HTMLInputElement>("#kb-next");
  const replay = $<HTMLInputElement>("#kb-replay");

  const s = await loadSettings();
  hold.checked = s.holdLookup;
  key.value = s.keyLookup;
  overlay.checked = s.holdLookupOverlay;
  prev.value = s.keyPrevLine;
  next.value = s.keyNextLine;
  replay.value = s.keyReplayLine;
  config.classList.toggle("-off", !s.holdLookup);

  const save = async (patch: Partial<Settings>) => {
    const cur = await loadSettings();
    await saveSettings({ ...cur, ...patch });
  };
  // A single key, lower-cased; ignore blanks so a field can't be wiped to nothing.
  const keyField = (input: HTMLInputElement, key: "keyPrevLine" | "keyNextLine" | "keyReplayLine") =>
    input.addEventListener("input", () => {
      const v = (input.value || "").trim().toLowerCase().slice(0, 1);
      input.value = v;
      if (v) save({ [key]: v });
    });

  hold.addEventListener("change", () => {
    config.classList.toggle("-off", !hold.checked);
    save({ holdLookup: hold.checked });
  });
  key.addEventListener("change", () => save({ keyLookup: key.value }));
  overlay.addEventListener("change", () => save({ holdLookupOverlay: overlay.checked }));
  keyField(prev, "keyPrevLine");
  keyField(next, "keyNextLine");
  keyField(replay, "keyReplayLine");
}

// ----------------------------------------------------------------- anki config

function anki(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return chrome.runtime.sendMessage({ type: "anki", action, params }).then((r: { ok: boolean; result?: unknown; error?: string }) => {
    if (!r?.ok) throw new Error(r?.error ?? "Anki request failed");
    return r.result;
  });
}

/** A searchable, multi-checkable dropdown (combo box) for picking deck names. */
interface DeckCombo {
  el: HTMLElement;
  setItems(items: string[], selected?: string[]): void;
  getSelected(): string[];
  count(): number;
}
function buildDeckCombo(placeholder: string, onChange?: (selected: string[]) => void): DeckCombo {
  const selected = new Set<string>();
  let items: string[] = [];

  const field = document.createElement("button");
  field.type = "button";
  field.className = "combo__field";
  const label = document.createElement("span");
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▾";
  field.append(label, caret);

  const search = document.createElement("input");
  search.className = "combo__search";
  search.placeholder = "Search decks…";
  const list = document.createElement("div");
  list.className = "combo__list";
  const menu = document.createElement("div");
  menu.className = "combo__menu";
  menu.hidden = true;
  menu.append(search, list);

  const el = document.createElement("div");
  el.className = "combo";
  el.append(field, menu);

  const updateLabel = () => {
    label.textContent =
      selected.size === 0 ? placeholder :
      selected.size === 1 ? [...selected][0] :
      items.length && selected.size === items.length ? `All ${items.length} decks` :
      `${selected.size} decks selected`;
  };
  const renderList = () => {
    list.innerHTML = "";
    const q = search.value.trim().toLowerCase();
    const shown = items.filter((it) => it.toLowerCase().includes(q));
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "combo__empty";
      empty.textContent = items.length ? "No matching decks." : "Test connection to load decks.";
      list.append(empty);
      return;
    }
    for (const it of shown) {
      const item = document.createElement("label");
      item.className = "combo__item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(it);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(it); else selected.delete(it);
        updateLabel();
        onChange?.([...selected]);
      });
      const span = document.createElement("span");
      span.textContent = it;
      item.append(cb, span);
      list.append(item);
    }
  };

  field.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    if (!menu.hidden) { search.value = ""; renderList(); search.focus(); }
  });
  search.addEventListener("input", renderList);
  document.addEventListener("click", (e) => {
    if (!el.contains(e.target as Node)) menu.hidden = true;
  });

  updateLabel();
  return {
    el,
    setItems(next, sel = []) {
      items = [...next];
      selected.clear();
      for (const s of sel) if (items.includes(s)) selected.add(s);
      updateLabel();
      if (!menu.hidden) renderList();
    },
    getSelected: () => [...selected],
    count: () => items.length,
  };
}

async function setupAnki(root: HTMLElement): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(id)!;
  const enabled = $<HTMLInputElement>("#anki-enabled");
  const config = $<HTMLDivElement>("#anki-config");
  const deck = $<HTMLSelectElement>("#anki-deck");
  const model = $<HTMLSelectElement>("#anki-model");
  const mainDict = $<HTMLSelectElement>("#anki-maindict");
  const image = $<HTMLInputElement>("#anki-image");
  const saudio = $<HTMLInputElement>("#anki-saudio");
  const waudio = $<HTMLInputElement>("#anki-waudio");
  const anim = $<HTMLInputElement>("#anki-anim");
  const testBtn = $<HTMLButtonElement>("#anki-test");
  const autosync = $<HTMLInputElement>("#anki-autosync");
  const deckCombo = buildDeckCombo("Select decks to sync…", (sel) => save({ ankiSyncDecks: sel }));
  $<HTMLDivElement>("#anki-sync-decks").append(deckCombo.el);
  const status = $<HTMLSpanElement>("#anki-status");

  const s = await loadSettings();
  enabled.checked = s.ankiEnabled;
  image.checked = s.ankiCaptureImage;
  saudio.checked = s.ankiCaptureSentenceAudio;
  waudio.checked = s.ankiCaptureWordAudio;
  anim.checked = s.ankiAnimatedImage;
  autosync.checked = s.ankiAutoSyncMined;
  config.classList.toggle("-off", !s.ankiEnabled);
  const option = (sel: HTMLSelectElement, val: string) => {
    if (val && !Array.from(sel.options).some((o) => o.value === val)) sel.append(new Option(val, val));
    if (val) sel.value = val;
  };
  option(deck, s.ankiDeck);
  option(model, s.ankiModel);

  // Main-definition dictionary: list imported dicts with glossaries; "" = auto.
  mainDict.append(new Option("Auto (prefer Jitendex/JMdict)", ""));
  try {
    for (const d of (await listDictionaries()).filter((d) => d.hasTerms)) mainDict.append(new Option(d.title, d.title));
  } catch { /* none */ }
  if (s.ankiMainDict && !Array.from(mainDict.options).some((o) => o.value === s.ankiMainDict)) {
    mainDict.append(new Option(s.ankiMainDict, s.ankiMainDict));
  }
  mainDict.value = s.ankiMainDict;

  const save = async (patch: Partial<Settings>) => {
    const cur = await loadSettings();
    await saveSettings({ ...cur, ...patch });
  };

  enabled.addEventListener("change", () => {
    config.classList.toggle("-off", !enabled.checked);
    save({ ankiEnabled: enabled.checked });
    if (enabled.checked) connect();
  });
  deck.addEventListener("change", () => save({ ankiDeck: deck.value }));
  model.addEventListener("change", () => save({ ankiModel: model.value }));
  mainDict.addEventListener("change", () => save({ ankiMainDict: mainDict.value }));
  image.addEventListener("change", () => save({ ankiCaptureImage: image.checked }));
  saudio.addEventListener("change", () => save({ ankiCaptureSentenceAudio: saudio.checked }));
  waudio.addEventListener("change", () => save({ ankiCaptureWordAudio: waudio.checked }));
  anim.addEventListener("change", () => save({ ankiAnimatedImage: anim.checked }));
  autosync.addEventListener("change", () => save({ ankiAutoSyncMined: autosync.checked }));
  testBtn.addEventListener("click", connect);

  // Backfill the local "mined" tracking from the chosen deck(s): read every note's
  // Expression (word) + Sentence so already-mined lines/words show their markers.
  $<HTMLButtonElement>("#anki-sync-mined").addEventListener("click", async () => {
    const selected = deckCombo.getSelected();
    // If the list is loaded but nothing is checked, the user deliberately picked none —
    // don't silently fall back. Only fall back to the mining deck when not yet loaded.
    if (!selected.length && deckCombo.count() > 0) {
      status.style.color = "#e0683f";
      status.textContent = "Pick at least one deck to sync.";
      return;
    }
    const decksToSync = selected.length ? selected : (deck.value ? [deck.value] : []);
    if (!decksToSync.length) { status.style.color = "#e0683f"; status.textContent = "Test connection and pick a deck first."; return; }
    status.style.color = "#9a9bab";
    status.textContent = `Reading ${decksToSync.length} deck(s) from Anki…`;
    try {
      const query = decksToSync.map((d) => `deck:"${d.replace(/"/g, "")}"`).join(" OR ");
      const ids = (await anki("findNotes", { query })) as number[];
      const infos = (await anki("notesInfo", { notes: ids })) as { fields?: Record<string, { value: string }> }[];
      const words: string[] = [];
      const sentences: string[] = [];
      for (const n of infos) {
        const exp = n.fields?.Expression?.value?.replace(/<[^>]*>/g, "").trim();
        const sen = n.fields?.Sentence?.value;
        if (exp) words.push(exp);
        if (sen) sentences.push(sen);
      }
      await mergeMined(words, sentences); // union — never drops existing tracking
      status.style.color = "#36c275";
      status.textContent = `Synced ${infos.length} cards (${new Set(words).size} words) from ${decksToSync.length} deck(s).`;
    } catch (e) {
      status.style.color = "#e0683f";
      status.textContent = "Sync failed: " + String((e as Error)?.message ?? e);
    }
  });

  // Clear the LOCAL mined tracking (✓ on lines / dots on words). Anki cards are untouched.
  $<HTMLButtonElement>("#anki-reset-mined").addEventListener("click", async () => {
    if (!confirm("Clear the local 'mined' tracking (the ✓ marks)?\n\nYour Anki cards are NOT affected — you can re-sync afterward.")) return;
    await clearMined();
    status.style.color = "#9a9bab";
    status.textContent = "Cleared local mined tracking. Pick decks above and Sync to rebuild.";
  });

  async function connect() {
    status.style.color = "#9a9bab";
    status.textContent = "Connecting…";
    try {
      const version = (await anki("version")) as number;
      const [decks, models] = (await Promise.all([anki("deckNames"), anki("modelNames")])) as [string[], string[]];
      fill(deck, decks, s.ankiDeck || deck.value);
      fill(model, models, s.ankiModel || pickLapis(models) || model.value);
      // Restore the remembered sync-deck selection (else default to the mining deck).
      const saved = (await loadSettings()).ankiSyncDecks ?? [];
      deckCombo.setItems([...decks].sort(), saved.length ? saved : deck.value ? [deck.value] : []);
      await save({ ankiDeck: deck.value, ankiModel: model.value });
      status.style.color = "#36c275";
      status.textContent = `Connected ✓ (AnkiConnect v${version}). Pick your deck & note type above.`;
    } catch (e) {
      status.style.color = "#ff7a7a";
      status.textContent =
        `Couldn't reach Anki: ${String((e as Error)?.message ?? e)}. ` +
        `Open Anki + AnkiConnect, then add "${chrome.runtime.getURL("").replace(/\/$/, "")}" to its webCorsOriginList ` +
        `(Tools → Add-ons → AnkiConnect → Config) and restart Anki.`;
    }
  }

  function fill(sel: HTMLSelectElement, items: string[], selected: string) {
    sel.innerHTML = "";
    for (const it of [...items].sort()) sel.append(new Option(it, it));
    if (selected && items.includes(selected)) sel.value = selected;
  }
  function pickLapis(models: string[]): string {
    return models.find((m) => /lapis/i.test(m)) ?? "";
  }

  if (s.ankiEnabled) connect();
}

async function refresh() {
  const dicts = await listDictionaries();
  renderCatalog(dicts);
  renderList(dicts);
}

// ----------------------------------------------------------------- catalog
function renderCatalog(dicts: DictionaryMeta[]) {
  const host = document.getElementById("catalog")!;
  host.innerHTML = "";
  const installed = new Set(dicts.map((d) => d.catalogId).filter(Boolean));
  for (const entry of CATALOG) {
    const isInstalled = installed.has(entry.id);
    const row = document.createElement("div");
    row.className = "cat";
    row.innerHTML = `
      <div class="cat__main">
        <div class="cat__title">${escapeHtml(entry.title)} <span class="badge -${entry.kind}">${entry.kind}</span></div>
        <div class="cat__desc">${escapeHtml(entry.desc)}</div>
        <div class="cat__size">~${entry.sizeMB} MB · ${escapeHtml(entry.attribution)}</div>
      </div>
      <div class="cat__action"></div>
    `;
    const action = row.querySelector(".cat__action")!;
    if (isInstalled) {
      action.innerHTML = `<span class="installed-chip">✓ Installed</span>`;
      // For release-tracked dicts, check GitHub for a newer version and offer a one-click update.
      const dict = dicts.find((d) => d.catalogId === entry.id);
      if (dict) {
        // A term dictionary installed before we captured styles.css has no example/note-box styling
        // stored — offer a one-click re-import to gain it, even when there's no newer release.
        const needsStyles = entry.kind === "terms" && !dict.styles && !!githubRepo(entry.url);
        const offer = (label: string, tip: string) => {
          const btn = document.createElement("button");
          btn.className = "btn-primary";
          btn.textContent = "⟳ Update";
          btn.title = tip;
          btn.addEventListener("click", () => updateDict(entry, dict.id, btn));
          action.innerHTML = `<span class="installed-chip" style="color:#ffb020">↑ ${escapeHtml(label)}</span>`;
          action.append(btn);
        };
        checkCatalogUpdate(entry, dict)
          .then((latest) => {
            if (latest) offer(latest, `Newer version available (${latest}); installed: ${dict.revision || "?"}`);
            else if (needsStyles) offer("styling", "Re-import to add Yomitan example/note-box styling to mined cards");
          })
          .catch(() => {
            if (needsStyles) offer("styling", "Re-import to add Yomitan example/note-box styling to mined cards");
          });
      }
    } else {
      const btn = document.createElement("button");
      btn.className = "btn-primary";
      btn.textContent = "Download";
      btn.addEventListener("click", () => downloadAndImport(entry, btn));
      action.append(btn);
    }
    host.append(row);
  }
}

async function downloadAndImport(entry: CatalogEntry, btn: HTMLButtonElement) {
  if (busy) return;
  busy = true;
  setDownloadButtonsDisabled(true);
  btn.textContent = "Downloading…";
  try {
    const data = await downloadWithProgress(entry);
    await importData(entry.title, data, entry.id);
    await refresh();
    hideProgressSoon();
  } catch (e: any) {
    setProgress(0, `Download failed: ${e?.message ?? e}`);
    btn.textContent = "Download";
  } finally {
    busy = false;
    setDownloadButtonsDisabled(false);
  }
}

/** Extract a YYYY-MM-DD date from a version/revision/tag string (these dicts are date-versioned). */
function parseDateKey(s: unknown): number | null {
  const m = String(s ?? "").match(/(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

/** Latest version label if the repo's newest release is newer than the installed revision, else null. */
async function checkCatalogUpdate(entry: CatalogEntry, dict: DictionaryMeta): Promise<string | null> {
  const repo = githubRepo(entry.url);
  const installed = parseDateKey(dict.revision);
  if (!repo || installed == null) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return null;
    const j = (await res.json()) as { tag_name?: string; name?: string; published_at?: string };
    const latest = parseDateKey(j.tag_name) ?? parseDateKey(j.name) ?? parseDateKey(j.published_at);
    if (latest == null || latest <= installed) return null;
    return j.tag_name || new Date(latest).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** Download the latest release and replace the installed copy (delete old → import new). */
async function updateDict(entry: CatalogEntry, oldId: number, btn: HTMLButtonElement) {
  if (busy) return;
  busy = true;
  setDownloadButtonsDisabled(true);
  btn.textContent = "Updating…";
  try {
    const data = await downloadWithProgress(entry);
    await deleteDictionary(oldId);
    await importData(entry.title, data, entry.id);
    await refresh();
    hideProgressSoon();
  } catch (e: any) {
    setProgress(0, `Update failed: ${e?.message ?? e}`);
    btn.textContent = "⟳ Update";
  } finally {
    busy = false;
    setDownloadButtonsDisabled(false);
  }
}

async function downloadWithProgress(entry: CatalogEntry): Promise<Uint8Array> {
  setProgress(0.01, `Downloading ${entry.title}…`);
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || entry.sizeMB * 1048576;
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    setProgress(0.42 * Math.min(1, received / total), `Downloading ${entry.title}… ${(received / 1048576).toFixed(1)} MB`);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function setDownloadButtonsDisabled(disabled: boolean) {
  document.querySelectorAll<HTMLButtonElement>("#catalog .btn-primary").forEach((b) => (b.disabled = disabled));
}

// ----------------------------------------------------------------- import core
function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => unzip(data, (err, files) => (err ? reject(err) : resolve(files))));
}

async function importFile(file: File) {
  if (busy) return;
  busy = true;
  try {
    setProgress(0.05, `Reading ${file.name}…`);
    await importData(file.name, new Uint8Array(await file.arrayBuffer()));
    await refresh();
    hideProgressSoon();
  } catch (e: any) {
    setProgress(0, `Import failed: ${e?.message ?? e}`);
  } finally {
    busy = false;
  }
}

async function importData(label: string, data: Uint8Array, catalogId?: string) {
  setProgress(0.45, "Unzipping…");
  const files = await unzipAsync(data);
  const indexFile = files["index.json"];
  if (!indexFile) throw new Error("Not a Yomitan dictionary (no index.json).");
  const index = parseIndex(JSON.parse(decode(indexFile)));

  // Yomitan structured-content styling (Jitendex ships this as styles.css): the example/note
  // boxes and tag chips are drawn entirely by this CSS via data-sc-* attributes, so we keep it
  // to inject into mined Anki cards (matching Yomitan's look).
  const styles = files["styles.css"] ? decode(files["styles.css"]) : "";

  const id = await createDictionary({
    title: index.title || label,
    revision: index.revision ?? "",
    enabled: true,
    order: (await listDictionaries()).length,
    catalogId,
    styles,
    hasTerms: false, hasFreq: false, hasKanji: false, hasPitch: false,
    counts: { terms: 0, termMeta: 0, kanji: 0, tags: 0 },
    importedAt: Date.now(),
  });

  const counts = { terms: 0, termMeta: 0, kanji: 0, tags: 0 };
  let hasTerms = false, hasFreq = false, hasKanji = false, hasPitch = false;

  // Dictionary-bundled media (images referenced by structured content), stored per path.
  const MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", avif: "image/avif" };
  for (const [name, bytes] of Object.entries(files)) {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const type = MEDIA_TYPES[ext];
    if (!type) continue;
    // Copy into a fresh ArrayBuffer (the fflate view may share a larger buffer).
    await putMedia(id, name, type, bytes.slice().buffer);
  }

  const names = Object.keys(files).filter((n) => n.endsWith(".json") && n !== "index.json");
  let processed = 0;
  for (const name of names) {
    const json = JSON.parse(decode(files[name]));
    if (/(^|\/)term_bank_/.test(name)) {
      const recs = parseTermBank(json, id);
      await bulkPut(STORES.TERMS, recs); counts.terms += recs.length; hasTerms = true;
    } else if (/(^|\/)term_meta_bank_/.test(name)) {
      const { freq, pitch } = parseTermMetaBank(json, id);
      if (freq.length) { await bulkPut(STORES.FREQ, freq); counts.termMeta += freq.length; hasFreq = true; }
      if (pitch.length) { await bulkPut(STORES.PITCH, pitch); hasPitch = true; }
    } else if (/(^|\/)kanji_bank_/.test(name)) {
      const recs = parseKanjiBank(json, id);
      await bulkPut(STORES.KANJI, recs); counts.kanji += recs.length; hasKanji = true;
    } else if (/(^|\/)kanji_meta_bank_/.test(name)) {
      await bulkPut(STORES.FREQ, parseKanjiMetaBank(json, id)); hasFreq = true;
    } else if (/(^|\/)tag_bank_/.test(name)) {
      const recs = parseTagBank(json, id);
      await bulkPut(STORES.TAGS, recs); counts.tags += recs.length;
    }
    processed++;
    setProgress(0.45 + 0.53 * (processed / names.length), `Importing ${index.title} — ${processed}/${names.length} files…`);
  }

  await updateDictionary(id, { counts, hasTerms, hasFreq, hasKanji, hasPitch });
  setProgress(1, `Imported “${index.title}” ✓`);
}

function decode(u8: Uint8Array): string {
  return new TextDecoder("utf-8").decode(u8);
}

function setProgress(pct: number, status: string) {
  const wrap = document.querySelector<HTMLElement>(".progress")!;
  wrap.style.display = "";
  wrap.querySelector<HTMLElement>(".bar > i")!.style.width = `${Math.round(pct * 100)}%`;
  wrap.querySelector<HTMLElement>(".status")!.textContent = status;
}
function hideProgressSoon() {
  setTimeout(() => { const p = document.querySelector<HTMLElement>(".progress"); if (p) p.style.display = "none"; }, 2500);
}

// ----------------------------------------------------------------- installed list
function renderList(dicts: DictionaryMeta[]) {
  const list = document.getElementById("list")!;
  if (!dicts.length) {
    list.innerHTML = `<div class="empty">No dictionaries installed yet. Jisho (online) is used by default.</div>`;
    return;
  }
  list.innerHTML = `<table><thead><tr><th style="width:64px">Order</th><th>Dictionary</th><th>Entries</th><th>On</th><th></th></tr></thead><tbody></tbody></table>`;
  const tbody = list.querySelector("tbody")!;
  dicts.forEach((d, i) => tbody.append(row(d, i, dicts.length)));
}

function row(d: DictionaryMeta, i: number, total: number): HTMLElement {
  const tr = document.createElement("tr");
  const badges =
    (d.hasTerms ? `<span class="badge -terms">terms</span>` : "") +
    (d.hasFreq ? `<span class="badge -freq">freq</span>` : "") +
    (d.hasKanji ? `<span class="badge -kanji">kanji</span>` : "");
  const n = (d.counts.terms || d.counts.kanji || d.counts.termMeta || 0).toLocaleString();
  tr.innerHTML = `
    <td><button class="ord up" ${i === 0 ? "disabled" : ""}>▲</button> <button class="ord down" ${i === total - 1 ? "disabled" : ""}>▼</button></td>
    <td><div class="title">${escapeHtml(d.title)}</div><div class="badges">${badges}</div></td>
    <td class="count">${n}</td>
    <td><label class="switch"><input type="checkbox" ${d.enabled ? "checked" : ""}><span class="tk"></span><span class="th"></span></label></td>
    <td><button class="btn-danger del">Delete</button></td>
  `;
  tr.querySelector(".up")!.addEventListener("click", () => reorder(d.id, -1));
  tr.querySelector(".down")!.addEventListener("click", () => reorder(d.id, 1));
  tr.querySelector<HTMLInputElement>("input")!.addEventListener("change", (e) =>
    updateDictionary(d.id, { enabled: (e.target as HTMLInputElement).checked }),
  );
  tr.querySelector(".del")!.addEventListener("click", async () => {
    if (!confirm(`Delete “${d.title}”? This removes its data.`)) return;
    await deleteDictionary(d.id);
    await refresh();
  });
  return tr;
}

async function reorder(id: number, dir: -1 | 1) {
  const dicts = await listDictionaries();
  const i = dicts.findIndex((d) => d.id === id);
  const j = i + dir;
  if (j < 0 || j >= dicts.length) return;
  await updateDictionary(dicts[i].id, { order: j });
  await updateDictionary(dicts[j].id, { order: i });
  await refresh();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

main();
