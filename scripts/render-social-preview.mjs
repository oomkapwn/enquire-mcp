#!/usr/bin/env node
// Composite the generated 2.5D memory-system art with the deterministic
// exact-text SVG overlay into a 1280x640 GitHub social preview.
// Run via: npm run render:preview
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const artPath = path.join(root, "assets", "social-preview-art.png");
const svgPath = path.join(root, "assets", "social-preview.svg");
const pngPath = path.join(root, "assets", "social-preview.png");

const svg = await fs.readFile(svgPath);
const overlay = await sharp(svg, { density: 300 }).resize(1280, 640, { fit: "fill" }).png().toBuffer();
await sharp(artPath)
  .resize(1280, 640, { fit: "cover" })
  .composite([{ input: overlay }])
  .png({ compressionLevel: 9 })
  .toFile(pngPath);

const stat = await fs.stat(pngPath);
console.log(`wrote ${path.relative(root, pngPath)} (${(stat.size / 1024).toFixed(1)} kB)`);
