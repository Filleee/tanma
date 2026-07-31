declare module "kuromoji" {
  export interface IpadicFeatures {
    word_id: number;
    word_type: string;
    word_position: number;
    surface_form: string;
    pos: string;
    pos_detail_1: string;
    pos_detail_2: string;
    pos_detail_3: string;
    conjugated_type: string;
    conjugated_form: string;
    basic_form: string;
    reading?: string;
    pronunciation?: string;
  }
  export interface Tokenizer {
    tokenize(text: string): IpadicFeatures[];
  }
  export interface TokenizerBuilder {
    build(callback: (err: Error | null, tokenizer: Tokenizer) => void): void;
  }
  const kuromoji: {
    builder(option: { dicPath: string }): TokenizerBuilder;
  };
  export default kuromoji;
}

declare module "kuromoji/src/loader/DictionaryLoader.js" {
  export default class DictionaryLoader {
    constructor(dicPath: string);
    loadArrayBuffer(url: string, callback: (err: unknown, buffer: ArrayBuffer | null) => void): void;
    load(callback: (err: unknown, dic: unknown) => void): void;
  }
}

declare module "kuromoji/src/Tokenizer.js" {
  import type { IpadicFeatures } from "kuromoji";
  export default class Tokenizer {
    constructor(dic: unknown);
    tokenize(text: string): IpadicFeatures[];
  }
}
