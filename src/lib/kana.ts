// Japanese script helpers used for furigana display.

export function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export function hiraganaToKatakana(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

export function hasKanji(s: string): boolean {
  return /[一-龯㐀-䶿]/.test(s);
}

export function isAllKana(s: string): boolean {
  return /^[぀-ゟ゠-ヿー]+$/.test(s);
}

export function isCJK(s: string): boolean {
  return /[぀-ヿ㐀-鿿가-힯ｦ-ﾟ]/.test(s);
}

/**
 * Decide the furigana to show above a surface form, given its reading.
 * Only show it when the surface contains kanji and the reading actually differs.
 * Returns "" when no furigana is warranted.
 */
export function furiganaFor(surface: string, readingHira: string): string {
  if (!readingHira) return "";
  if (!hasKanji(surface)) return "";
  if (katakanaToHiragana(surface) === readingHira) return "";
  return readingHira;
}

export interface FuriPart {
  text: string;
  /** Furigana to show above `text` (only set for kanji runs). */
  rt?: string;
}

/**
 * Split surface + reading into furigana parts, okurigana-aware: each kanji run carries
 * just its portion of the reading in `rt`, kana stays plain (思う/おもう → [思:おも][う];
 * 持ち主/もちぬし → [持:も][ち][主:ぬし]). Falls back to one ruby over the whole surface
 * if it can't align the kana cleanly, and to plain text when there's no kanji.
 */
export function furiganaParts(surface: string, reading: string): FuriPart[] {
  if (!surface) return [];
  const rd = katakanaToHiragana(reading || "");
  if (!rd || !hasKanji(surface)) return [{ text: surface }];
  if (katakanaToHiragana(surface) === rd) return [{ text: surface }];

  // Maximal runs of kanji vs non-kanji.
  const segs: { text: string; kanji: boolean }[] = [];
  for (const ch of surface) {
    const kanji = hasKanji(ch);
    const last = segs[segs.length - 1];
    if (last && last.kanji === kanji) last.text += ch;
    else segs.push({ text: ch, kanji });
  }

  const whole: FuriPart[] = [{ text: surface, rt: rd }];
  const parts: FuriPart[] = [];
  let r = 0; // consumed position in `rd`
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg.kanji) {
      const kana = katakanaToHiragana(seg.text);
      if (rd.slice(r, r + kana.length) !== kana) return whole; // misaligned
      parts.push({ text: seg.text });
      r += kana.length;
    } else {
      const nextKana = segs[i + 1]; // runs alternate, so this is a kana run (or undefined)
      if (nextKana) {
        const target = katakanaToHiragana(nextKana.text);
        const idx = rd.indexOf(target, r);
        if (idx < 0) return whole;
        parts.push({ text: seg.text, rt: rd.slice(r, idx) });
        r = idx;
      } else {
        parts.push({ text: seg.text, rt: rd.slice(r) }); // trailing kanji takes the rest
        r = rd.length;
      }
    }
  }
  return r === rd.length ? parts : whole;
}
