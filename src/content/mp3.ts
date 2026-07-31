import { Mp3Encoder } from "@breezystack/lamejs";

/**
 * Decode any browser-decodable audio Blob (the webm/opus MediaRecorder produces) and
 * re-encode it as a mono MP3, returned as base64 (no `data:` prefix). MP3 plays on
 * iOS / AnkiMobile, where webm/opus does NOT. Returns null if the audio can't be
 * decoded, so the caller can fall back to the original container.
 */
export async function audioBlobToMp3Base64(blob: Blob, kbps = 64): Promise<string | null> {
  const arrayBuf = await blob.arrayBuffer();

  // Decode through an OfflineAudioContext pinned to 44.1 kHz so the PCM lands on a
  // sample rate lamejs supports, regardless of what the recorder used.
  const Ctx = (window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext);
  if (!Ctx) return null;
  const sampleRate = 44100;
  let audio: AudioBuffer;
  try {
    audio = await new Ctx(1, 1, sampleRate).decodeAudioData(arrayBuf);
  } catch {
    return null;
  }

  // Downmix to mono, then Float32 [-1,1] → Int16.
  const n = audio.length;
  if (!n) return null;
  const channels = audio.numberOfChannels;
  const pcm = new Int16Array(n);
  for (let c = 0; c < channels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < n; i++) pcm[i] += clampSample(data[i]) / channels;
  }

  // Encode mono MP3 in 1152-sample blocks (lamejs's preferred granule size).
  const encoder = new Mp3Encoder(1, audio.sampleRate || sampleRate, kbps);
  const parts: Uint8Array[] = [];
  const BLOCK = 1152;
  for (let i = 0; i < n; i += BLOCK) {
    const chunk = encoder.encodeBuffer(pcm.subarray(i, i + BLOCK));
    if (chunk.length) parts.push(chunk);
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(tail);
  if (!parts.length) return null;

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return bytesToBase64(out);
}

/** Float sample [-1,1] → Int16 range (kept as a float here; assigned into Int16Array). */
function clampSample(s: number): number {
  const v = s < -1 ? -1 : s > 1 ? 1 : s;
  return v < 0 ? v * 0x8000 : v * 0x7fff;
}

/** Chunked btoa so large buffers don't blow the apply() argument limit. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}
