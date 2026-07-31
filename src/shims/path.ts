// Minimal browser shim for Node's `path`, aliased in vite.config.ts.
// kuromoji's DictionaryLoader only uses `path.join` to build dictionary URLs.
// The real POSIX join collapses the `//` in `chrome-extension://`, which breaks
// the URL — this join preserves protocol-style prefixes.
export function join(...parts: string[]): string {
  return parts
    .filter((p) => p != null && p !== "")
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .join("/");
}

export default { join };
