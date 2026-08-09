#!/usr/bin/env node
/**
 * Draw LiveOpsPoppy's app icon → frontend/public/liveopspoppy-icon.png.
 *
 * This script is the icon's SOURCE OF TRUTH: there's no SVG rasterizer on a stock macOS
 * box (no rsvg/cairo/magick), so rather than commit a binary nobody can regenerate, we
 * draw the mark in code and encode the PNG with zlib. Deterministic — same bytes every run.
 *
 * The mark: three horizontal slider tracks with round knobs at different positions —
 * live tuning, which is what LiveOps *is* — in the poppy's ONE assigned accent, on
 * transparency. Deliberately simple so it stays legible at 24px in the sidebar, and the
 * host draws the rounded corners itself, so we ship it square (AGENTS.md §9).
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "frontend", "public", "liveopspoppy-icon.png");

const SIZE = 512;
const SS = 4; // supersample factor → anti-aliased edges without a graphics lib

/** The accent the host assigns us: poppyAccent("com.liveopspoppy.desktop") = #e8b8c9. */
const ACCENT = [0xe8, 0xb8, 0xc9];
/** A dimmer tint of the same hue for the tracks — one colour, two weights. */
const tint = (f) => ACCENT.map((c) => Math.round(c * f));

/**
 * Shapes as rounded rects [x, y, w, h] with radius r; a square with r = w/2 is a circle.
 * Knobs FIRST — the rasterizer takes the first hit, so knobs win where they overlap
 * their track.
 */
const KNOB = 96; // knob diameter
const TRACK_H = 30;
const rowY = [133, 256, 379]; // row centres
const knobX = [352, 172, 296]; // knob centres — deliberately uneven: mid-tune, not a pattern
const SHAPES = [
  ...rowY.map((cy, i) => ({
    rect: [knobX[i] - KNOB / 2, cy - KNOB / 2, KNOB, KNOB],
    r: KNOB / 2,
    colour: tint(1.0),
  })),
  ...rowY.map((cy) => ({
    rect: [72, cy - TRACK_H / 2, 368, TRACK_H],
    r: TRACK_H / 2,
    colour: tint(0.5),
  })),
];

/** Is (x, y) inside a rounded rectangle? */
function inRoundedRect(x, y, [rx, ry, rw, rh], r) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Render RGBA, supersampled then box-filtered down. */
function render() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const hit = SHAPES.find((s) => inRoundedRect(fx, fy, s.rect, s.r));
          if (hit) {
            r += hit.colour[0];
            g += hit.colour[1];
            b += hit.colour[2];
            a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (y * SIZE + x) * 4;
      // Un-premultiply so partially-covered edge pixels keep full colour.
      if (a > 0) {
        const cov = a / n / 255;
        px[i] = Math.round(r / n / cov);
        px[i + 1] = Math.round(g / n / cov);
        px[i + 2] = Math.round(b / n / cov);
        px[i + 3] = Math.round(a / n);
      }
    }
  }
  return px;
}

/** One PNG chunk: length + type + data + CRC32. */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function encodePng(px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 6; // truecolour + alpha
  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png = encodePng(render());
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(
  `✅ ${outPath} — ${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB, sha256 ${createHash("sha256").update(png).digest("hex").slice(0, 12)}…`,
);
