#!/usr/bin/env node
// Source assets for the native app icon + launch screen, generated from the
// same HC mark and brass-on-ink-green recipe as the PWA icons
// (build-app-icons.mjs). Separate script so running this never rewrites the
// committed public/icon-*.png and churns the web build.
//
// Outputs feed `npx @capacitor/assets generate`, which expands them into the
// Xcode AppIcon and LaunchImage sets. The App Store icon MUST be fully opaque
// -- an alpha channel is a hard rejection -- so every tile is flattened.

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'public/logo-hc-mark.png');
const OUT_DIR = resolve(ROOT, 'assets');
mkdirSync(OUT_DIR, { recursive: true });

const BG = { r: 0x13, g: 0x20, b: 0x1c };
const BRASS = { r: 0xd8, g: 0xa8, b: 0x5a };

const trimmed = await sharp(SRC).trim({ threshold: 10 }).toBuffer();
const alphaMask = await sharp(trimmed)
  .greyscale()
  .threshold(128)
  .negate({ alpha: false })
  .toBuffer();

const { width: mw, height: mh } = await sharp(alphaMask).metadata();

const alphaChannel = await sharp(alphaMask).extractChannel('red').raw().toBuffer();
const brassMark = await sharp({
  create: { width: mw, height: mh, channels: 3, background: BRASS },
})
  .joinChannel(alphaChannel, { raw: { width: mw, height: mh, channels: 1 } })
  .png()
  .toBuffer();

async function renderTile(size, safe, outPath) {
  const targetW = Math.round(size * safe);
  const targetH = Math.round((mh / mw) * targetW);
  const scaledMark = await sharp(brassMark).resize(targetW, targetH, { fit: 'contain' }).toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: { ...BG, alpha: 1 } },
  })
    .composite([{ input: scaledMark, gravity: 'center' }])
    // removeAlpha, not just an opaque background: App Store Connect rejects an
    // icon that merely LOOKS opaque but still carries an alpha channel.
    .removeAlpha()
    .png()
    .toFile(outPath);
  console.log(`${outPath} (${size}px, mark ${Math.round(safe * 100)}%)`);
}

// 1024 is the App Store / AppIcon source size.
await renderTile(1024, 0.62, resolve(OUT_DIR, 'icon.png'));

// The launch screen is centred on a square canvas and cropped to whatever
// aspect the device has, so the mark sits small enough to survive the crop on
// the narrowest one.
await renderTile(2732, 0.28, resolve(OUT_DIR, 'splash.png'));
await renderTile(2732, 0.28, resolve(OUT_DIR, 'splash-dark.png'));

console.log('done');
