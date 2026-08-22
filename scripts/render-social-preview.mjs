#!/usr/bin/env node
// Render the generated 2.5D memory-system art underneath the exact-text SVG
// with one platform-independent WASM rasterizer. The committed fonts and the
// WASM bytecode are the complete rendering environment: no system font,
// native Sharp, or native Canvas implementation may affect the PNG bytes.
// Run via: npm run render:preview
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const artPath = path.join(root, "assets", "social-preview-art.png");
const svgPath = path.join(root, "assets", "social-preview.svg");
const defaultPngPath = path.join(root, "assets", "social-preview.png");
const fontPaths = [
  path.join(root, "assets", "fonts", "LiberationSans-Regular.ttf"),
  path.join(root, "assets", "fonts", "LiberationSans-Bold.ttf")
];
const fontLicensePath = path.join(root, "assets", "fonts", "LICENSE_LIBERATION");
const fontProvenancePath = path.join(root, "assets", "fonts", "font-provenance.json");
const wasmPath = fileURLToPath(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm"));

let wasmReady;

async function ensureWasm() {
  wasmReady ??= fs.readFile(wasmPath).then((bytes) => initWasm(bytes));
  await wasmReady;
}

function composeSvg(svg, art) {
  const openingTagEnd = svg.indexOf(">");
  if (openingTagEnd < 0 || !svg.slice(0, openingTagEnd).includes("<svg")) {
    throw new Error("assets/social-preview.svg must start with an <svg> element");
  }
  const embeddedArt =
    `<image x="0" y="0" width="1280" height="640" preserveAspectRatio="xMidYMid slice" ` +
    `href="data:image/png;base64,${art.toString("base64")}"/>`;
  return `${svg.slice(0, openingTagEnd + 1)}\n  ${embeddedArt}${svg.slice(openingTagEnd + 1)}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertFontProvenance(manifest, fontBuffers, license) {
  const expectedFiles = fontPaths.map((fontPath) => path.basename(fontPath));
  if (
    manifest?.schemaVersion !== 1 ||
    !Array.isArray(manifest.fonts) ||
    manifest.fonts.length !== expectedFiles.length
  ) {
    throw new Error("assets/fonts/font-provenance.json has an unsupported shape");
  }
  for (const [index, expectedFile] of expectedFiles.entries()) {
    const entry = manifest.fonts[index];
    const bytes = fontBuffers[index];
    if (entry?.file !== expectedFile || !bytes || entry.sha256 !== sha256(bytes)) {
      throw new Error(`bundled font provenance mismatch: ${expectedFile}`);
    }
  }
  if (
    manifest.license?.file !== path.basename(fontLicensePath) ||
    manifest.license?.spdx !== "OFL-1.1" ||
    manifest.license?.sha256 !== sha256(license)
  ) {
    throw new Error("bundled font license provenance mismatch");
  }
}

/**
 * Render the canonical social preview with a byte-identical WASM/font stack.
 *
 * @param {string} outputPath - Absolute or cwd-relative PNG destination.
 * @returns {Promise<{ outputPath: string, size: number }>} Render receipt.
 */
export async function renderSocialPreview(outputPath = defaultPngPath) {
  await ensureWasm();
  const [art, svg, provenanceRaw, license, ...fontBuffers] = await Promise.all([
    fs.readFile(artPath),
    fs.readFile(svgPath, "utf8"),
    fs.readFile(fontProvenancePath, "utf8"),
    fs.readFile(fontLicensePath),
    ...fontPaths.map((fontPath) => fs.readFile(fontPath))
  ]);
  assertFontProvenance(JSON.parse(provenanceRaw), fontBuffers, license);
  const renderer = new Resvg(composeSvg(svg, art), {
    dpi: 96,
    fitTo: { mode: "original" },
    font: {
      fontBuffers,
      defaultFontFamily: "Liberation Sans",
      sansSerifFamily: "Liberation Sans"
    },
    imageRendering: 0,
    shapeRendering: 2,
    textRendering: 2
  });
  const rendered = renderer.render();
  const png = Buffer.from(rendered.asPng());
  rendered.free();
  renderer.free();

  const resolvedOutputPath = path.resolve(outputPath);
  await fs.writeFile(resolvedOutputPath, png);
  return { outputPath: resolvedOutputPath, size: png.byteLength };
}

function outputPathFromArgs(args) {
  if (args.length === 0) return defaultPngPath;
  if (args.length === 2 && args[0] === "--output" && args[1]) return args[1];
  throw new Error("usage: node scripts/render-social-preview.mjs [--output <png-path>]");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const { outputPath, size } = await renderSocialPreview(outputPathFromArgs(process.argv.slice(2)));
  console.log(`wrote ${path.relative(root, outputPath)} (${(size / 1024).toFixed(1)} kB)`);
}
