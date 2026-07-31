# TANMA!

An in-page **learning subtitle** system for any video. Whenever there's a `<video>`, TANMA!
overlays its own **learning subtitles**, a **subtitle browser**, a **controls toolbar**,
**click/hover-to-look-up words**, and **one-click sentence mining to Anki**.

It's a self-contained **Manifest V3** extension, **Japanese-first**: real morphological
tokenization with **furigana**, dictionary-form word lookups, and mining into the
**lapis-simplified** Anki note type via **AnkiConnect** — cards go to *your own* local Anki
(no cloud account or sync).

---

## Features

### Overlay & words
- **Subtitle overlay** over any `<video>`: a target-language line + optional translation line,
  draggable, with outline/plate styling that reads over any footage. Scales with the video and
  follows it into **fullscreen** — and into windowed **"theater"/wide** players (e.g. miruro): the
  player shrinks left so the subtitle browser sits beside it instead of covering it.
- **Word tokens** (the `tnm-token` model):
  - Japanese → **kuromoji** (IPADIC). Conjugations are merged into one clickable word with its
    lemma (食べさせられた → 食べる; 勉強したくない → 勉強), and **furigana** is rendered okurigana-aware
    (おも over 思 only, in 思う).
  - Chinese / Korean → the browser's `Intl.Segmenter`; space-delimited languages split on words.
  - Each word is colored by **known status** (Unknown / Learning / Known); **mined** words get a dot.

### Looking words up
- **Hold-to-look-up (Yomitan-style, default key `Alt`)** — hold the key and hover:
  - over the **start of a word** → looks up the whole word;
  - **further into a word** → scans forward to the next word boundary and grabs that sub-piece
    (hover 疲 in お疲れ様 → 疲れ), with a highlight box showing exactly what's grabbed;
  - **hold + drag-select** → looks up the exact selected span.
- **Click a word** always looks up the whole word; **click it again to dismiss** the look-up (an
  optional always-on hover is in Settings).
- **Definition card**: the word with okurigana furigana + a separate **"Selected"** line for the
  conjugated form you hovered, one-click **Known / Learning / Unknown**, a **🔊 pronounce** button
  (human recordings from JapanesePod101 → Google neural TTS → speech synthesis), frequency badges,
  kanji, and Jitendex **structured-content** definitions. Entries are ordered the Yomitan way —
  real expression-matches first, then the **in-context reading** (港→こう vs みなと), then
  priority/score — so the relevant sense leads.
- **Dictionaries** — the options page has a **one-click download catalog** (Jitendex, JMnedict,
  KANJIDIC, JPDB & BCCWJ frequency) plus **import** for any Yomitan `.zip`; stored in IndexedDB for
  **offline, instant** lookups (a section per dictionary, merged + scrollable). Online **Jisho** (JA)
  / **Wiktionary** (others) are appended after the instant offline results.

