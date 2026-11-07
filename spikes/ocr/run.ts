// Spike 2: can we redact personal data in images locally (OCR, detect, black out) on
// Windows, macOS and Linux, with language data that ships through npm?
//
// For each fixture: OCR the words, run the same detection as for text, black out the boxes of
// matching words, then measure against ground-truth masks how much of each sensitive string's
// pixels were covered. Re-OCR is not used as proof: text the OCR misread is exactly the text a
// vision model may still read.

import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { FIXTURES, OCR_KNOWN_NAMES, maskName } from './fixtures.ts';
import { detectWithDictionary, detectWithRules, dropAllowlisted } from '../lib/rules.ts';
import { mergeSpans, type Span } from '../lib/spans.ts';
import { OUT_DIR, pct, platform, table, writeReport } from '../lib/report.ts';

const require = createRequire(import.meta.url);
const VARIANTS = (process.env.OCR_VARIANTS ?? '4.0.0_best_int,4.0.0').split(',');
// Padding around each word box, relative to its height: glyphs can overhang Tesseract's box.
const pad = (b: { y0: number; y1: number }) => Math.max(3, Math.round((b.y1 - b.y0) * 0.2));

/** Copy the npm language packs into one folder per variant, since tesseract.js takes one langPath. */
function langDir(variant: string): string {
  const dir = join(OUT_DIR, 'tessdata', variant);
  mkdirSync(dir, { recursive: true });
  for (const lang of ['eng', 'fra', 'chi_sim']) {
    const src = join(dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`)), variant);
    for (const f of readdirSync(src)) copyFileSync(join(src, f), join(dir, f));
  }
  return dir;
}

const isCjk = (c: string | undefined) => !!c && /[㐀-鿿　-〿＀-￯]/u.test(c);

interface OcrWord {
  text: string;
  start: number;
  end: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Rebuild page text from OCR words, remembering where each word sits in it. */
function pageText(blocks: any[]): { text: string; words: OcrWord[] } {
  let text = '';
  const words: OcrWord[] = [];
  for (const b of blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? []) {
        let first = true;
        for (const w of l.words ?? []) {
          const wt: string = w.text;
          if (!first && !(isCjk(text[text.length - 1]) && isCjk(wt[0]))) text += ' ';
          first = false;
          words.push({ text: wt, start: text.length, end: text.length + wt.length, bbox: w.bbox });
          text += wt;
        }
        text += '\n';
      }
  return { text, words };
}

let detectModel: ((text: string) => Promise<Span[]>) | null = null;
if (process.env.OCR_NER_MODEL) {
  const { loadNer } = await import('../pii/ner.ts');
  const [id, dtype = 'q8'] = process.env.OCR_NER_MODEL.split('@');
  const m = await loadNer(id!, dtype, join(OUT_DIR, 'hf-cache'));
  detectModel = (t) => m.detect(t);
}

async function detect(text: string): Promise<Span[]> {
  const known = OCR_KNOWN_NAMES.map((value) => ({ value, type: 'PERSON' }));
  const spans = [...detectWithRules(text), ...detectWithDictionary(text, known)];
  if (detectModel) {
    // Run the model line by line; OCR pages can exceed one model window.
    let offset = 0;
    for (const line of text.split('\n')) {
      if (line.trim()) for (const s of await detectModel(line)) spans.push({ ...s, start: s.start + offset, end: s.end + offset });
      offset += line.length + 1;
    }
  }
  return mergeSpans(dropAllowlisted(text, spans));
}

interface Grey {
  data: Buffer;
  width: number;
  height: number;
}

async function grey(file: string): Promise<Grey> {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const INK = 160; // darker than this is text

function inBoxes(x: number, y: number, boxes: OcrWord['bbox'][]): boolean {
  return boxes.some((b) => x >= b.x0 - pad(b) && x <= b.x1 + pad(b) && y >= b.y0 - pad(b) && y <= b.y1 + pad(b));
}

/** Share of a mask's ink pixels that fall inside the redaction boxes. */
function covered(mask: Grey, boxes: OcrWord['bbox'][]): number {
  let ink = 0;
  let hit = 0;
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[y * mask.width + x]! > INK) continue;
      ink++;
      if (inBoxes(x, y, boxes)) hit++;
    }
  return ink === 0 ? 1 : hit / ink;
}

/**
 * Over-redaction: share of the image's other text (ink that belongs to no sensitive string)
 * that ended up under a black box. Pixels next to sensitive ink are skipped (anti-aliasing).
 */
function otherInkCovered(image: Grey, masks: Grey[], boxes: OcrWord['bbox'][]): number {
  const nearSensitive = (x: number, y: number) =>
    masks.some((m) => {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < m.width && yy < m.height && m.data[yy * m.width + xx]! < 230) return true;
        }
      return false;
    });
  let ink = 0;
  let hit = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      if (image.data[y * image.width + x]! > INK || nearSensitive(x, y)) continue;
      ink++;
      if (inBoxes(x, y, boxes)) hit++;
    }
  return ink === 0 ? 0 : hit / ink;
}

const fixturesDir = join(import.meta.dirname, 'fixtures');
const rows: (string | number)[][] = [];
const misses: string[] = [];
const results: unknown[] = [];
for (const variant of VARIANTS) {
  const langPath = langDir(variant);
  for (const f of FIXTURES) {
    const t0 = performance.now();
    const worker = await createWorker(f.lang.split('+'), 1, { langPath, gzip: true, cachePath: join(OUT_DIR, 'tess-cache', variant) });
    const initMs = performance.now() - t0;
    const t1 = performance.now();
    const { data } = await worker.recognize(join(fixturesDir, f.file), {}, { blocks: true, text: true });
    const ocrMs = performance.now() - t1;
    await worker.terminate();

    const { text, words } = pageText(data.blocks as any[]);
    const spans = await detect(text);
    const boxes = words
      .filter((w) => spans.some((s) => s.start < w.end && w.start < s.end))
      .map((w) => {
        // Tesseract often boxes the last CJK character too narrowly; assume square glyphs instead.
        const b = { ...w.bbox };
        const cjk = [...w.text].filter((c) => isCjk(c)).length;
        if (cjk > 0) b.x1 = Math.max(b.x1, b.x0 + Math.round([...w.text].length * (b.y1 - b.y0) * 1.05));
        return b;
      });

    const meta = await sharp(join(fixturesDir, f.file)).metadata();
    const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">${boxes
      .map((b) => `<rect x="${b.x0 - pad(b)}" y="${b.y0 - pad(b)}" width="${b.x1 - b.x0 + 2 * pad(b)}" height="${b.y1 - b.y0 + 2 * pad(b)}" fill="#000"/>`)
      .join('')}</svg>`;
    const outFile = join(OUT_DIR, 'redacted', variant, f.file);
    mkdirSync(dirname(outFile), { recursive: true });
    await sharp(join(fixturesDir, f.file)).composite([{ input: Buffer.from(overlay) }]).png().toFile(outFile);

    let full = 0;
    const perString: { value: string; covered: number; readByOcr: boolean }[] = [];
    const masks = await Promise.all(f.sensitive.map((_, i) => grey(join(fixturesDir, maskName(f.file, i)))));
    const overRedacted = otherInkCovered(await grey(join(fixturesDir, f.file)), masks, boxes);
    for (const [i, s] of f.sensitive.entries()) {
      const c = covered(masks[i]!, boxes);
      const readByOcr = text.replace(/\s/g, '').includes(s.replace(/\s/g, ''));
      perString.push({ value: s, covered: c, readByOcr });
      if (c >= 0.98) full++;
      else misses.push(`${variant} ${f.file}: "${s}" ${Math.round(c * 100)}% covered, OCR ${readByOcr ? 'read it' : 'misread it'}`);
    }
    results.push({ variant, file: f.file, ocrText: text, perString, boxes: boxes.length, overRedacted, initMs, ocrMs });
    rows.push([variant, f.file, pct(full, f.sensitive.length), `${(overRedacted * 100).toFixed(1)}%`, `${Math.round(initMs)} ms`, `${Math.round(ocrMs)} ms`, Math.round(data.confidence)]);
  }
}

let md = `## Spike 2: image redaction with OCR (${platform()})\n\n`;
md += `Detection: rules + known names${detectModel ? ` + model ${process.env.OCR_NER_MODEL}` : ' (no model)'}. A string counts as redacted when at least 98% of its pixels are under a black box.\n\n`;
md += table(['Language data', 'Image', 'Sensitive strings redacted', 'Other text blacked out', 'Worker start', 'OCR', 'OCR confidence'], rows);
md += `\n\n${misses.length ? 'Not fully redacted:\n\n' + misses.map((m) => `- ${m}`).join('\n') : 'Every sensitive string was fully redacted.'}\n`;
writeReport(`ocr-${process.platform}`, md, results);
