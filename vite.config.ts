import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { cpSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { manifest } from "./src/manifest";

const root = dirname(fileURLToPath(import.meta.url));
const r = (...p: string[]) => resolve(root, ...p);

// Emits manifest.json and copies the kuromoji dictionary into dist/dict.
function extensionAssets(): Plugin {
  return {
    name: "tnm-extension-assets",
    apply: "build",
    closeBundle() {
      const out = r("dist");
      mkdirSync(out, { recursive: true });
      writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2));

      // Bundle the IPADIC dictionary kuromoji needs (served as web-accessible resources).
      const dictSrc = r("node_modules", "kuromoji", "dict");
      if (existsSync(dictSrc)) {
        cpSync(dictSrc, resolve(out, "dict"), { recursive: true });
      } else {
        this.warn("kuromoji dict not found — Japanese tokenization will not work.");
      }
    },
  };
}

export default defineConfig({
  // Resolve Node's `path` (used by kuromoji's loader) to a URL-safe browser shim.
  resolve: {
    alias: { path: r("src/shims/path.ts") },
  },
  define: {
    // kuromoji / zlibjs occasionally probe for a CommonJS-ish global.
    global: "globalThis",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
    minify: false, // readable output; this is a study/clone project
    sourcemap: true,
    rollupOptions: {
      input: {
        content: r("src/content/main.ts"),
        background: r("src/background/main.ts"),
        youtube: r("src/inject/youtube.ts"),
        popup: r("src/popup/popup.ts"),
        options: r("src/pages/options/options.ts"),
        player: r("src/pages/player/player.ts"),
        reader: r("src/pages/reader/reader.ts"),
      },
      output: {
        format: "es",
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/chunk-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  plugins: [extensionAssets()],
});
