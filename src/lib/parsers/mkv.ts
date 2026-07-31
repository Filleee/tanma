// Dependency-free streaming Matroska (MKV/WebM) parser that extracts embedded TEXT subtitle
// tracks (S_TEXT/ASS, S_TEXT/UTF8, S_TEXT/WEBVTT) and reconstructs them into a normal subtitle
// file. It streams the container and SKIPS the heavy audio/video block payloads, so memory
// stays tiny even for multi-GB files. Image subtitles (PGS/VobSub) are ignored — not usable here.

// ---- EBML element IDs (stored including their length-marker bits) ----
const ID = {
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMESTAMP_SCALE: 0x2ad7b1,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  LANGUAGE: 0x22b59c,
  LANGUAGE_BCP47: 0x22b59d,
  NAME: 0x536e,
  CLUSTER: 0x1f43b675,
  TIMESTAMP: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_DURATION: 0x9b,
} as const;

const MASTERS = new Set<number>([ID.SEGMENT, ID.INFO, ID.TRACKS, ID.TRACK_ENTRY, ID.CLUSTER, ID.BLOCK_GROUP]);
const TRACK_TYPE_SUBTITLE = 0x11;

export interface MkvSubtitleTrack {
  number: number;
  codecId: string;
  /** ISO-639 language tag from the track ("und" if unset). */
  lang: string;
  name: string;
  ext: "ass" | "srt" | "vtt";
  cueCount: number;
  /** Reconstruct the track as a standalone subtitle file body. */
  toText(): string;
}

interface RawCue {
  start: number; // seconds
  end: number; // seconds (-1 = unset → defaulted on output)
  payload: string;
}
interface RawTrack {
  number: number;
  type: number;
  codecId: string;
  codecPrivate: Uint8Array | null;
  /** Legacy ISO-639 Language element ("" = absent → defaults to "eng" per the Matroska spec). */
  language: string;
  /** Newer BCP-47 LanguageIETF element (takes precedence when present). */
  langIETF: string;
  lang: string; // resolved on commit
  name: string;
  cues: RawCue[];
}

function vintLen(b: number): number {
  for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1;
  return 0; // invalid first byte
}

/** A pull reader over the file's byte stream with a small sliding buffer. */
class ByteStream {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = new Uint8Array(0);
  private pos = 0;
  private done = false;
  consumed = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }
  private get avail(): number {
    return this.buf.length - this.pos;
  }
  private async pull(): Promise<boolean> {
    if (this.done) return false;
    const { value, done } = await this.reader.read();
    if (done || !value) {
      this.done = true;
      return false;
    }
    const rest = this.buf.subarray(this.pos);
    const merged = new Uint8Array(rest.length + value.length);
    merged.set(rest);
    merged.set(value, rest.length);
    this.buf = merged;
    this.pos = 0;
    return true;
  }
  async ensure(n: number): Promise<boolean> {
    while (this.avail < n) if (!(await this.pull())) return false;
    return true;
  }
  read(n: number): Uint8Array {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    this.consumed += n;
    return out;
  }
  peek(): number {
    return this.avail > 0 ? this.buf[this.pos] : -1;
  }
  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.avail === 0 && !(await this.pull())) return;
      const take = Math.min(left, this.avail);
      this.pos += take;
      this.consumed += take;
      left -= take;
    }
  }
  get atEnd(): boolean {
    return this.done && this.avail === 0;
  }

  async readId(): Promise<number | null> {
    if (!(await this.ensure(1))) return null;
    const len = vintLen(this.peek());
    if (len < 1 || len > 4 || !(await this.ensure(len))) return null;
    const bytes = this.read(len);
    let id = 0;
    for (const b of bytes) id = id * 256 + b;
    return id;
  }
  async readSize(): Promise<{ size: number; unknown: boolean } | null> {
    if (!(await this.ensure(1))) return null;
    const len = vintLen(this.peek());
    if (len < 1 || len > 8 || !(await this.ensure(len))) return null;
    const bytes = this.read(len);
    let value = bytes[0] & ((0x80 >> (len - 1)) - 1);
    for (let i = 1; i < len; i++) value = value * 256 + bytes[i];
    return { size: value, unknown: value === Math.pow(2, 7 * len) - 1 };
  }
}

const td = new TextDecoder("utf-8");
const uint = (b: Uint8Array): number => b.reduce((n, x) => n * 256 + x, 0);
const decode = (b: Uint8Array): string => td.decode(b);
function vintValue(b: Uint8Array, pos: number): { value: number; len: number } {
  const len = vintLen(b[pos]);
  let value = b[pos] & ((0x80 >> (len - 1)) - 1);
  for (let i = 1; i < len; i++) value = value * 256 + b[pos + i];
  return { value, len };
}

