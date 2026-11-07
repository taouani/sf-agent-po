import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Database,
  createRecognizer,
  decodeImage,
  encodePng,
  exifOrientation,
  IMAGE_LIMITS,
  imageSize,
  Masker,
  newVaultKey,
  orient,
  pageText,
  redactionBox,
  TRUSTED_FROM,
  Vault,
  worthChecking,
  type OcrWord,
  type RgbaImage,
  type TextRecognizer,
} from "../src/index.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "ocr");

const masker = () => new Masker({ vault: new Vault(new Database(":memory:"), newVaultKey()) });

const blank = (width: number, height: number): RgbaImage => ({ width, height, data: new Uint8Array(width * height * 4).fill(255) });
const isBlack = (img: RgbaImage, x: number, y: number) => [0, 1, 2].every((c) => img.data[(y * img.width + x) * 4 + c] === 0);
const word = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 95): OcrWord => ({ text, confidence, box: { x0, y0, x1, y1 } });
const fakeOcr = (lines: OcrWord[][], seen: Uint8Array[] = [], confidence: (call: number) => number = () => 90): TextRecognizer => ({
  recognize: async (image) => (seen.push(image), { lines, confidence: confidence(seen.length) }),
  close: async () => {},
});

/** PNG chunk names, in order. */
function chunks(png: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 8; i < png.length; ) {
    const length = ((png[i]! << 24) | (png[i + 1]! << 16) | (png[i + 2]! << 8) | png[i + 3]!) >>> 0;
    out.push(String.fromCharCode(...png.subarray(i + 4, i + 8)));
    i += 12 + length;
  }
  return out;
}

/** A JPEG with an EXIF orientation, in big- or little-endian TIFF. */
function withOrientation(jpg: Uint8Array, orientation: number, little = false): Buffer {
  const w16 = (v: number) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const w32 = (v: number) => (little ? [v & 255, (v >> 8) & 255, 0, 0] : [0, 0, (v >> 8) & 255, v & 255]);
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...w16(42), ...w32(8), ...w16(1), ...w16(0x0112), ...w16(3), ...w32(1), ...w16(orientation), 0, 0, ...w32(0)];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload];
  return Buffer.concat([Buffer.from(jpg.subarray(0, 2)), Buffer.from(app1), Buffer.from(jpg.subarray(2))]);
}

