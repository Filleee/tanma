// Pure-Node unit tests for the YouTube caption cleaning/de-dup pipeline.
// Compiles src/lib/parsers/youtube.ts with esbuild (the DOM-free core: json3
// parse + clean + merge) and asserts against realistic noisy fixtures.
// Run: node scripts/test-youtube.mjs
import * as esbuild from "esbuild";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = resolve(root, "src/lib/parsers/youtube.ts");

// Transform the TS module to ESM (type-only imports are erased; DOMParser is
// only referenced inside the srv3/xml fns, which we don't call here).
const { code } = await esbuild.transform(await (await import("node:fs/promises")).readFile(src, "utf8"), {
  loader: "ts",
  format: "esm",
});
const dir = await mkdtemp(join(tmpdir(), "tnm-yt-"));
const file = join(dir, "youtube.mjs");
await writeFile(file, code);
const { parseYoutubeJson3, parseYoutubeTimedText, __test } = await import(pathToFileURL(file).href);

let failures = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}`);
  if (!ok) {
    console.log("     got :", JSON.stringify(got));
    console.log("     want:", JSON.stringify(want));
    failures++;
  }
};
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✅" : "  ❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};
const ev = (tStartMs, dDurationMs, ...utf8s) => ({ tStartMs, dDurationMs, segs: utf8s.map((utf8) => ({ utf8 })) });
const texts = (cues) => cues.map((c) => c.text);

console.log("cleanText");
eq("decodes numeric + named entities", __test.cleanText("Tom&#39;s &amp; Jerry&#39;s"), "Tom's & Jerry's");
eq("strips markup tags", __test.cleanText("<font color=\"red\">hello</font> <b>world</b>"), "hello world");
eq("removes bidi/zero-width marks", __test.cleanText("‫مرحبا‬‎"), "مرحبا");
eq("collapses whitespace + newlines", __test.cleanText("  foo \n  bar   baz "), "foo bar baz");
eq("hex entity for a music note survives as a glyph", __test.cleanText("&#x266a;"), "♪");

console.log("\nendsWithDelimiter");
ok("sentence end (。)", __test.endsWithDelimiter("これは本です。") === true);
ok("fully bracketed unit", __test.endsWithDelimiter("[音楽]") === true);
ok("mid-sentence fragment is not complete", __test.endsWithDelimiter("これは") === false);

console.log("\njoinFragments (CJK-aware)");
eq("no space between Japanese fragments", __test.joinFragments("日本語を", "勉強する"), "日本語を勉強する");
eq("space between English words", __test.joinFragments("hello", "world"), "hello world");

console.log("\nparseYoutubeJson3 — manual (clean line-level) track");
{
  const cues = parseYoutubeJson3({
    events: [ev(1000, 4000, "日本語を勉強しています"), ev(5000, 4000, "今日はいい天気ですね")],
  });
  eq("kept verbatim, ids reassigned", texts(cues), ["日本語を勉強しています", "今日はいい天気ですね"]);
  ok("timing preserved", cues[0].start === 1 && cues[0].end === 5);
}

console.log("\nparseYoutubeJson3 — ASR rolling-window duplication");
{
  // The two-line scroller re-emits the same line a moment later. Should collapse.
  const cues = parseYoutubeJson3({
    events: [
      ev(1000, 2000, "今日は"),
      ev(3000, 3000, "今日は"), // repeat within 5s of prior end → merge, extend end
      ev(6000, 2000, "いい天気ですね"),
    ],
  });
  eq("duplicate line collapsed", texts(cues), ["今日は", "いい天気ですね"]);
  ok("end extended over the duplicate", cues[0].end === 6, `(end=${cues[0].end})`);
}

console.log("\nparseYoutubeJson3 — word segs are concatenated, not space-joined");
{
  const cues = parseYoutubeJson3({ events: [ev(0, 3000, "魚", "釣り", "に", "行き", "ましょう")] });
  eq("Japanese segs joined without spaces", texts(cues), ["魚釣りに行きましょう"]);
}
{
  const cues = parseYoutubeJson3({ events: [ev(0, 3000, "we", " are", " going")] });
  eq("English segs keep their embedded spaces", texts(cues), ["we are going"]);
}

console.log("\nparseYoutubeJson3 — overlapping (rolling) durations are trimmed to next start");
{
  // Each line's duration overruns the next (YouTube's rolling display). After
  // trimming, cues are back-to-back so the active cue tracks the speech.
  const cues = parseYoutubeJson3({
    events: [
      ev(0, 6000, "あさ"), // 0–6 overruns the next
      ev(3000, 6000, "ひる"), // 3–9 overruns the next
      ev(6000, 3000, "よる"), // 6–9
    ],
  });
  eq("ends trimmed to next start (no overlap)", cues.map((c) => [c.start, c.end]), [
    [0, 3],
    [3, 6],
    [6, 9],
  ]);
}

console.log("\nparseYoutubeJson3 — noise filtering");
{
  const cues = parseYoutubeJson3({
    events: [
      ev(0, 2000, "♪"), // pure music note → dropped
      ev(0, 10, "\n"), // append-window artifact → empty → dropped
      ev(2000, 2000, "[音楽]"), // bracketed sound cue → kept (matches TANMA!)
      ev(4000, 2000, "Tom&#39;s line"), // entity decoded
    ],
  });
  eq("music notes/empties dropped, brackets kept, entities decoded", texts(cues), ["[音楽]", "Tom's line"]);
}

console.log("\nparseYoutubeJson3 — same-span fragments merged unless complete");
{
  const cues = parseYoutubeJson3({
    events: [
      // two positioned fragments sharing one time span → join (prev not complete)
      ev(0, 3000, "これは"),
      { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: "本です。" }] },
      // a complete line then another at the same span → NOT merged
      { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: "おわり。" }] },
      { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: "次へ" }] },
    ],
  });
  eq("incomplete fragments glued, complete ones kept apart", texts(cues), ["これは本です。", "おわり。", "次へ"]);
}

console.log("\nnormaliseAllCaps");
{
  const caps = [
    { id: 0, start: 0, end: 1, text: "HELLO THERE" },
    { id: 1, start: 1, end: 2, text: "HOW ARE YOU" },
    { id: 2, start: 2, end: 3, text: "FINE THANKS" },
  ];
  eq("English ALL CAPS → sentence case", texts(__test.normaliseAllCaps(caps, "en")), ["Hello there", "How are you", "Fine thanks"]);
  eq("Japanese left untouched (no letter case)", texts(__test.normaliseAllCaps([{ id: 0, start: 0, end: 1, text: "ですね" }], "ja")), ["ですね"]);
  const mixed = [
    { id: 0, start: 0, end: 1, text: "hello there" },
    { id: 1, start: 1, end: 2, text: "HOW ARE YOU" },
  ];
  eq("below threshold → untouched", texts(__test.normaliseAllCaps(mixed, "en")), ["hello there", "HOW ARE YOU"]);
}

console.log("\nparseYoutubeTimedText — format detection");
{
  const json = JSON.stringify({ events: [ev(1000, 2000, "テスト")] });
  eq("detects + parses json3", texts(parseYoutubeTimedText(json)), ["テスト"]);
  eq("empty body → no cues", parseYoutubeTimedText(""), []);
}

console.log("\nASR regroup (stable-ts style merge_by_gap)");
{
  // Word-level fragments running straight on → one speech unit.
  const frags = [
    { id: 0, start: 0.0, end: 0.4, text: "いや" },
    { id: 1, start: 0.4, end: 0.8, text: "でも" },
    { id: 2, start: 0.8, end: 1.6, text: "難易度" },
    { id: 3, start: 1.6, end: 2.2, text: "による" },
  ];
  eq("fragments with no pause merge into one cue", texts(__test.mergeByGap(frags)), ["いやでも難易度による"]);

  // A clear silence is a sentence break.
  const withPause = [
    { id: 0, start: 0.0, end: 0.4, text: "そうですね" },
    { id: 1, start: 3.0, end: 3.5, text: "じゃあ" },
    { id: 2, start: 3.5, end: 4.0, text: "行こう" },
  ];
  eq("a real pause splits the run", texts(__test.mergeByGap(withPause)), ["そうですね", "じゃあ行こう"]);

  ok("punctuated track detected (left to the sentence path)", __test.isPunctuated([{ id: 0, start: 0, end: 1, text: "行こう。" }]));
  ok("unpunctuated ASR detected", !__test.isPunctuated(frags));
  ok("CJK costs more time per char than Latin", __test.spokenSeconds("難易度") > __test.spokenSeconds("abc"));

  // Caps keep a cue minable even when the speaker never pauses.
  const many = [];
  for (let i = 0; i < 80; i++) many.push({ id: i, start: i * 0.2, end: i * 0.2 + 0.2, text: "あ" });
  ok("length/duration cap breaks an endless run", __test.mergeByGap(many).length > 1);

  // End-to-end: unpunctuated json3 fragments come out as one speech unit.
  eq(
    "json3 ASR fragments regroup end-to-end",
    texts(parseYoutubeJson3({ events: [ev(0, 400, "いや"), ev(400, 400, "でも"), ev(800, 800, "難易度")] })),
    ["いやでも難易度"],
  );
}

console.log(failures === 0 ? "\nYOUTUBE PARSER: ALL TESTS PASS ✅" : `\n${failures} TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
