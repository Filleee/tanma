import type { Token } from "../../common/types";
import { katakanaToHiragana } from "../kana";

/** The subset of kuromoji's IpadicFeatures the merge logic needs (kept minimal so this
 *  module is pure + unit-testable without the kuromoji runtime). */
export interface JaFeature {
  surface_form: string;
  pos: string;
  pos_detail_1: string;
  basic_form: string;
  reading?: string;
}

/** IPADIC part-of-speech (Japanese) → short English label. */
const POS_MAP: Record<string, string> = {
  名詞: "noun",
  動詞: "verb",
  形容詞: "i-adjective",
  形容動詞: "na-adjective",
  副詞: "adverb",
  助詞: "particle",
  助動詞: "auxiliary",
  連体詞: "adnominal",
  接続詞: "conjunction",
  感動詞: "interjection",
  記号: "symbol",
  接頭詞: "prefix",
  フィラー: "filler",
  その他: "other",
};

/**
 * Morphemes that continue an inflected word rather than starting a new one:
 *  - 助動詞 (auxiliaries: た, ない, ます, たい, だ, です…)
 *  - 動詞,接尾 / 動詞,非自立 (suffix + subsidiary verbs: させ, られ, and the て-form
 *    helpers いる/いく/くる/みる/しまう…)
 *  - the conjunctive particle て / で (the te-form join)
 */
function isInflectionTail(f: JaFeature): boolean {
  if (f.pos === "助動詞") return true;
  if (f.pos === "動詞" && (f.pos_detail_1 === "接尾" || f.pos_detail_1 === "非自立")) return true;
  if (f.pos === "助詞" && f.pos_detail_1 === "接続助詞" && (f.surface_form === "て" || f.surface_form === "で")) return true;
  return false;
}

function readingOf(f: JaFeature): string {
  return f.reading && f.reading !== "*" ? f.reading : f.surface_form;
}

function groupToToken(group: JaFeature[]): Token {
  const head = group[0];
  const surface = group.map((g) => g.surface_form).join("");
  const reading = katakanaToHiragana(group.map(readingOf).join(""));
  const posJa = head.pos ?? "";
  const pos = POS_MAP[posJa] ?? posJa;
  const isSymbol = posJa === "記号";
  // Lemma = the head's dictionary form (食べる for 食べさせられた; 勉強 for 勉強した — the
  // noun, which is what JMdict/Jitendex key suru-verbs under).
  const dict = head.basic_form && head.basic_form !== "*" ? head.basic_form : head.surface_form;
  return {
    surface,
    reading,
    dict,
    pos,
    isWord: !isSymbol && /\S/.test(surface) && !/^[、。「」『』（）()・\s]+$/.test(surface),
  };
}

/**
 * Merge kuromoji morphemes into clickable "words": a verb / i-adjective (or a
 * サ変接続 noun + する) plus its full trailing inflection becomes ONE token whose
 * `dict` is the lemma — so 食べさせられた → 食べる and 勉強したくない → 勉強, mirroring
 * what Yomitan grabs for a single deinflectable word. Compounds the dictionary
 * splits (e.g. 自動販売機) are left as-is; merging those needs dictionary access,
 * which this pure pass deliberately avoids.
 */
export function mergeJapaneseFeatures(feats: JaFeature[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < feats.length; ) {
    const head = feats[i];
    const group: JaFeature[] = [head];
    i++;

    const inflectableHead = (head.pos === "動詞" || head.pos === "形容詞") && head.pos_detail_1 === "自立";
    const next = feats[i];
    const suruNounHead =
      head.pos === "名詞" && head.pos_detail_1 === "サ変接続" &&
      !!next && next.pos === "動詞" && (next.basic_form === "する" || next.basic_form === "為る");

    if (suruNounHead) {
      group.push(next); // the する verb
      i++;
    }
    if (inflectableHead || suruNounHead) {
      while (i < feats.length && isInflectionTail(feats[i])) {
        group.push(feats[i]);
        i++;
      }
    }
    out.push(groupToToken(group));
  }
  return out;
}
