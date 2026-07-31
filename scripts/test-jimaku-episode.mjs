// Unit test for Jimaku episode heuristics (lib/jimaku/episode).
// Run: node scripts/test-jimaku-episode.mjs
import * as esbuild from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { code } = await esbuild.transform(await readFile(resolve(root, "src/lib/jimaku/episode.ts"), "utf8"), { loader: "ts", format: "esm" });
const f = join(await mkdtemp(join(tmpdir(), "tnm-ep-")), "episode.mjs");
await writeFile(f, code);
const { episodeFromUrl, episodeFromFilename, isBatchFile, bestEpisodeFile, searchAttempts } = await import(pathToFileURL(f).href);

let failures = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}  → ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
};

console.log("episodeFromUrl:");
eq("miruro ?ep=12", episodeFromUrl("https://www.miruro.to/watch/202381/killed-again-mr-detective?ep=12"), 12);
eq("?episode=3", episodeFromUrl("https://example.com/anime/foo?episode=3&autoplay=1"), 3);
eq("path /episode-7", episodeFromUrl("https://site.tv/show/episode-7"), 7);
eq("path /ep/24", episodeFromUrl("https://site.tv/anime/x/ep/24"), 24);
eq("no episode in url", episodeFromUrl("https://site.tv/anime/some-show"), undefined);
eq("bad url", episodeFromUrl("not a url"), undefined);

console.log("\nepisodeFromFilename:");
eq("E12 marker", episodeFromFilename("[Group] Show Title - E12 [1080p].srt"), 12);
eq("Ep. 05", episodeFromFilename("Show Name Ep. 05.ass"), 5);
eq("Episode 8", episodeFromFilename("Some Anime Episode 8.srt"), 8);
eq("bare - 12", episodeFromFilename("Serial Experiments Lain - 12.srt"), 12);
eq("#7", episodeFromFilename("Title #7.ass"), 7);
eq("ignores 1080p resolution", episodeFromFilename("[Sub] Cool Show 03 [1080p].srt"), 3);
eq("ignores year, takes ep", episodeFromFilename("Show (2024) - 06.srt"), 6);
eq("batch → null", episodeFromFilename("Show Complete Batch (01-24).srt"), null);

console.log("\nisBatchFile:");
eq("batch file", isBatchFile("Show Complete Batch.srt"), true);
eq("season file", isBatchFile("Show Season 1 [all].srt"), true);
eq("single episode not batch", isBatchFile("Show - E12.srt"), false);

console.log("\nbestEpisodeFile:");
const files = [
  { name: "[GroupA] Show - 04 [1080p].ass" },
  { name: "[GroupB] Show - 04 [720p].srt" }, // .srt preferred among ep-4 matches
  { name: "[GroupC] Show - 05.srt" },
  { name: "Show Complete (01-12).zip" }, // not a sub
];
eq("picks the .srt match for ep 4", bestEpisodeFile(files, 4)?.name, "[GroupB] Show - 04 [720p].srt");
eq("no match for ep 9 → null", bestEpisodeFile(files, 9), null);
eq("no episode + many subs → null (ambiguous)", bestEpisodeFile(files, null), null);
eq("no episode + single sub → that sub", bestEpisodeFile([{ name: "Only File E01.srt" }], null)?.name, "Only File E01.srt");

console.log("\nsearchAttempts (order: anilist_id → titles → page title):");
eq(
  "id first, then titles, deduped",
  searchAttempts({ anilistId: 202381, titles: ["Mata Korosarete", "Matakoro", "Mata Korosarete"], title: "Killed Again" }),
  [{ anilistId: 202381 }, { query: "Mata Korosarete" }, { query: "Matakoro" }, { query: "Killed Again" }],
);
eq("no id → titles only", searchAttempts({ titles: ["Romaji Name"], title: "Page Title" }), [{ query: "Romaji Name" }, { query: "Page Title" }]);

console.log(failures === 0 ? "\nJIMAKU EPISODE HEURISTICS: WORKING ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
