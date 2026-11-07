// Images (FE4): text in a screenshot or a photo is read locally (OCR), the same detection as
// for documents finds what to hide, and those words are blacked out before any model sees
// the image. Models that cannot see images get the OCR text, masked.

import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { defaultModelDir } from "./model/files.js";

const require = createRequire(import.meta.url);

/** The most pixels an image may have: larger ones would take gigabytes once decoded. */
export const IMAGE_LIMITS = { pixels: 50_000_000 };

/** An image as 8-bit RGBA pixels, row by row. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A rectangle in pixels: x0 and y0 inclusive, x1 and y1 exclusive. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type ImageFormat = "png" | "jpeg";

/** The format of an image file from its first bytes, or undefined if it is neither PNG nor JPEG. */
export function imageFormat(raw: Uint8Array): ImageFormat | undefined {
  if (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) return "png";
  if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) return "jpeg";
  return undefined;
}

const u16 = (b: Uint8Array, i: number, little = false) => (little ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!);
const u32 = (b: Uint8Array, i: number, little = false) => (little ? u16(b, i, true) + u16(b, i + 2, true) * 65536 : u16(b, i) * 65536 + u16(b, i + 2));

/** JPEG segments before the image data: marker and the bounds of its payload. */
function* jpegSegments(raw: Uint8Array): Generator<{ marker: number; start: number; end: number }> {
  let i = 2;
  while (i + 4 <= raw.length) {
    if (raw[i] !== 0xff) return;
    const marker = raw[i + 1]!;
    // Fill bytes and markers without a payload.
    if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      i++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return;
    const length = u16(raw, i + 2);
    yield { marker, start: i + 4, end: Math.min(raw.length, i + 2 + length) };
    i += 2 + length;
  }
}

/** Width and height, read from the header before anything is decoded. */
export function imageSize(raw: Uint8Array): { width: number; height: number } {
  const format = imageFormat(raw);
  if (format === "png") {
    if (raw.length < 24) throw new Error("This PNG image is cut short.");
    return { width: u32(raw, 16), height: u32(raw, 20) };
  }
  if (format === "jpeg") {
    for (const s of jpegSegments(raw)) {
      // Start of frame: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
      if (s.marker >= 0xc0 && s.marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(s.marker)) return { width: u16(raw, s.start + 3), height: u16(raw, s.start + 1) };
    }
    throw new Error("This JPEG image has no frame header.");
  }
  throw new Error("This file is not a PNG or JPEG image.");
}

/** The EXIF orientation of a JPEG (1 to 8), 1 when it has none. */
export function exifOrientation(raw: Uint8Array): number {
  for (const s of jpegSegments(raw)) {
    if (s.marker !== 0xe1 || String.fromCharCode(...raw.subarray(s.start, s.start + 4)) !== "Exif") continue;
    const tiff = s.start + 6;
    const little = raw[tiff] === 0x49;
    const ifd = tiff + u32(raw, tiff + 4, little);
    if (ifd + 2 > s.end) return 1;
    const entries = u16(raw, ifd, little);
    for (let e = 0; e < entries; e++) {
      const at = ifd + 2 + e * 12;
      if (at + 12 > s.end) return 1;
      if (u16(raw, at, little) === 0x0112) {
        const v = u16(raw, at + 8, little);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
    return 1;
  }
  return 1;
}

/** Turns pixels the way an EXIF orientation says, so they look as the user sees the photo. */
export function orient(img: RgbaImage, orientation: number): RgbaImage {
  if (orientation <= 1 || orientation > 8) return img;
  const { width: w, height: h, data } = img;
  const swap = orientation >= 5;
  const out = new Uint8Array(data.length);
  const W = swap ? h : w;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // Where source pixel (x, y) lands in the output.
      const [nx, ny] = [
        [x, y],
        [w - 1 - x, y],
        [w - 1 - x, h - 1 - y],
        [x, h - 1 - y],
        [y, x],
        [h - 1 - y, x],
        [h - 1 - y, w - 1 - x],
        [y, w - 1 - x],
      ][orientation - 1]!;
      out.set(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (ny! * W + nx!) * 4);
    }
  return { width: W, height: swap ? w : h, data: out };
}

/** Decodes a PNG or JPEG image to RGBA, upright, within IMAGE_LIMITS. */
export function decodeImage(raw: Uint8Array): RgbaImage {
  const { width, height } = imageSize(raw);
  if (!width || !height) throw new Error("This image has no pixels.");
  if (width * height > IMAGE_LIMITS.pixels) throw new Error(`This image is ${width} × ${height} pixels; images over ${IMAGE_LIMITS.pixels / 1e6} million pixels are not read.`);
  try {
    if (imageFormat(raw) === "png") {
      const png = PNG.sync.read(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
      return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
    }
    const img = jpeg.decode(raw, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: IMAGE_LIMITS.pixels / 1e6, maxMemoryUsageInMB: 2048 });
    return orient({ width: img.width, height: img.height, data: img.data }, exifOrientation(raw));
  } catch (err) {
    throw new Error(`This image cannot be decoded: ${(err as Error).message}`);
  }
}

/** Encodes RGBA pixels as PNG, with no metadata (an EXIF block can hold a name or a place). */
export function encodePng(img: RgbaImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png);
}

