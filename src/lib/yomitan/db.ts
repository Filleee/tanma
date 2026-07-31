import type {
  DictionaryMeta,
  FreqRecord,
  KanjiRecord,
  PitchRecord,
  TagRecord,
  TermRecord,
} from "./types";

// Lives in the extension origin's IndexedDB, so the options page (which imports)
// and the background service worker (which looks up) share the same database.

const DB_NAME = "tnm-dictionaries";
const DB_VERSION = 2;

const STORE_DICTS = "dictionaries";
const STORE_TERMS = "terms";
const STORE_FREQ = "termMeta";
const STORE_PITCH = "pitch";
const STORE_KANJI = "kanji";
const STORE_TAGS = "tags";
const STORE_MEDIA = "media"; // dictionary-bundled images for structured content (added in DB v2)

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DICTS)) {
        db.createObjectStore(STORE_DICTS, { keyPath: "id", autoIncrement: true });
      }
      const withDictIndex = (name: string, indexes: [string, string | string[]][]) => {
        const store = db.createObjectStore(name, { keyPath: "_id", autoIncrement: true });
        store.createIndex("dictId", "dictId", { unique: false });
        for (const [iname, keyPath] of indexes) store.createIndex(iname, keyPath as string, { unique: false });
      };
      if (!db.objectStoreNames.contains(STORE_TERMS)) withDictIndex(STORE_TERMS, [["expression", "expression"], ["reading", "reading"]]);
      if (!db.objectStoreNames.contains(STORE_FREQ)) withDictIndex(STORE_FREQ, [["expression", "expression"]]);
      if (!db.objectStoreNames.contains(STORE_PITCH)) withDictIndex(STORE_PITCH, [["expression", "expression"]]);
      if (!db.objectStoreNames.contains(STORE_KANJI)) withDictIndex(STORE_KANJI, [["character", "character"]]);
      if (!db.objectStoreNames.contains(STORE_TAGS)) withDictIndex(STORE_TAGS, []);
      if (!db.objectStoreNames.contains(STORE_MEDIA)) withDictIndex(STORE_MEDIA, [["path", "path"]]);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------- import API

export async function createDictionary(meta: Omit<DictionaryMeta, "id">): Promise<number> {
  const db = await openDb();
  const tx = db.transaction(STORE_DICTS, "readwrite");
  const id = (await reqP(tx.objectStore(STORE_DICTS).add(meta as any))) as number;
  return id;
}

export async function updateDictionary(id: number, patch: Partial<DictionaryMeta>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_DICTS, "readwrite");
  const store = tx.objectStore(STORE_DICTS);
  const cur = (await reqP(store.get(id))) as DictionaryMeta | undefined;
  if (!cur) return;
  store.put({ ...cur, ...patch, id });
  await txDone(tx);
}

type StoreName =
  | typeof STORE_TERMS
  | typeof STORE_FREQ
  | typeof STORE_PITCH
  | typeof STORE_KANJI
  | typeof STORE_TAGS;

