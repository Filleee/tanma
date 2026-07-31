import type { ManifestV3 } from "./common/types";

// Authored as a typed object; emitted to dist/manifest.json by the vite plugin.
export const manifest: ManifestV3 = {
  manifest_version: 3,
  name: "TANMA!",
  version: "0.1.0",
  description:
    "In-page learning subtitle overlay & subtitle browser for any video. Japanese-first (furigana + word lookups).",
  // The overlay logic loads on every page via a tiny ESM loader.
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["content-loader.js"],
      run_at: "document_idle",
      // Runs in sub-frames too: some players host the <video> in a nested cross-origin
      // iframe. Only the top frame + frames that actually contain a video boot the full
      // app (see content/main.ts); the rest just relay cross-frame messages.
      all_frames: true,
    },
    {
      // Runs in the page's MAIN world to read YouTube's caption tracks.
      matches: ["*://*.youtube.com/*"],
      js: ["assets/youtube.js"],
      run_at: "document_start",
      world: "MAIN",
      all_frames: false,
    },
  ],
  background: {
    service_worker: "assets/background.js",
    type: "module",
  },
  action: {
    default_title: "TANMA!",
    default_popup: "popup.html",
  },
  options_ui: {
    page: "options.html",
    open_in_tab: true,
  },
  permissions: ["storage"],
  host_permissions: [
    "https://jisho.org/*",
    "https://*.wiktionary.org/*",
    "https://assets.languagepod101.com/*",
    "https://translate.google.com/*",
    // machine translation for the secondary line (Google keyless / DeepL)
    "https://translate.googleapis.com/*",
    "https://api-free.deepl.com/*",
    "https://api.deepl.com/*",
    // dictionary downloads (catalog): GitHub release + raw hosts
    "https://github.com/*",
    "https://*.githubusercontent.com/*",
    // "update available" check — the repo's latest release via the GitHub API
    "https://api.github.com/*",
    // AnkiConnect (sentence mining → Anki) runs locally
    "http://127.0.0.1:8765/*",
    "http://localhost:8765/*",
    // needed for tabs.captureVisibleTab (mining screenshots)
    "<all_urls>",
  ],
  web_accessible_resources: [
    {
      matches: ["<all_urls>"],
      resources: ["assets/*", "dict/*", "fonts/*"],
      use_dynamic_url: false,
    },
  ],
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
};
