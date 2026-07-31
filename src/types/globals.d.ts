// Minimal Intl.Segmenter typing (avoids depending on a specific TS lib build).
declare namespace Intl {
  type SegmenterGranularity = "grapheme" | "word" | "sentence";
  interface SegmenterOptions {
    granularity?: SegmenterGranularity;
    localeMatcher?: "best fit" | "lookup";
  }
  interface SegmentData {
    segment: string;
    index: number;
    input: string;
    isWordLike?: boolean;
  }
  interface Segments {
    [Symbol.iterator](): IterableIterator<SegmentData>;
    containing(index?: number): SegmentData;
  }
  class Segmenter {
    constructor(locales?: string | string[], options?: SegmenterOptions);
    segment(input: string): Segments;
    resolvedOptions(): { locale: string; granularity: SegmenterGranularity };
  }
}
