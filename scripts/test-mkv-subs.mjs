// Unit test for the embedded-subtitle extractor (lib/parsers/mkv). Builds a minimal in-memory
// MKV with one Japanese ASS subtitle track + 2 cues and checks extraction + reconstruction.
// Run: node scripts/test-mkv-subs.mjs
import * as esbuild from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { code } = await esbuild.transform(await readFile(resolve(root, "src/lib/parsers/mkv.ts"), "utf8"), { loader: "ts", format: "esm" });
const f = join(await mkdtemp(join(tmpdir(), "tnm-mkv-")), "mkv.mjs");
await writeFile(f, code);
const { extractMkvSubtitles, pickBestSubtitleTrack } = await import(pathToFileURL(f).href);

// ---- tiny EBML encoder ----
const enc = (s) => new TextEncoder().encode(s);
const cat = (...a) => { const arrs = a.map((x) => (x instanceof Uint8Array ? x : new Uint8Array(x))); const n = arrs.reduce((s, x) => s + x.length, 0); const out = new Uint8Array(n); let o = 0; for (const x of arrs) { out.set(x, o); o += x.length; } return out; };
function vint(n) { let len = 1; while (n > Math.pow(2, 7 * len) - 2) len++; const b = new Uint8Array(len); let v = n; for (let i = len - 1; i >= 0; i--) { b[i] = v & 0xff; v = Math.floor(v / 256); } b[0] |= 0x80 >> (len - 1); return b; }
function uintB(n) { if (n === 0) return new Uint8Array([0]); const b = []; let v = n; while (v > 0) { b.unshift(v & 0xff); v = Math.floor(v / 256); } return new Uint8Array(b); }
const el = (id, data) => cat(new Uint8Array(id), vint(data.length), data);
function block(track, rel, payload) { return cat(vint(track), new Uint8Array([(rel >> 8) & 0xff, rel & 0xff, 0x00]), enc(payload)); }

const assHeader =
  "[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname\nStyle: Default,Arial\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

const trackEntry = el([0xae], cat(
  el([0xd7], uintB(1)),               // TrackNumber 1
  el([0x83], uintB(0x11)),            // TrackType 17 (subtitle)
  el([0x86], enc("S_TEXT/ASS")),      // CodecID
  el([0x63, 0xa2], enc(assHeader)),   // CodecPrivate (ASS header)
  el([0x22, 0xb5, 0x9c], enc("jpn")), // Language
));
const tracks = el([0x16, 0x54, 0xae, 0x6b], trackEntry);
const info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], uintB(1_000_000))); // TimestampScale 1ms

const cluster = el([0x1f, 0x43, 0xb6, 0x75], cat(
  el([0xe7], uintB(0)), // cluster Timecode 0
  el([0xa0], cat(el([0xa1], block(1, 0, "0,0,Default,,0,0,0,,こんにちは")), el([0x9b], uintB(2000)))),    // cue @0s, 2s
  el([0xa0], cat(el([0xa1], block(1, 2500, "0,0,Default,,0,0,0,,さようなら")), el([0x9b], uintB(1500)))), // cue @2.5s, 1.5s
));

const ebmlHeader = el([0x1a, 0x45, 0xdf, 0xa3], enc("dummy")); // skipped by the parser
const segment = el([0x18, 0x53, 0x80, 0x67], cat(info, tracks, cluster));
const mkv = cat(ebmlHeader, segment);

let failures = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "  ✅" : "  ❌"} ${n}${extra ? "  " + extra : ""}`); if (!ok) failures++; };

const result = await extractMkvSubtitles(new Blob([mkv]));
check("found one embedded subtitle track", result.length === 1, `(${result.length})`);
const t = result[0];
check("track language is jpn", t?.lang === "jpn", `(${t?.lang})`);
check("track format is ass", t?.ext === "ass", `(${t?.ext})`);
check("two cues extracted", t?.cueCount === 2, `(${t?.cueCount})`);

const text = t?.toText() ?? "";
check("keeps the ASS header (Events section)", /\[Events\]/.test(text));
check("first cue: text + timing", text.includes("Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,こんにちは"), `\n--- reconstructed ---\n${text}`);
check("second cue: offset start + duration", text.includes("Dialogue: 0,0:00:02.50,0:00:04.00,Default,,0,0,0,,さようなら"));

check("pickBestSubtitleTrack returns the jpn track", pickBestSubtitleTrack(result)?.lang === "jpn");

console.log(failures === 0 ? "\nMKV SUBTITLE EXTRACTION: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
