#!/usr/bin/env node
// Turns an image into the halftone grid the hero card draws.
// Run locally when the picture changes (needs ImageMagick):
//   node scripts/make-portrait.mjs path/to/image.png [grid=96]
// Writes scripts/portrait.json. The daily build only reads that file.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const src = process.argv[2];
const N = Number(process.argv[3] ?? 96);
if (!src) {
  console.error('usage: node scripts/make-portrait.mjs <image> [grid=96]');
  process.exit(1);
}

// Raw RGB bytes of the image scaled to N x N, after optional extra magick ops.
function pixels(ops = []) {
  const ppm = execFileSync('magick', [src, ...ops, '-resize', `${N}x${N}!`, '-depth', '8', 'ppm:-']);
  // P6 header: magic, width, height, maxval, then raw RGB bytes.
  let pos = 0;
  const fields = [];
  while (fields.length < 4) {
    while (/\s/.test(String.fromCharCode(ppm[pos]))) pos++;
    let tok = '';
    while (!/\s/.test(String.fromCharCode(ppm[pos]))) tok += String.fromCharCode(ppm[pos++]);
    fields.push(tok);
  }
  if (fields[0] !== 'P6' || Number(fields[1]) !== N || Number(fields[2]) !== N) {
    throw new Error(`unexpected image header ${fields.join(' ')}`);
  }
  return ppm.subarray(pos + 1);
}

// Contrast is boosted for the darkness map so thin outlines survive the downscale.
const tone = pixels(['-colorspace', 'gray', '-sigmoidal-contrast', '8x60%']);
const color = pixels();

// Each cell: [darkness 0-100, accent 0|1]. Accent marks clearly blue pixels,
// which the card draws in the accent colour instead of ink.
const cells = [];
for (let i = 0; i < N * N; i++) {
  const lum = tone[i * 3] / 255;
  const [r, g, b] = [color[i * 3], color[i * 3 + 1], color[i * 3 + 2]];
  const blue = b - Math.max(r, g) > 28 ? 1 : 0;
  cells.push([Math.round((1 - lum) * 100), blue]);
}

writeFileSync(new URL('./portrait.json', import.meta.url), JSON.stringify({ size: N, cells }));
console.log(`portrait.json: ${N}x${N} grid from ${src}`);