### Sentence mining → Anki
- A **＋** button on the look-up card mines the word to **Anki via AnkiConnect**, into the
  **lapis-simplified** note type (fields per animecards.site). Auto-captured:
  - **Expression / ExpressionReading** (lemma + reading), **Sentence** (with the word bolded),
  - **MainDefinition** (one dictionary) + **Glossary** (all dictionaries, in Yomitan's exact
    structure so the deck's template formats/de-dups them),
  - **Picture** — a still **JPG** screenshot (cropped to the video, downscaled) or an optional
    looping **clip**; **SentenceAudio** + **ExpressionAudio** as **MP3** (transcoded so they play on
    **iOS / AnkiMobile**), frequency, and misc (title · timestamp · URL).
- **Mined tracking** — mined **lines** show a ✓ in the subtitle browser and mined **words** get a
  marker. **Backfill** the markers from an existing deck with **Options → Sync mined from deck**
  (reads each note's Expression + Sentence via AnkiConnect).

### Browser, controls & sources
- **Subtitle browser** side panel: every line, click to seek (respects the timing offset), search
  filter, ⭐ bookmarks, ✓ mined markers, auto-scroll to the current line, hover/drag look-up.
- **Controls toolbar** (docked across the top, auto-hides): play/pause, prev / replay / next line,
  a **timing offset** (− / + nudge + an editable box, ±60s — full slider in Settings),
  hide-subtitles (listening mode), **import**, **🔎 Jimaku**, settings, known-word count.
- **Pause modes**: **pause each line** (auto-resume after N seconds), or **pause on look-up** —
  the video pauses only when you actually look a word up (browsing/scrolling the list doesn't
  pause it) and resumes when you close the look-up.
- **Subtitle sources**:
  - **YouTube** — automatic (enables the target-language captions itself, intercepts the caption
    data, hides the native rendering, and can auto-translate the second line).
  - **Jimaku** — searches **jimaku.cc** and loads a `.srt`/`.ass` (paste your free API key in
    Options). With **Auto-load** on (Options → Jimaku, default on), it **loads subs automatically**
    on an anime page — and again when you switch episodes — by detecting the show (an AniList/MAL
    link in the page, or the AniList id in the URL path like miruro's `/watch/202381/…`) and the
    **episode from the URL** (`?ep=12`). It searches by AniList id, then falls back to the show's
    **romaji/Japanese titles** (what Jimaku indexes — English titles rarely match), and **auto-picks**
    the best file for that episode. The **🔎** toolbar button opens the panel to search manually,
    override the episode, **↻** re-detect, or switch release.
  - **Anything else** — **import** your own `.srt` / `.vtt` / `.ass/.ssa` from the toolbar.
- **Local player**: open it from the popup (**Local media player → Open**) for a
  full-page player — **drag-and-drop a video/audio file + a subtitle file** (or use the pickers) and
  get the exact same overlay, look-ups, browser, and mining. It has a **custom (Netflix-style)
  control bar** — scrubber, play/skip ±10s, volume, time, fullscreen — plus keyboard shortcuts
  (`space` play, `←/→` seek, `↑/↓` volume, `m` mute, `f` fullscreen). Plays anything the browser
  supports (mp4/webm/ogg/mov, mp3/m4a/wav). Drop an **`.mkv`** and its **embedded subtitle tracks
  are extracted automatically** (ASS/SRT/VTT) — the best (Japanese preferred) loads, and a **track
  selector** in the bar lets you switch between them. That works even when the video itself can't
  play (10-bit/HEVC), so you can still load the subs. **Fullscreen** fullscreens the whole page so
  the subtitles + browser stay on top. Files stay local (never uploaded).

### Settings, keybindings & scope
- **Settings** (gear): target/translation language, subtitle size / shadow / background plate,
  timing offset (slider **or type an exact value**, ±60s), furigana, translation, known-status
  coloring, hover look-up, pause modes, blur/hide reveal.
- **Timing offset** also lives in the toolbar: **−/+** nudge by 0.1s, or **type a precise value**
  in the box (±60s). It's saved per-video.
- **Dashboard** (popup → **Dashboard & settings → Open**): a tabbed page. The **Overview** has
  stats (known/learning/mined words, dictionaries), a **getting-started checklist**, **recently
  mined** activity, an **Appearance** accent-colour picker (recolours the overlay, dashboard, popup
  and player), a **per-site settings** list (reset a site's overrides), **activation rules** (limit
  the overlay to real video pages — e.g. `youtube.com` → only `/watch`, `/shorts/`, so it doesn't
  show on the home/feed), **Backup & restore** (export/import your data to another browser since
  Chrome local storage isn't synced), and a **Danger zone** to reset all data. Plus tabs for
  **Dictionaries**, **Anki mining**, **Look-up & keys**, and **Jimaku**. Deep-linkable via `#anki` etc.
- **Scoping**: the timing **offset is per-video**; the toolbar + subtitle-display options are
  **per-site** (e.g. youtube.com vs miruro.tv); Anki/dictionary/keybinding config is **global**.

Everything persists via `chrome.storage` (+ IndexedDB for imported dictionaries).

---

## Build & load

```bash
cd project
npm install
npm run build      # outputs the unpacked extension into project/dist
```

Then in Chrome (or any Chromium browser):

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the **`project/dist`** folder.
4. (Optional) For the local test page over `file://`, open the extension's **Details** and enable
   **Allow access to file URLs**.

`npm run dev` rebuilds on change (then hit the ⟳ reload button on the extension card).

To mine to Anki: open Anki with the **AnkiConnect** add-on, install the **lapis-simplified** note
type, and in **Options → Anki** add this extension's origin to AnkiConnect's `webCorsOriginList`
(the **Test connection** button prints the exact value).

### Try it

- **YouTube:** open any video that has captions — subtitles load automatically.
- **Local test:** `npx serve project/test`, open the printed URL, click the toolbar's **⬆ import**,
  choose `project/test/sample.ja.srt`, and press play.

### Automated tests

End-to-end (Playwright, real Chromium, new headless) + pure unit checks:

| Script | Checks |
| --- | --- |
| `scripts/e2e.mjs` | import SRT → overlay tokens + furigana + lookup popup |
| `scripts/e2e-browser-lookup.mjs` | hold-key hover look-up in the browser, popup placement |
| `scripts/e2e-drag-select.mjs` | Alt-drag span + Alt-hover forward sub-piece + highlight |
| `scripts/e2e-player.mjs` | local TANMA! player: drop video + subtitle → overlay + cues; .mkv embedded-sub extraction |
| `scripts/e2e-dashboard.mjs` | dashboard tabs + overview stats/checklist + backup export + activation editor |
| `scripts/e2e-activation.mjs` | per-host activation rules gate the overlay (hidden off-`/watch`) |
| `scripts/test-mkv-subs.mjs` | MKV/EBML embedded-subtitle extractor (parse + ASS reconstruction) |
| `scripts/e2e-jimaku.mjs` | Jimaku panel + search proxy + search-box key isolation |
| `scripts/e2e-jimaku-detect.mjs` | Jimaku auto-detect: AniList link + `?ep=` → episode field + auto-search |
| `scripts/test-jimaku-episode.mjs` | episode parsing from URLs and filenames (unit) |
| `scripts/e2e-dict.mjs` / `e2e-dict-real.mjs` | dictionary import + lookup (synthetic / real JMdict) |
| `scripts/e2e-toolbar.mjs` | docked toolbar geometry + auto-hide |
| `scripts/e2e-anki-button.mjs` | ＋ mine button gating |
| `scripts/test-*.mjs` | tokenizer merge, furigana split, settings scope, mined store, anki fields, align, youtube |

`npm run typecheck` type-checks the whole project.

---

## Architecture

A small, dependency-light TypeScript app built around a Shadow-DOM overlay with its own class
names (`TnmSubs`, `tnm-token`, `TnmBrowser`, `TnmBar`, `data-tnm-known-status`, …):

| Area | How it's done |
| --- | --- |
| Content-script injection | tiny `content-loader.js` dynamic-imports the ESM bundle |
| Overlay isolation | Shadow DOM host, reparented into the fullscreen element |
| Japanese tokenizer | `kuromoji` (IPADIC) + conjugation-merge; dict shipped as web-accessible resources |
| CJK fallback | `Intl.Segmenter` |
| Dictionaries | imported Yomitan `.zip` → IndexedDB (offline); Jisho / Wiktionary online |
| Card creation | AnkiConnect → lapis-simplified (text + screenshot/clip + MP3 audio) |
| Storage | `chrome.storage.local` — per-site & global settings, per-video offset, known words, mined set, bookmarks |

### Source layout

```
src/
  manifest.ts            generated → dist/manifest.json
  common/types.ts        shared domain types + default settings
  lib/
    parsers/             srt / vtt / ass / youtube(json3,srv3) + secondary-line align
    tokenizer/           japanese (kuromoji) + jaMerge (conjugation merge) + Intl.Segmenter
    kana.ts              katakana→hiragana + okurigana-aware furigana splitting
    storage.ts           settings (per-site/global), per-video offset, known-words, mined store
    yomitan/             imported-dictionary engine: parse banks + IndexedDB + lookup
    anki/                AnkiConnect client + lapis-simplified field mapping
  pages/options/         dictionaries, Anki mining, look-up & keybindings, Jimaku key
  content/
    main.ts              entry (top-frame guard)
    app.ts               controller: sync loop, look-up, pause, mining, YouTube, import, Jimaku
    videoManager.ts      finds/tracks the primary <video>
    mp3.ts               webm/opus → MP3 transcode (lamejs) for iOS-playable card audio
    ui/                  ShadowHost, TnmSubs, TnmBar, SettingsPanel, TnmBrowser,
                         JimakuPanel, LookupPopup, token renderer, css
  inject/youtube.ts      MAIN-world: reads/translates YouTube caption tracks → postMessage
  background/main.ts     dictionary lookups + word audio + AnkiConnect proxy/mine + Jimaku proxy
  popup/                 toolbar popup (per-site enable + language + help)
```

---

## Limitations / notes

- **YouTube auto-enables its own captions.** YouTube returns HTTP 403 for direct caption downloads
  (a player-generated token is required), so the extension turns on YouTube's captions for your
  target language, piggy-backs on that request, then hides the native rendering. You may briefly see
  YouTube's captions before the overlay takes over.
- **Netflix / Crunchyroll / Disney+ etc. are not hooked** (DRM-obfuscated streams, out of scope).
  Use YouTube, Jimaku, or import a file.
- **Sentence/word look-up vs Yomitan**: kuromoji segments morphemes (with a conjugation merge), not
  Yomitan's rule-based deinflection + longest dictionary match. They agree for most words; the
  hold-key sub-piece scan grabs by morpheme boundary (no dictionary deinflection yet).
- **Mined-clip on mobile**: the still-image Picture + MP3 audio play on iOS; the *optional animated
  clip* is webm (desktop-only).
- Online lookups need network. Japanese uses **Jisho** (JMdict); others use **Wiktionary**.
- The first Japanese line triggers a one-time **kuromoji dictionary load** (~a few MB); words are
  clickable without furigana until it finishes, then it re-renders.
- A study tool — no cloud SRS/account/sync; cards go to your own local Anki.
```

## License

GPL-3.0-or-later. TANMA! is and will stay free software: use it, read it, fork it —
derivatives must remain free under the same terms. (GPL also lets the project adapt
code from other GPL tools in this space, like Yomitan and Textractor.)
