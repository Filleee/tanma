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

/** One note as returned by AnkiConnect's `notesInfo`. */
interface NoteInfo {
  noteId: number;
  fields: Record<string, { value: string; order: number }>;
}

/** Escape a value for use inside an Anki search query (wildcards + quoting). */
function ankiEscape(s: string): string {
  return s.replace(/[\\"*_]/g, "\\$&");
}

/** Normalise a Sentence field for equality: drop tags (our <b> bolding), decode
 *  &nbsp;, collapse whitespace. So the SAME line re-mined counts as a duplicate
 *  regardless of where the word got bolded, while a NEW line does not. */
function normSentence(s: string | undefined): string {
  return (s ?? "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/** Kiku aggregates sibling notes sharing one Expression into its multi-sentence
 *  ("1/3") nav, so — unlike lapis — a word may legitimately have many notes. For
 *  Kiku we therefore allow duplicate Expressions but still block re-mining the
 *  identical sentence, deduping on Expression+Sentence ourselves (Anki's built-in
 *  check only looks at the first field, so it can't express this). */
async function isSameWordAndSentence(deck: string, expression: string, sentence: string): Promise<boolean> {
  if (!expression) return false;
  const query = `"deck:${ankiEscape(deck)}" "Expression:${ankiEscape(expression)}"`;
  const ids = await invoke<number[]>("findNotes", { query });
  if (!ids.length) return false;
  const infos = await invoke<NoteInfo[]>("notesInfo", { notes: ids });
  const incoming = normSentence(sentence);
  return infos.some((n) => normSentence(n.fields.Sentence?.value) === incoming);
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
 * Returns the new note id. Throws "duplicate" for a note already in the deck —
 * by Expression for lapis, or by Expression+Sentence for Kiku (which keeps one
 * note per sentence so its multi-sentence card can aggregate them).
 */
export async function addCard(payload: AddCardPayload): Promise<number> {
  const { deck, model, fields, media, tags } = payload;

  const have = new Set(await modelFieldNames(model));
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (have.has(k)) filtered[k] = v;
  if (Object.keys(filtered).length === 0) {
    throw new Error(`None of the lapis fields exist on note type "${model}". Check the note-type name.`);
  }

  // Kiku's multi-sentence cards want one note per (word, sentence), so allow a
  // repeated Expression there and enforce Expression+Sentence uniqueness ourselves.
  // Every other note type (lapis) keeps Anki's one-note-per-word (first-field) check.
  const isKiku = /kiku/i.test(model);
  if (isKiku && (await isSameWordAndSentence(deck, fields.Expression ?? "", fields.Sentence ?? ""))) {
    throw new Error("duplicate");
  }

  // Kiku renders SelectionText as the FIRST definition page, ahead of MainDefinition. We fill it
  // with just the surface word — already the Expression and the bolded word in Sentence — so it's a
  // redundant page that buries the definition. Drop it for Kiku so Main Definition → Glossary leads.
  // (lapis keeps SelectionText: it's used differently there.)
  if (isKiku) delete filtered.SelectionText;

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
        options: { allowDuplicate: isKiku, duplicateScope: "deck" },
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
