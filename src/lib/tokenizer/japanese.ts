import type { IpadicFeatures } from "kuromoji";
import DictionaryLoader from "kuromoji/src/loader/DictionaryLoader.js";
import Tokenizer from "kuromoji/src/Tokenizer.js";
import type { Token } from "../../common/types";
import { mergeJapaneseFeatures } from "./jaMerge";

interface KuroTokenizer {
  tokenize(text: string): IpadicFeatures[];
}

let instance: KuroTokenizer | null = null;
let building: Promise<KuroTokenizer> | null = null;

/** Gunzip with the browser-native DecompressionStream (no zlibjs dependency). */
async function gunzip(buffer: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Response(buffer).body!.pipeThrough(new DecompressionStream("gzip"));
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}

/**
 * kuromoji's bundled loader decompresses .dat.gz with zlibjs, whose CommonJS
 * shape doesn't survive ESM bundling. We subclass the base loader and override
 * only the fetch+gunzip step to use fetch + DecompressionStream instead.
 */
class FetchDictionaryLoader extends DictionaryLoader {
  loadArrayBuffer(url: string, callback: (err: unknown, buffer: ArrayBuffer | null) => void): void {
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`dict ${res.status}: ${url}`);
        return res.arrayBuffer();
      })
      .then(gunzip)
      .then((u8) => callback(null, u8.buffer as ArrayBuffer))
      .catch((err) => callback(err, null));
  }
}

export function isJapaneseReady(): boolean {
  return instance !== null;
}

/** Lazily build the kuromoji tokenizer from the bundled IPADIC dictionary. */
export function ensureJapanese(): Promise<KuroTokenizer> {
  if (instance) return Promise.resolve(instance);
  if (building) return building;

  const dicPath =
    typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL("dict/")
      : "dict/";

  building = new Promise<KuroTokenizer>((resolve, reject) => {
    const loader = new FetchDictionaryLoader(dicPath);
    loader.load((err: unknown, dic: unknown) => {
      if (err) {
        building = null;
        reject(err);
        return;
      }
      instance = new Tokenizer(dic) as KuroTokenizer;
      resolve(instance);
    });
  });
  return building;
}

export function tokenizeJapanese(text: string): Token[] {
  if (!instance) throw new Error("Japanese tokenizer not ready");
  // Merge each verb/adjective/suru-verb with its inflection tail into one token.
  return mergeJapaneseFeatures(instance.tokenize(text));
}
