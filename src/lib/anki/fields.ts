// Maps mined data onto the lapis-simplified note type (AnimeCards fields).
// Pure + DOM-free so it can be unit-tested in Node.

/** Everything gathered for one mined card (media are pre-stored filenames). */
export interface MineInput {
  /** Dictionary form → Expression. */
  word: string;
  /** Reading in kana → ExpressionReading. */
  reading: string;
  /** Surface form as it appeared → SelectionText, and bolded inside Sentence. */
  surface: string;
  /** The subtitle line the word came from (raw). */
  sentence: string;
  /** Top gloss → MainDefinition. */
  definition: string;
  /** Full glossary (HTML or text) → Glossary. */
  glossary: string;
  /** Frequency display (e.g. "JPDB: 1234") → Frequency. */
  frequency: string;
  /** Harmonic frequency rank (number-ish) → FreqSort. */
  freqSort: string;
  /** Pitch-accent positions → PitchPosition. */
  pitchPosition: string;
  /** Pitch-accent categories → PitchCategories. */
  pitchCategories: string;
  /** Title · timestamp · url → MiscInfo. */
  misc: string;
  /** Stored media filenames (already in Anki's collection.media). */
  wordAudioFilename?: string;
  sentenceAudioFilename?: string;
  pictureHtml?: string; // full <img>/<video> markup for the Picture field
}

/** Wrap the first occurrence of `surface` in the sentence with <b> (cloze body). */
export function boldSentence(sentence: string, surface: string): string {
  const clean = (sentence ?? "").replace(/\s+/g, " ").trim();
  if (!surface) return clean;
  const i = clean.indexOf(surface);
  if (i < 0) return clean;
  return `${clean.slice(0, i)}<b>${surface}</b>${clean.slice(i + surface.length)}`;
}

/**
 * Build the lapis-simplified field map. Field names follow the AnimeCards lapis
 * template (minus the furigana/boolean fields the "simplified" fork removed).
 * Background filters this to the fields the user's note type actually has.
 */
export function buildLapisFields(input: MineInput): Record<string, string> {
  return {
    Expression: input.word,
    ExpressionReading: input.reading,
    ExpressionAudio: input.wordAudioFilename ? `[sound:${input.wordAudioFilename}]` : "",
    SelectionText: input.surface,
    MainDefinition: input.definition,
    Sentence: boldSentence(input.sentence, input.surface),
    SentenceAudio: input.sentenceAudioFilename ? `[sound:${input.sentenceAudioFilename}]` : "",
    Picture: input.pictureHtml ?? "",
    Glossary: input.glossary,
    PitchPosition: input.pitchPosition,
    PitchCategories: input.pitchCategories,
    Frequency: input.frequency,
    FreqSort: input.freqSort,
    MiscInfo: input.misc,
  };
}
