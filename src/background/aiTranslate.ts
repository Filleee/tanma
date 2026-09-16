// Translation of ONE mined line, written into an Anki field (e.g. Kiku's SentenceTranslation).
//
// Deliberately separate from translate.ts (the live secondary subtitle line): that one runs on every
// line while you watch and must stay cheap, so it stays on keyless Google / DeepL. This runs once
// per mined card, so it can afford an LLM with the surrounding dialogue as context.
//
// Unlike a text hooker we hold the WHOLE subtitle track, so context can look forward as well as
// back — Japanese frequently resolves dropped subjects and referents in the following line.

import { loadSettings } from "../lib/storage";
import { CANNED_PROMPT, renderPrompt, sanitizeTranslation } from "../lib/prompt";
import { translateText } from "./translate";

const SYSTEM = "You are a precise subtitle translator. Output only the translation, nothing else.";

interface Sampling {
  temperature: number;
  maxTokens: number;
  topP: number;
}

function langName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code.split("-")[0]) || code;
  } catch {
    return code;
  }
}

async function fail(model: string, res: Response): Promise<never> {
  throw new Error(model + ": HTTP " + res.status + " " + (await res.text()).slice(0, 160));
}

async function openaiChat(base: string, key: string, model: string, user: string, o: Sampling): Promise<string> {
  const res = await fetch(base.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      temperature: o.temperature,
      max_tokens: o.maxTokens,
      top_p: o.topP,
    }),
  });
  if (!res.ok) await fail(model, res);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return j?.choices?.[0]?.message?.content ?? "";
}

async function geminiChat(key: string, model: string, user: string, o: Sampling): Promise<string> {
  const m = model.replace(/^models\//, "");
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(m) +
      ":generateContent?key=" +
      encodeURIComponent(key),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: o.temperature, maxOutputTokens: o.maxTokens, topP: o.topP },
      }),
    },
  );
  if (!res.ok) await fail(m, res);
  const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return (j?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? "").join("");
}

/** Models this key can actually call generateContent on — for the options dropdown. */
export async function listGeminiModels(key: string): Promise<string[]> {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(key));
  if (!res.ok) await fail("models", res);
  const j = (await res.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
  return (j?.models ?? [])
    .filter((m) => (m?.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => String(m?.name ?? "").replace(/^models\//, ""))
    .filter(Boolean)
    .sort();
}

export interface AiTranslateRequest {
  /** The mined line WITH its <b> around the mined surface — the model carries the tag across. */
  sentence: string;
  word: string;
  title: string;
  /** Surrounding dialogue; the line being translated is prefixed with an arrow. */
  context: string;
}

/** Translate one mined line. Returns "" when disabled or nothing usable came back. */
export async function aiTranslate(req: AiTranslateRequest): Promise<string> {
  const s = await loadSettings();
  if (!s.trEnabled || !req.sentence.trim()) return "";

  // Plain MT can follow neither a prompt nor tags — hand it the bare text.
  if (s.trProvider === "google" || s.trProvider === "deepl") {
    const plain = req.sentence.replace(/<[^>]*>/g, "");
    const [out] = await translateText([plain], s.targetLang, s.nativeLang, s.trProvider);
    return (out ?? "").trim();
  }

  const user = renderPrompt(s.trPrompt.trim() || CANNED_PROMPT, {
    sentence: req.sentence,
    context: req.context,
    word: req.word,
    title: req.title,
    target_lang: langName(s.targetLang),
    native_lang: langName(s.nativeLang),
  });
  const o: Sampling = { temperature: s.trTemperature, maxTokens: s.trMaxTokens, topP: s.trTopP };

  let out: string;
  if (s.trProvider === "gemini") {
    if (!s.trGeminiKey || !s.trGeminiModel) throw new Error("Set a Gemini model and API key first.");
    out = await geminiChat(s.trGeminiKey, s.trGeminiModel, user, o);
  } else {
    if (!s.trOpenaiUrl || !s.trOpenaiModel) throw new Error("Set an OpenAI API URL and model first.");
    try {
      out = await openaiChat(s.trOpenaiUrl, s.trOpenaiKey, s.trOpenaiModel, user, o);
    } catch (e) {
      if (!s.trOpenaiBackupModel) throw e;
      out = await openaiChat(s.trOpenaiUrl, s.trOpenaiKey, s.trOpenaiBackupModel, user, o);
    }
  }
  return sanitizeTranslation(out);
}
