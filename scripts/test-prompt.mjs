// Unit tests for lib/prompt (the mined-line translation prompt + output cleaning).
// Run: node scripts/test-prompt.mjs
import * as esbuild from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { code } = await esbuild.transform(await readFile(resolve(root, "src/lib/prompt.ts"), "utf8"), {
  loader: "ts",
  format: "esm",
});
const dir = await mkdtemp(join(tmpdir(), "tnm-prompt-"));
const mod = join(dir, "prompt.mjs");
await writeFile(mod, code);
const { CANNED_PROMPT, renderPrompt, sanitizeTranslation } = await import(pathToFileURL(mod).href);

let failures = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}`);
  if (!ok) {
    console.log("     got :", JSON.stringify(got));
    console.log("     want:", JSON.stringify(want));
    failures++;
  }
};
const ok = (name, cond) => {
  console.log(`${cond ? "  ✅" : "  ❌"} ${name}`);
  if (!cond) failures++;
};

const VARS = {
  sentence: "今<b>踏み出した</b>。",
  context: "→ 今踏み出した。",
  word: "踏み出す",
  title: "Some Stream",
  target_lang: "Japanese",
  native_lang: "English",
};

console.log("\nrenderPrompt");
{
  eq("substitutes every placeholder", renderPrompt("{word}|{title}|{target_lang}", VARS), "踏み出す|Some Stream|Japanese");
  eq("keeps the sentence markup intact", renderPrompt("{sentence}", VARS), "今<b>踏み出した</b>。");
  eq("unknown placeholders are left visible", renderPrompt("{nope}", VARS), "{nope}");
  const filled = renderPrompt(CANNED_PROMPT, VARS);
  ok("canned prompt leaves no {placeholder} behind", !/\{(sentence|context|word|title|target_lang|native_lang)\}/.test(filled));
  ok("canned prompt carries the bolded line through", filled.includes("今<b>踏み出した</b>。"));
}

console.log("\nCANNED_PROMPT content");
{
  for (const k of ["sentence", "context", "word", "title", "target_lang", "native_lang"]) {
    ok(`mentions {${k}}`, CANNED_PROMPT.includes("{" + k + "}"));
  }
  ok("tells the model to carry HTML tags across", /Carry over any HTML tags/i.test(CANNED_PROMPT));
  ok("forbids Markdown", /Markdown/i.test(CANNED_PROMPT));
  ok("has the names rule", /NAME \(person, place/i.test(CANNED_PROMPT));
}

console.log("\nsanitizeTranslation");
{
  eq("markdown bold becomes <b>", sanitizeTranslation("it **depends** on it"), "it <b>depends</b> on it");
  eq("underscore bold becomes <b>", sanitizeTranslation("it __depends__ on it"), "it <b>depends</b> on it");
  eq("keeps a real <b> span", sanitizeTranslation("it <b>depends</b> on it"), "it <b>depends</b> on it");
  eq("strips other tags", sanitizeTranslation("<p>hello <i>there</i></p>"), "hello there");
  eq("strips wrapping quotes", sanitizeTranslation('"just this"'), "just this");
  eq("strips code fences", sanitizeTranslation("```\njust this\n```"), "just this");
  eq("strips a labelled fence", sanitizeTranslation("```text\njust this\n```"), "just this");
  eq("drops a bold spanning the whole line", sanitizeTranslation("<b>everything bolded</b>"), "everything bolded");
  eq("collapses newlines to one line", sanitizeTranslation("two\nlines"), "two lines");
  eq("empty stays empty", sanitizeTranslation("   "), "");
}

console.log(failures === 0 ? "\nPROMPT: ALL TESTS PASS ✅" : `\n${failures} TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
