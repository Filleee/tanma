// Japanese pitch-accent helpers: mora splitting, high/low pattern from a downstep
// position, and the standard category names. Pure — unit-tested in Node.

/** Split a kana reading into moras: small ゃゅょ (etc.) attach to the previous kana;
 *  ー and っ are their own moras. */
export function moraSplit(reading: string): string[] {
  const out: string[] = [];
  for (const ch of reading) {
    if (/[ゃゅょぁぃぅぇぉャュョァィゥェォヮゎ]/.test(ch) && out.length) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/** High/low per mora for a downstep position (Yomitan/NHK convention):
 *  0 = heiban (LHHH…), 1 = atamadaka (HLLL…), k = rise then drop after mora k. */
export function pitchPattern(position: number, moraCount: number): boolean[] {
  const highs: boolean[] = [];
  for (let i = 1; i <= moraCount; i++) {
    if (position === 0) highs.push(i !== 1);
    else if (position === 1) highs.push(i === 1);
    else highs.push(i !== 1 && i <= position);
  }
  return highs;
}

export function pitchCategory(position: number, moraCount: number): string {
  if (position === 0) return "heiban";
  if (position === 1) return "atamadaka";
  if (position === moraCount) return "odaka";
  return "nakadaka";
}

/** The lapis/AnimeCards card fields for a set of accent positions. */
export function pitchFields(positions: number[], reading: string): { position: string; categories: string } {
  const moras = moraSplit(reading).length;
  const uniq = [...new Set(positions)];
  return {
    position: uniq.map((p) => `[${p}]`).join(""),
    categories: [...new Set(uniq.map((p) => pitchCategory(p, moras)))].join(","),
  };
}
