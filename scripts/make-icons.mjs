// Generates simple placeholder PNG icons (no external deps) into public/icons.
// A rounded orange tile with a white subtitle bar — evokes the "subtitle" theme.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = resolve(root, "public", "icons");
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(size, draw) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y);
      const o = (y * size + x) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
    }
  }
  // add per-row filter byte (0)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeIcon(size) {
  const radius = size * 0.22;
  const inRounded = (x, y) => {
    // rounded-rect mask
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
  return png(size, (x, y) => {
    if (!inRounded(x, y)) return [0, 0, 0, 0];
    // subtitle bar near the bottom
    const barTop = size * 0.6, barBot = size * 0.78;
    const barL = size * 0.2, barR = size * 0.8;
    if (y >= barTop && y <= barBot && x >= barL && x <= barR) return [255, 255, 255, 255];
    // background gradient orange
    const t = y / size;
    const r = Math.round(255);
    const g = Math.round(147 - t * 30);
    const b = Math.round(69 - t * 20);
    return [r, g, b, 255];
  });
}

for (const s of [16, 48, 128]) {
  writeFileSync(resolve(outDir, `icon-${s}.png`), makeIcon(s));
  console.log("wrote", `icons/icon-${s}.png`);
}
