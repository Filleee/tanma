# TANMA! — documentation site

A small, self-contained marketing/documentation web page for **TANMA!**, the in-page
learning-subtitle browser extension (this lives in the `web_doc/` folder of the extension repo).

It covers: what TANMA is, why to use it, its features, how to use it, the companion
plugins (tanma-asr, tanma-hook), and how to get started.

## View it

No build step, no dependencies — it's plain HTML/CSS/JS. Just open the file:

```
# from this folder
open index.html          # macOS
start index.html         # Windows
xdg-open index.html      # Linux
```

or serve the folder if you prefer a local server:

```
python -m http.server 8080
# then visit http://localhost:8080
```

## Deploy it

Because it's static, drop the whole `webdoc-project/` folder onto any static host —
GitHub Pages, Netlify, Cloudflare Pages, etc. `index.html` is the entry point.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page content (all sections). |
| `styles.css` | Styling — dark theme matching TANMA's palette (accent `#ff9345`). |
| `script.js` | Mobile-nav toggle + active-section highlight (progressive enhancement; the page works without JS). |
| `assets/` | The TANMA mascot (used as the logo) and favicon, copied from the extension's icons. |

## Notes

- The UI "screenshots" (the look-up popup, mining queue, toolbar) are reproduced in
  **HTML/CSS** rather than captured images, so the site stays crisp at any size and has
  no external image dependencies. To use real screenshots instead, drop PNGs into
  `assets/` and swap the corresponding mockup blocks in `index.html`.
- The mascot art comes from the extension's own icon set (`project/public/icons`).
- Content is accurate as of this repo's current state; update the Features / Plugins
  sections if the extension gains or loses capabilities.
