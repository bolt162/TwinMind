#!/usr/bin/env node
/**
 * build-tray-icon — one-off generator for the macOS tray icons.
 *
 * Run with `node scripts/build-tray-icon.cjs` whenever the design changes;
 * the resulting `iconTemplate.png` + `iconTemplate@2x.png` are committed
 * under `resources/tray/`. macOS auto-loads the `@2x` variant on Retina
 * displays when the @1x path is passed to `nativeImage.createFromPath`,
 * and `setTemplateImage(true)` makes the silhouette auto-tint per menu-
 * bar theme (so the icon must be pure black + alpha; the RGB channels are
 * ignored).
 *
 * Self-contained PNG encoder — no external deps. The image is a filled
 * black dot (the same shape that used to be generated at runtime in
 * Tray.ts), saved as a real file so macOS picks it up reliably under
 * Bartender / notch-overflow / menu-bar-management apps.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ─── PNG encoder ──────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth (per channel)
  ihdr.writeUInt8(6, 9); // color type: 6 = RGBA
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter: adaptive
  ihdr.writeUInt8(0, 12); // interlace: none

  // PNG requires a filter byte at the start of every scanline.
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    filtered[y * (1 + stride)] = 0; // filter type 0 (None)
    rgba.copy(filtered, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(filtered);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Icon shape ───────────────────────────────────────────────────────────

/**
 * Filled circle: black (R=G=B=0) inside, fully transparent outside. macOS
 * uses the alpha channel as the template mask and ignores RGB, so this
 * silhouette gets tinted to match the menu-bar theme automatically.
 *
 * Radius is 32% of the icon size — leaves visible margin around the dot so
 * it doesn't crowd adjacent menu-bar icons. Same proportions @1x and @2x.
 */
function generateCircleRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size * 0.32;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const inside = Math.sqrt(dx * dx + dy * dy) <= radius;
      const offset = (y * size + x) * 4;
      buf[offset] = 0;
      buf[offset + 1] = 0;
      buf[offset + 2] = 0;
      buf[offset + 3] = inside ? 255 : 0;
    }
  }
  return buf;
}

// ─── Run ──────────────────────────────────────────────────────────────────

function main() {
  const outDir = path.resolve(__dirname, '..', 'resources', 'tray');
  fs.mkdirSync(outDir, { recursive: true });

  const x1Path = path.join(outDir, 'iconTemplate.png');
  const x2Path = path.join(outDir, 'iconTemplate@2x.png');

  fs.writeFileSync(x1Path, encodePng(16, 16, generateCircleRgba(16)));
  fs.writeFileSync(x2Path, encodePng(32, 32, generateCircleRgba(32)));

  console.log('Wrote', x1Path);
  console.log('Wrote', x2Path);
}

main();