/** Parse an MKV/WebM blob and return its embedded text subtitle tracks. */
export async function extractMkvSubtitles(blob: Blob): Promise<MkvSubtitleTrack[]> {
  const s = new ByteStream(blob.stream() as ReadableStream<Uint8Array>);
  const stack: { id: number; end: number }[] = [];

  let timestampScale = 1_000_000; // ns per tick (default)
  let clusterTime = 0;
  const tracks = new Map<number, RawTrack>();
  let pendingTrack: RawTrack | null = null;
  let pendingCue: RawCue | null = null;

  const commitTrack = () => {
    const t = pendingTrack;
    pendingTrack = null;
    if (t && t.type === TRACK_TYPE_SUBTITLE && /^S_TEXT\//i.test(t.codecId)) {
      // Matroska: a missing Language element means English; LanguageIETF (BCP-47) wins if present.
      t.lang = t.langIETF || t.language || "eng";
      tracks.set(t.number, t);
    }
  };

  while (!s.atEnd) {
    while (stack.length && s.consumed >= stack[stack.length - 1].end) {
      const closed = stack.pop()!;
      if (closed.id === ID.TRACK_ENTRY) commitTrack();
      else if (closed.id === ID.BLOCK_GROUP) pendingCue = null;
    }

    const id = await s.readId();
    if (id === null) break;
    const sz = await s.readSize();
    if (sz === null) break;
    const dataStart = s.consumed;
    const end = sz.unknown ? Infinity : dataStart + sz.size;

    if (MASTERS.has(id)) {
      stack.push({ id, end });
      if (id === ID.TRACK_ENTRY) pendingTrack = { number: 0, type: 0, codecId: "", codecPrivate: null, language: "", langIETF: "", lang: "eng", name: "", cues: [] };
      if (id === ID.CLUSTER) clusterTime = 0;
      continue;
    }

    if (id === ID.SIMPLE_BLOCK || id === ID.BLOCK) {
      await handleBlock(sz.size);
      continue;
    }

    // Leaf elements we care about — read fully, everything else is skipped.
    if (
      id === ID.TIMESTAMP_SCALE || id === ID.TRACK_NUMBER || id === ID.TRACK_TYPE || id === ID.CODEC_ID ||
      id === ID.CODEC_PRIVATE || id === ID.LANGUAGE || id === ID.LANGUAGE_BCP47 || id === ID.NAME || id === ID.TIMESTAMP || id === ID.BLOCK_DURATION
    ) {
      if (!(await s.ensure(sz.size))) break;
      const data = s.read(sz.size);
      handleLeaf(id, data);
    } else {
      await s.skip(sz.size);
    }
  }
  // flush a final open track entry (file may end right at Tracks)
  commitTrack();

  async function handleBlock(size: number): Promise<void> {
    if (!(await s.ensure(1))) return;
    const tnLen = vintLen(s.peek());
    if (tnLen < 1 || !(await s.ensure(tnLen))) return;
    const tnBytes = s.read(tnLen);
    const { value: trackNum } = vintValue(tnBytes, 0);
    let rest = size - tnLen;
    const track = tracks.get(trackNum);
    if (!track || rest < 3 || rest > 1 << 20) {
      await s.skip(rest); // not a subtitle track (or implausibly large) → discard
      return;
    }
    if (!(await s.ensure(rest))) return;
    const body = s.read(rest);
    rest = 0;
    let rel = (body[0] << 8) | body[1];
    if (rel > 0x7fff) rel -= 0x10000;
    const flags = body[2];
    if (flags & 0x06) return; // laced subtitle block (rare) — skip
    const payload = decode(body.subarray(3)).replace(/\0+$/, "");
    const start = ((clusterTime + rel) * timestampScale) / 1e9;
    const cue: RawCue = { start, end: -1, payload };
    track.cues.push(cue);
    pendingCue = cue;
  }

  function handleLeaf(id: number, data: Uint8Array): void {
    switch (id) {
      case ID.TIMESTAMP_SCALE:
        timestampScale = uint(data) || timestampScale;
        break;
      case ID.TIMESTAMP:
        clusterTime = uint(data);
        break;
      case ID.BLOCK_DURATION:
        if (pendingCue) pendingCue.end = pendingCue.start + (uint(data) * timestampScale) / 1e9;
        break;
      case ID.TRACK_NUMBER:
        if (pendingTrack) pendingTrack.number = uint(data);
        break;
      case ID.TRACK_TYPE:
        if (pendingTrack) pendingTrack.type = uint(data);
        break;
      case ID.CODEC_ID:
        if (pendingTrack) pendingTrack.codecId = decode(data).replace(/\0+$/, "");
        break;
      case ID.CODEC_PRIVATE:
        if (pendingTrack) pendingTrack.codecPrivate = data.slice();
        break;
      case ID.LANGUAGE:
        if (pendingTrack) pendingTrack.language = decode(data).replace(/\0+$/, "");
        break;
      case ID.LANGUAGE_BCP47:
        if (pendingTrack) pendingTrack.langIETF = decode(data).replace(/\0+$/, "");
        break;
      case ID.NAME:
        if (pendingTrack) pendingTrack.name = decode(data).replace(/\0+$/, "");
        break;
    }
  }

  return [...tracks.values()].filter((t) => t.cues.length).map(toSubtitleTrack);
}