describe("images", () => {
  it("reads sizes from headers and refuses what is not a PNG or JPEG, or is too large", () => {
    const png = encodePng(blank(7, 3));
    expect(imageSize(png)).toEqual({ width: 7, height: 3 });
    const jpg = jpeg.encode({ width: 9, height: 5, data: Buffer.alloc(9 * 5 * 4, 255) }, 90).data;
    expect(imageSize(jpg)).toEqual({ width: 9, height: 5 });
    expect(() => decodeImage(Buffer.from("GIF89a"))).toThrow(/not a PNG or JPEG/);
    const huge = Buffer.from(png);
    huge.writeUInt32BE(100_000, 16);
    huge.writeUInt32BE(100_000, 20);
    expect(() => decodeImage(huge)).toThrow(new RegExp(`over ${IMAGE_LIMITS.pixels / 1e6} million pixels`));
    expect(() => decodeImage(png.subarray(0, 40))).toThrow(/cannot be decoded/);
  });

  it("lays transparent pixels on white, so what the OCR cannot see is not there", () => {
    const rgba = new PNG({ width: 2, height: 1 });
    rgba.data = Buffer.from([0, 0, 0, 0, 0, 0, 0, 128]);
    const img = decodeImage(PNG.sync.write(rgba));
    expect([...img.data]).toEqual([255, 255, 255, 255, 127, 127, 127, 255]);
  });

  it("turns pixels the way each EXIF orientation says", () => {
    // 3 × 2 pixels numbered 1..6 in the red channel.
    const img: RgbaImage = { width: 3, height: 2, data: new Uint8Array([1, 2, 3, 4, 5, 6].flatMap((v) => [v, 0, 0, 255])) };
    const red = (o: number) => {
      const r = orient(img, o);
      return [r.width, r.height, ...Array.from({ length: r.width * r.height }, (_, i) => r.data[i * 4])];
    };
    expect(red(1)).toEqual([3, 2, 1, 2, 3, 4, 5, 6]);
    expect(red(2)).toEqual([3, 2, 3, 2, 1, 6, 5, 4]);
    expect(red(3)).toEqual([3, 2, 6, 5, 4, 3, 2, 1]);
    expect(red(4)).toEqual([3, 2, 4, 5, 6, 1, 2, 3]);
    expect(red(5)).toEqual([2, 3, 1, 4, 2, 5, 3, 6]);
    expect(red(6)).toEqual([2, 3, 4, 1, 5, 2, 6, 3]);
    expect(red(7)).toEqual([2, 3, 6, 3, 5, 2, 4, 1]);
    expect(red(8)).toEqual([2, 3, 3, 6, 2, 5, 1, 4]);
  });

  it("decodes a JPEG upright from its EXIF orientation", () => {
    // Left half black, right half white, 32 × 16.
    const data = Buffer.alloc(32 * 16 * 4, 255);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) data.fill(0, (y * 32 + x) * 4, (y * 32 + x) * 4 + 3);
    const jpg = jpeg.encode({ width: 32, height: 16, data }, 95).data;
    expect(exifOrientation(jpg)).toBe(1);
    for (const little of [false, true]) {
      const rotated = withOrientation(jpg, 6, little);
      expect(exifOrientation(rotated)).toBe(6);
      const img = decodeImage(rotated);
      // Turned 90° clockwise: the black half is now on top.
      expect([img.width, img.height]).toEqual([16, 32]);
      expect(img.data[(4 * 16 + 8) * 4]).toBeLessThan(40);
      expect(img.data[(28 * 16 + 8) * 4]).toBeGreaterThan(215);
    }
  });

  it("places OCR words in the page text, joining CJK words without a space", () => {
    const { text, words } = pageText([[word("Owner:", 0, 0, 1, 1), word("Tom", 0, 0, 1, 1)], [word("客户", 0, 0, 1, 1), word("刘洋", 0, 0, 1, 1), word("VIP", 0, 0, 1, 1)]]);
    expect(text).toBe("Owner: Tom\n客户刘洋 VIP\n");
    expect(words.map((w) => text.slice(w.start, w.end))).toEqual(["Owner:", "Tom", "客户", "刘洋", "VIP"]);
  });

  it("grows boxes past overhanging glyphs, and CJK words to square glyphs", () => {
    expect(redactionBox(word("Tom", 10, 10, 40, 30))).toEqual({ x0: 6, y0: 6, x1: 44, y1: 34 });
    expect(redactionBox(word("Tom", 10, 10, 40, 12))).toEqual({ x0: 7, y0: 7, x1: 43, y1: 15 });
    expect(redactionBox(word("刘洋", 10, 10, 40, 30))).toEqual({ x0: 6, y0: 6, x1: 56, y1: 34 });
  });

  it("checks uncertain words that could be part of a name", () => {
    expect(["Gr4ce", "ok", "刘", "a", "-", "1"].map(worthChecking)).toEqual([true, true, true, false, false, false]);
  });
});