/** Insert records in chunks so we never hold one giant transaction. */
export async function bulkPut(
  store: StoreName,
  records: object[],
  onProgress?: (done: number, total: number) => void,
  chunkSize = 2000,
): Promise<void> {
  const db = await openDb();
  for (let i = 0; i < records.length; i += chunkSize) {
    const slice = records.slice(i, i + chunkSize);
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    for (const rec of slice) os.put(rec);
    await txDone(tx);
    onProgress?.(Math.min(i + chunkSize, records.length), records.length);
  }
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------- manage API

export async function listDictionaries(): Promise<DictionaryMeta[]> {
  const db = await openDb();
  const all = (await reqP(db.transaction(STORE_DICTS).objectStore(STORE_DICTS).getAll())) as DictionaryMeta[];
  return all.sort((a, b) => a.order - b.order);
}

export async function deleteDictionary(id: number): Promise<void> {
  const db = await openDb();
  for (const store of [STORE_TERMS, STORE_FREQ, STORE_PITCH, STORE_KANJI, STORE_TAGS]) {
    // delete in chunks via the dictId index
    // eslint-disable-next-line no-await-in-loop
    await deleteByDictId(db, store, id);
  }
  const tx = db.transaction(STORE_DICTS, "readwrite");
  tx.objectStore(STORE_DICTS).delete(id);
  await txDone(tx);
  tagCache.clear();
}

function deleteByDictId(db: IDBDatabase, store: string, dictId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const idx = tx.objectStore(store).index("dictId");
    const cursorReq = idx.openCursor(IDBKeyRange.only(dictId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------- lookup API

async function enabledOrder(): Promise<Map<number, { order: number; title: string }>> {
  const dicts = await listDictionaries();
  const m = new Map<number, { order: number; title: string }>();
  for (const d of dicts) if (d.enabled) m.set(d.id, { order: d.order, title: d.title });
  return m;
}

async function getAllByIndex(store: string, index: string, key: string): Promise<any[]> {
  const db = await openDb();
  return reqP(db.transaction(store).objectStore(store).index(index).getAll(IDBKeyRange.only(key)));
}

/** Look up term entries matching any of the given keys (by expression or reading). */
export async function lookupTerms(keys: string[]): Promise<{ enabled: Map<number, { order: number; title: string }>; terms: TermRecord[] }> {
  const enabled = await enabledOrder();
  if (enabled.size === 0) return { enabled, terms: [] };
  const uniq = [...new Set(keys.filter(Boolean))];
  const seen = new Set<string>();
  const terms: TermRecord[] = [];
  for (const key of uniq) {
    for (const idx of ["expression", "reading"]) {
      // eslint-disable-next-line no-await-in-loop
      const rows = (await getAllByIndex(STORE_TERMS, idx, key)) as TermRecord[];
      for (const r of rows) {
        if (!enabled.has(r.dictId)) continue;
        const sig = `${r.dictId}:${r.expression}:${r.reading}:${r.sequence}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        terms.push(r);
      }
    }
  }
  return { enabled, terms };
}

/** Store one dictionary-bundled media file (image referenced by structured content). */
export async function putMedia(dictId: number, path: string, type: string, data: ArrayBuffer): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_MEDIA, "readwrite");
  tx.objectStore(STORE_MEDIA).put({ dictId, path, type, data });
  await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}

/** A dictionary image as a data: URL (null when absent). */
export async function getMediaDataUrl(dictId: number, path: string): Promise<string | null> {
  const rows = (await getAllByIndex(STORE_MEDIA, "path", path)) as { dictId: number; type: string; data: ArrayBuffer }[];
  const hit = rows.find((r) => r.dictId === dictId);
  if (!hit) return null;
  let bin = "";
  const bytes = new Uint8Array(hit.data);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${hit.type};base64,${btoa(bin)}`;
}

/** Pitch-accent records for any of the given written forms (enabled dicts only). */
export async function lookupPitch(keys: string[]): Promise<PitchRecord[]> {
  const enabled = await enabledOrder();
  if (enabled.size === 0) return [];
  const out: PitchRecord[] = [];
  const seen = new Set<string>();
  for (const key of [...new Set(keys.filter(Boolean))]) {
    // eslint-disable-next-line no-await-in-loop
    const rows = (await getAllByIndex(STORE_PITCH, "expression", key)) as PitchRecord[];
    for (const r of rows) {
      if (!enabled.has(r.dictId)) continue;
      const sig = `${r.dictId}:${r.expression}:${r.reading}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(r);
    }
  }
  return out;
}

/** Which of these expressions have at least one entry in an enabled dictionary?
 *  Used for dictionary-assisted token merging (魔+族 -> 魔族). */
export async function expressionsExist(exprs: string[]): Promise<{ expression: string; reading: string }[]> {
  const enabled = await enabledOrder();
  if (enabled.size === 0) return [];
  const out: { expression: string; reading: string }[] = [];
  for (const e of [...new Set(exprs.filter(Boolean))]) {
    // eslint-disable-next-line no-await-in-loop
    const rows = ((await getAllByIndex(STORE_TERMS, "expression", e)) as TermRecord[])
      .filter((r) => enabled.has(r.dictId))
      .sort((a, b) => b.score - a.score);
    if (rows.length) out.push({ expression: e, reading: rows[0].reading ?? "" });
  }
  return out;
}

export async function lookupFrequencies(keys: string[]): Promise<FreqRecord[]> {
  const enabled = await enabledOrder();
  if (enabled.size === 0) return [];
  const uniq = [...new Set(keys.filter(Boolean))];
  const seen = new Set<string>();
  const out: FreqRecord[] = [];
  for (const key of uniq) {
    // eslint-disable-next-line no-await-in-loop
    const rows = (await getAllByIndex(STORE_FREQ, "expression", key)) as FreqRecord[];
    for (const r of rows) {
      if (!enabled.has(r.dictId)) continue;
      const sig = `${r.dictId}:${r.expression}:${r.reading}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(r);
    }
  }
  return out;
}

export async function lookupKanji(chars: string[]): Promise<KanjiRecord[]> {
  const enabled = await enabledOrder();
  if (enabled.size === 0) return [];
  const uniq = [...new Set(chars.filter((c) => /[一-龯㐀-䶿]/.test(c)))];
  const out: KanjiRecord[] = [];
  for (const c of uniq) {
    // eslint-disable-next-line no-await-in-loop
    const rows = (await getAllByIndex(STORE_KANJI, "character", c)) as KanjiRecord[];
    for (const r of rows) if (enabled.has(r.dictId)) out.push(r);
  }
  return out;
}

// tag resolution (cached per dictionary)
const tagCache = new Map<number, Map<string, TagRecord>>();
export async function getTagsForDict(dictId: number): Promise<Map<string, TagRecord>> {
  if (tagCache.has(dictId)) return tagCache.get(dictId)!;
  const db = await openDb();
  const list = (await reqP(
    db.transaction(STORE_TAGS).objectStore(STORE_TAGS).index("dictId").getAll(IDBKeyRange.only(dictId)),
  )) as TagRecord[];
  const map = new Map<string, TagRecord>();
  for (const t of list) map.set(t.name, t);
  tagCache.set(dictId, map);
  return map;
}

export const STORES = {
  TERMS: STORE_TERMS,
  FREQ: STORE_FREQ,
  PITCH: STORE_PITCH,
  KANJI: STORE_KANJI,
  TAGS: STORE_TAGS,
} as const;

export type { PitchRecord };