// ---- reconstruction → standalone subtitle file ----

function pad(n: number, w = 2): string {
  return Math.floor(n).toString().padStart(w, "0");
}
function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360000)}:${pad((cs / 6000) % 60)}:${pad((cs / 100) % 60)}.${pad(cs % 100)}`;
}
function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad(ms / 3600000)}:${pad((ms / 60000) % 60)}:${pad((ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}
function vttTime(sec: number): string {
  return srtTime(sec).replace(",", ".");
}
/** Split into at most `n` comma fields; the last field keeps any remaining commas. */
function splitFields(s: string, n: number): string[] {
  const out: string[] = [];
  let i = 0;
  for (let k = 0; k < n - 1; k++) {
    const j = s.indexOf(",", i);
    if (j < 0) break;
    out.push(s.slice(i, j));
    i = j + 1;
  }
  out.push(s.slice(i));
  return out;
}

function toSubtitleTrack(t: RawTrack): MkvSubtitleTrack {
  const codec = t.codecId.toUpperCase();
  const ext: MkvSubtitleTrack["ext"] = codec.includes("ASS") || codec.includes("SSA") ? "ass" : codec.includes("WEBVTT") ? "vtt" : "srt";
  const cues = [...t.cues].sort((a, b) => a.start - b.start);
  // give cues with no BlockDuration a sane end (clamped to the next cue's start)
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].end > cues[i].start) continue;
    const next = cues[i + 1]?.start ?? cues[i].start + 5;
    cues[i].end = Math.min(cues[i].start + 5, next);
  }

  const toText = (): string => {
    if (ext === "ass") {
      const header = t.codecPrivate ? decode(t.codecPrivate).replace(/\s+$/, "") : "[Script Info]\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";
      const lines = cues.map((c) => {
        // block payload = ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
        const f = splitFields(c.payload, 9);
        const [, layer = "0", style = "Default", name = "", mL = "0", mR = "0", mV = "0", effect = "", text = ""] = f;
        return `Dialogue: ${layer},${assTime(c.start)},${assTime(c.end)},${style},${name},${mL},${mR},${mV},${effect},${text}`;
      });
      return `${header}\n${lines.join("\n")}\n`;
    }
    if (ext === "vtt") {
      const header = t.codecPrivate ? decode(t.codecPrivate).replace(/\s+$/, "") : "WEBVTT";
      const blocks = cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.payload}`);
      return `${header}\n\n${blocks.join("\n\n")}\n`;
    }
    const blocks = cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.payload}`);
    return `${blocks.join("\n\n")}\n`;
  };

  return { number: t.number, codecId: t.codecId, lang: t.lang || "und", name: t.name, ext, cueCount: cues.length, toText };
}

/** Pick the most useful track: prefer Japanese, then ASS > SRT > VTT, then most cues. */
export function pickBestSubtitleTrack(tracks: MkvSubtitleTrack[], preferLangs = ["ja", "jpn", "jp"]): MkvSubtitleTrack | null {
  if (!tracks.length) return null;
  const extRank = (e: string) => (e === "ass" ? 0 : e === "srt" ? 1 : 2);
  const langRank = (l: string) => {
    const i = preferLangs.indexOf(l.toLowerCase());
    return i < 0 ? preferLangs.length : i;
  };
  return [...tracks].sort((a, b) => langRank(a.lang) - langRank(b.lang) || extRank(a.ext) - extRank(b.ext) || b.cueCount - a.cueCount)[0];
}