/** Paints boxes black, clipped to the image. */
export function blackOut(img: RgbaImage, boxes: readonly Box[]): RgbaImage {
  const data = new Uint8Array(img.data);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x0));
    const x1 = Math.min(img.width, Math.ceil(b.x1));
    for (let y = Math.max(0, Math.floor(b.y0)); y < Math.min(img.height, Math.ceil(b.y1)); y++)
      for (let x = x0; x < x1; x++) data.set([0, 0, 0, 255], (y * img.width + x) * 4);
  }
  return { ...img, data };
}

// ---------------------------------------------------------------- OCR

/** A word the OCR read, with how sure it is (0 to 100) and where it is. */
export interface OcrWord {
  text: string;
  confidence: number;
  box: Box;
}

/** The OCR result: lines of words, in reading order, and the page's confidence. */
export interface OcrResult {
  lines: OcrWord[][];
  confidence: number;
}

/** Reads the text of an image. `image` is an upright PNG with no metadata (see encodePng). */
export interface TextRecognizer {
  recognize(image: Uint8Array): Promise<OcrResult>;
  close(): Promise<void>;
}

/** Languages whose data ships with the package. English comes first: Tesseract fails to start with chi_sim first. */
export const OCR_LANGUAGES = ["eng", "fra", "chi_sim"] as const;
export type OcrLanguage = (typeof OCR_LANGUAGES)[number];

/** The language data variant: integer "best" models, the most accurate in the spike (100% on Chinese). */
const OCR_DATA = "4.0.0_best_int";

/**
 * Tesseract reads its language files from one folder, while each npm package has its own:
 * the files are copied once into the model cache.
 */
async function languageFolder(languages: readonly OcrLanguage[], dir: string): Promise<string> {
  const folder = join(dir, `tessdata-${OCR_DATA}`);
  await mkdir(folder, { recursive: true });
  for (const lang of languages) {
    const file = `${lang}.traineddata.gz`;
    const src = join(dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`)), OCR_DATA, file);
    const dest = join(folder, file);
    const [want, have] = await Promise.all([stat(src), stat(dest).catch(() => undefined)]);
    if (have?.size === want.size) continue;
    const part = `${dest}.${process.pid}.part`;
    await copyFile(src, part);
    await rename(part, dest);
  }
  return folder;
}

export interface RecognizerOptions {
  /** Languages to read; all shipped ones by default. Each one adds to the start-up time. */
  languages?: readonly OcrLanguage[];
  /** Where the language files are copied; defaults to the model cache. */
  dir?: string;
}

/** Starts a local OCR worker (Tesseract compiled to WebAssembly; nothing is downloaded). Close it when done. */
export async function createRecognizer(opts: RecognizerOptions = {}): Promise<TextRecognizer> {
  const requested = opts.languages?.length ? opts.languages : OCR_LANGUAGES;
  for (const l of requested) if (!(OCR_LANGUAGES as readonly string[]).includes(l)) throw new Error(`OCR language ${l} is not available; use ${OCR_LANGUAGES.join(", ")}.`);
  const languages = OCR_LANGUAGES.filter((l) => requested.includes(l));
  const langPath = await languageFolder(languages, opts.dir ?? defaultModelDir());
  const { createWorker } = await import("tesseract.js");
  // cacheMethod "none": nothing is written next to the working folder.
  const worker = await createWorker([...languages], 1, { langPath, gzip: true, cacheMethod: "none" });
  return {
    async recognize(image) {
      const { data } = await worker.recognize(Buffer.from(image), {}, { blocks: true, text: false });
      const lines: OcrWord[][] = [];
      for (const block of data.blocks ?? [])
        for (const para of block.paragraphs)
          for (const line of para.lines) {
            const words = line.words.filter((w) => w.text.trim()).map((w) => ({ text: w.text, confidence: w.confidence, box: { ...w.bbox } }));
            if (words.length) lines.push(words);
          }
      return { lines, confidence: data.confidence };
    },
    close: async () => void (await worker.terminate()),
  };
}

// ---------------------------------------------------------------- Redaction

const CJK = /[㐀-鿿　-〿＀-￯가-힯぀-ヿ]/u;

/** A word placed in the page text. */
export interface PlacedWord extends OcrWord {
  start: number;
  end: number;
}

/** The page text rebuilt from OCR lines, with where each word sits in it. CJK words are joined without a space. */
export function pageText(lines: readonly OcrWord[][]): { text: string; words: PlacedWord[] } {
  let text = "";
  const words: PlacedWord[] = [];
  for (const line of lines) {
    for (const [i, w] of line.entries()) {
      if (i > 0 && !(CJK.test(text.at(-1) ?? "") && CJK.test(w.text[0] ?? ""))) text += " ";
      words.push({ ...w, start: text.length, end: text.length + w.text.length });
      text += w.text;
    }
    text += "\n";
  }
  return { text, words };
}

/**
 * The box to black out for a word: grown by a fifth of its height (at least 3 px), since
 * glyphs overhang the OCR's box. Tesseract boxes the last CJK character too narrowly, so a
 * CJK word is taken to be as wide as its square glyphs.
 */
export function redactionBox(w: OcrWord): Box {
  const b = { ...w.box };
  const height = b.y1 - b.y0;
  const cjk = [...w.text].filter((c) => CJK.test(c)).length;
  if (cjk) b.x1 = Math.max(b.x1, b.x0 + Math.round([...w.text].length * height * 1.05));
  const pad = Math.max(3, Math.round(height * 0.2));
  return { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad };
}

/** Below this confidence a word that was left visible is reported as uncertain: the OCR may have misread a name. */
export const UNCERTAIN_BELOW = 60;