describe("masking an image", () => {
  const lines = [
    [word("Owner:", 10, 10, 70, 30), word("Sarah", 80, 10, 130, 30), word("Whitfield", 140, 10, 230, 30)],
    [word("Mail:", 10, 40, 60, 60), word("sarah@example.com", 70, 40, 230, 60)],
    [word("Gr4ce", 10, 70, 60, 90, 41), word("ok", 70, 70, 90, 90, 30)],
  ];

  it("blacks out every word that holds personal data and masks the OCR text", async () => {
    const m = masker();
    m.remember("acme", [{ type: "PERSON", value: "Sarah Whitfield" }]);
    const seen: Uint8Array[] = [];
    const out = await m.maskImage("acme", encodePng(blank(240, 100)), fakeOcr(lines, seen));
    expect(out.text).toBe("Owner: [PERSON_1]\nMail: [EMAIL_1]\nGr4ce ok");
    expect(out.report).toEqual({ counts: { PERSON: 1, EMAIL: 1 }, model: false });
    expect(out.ocr.redacted).toHaveLength(3);
    const img = decodeImage(out.image);
    for (const [x, y] of [[100, 20], [180, 20], [150, 50]] as const) expect(isBlack(img, x, y)).toBe(true);
    for (const [x, y] of [[40, 20], [30, 50], [30, 80]] as const) expect(isBlack(img, x, y)).toBe(false);
    // The OCR saw a PNG with no metadata, and the result has none either.
    expect(chunks(seen[0]!)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(chunks(out.image).filter((c) => c !== "IDAT")).toEqual(["IHDR", "IEND"]);
  });

  it("reports words the OCR was unsure of, or blacks them out when asked", async () => {
    const out = await masker().maskImage("acme", encodePng(blank(240, 100)), fakeOcr(lines));
    // "ok" is unsure too, but "Gr4ce" could be a misread name; both have two letters or more.
    expect(out.ocr.uncertain).toEqual([redactionBox(lines[2]![0]!), redactionBox(lines[2]![1]!)]);
    const strict = await masker().maskImage("acme", encodePng(blank(240, 100)), fakeOcr(lines), { redactUncertain: true });
    expect(strict.ocr.uncertain).toEqual([]);
    expect(isBlack(decodeImage(strict.image), 30, 80)).toBe(true);
  });

  it("gives back an image with no text unchanged, re-encoded", async () => {
    const out = await masker().maskImage("acme", encodePng(blank(20, 10)), fakeOcr([]));
    expect(out).toMatchObject({ text: "", width: 20, height: 10, report: { counts: {} }, ocr: { words: 0, redacted: [], uncertain: [], trusted: true, rotated: 0 } });
  });

  it("blacks out text that looks like a pseudonym, which publishing would turn into a name", async () => {
    const out = await masker().maskImage("acme", encodePng(blank(240, 40)), fakeOcr([[word("Ask", 10, 10, 50, 30), word("[PERSON_1]", 60, 10, 160, 30)]]));
    expect(out.text).toBe("Ask [LITERAL_1]");
    expect(out.ocr.redacted).toEqual([redactionBox(word("[PERSON_1]", 60, 10, 160, 30))]);
    expect(out.report.counts).toEqual({});
  });

  it("tries a poorly read page turned, keeps the best reading, and flags one that never reads well", async () => {
    const seen: Uint8Array[] = [];
    // Only the last try (turned 270°) reads well.
    const out = await masker().maskImage("acme", encodePng(blank(40, 20)), fakeOcr([], seen, (call) => (call === 4 ? 88 : 30)));
    expect(seen).toHaveLength(4);
    expect(out.ocr).toMatchObject({ rotated: 270, trusted: true, confidence: 88 });
    expect([out.width, out.height]).toEqual([20, 40]);
    expect(imageSize(out.image)).toEqual({ width: 20, height: 40 });
    const poor = await masker().maskImage("acme", encodePng(blank(40, 20)), fakeOcr([], [], () => TRUSTED_FROM - 1));
    expect(poor.ocr).toMatchObject({ rotated: 0, trusted: false });
    // A page that reads well is read once.
    const once: Uint8Array[] = [];
    await masker().maskImage("acme", encodePng(blank(40, 20)), fakeOcr([], once));
    expect(once).toHaveLength(1);
  });

  it("refuses OCR boxes that do not fit the image", async () => {
    await expect(masker().maskImage("acme", encodePng(blank(40, 20)), fakeOcr([[word("Tom", 10, 10, 30, 60)]]))).rejects.toThrow(/do not fit the image/);
  });
});

// The spike's test images (spikes/ocr): each sensitive string has a mask of its pixels.
const IMAGES = [
  { file: "en-contact", sensitive: ["Sarah Whitfield", "s.whitfield@example-mail.com", "+44 20 7946 0958", "4111 1111 1111 1111"] },
  { file: "fr-email", sensitive: ["Théo Marchand", "theo.marchand@exemple.fr", "06 12 34 56 78", "FR76 3000 6000 0112 3456 7890 189", "Aurelle#2026"] },
  { file: "zh-order", sensitive: ["刘洋", "13812345678", "liuyang.vip@example.cn", "11010519491231002X"] },
  { file: "en-small-grey", sensitive: ["Priya Natarajan", "(212) 555-0147", "536-22-8094", "Spring2026!x"] },
];
/** Names the context already knows: these tests run without the detection model. */
const KNOWN = ["Sarah Whitfield", "Théo Marchand", "刘洋", "Priya Natarajan"];

const png = (file: string) => {
  const p = PNG.sync.read(readFileSync(join(FIXTURES, file)));
  return { width: p.width, height: p.height, data: new Uint8Array(p.data) } satisfies RgbaImage;
};
const INK = 160;
const ink = (img: RgbaImage, x: number, y: number) => img.data[(y * img.width + x) * 4]! <= INK;

describe("OCR redaction on real images", { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-agent-po-ocr-"));
  let ocr: TextRecognizer;
  beforeAll(async () => {
    ocr = await createRecognizer({ dir });
  }, 120_000);
  afterAll(async () => {
    await ocr?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(IMAGES)("hides every sensitive string in $file and little else", async ({ file, sensitive }) => {
    const m = masker();
    m.remember("acme", KNOWN.map((value) => ({ type: "PERSON", value })));
    const out = await m.maskImage("acme", readFileSync(join(FIXTURES, `${file}.png`)), ocr);
    const redacted = decodeImage(out.image);
    const original = png(`${file}.png`);
    const masks = sensitive.map((_, i) => png(`${file}.mask-${i}.png`));
    // At least 98% of each string's pixels are black, as in the spike.
    for (const [i, mask] of masks.entries()) {
      let total = 0;
      let hidden = 0;
      for (let y = 0; y < mask.height; y++)
        for (let x = 0; x < mask.width; x++)
          if (ink(mask, x, y)) {
            total++;
            if (isBlack(redacted, x, y)) hidden++;
          }
      expect(hidden / total, sensitive[i]).toBeGreaterThanOrEqual(0.98);
    }
    // Other text stays readable: under 3% of it is blacked out.
    let other = 0;
    let lost = 0;
    for (let y = 0; y < original.height; y++)
      for (let x = 0; x < original.width; x++) {
        if (!ink(original, x, y) || masks.some((mk) => mk.data[(y * mk.width + x) * 4]! < 230)) continue;
        other++;
        if (isBlack(redacted, x, y)) lost++;
      }
    expect(lost / other).toBeLessThan(0.03);
    const flat = out.text.replace(/\s/g, "");
    for (const s of sensitive) expect(flat).not.toContain(s.replace(/\s/g, ""));
    expect(out.text).toMatch(/\[PERSON_\d+\]/);
  });

  it("reads a page turned a quarter, and gives it back upright and redacted", async () => {
    const m = masker();
    m.remember("acme", KNOWN.map((value) => ({ type: "PERSON", value })));
    const original = png("en-contact.png");
    const out = await m.maskImage("acme", encodePng(orient(original, 6)), ocr);
    expect(out.ocr).toMatchObject({ rotated: 270, trusted: true });
    const redacted = decodeImage(out.image);
    expect([redacted.width, redacted.height]).toEqual([original.width, original.height]);
    const mask = png("en-contact.mask-0.png");
    let total = 0;
    let hidden = 0;
    for (let y = 0; y < mask.height; y++)
      for (let x = 0; x < mask.width; x++)
        if (ink(mask, x, y)) {
          total++;
          if (isBlack(redacted, x, y)) hidden++;
        }
    expect(hidden / total).toBeGreaterThanOrEqual(0.98);
    expect(out.text).toContain("Contact: [PERSON_1]");
  });

  it("does not read text hidden under transparent pixels, and does not give it back", async () => {
    const img = png("en-contact.png");
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 0;
    const out = await masker().maskImage("acme", encodePng(img), ocr);
    expect(out.ocr.words).toBe(0);
    const back = PNG.sync.read(out.image);
    expect(back.data.every((v) => v === 255)).toBe(true);
  });

  it("starts several recognizers at once on an empty cache", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "sf-agent-po-ocr-"));
    try {
      const started = await Promise.all([1, 2, 3].map(() => createRecognizer({ dir: fresh, languages: ["eng"] })));
      await Promise.all(started.map((r) => r.close()));
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("refuses a language that is not shipped", async () => {
    await expect(createRecognizer({ dir, languages: ["deu" as never] })).rejects.toThrow(/OCR language deu is not available/);
  });
});
