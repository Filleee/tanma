// Thin AnkiConnect client. Runs in the BACKGROUND service worker so the request
// Origin is the extension's (one entry to whitelist in AnkiConnect's
// webCorsOriginList) and so it uses the extension's host_permissions.
//
// AnkiConnect listens on http://127.0.0.1:8765 and answers {result, error}.

const ANKI_URL = "http://127.0.0.1:8765";

export interface MediaFile {
  filename: string;
  /** base64 (no data: prefix). */
  dataBase64: string;
}

export interface AddCardPayload {
  deck: string;
  model: string;
  fields: Record<string, string>;
  media: MediaFile[];
  tags: string[];
}

async function invoke<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ANKI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: 6, params }),
    });
  } catch {
    throw new Error("Can't reach Anki. Make sure Anki is open with the AnkiConnect add-on installed.");
  }
  const json = (await res.json()) as { result: T; error: string | null };
  if (json.error) throw new Error(json.error);
  return json.result;
}

/** Connection probe — returns the AnkiConnect version, or throws a friendly error. */
export function version(): Promise<number> {
  return invoke<number>("version");
}

export function deckNames(): Promise<string[]> {
  return invoke<string[]>("deckNames");
}
export function modelNames(): Promise<string[]> {
  return invoke<string[]>("modelNames");
}
export function modelFieldNames(modelName: string): Promise<string[]> {
  return invoke<string[]>("modelFieldNames", { modelName });
}

/**
 * Store all media, then add the note. Fields are filtered to the ones the model
 * actually has (so lapis vs lapis-simplified naming differences don't error).
 * Returns the new note id. Throws "duplicate" if Anki rejects it as a dupe.
 */
export async function addCard(payload: AddCardPayload): Promise<number> {
  const { deck, model, fields, media, tags } = payload;

  const have = new Set(await modelFieldNames(model));
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (have.has(k)) filtered[k] = v;
  if (Object.keys(filtered).length === 0) {
    throw new Error(`None of the lapis fields exist on note type "${model}". Check the note-type name.`);
  }

  for (const m of media) {
    await invoke("storeMediaFile", { filename: m.filename, data: m.dataBase64 });
  }

  try {
    return await invoke<number>("addNote", {
      note: {
        deckName: deck,
        modelName: model,
        fields: filtered,
        tags,
        options: { allowDuplicate: false, duplicateScope: "deck" },
      },
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/duplicate/i.test(msg)) throw new Error("duplicate");
    throw e;
  }
}

/** Generic proxy for the options page (deckNames/modelNames/modelFieldNames/version). */
export function proxy(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return invoke(action, params);
}
