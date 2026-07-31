// Unit tests for parseLrc (lib/parsers/lrc) + guessSong (lib/lyrics/song).
// Run: node scripts/test-lrc.mjs
import * as esbuild from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), "tnm-lrc-"));
async function load(rel, name) {
  const { code } = await esbuild.transform(await readFile(resolve(root, rel), "utf8"), { loader: "ts", format: "esm" });
  const p = join(dir, name);
  await writeFile(p, code);
  return import(pathToFileURL(p).href);
}
const { parseLrc } = await load("src/lib/parsers/lrc.ts", "lrc.mjs");
const { guessSong } = await load("src/lib/lyrics/song.ts", "song.mjs");

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "OK " : "XX "} ${name}${ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
};

// --- parseLrc ---
const lrc = [
  "[ti:せかいのしくみ]",
  "[ar:Guiano]",
  "[length:03:43]",
  "[00:40.59] 戦争は無くならないし",
  "[00:46.58] 音楽は世界変えられやしないし",
  "[00:51.61] じゃあ",
].join("\n");
const cues = parseLrc(lrc);
check("metadata lines skipped, 3 cues parsed", cues.length, 3);
check("first cue start = 40.59", cues[0].start, 40.59);
check("first cue text", cues[0].text, "戦争は無くならないし");
check("cue end = next start (capped)", cues[0].end, 46.58);
check("cues sorted & monotonic", cues.every((c, i) => i === 0 || c.start >= cues[i - 1].start), true);
check("last cue has a tail end > start", cues[2].end > cues[2].start, true);

// repeated tags on one line → one cue each
const rep = parseLrc("[00:10.00][01:20.00] リフレイン");
check("repeated time tags → 2 cues", rep.length, 2);
check("repeated tag texts equal", rep[0].text === rep[1].text && rep[0].text === "リフレイン", true);

// no timestamps → nothing
check("plain text (no tags) → 0 cues", parseLrc("ただの歌詞\nもう一行").length, 0);

// --- guessSong ---
check("Artist - Track", guessSong("Guiano - せかいのしくみ"), { artistName: "Guiano", trackName: "せかいのしくみ", query: "Guiano - せかいのしくみ" });
check("strips (Official Music Video)", guessSong("YOASOBI - アイドル (Official Music Video)").trackName, "アイドル");
check("Artist「Track」", (() => { const g = guessSong("米津玄師「Lemon」"); return [g.artistName, g.trackName]; })(), ["米津玄師", "Lemon"]);
check("Track / Artist (JP MV order)", (() => { const g = guessSong("KICK BACK ／ 米津玄師"); return [g.trackName, g.artistName]; })(), ["KICK BACK", "米津玄師"]);
check("bracket 【MV】 stripped", /MV/.test(guessSong("【MV】曲名 - アーティスト").query), false);

console.log(failures === 0 ? "\nLRC + SONG: ALL PASSING" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
