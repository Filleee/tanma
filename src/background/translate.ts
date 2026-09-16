// Machine translation for the secondary subtitle line. Runs in the background service worker
// so fetches use the extension's host_permissions (no page CORS) and the DeepL key never
// reaches the page. Provider + key come from the saved settings, so the content script only
// has to send the text it wants translated.

const SETTINGS_KEY = "tnm:settings";

type Provider = "google" | "deepl";

// `${provider}|${from}|${to}|${text}` → translation. In-memory for the worker's lifetime;
// losing it on a worker restart just means re-translating, which is harmless.
const cache = new Map<string, string>();
const MAX_CACHE = 5000;

function remember(key: string, value: string): void {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
}

async function providerSettings(force?: Provider): Promise<{ provider: Provider; key: string }> {
  try {
    const all = await chrome.storage.local.get(SETTINGS_KEY);
    const s = (all[SETTINGS_KEY] ?? {}) as { mtProvider?: Provider; mtApiKey?: string };
    return { provider: force ?? (s.mtProvider === "deepl" ? "deepl" : "google"), key: s.mtApiKey ?? "" };
  } catch {
    return { provider: force ?? "google", key: "" };
  }
}

/** Translate `texts` from → to. `force` overrides the configured provider (mined-card path). */
export async function translateText(texts: string[], from: string, to: string, force?: Provider): Promise<string[]> {
  const { provider, key } = await providerSettings(force);
  const out = new Array<string>(texts.length).fill("");
  const todo: { i: number; text: string }[] = [];
  texts.forEach((raw, i) => {
    const text = (raw ?? "").trim();
    if (!text) return;
    const hit = cache.get(`${provider}|${from}|${to}|${text}`);
    if (hit != null) out[i] = hit;
    else todo.push({ i, text });
  });
  if (!todo.length) return out;

  const inputs = todo.map((t) => t.text);
  const results = provider === "deepl" ? await deepl(inputs, from, to, key) : await google(inputs, from, to);
  todo.forEach((t, k) => {
    const translated = results[k] ?? "";
    out[t.i] = translated;
    if (translated) remember(`${provider}|${from}|${to}|${t.text}`, translated);
  });
  return out;
}

// ---- Google's keyless web endpoint — one request per line, with light concurrency ----
async function google(texts: string[], from: string, to: string): Promise<string[]> {
  const sl = from || "auto";
  const one = async (q: string): Promise<string> => {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t" +
      `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(to)}&q=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
    const data = (await res.json()) as [Array<[string]>];
    return (data[0] || []).map((seg) => seg[0]).join("");
  };
  return mapLimit(texts, 5, one);
}

// ---- DeepL (API key; free keys end in ":fx" and use the api-free host) ----
async function deepl(texts: string[], from: string, to: string, key: string): Promise<string[]> {
  const k = key.trim();
  if (!k) throw new Error("DeepL API key not set (add it in the dashboard).");
  const host = k.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
  const body = new URLSearchParams();
  for (const t of texts) body.append("text", t);
  body.set("target_lang", deeplLang(to, true));
  const sl = deeplLang(from, false);
  if (sl) body.set("source_lang", sl);
  const res = await fetch(`${host}/v2/translate`, {
    method: "POST",
    headers: { Authorization: `DeepL-Auth-Key ${k}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`DeepL HTTP ${res.status}`);
  const data = (await res.json()) as { translations?: { text: string }[] };
  return (data.translations || []).map((t) => t.text);
}

/** Map our BCP-47-ish codes to DeepL's. Targets may be regional (EN-US); sources must be base (EN). */
function deeplLang(code: string, target: boolean): string {
  const base = (code || "").toLowerCase().split("-")[0];
  if (!base) return "";
  if (target) {
    const regional: Record<string, string> = { en: "EN-US", pt: "PT-PT" };
    return (regional[base] ?? base).toUpperCase();
  }
  return base.toUpperCase();
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
