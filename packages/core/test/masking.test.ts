import { describe, expect, it } from "vitest";
import {
  applyPolicy,
  cnIdValid,
  detect,
  detectWithDictionary,
  detectWithRules,
  ibanValid,
  luhnValid,
  mergeSpans,
  nirValid,
  replaceSpans,
  type Span,
} from "../src/index.js";
import { KNOWN_NAMES, SAMPLES } from "./fixtures/pii-samples.js";

/** Types the rules must find on their own; people need the dictionary or the model. */
const RULE_TYPES = ["EMAIL", "PHONE", "IBAN", "CARD", "NATIONAL_ID", "SECRET", "IP", "ADDRESS"];

const masked = (text: string, spans: Span[]) => mergeSpans(spans).map((s) => text.slice(s.start, s.end));
const covered = (spans: Span[], start: number, end: number, text: string) =>
  [...text.slice(start, end)].every((ch, i) => /\s/.test(ch) || spans.some((s) => s.start <= start + i && start + i < s.end));

describe("detect, without a model", () => {
  it("masks every structured value and every known name in the samples, and nothing else", async () => {
    const misses: string[] = [];
    const extra: string[] = [];
    for (const s of SAMPLES) {
      const spans = await detect(s.text, { dictionary: KNOWN_NAMES });
      for (const g of s.gold) {
        const known = g.type === "PERSON" && KNOWN_NAMES.some((k) => k.value === g.value);
        if ((RULE_TYPES.includes(g.type) || known) && !covered(spans, g.start, g.end, s.text)) misses.push(`${g.type} "${g.value}"`);
      }
      // Every masked character belongs to a labelled value: no false positives, no over-masking.
      for (const sp of spans) {
        for (let i = sp.start; i < sp.end; i++) {
          if (!/\s/.test(s.text[i]!) && !s.gold.some((g) => g.start <= i && i < g.end)) {
            extra.push(`${sp.type} "${s.text.slice(sp.start, sp.end)}" in: ${s.text}`);
            break;
          }
        }
      }
    }
    expect(misses).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("leaves Salesforce vocabulary and ordinary words alone", async () => {
    for (const s of SAMPLES.filter((x) => !x.gold.length)) expect(await detect(s.text)).toEqual([]);
  });

  it.each([
    ["Card 4111 1111 1111 1111 12/27 on file", ["4111 1111 1111 1111"]],
    ["IBAN BE68 5390 0754 7034 2024 for the refund", ["BE68 5390 0754 7034"]],
    ["The secretary is Marie Dupont", []],
    ["The token is valid until Friday", []],
    ["password: hunter2!", ["hunter2!"]],
    ["clone https://deploy:s3cr3t-Pa55@git.example.com/repo.git", ["s3cr3t-Pa55"]],
    ["GitLab glpat-AbCdEfGhIjKlMnOpQrSt12 in the pipeline", ["glpat-AbCdEfGhIjKlMnOpQrSt12"]],
    ["Order 00012345 shipped on 2026-03-15", []],
    ["Livraison au 3 bis avenue Foch, 69006 Lyon demain.", ["3 bis avenue Foch, 69006 Lyon"]],
    ["Ship to 1600 Pennsylvania Avenue, Washington DC 20500 by Friday.", ["1600 Pennsylvania Avenue, Washington DC 20500"]],
    ["客户住在广州市天河区天河路385号，周五送货。", ["广州市天河区天河路385号"]],
    ["The boutique on Bond Street opens at 10.", []],
    ["Write to mailto:anna@example.com today", ["anna@example.com"]],
  ])("%s", (text, expected) => {
    expect(masked(text, detectWithRules(text))).toEqual(expected);
  });
});

describe("the dictionary", () => {
  it("matches whole words in any case and spacing, and CJK names anywhere", () => {
    const entries = [
      { value: "Sarah Whitfield", type: "PERSON" },
      { value: "刘洋", type: "PERSON" },
      { value: "A", type: "PERSON" },
    ];
    expect(masked("sarah  whitfield and Sarah Whitfields", detectWithDictionary("sarah  whitfield and Sarah Whitfields", entries))).toEqual(["sarah  whitfield"]);
    expect(masked("刘洋经理批准了", detectWithDictionary("刘洋经理批准了", entries))).toEqual(["刘洋"]);
    expect(detectWithDictionary("A plan", entries)).toEqual([]);
  });
});

describe("the policy (MA1)", () => {
  it("keeps the model's people, and drops its places, organisations and allowlisted terms", () => {
    const text = "Kenji Watanabe from Maison Aurelle in Tokyo uses Service Cloud";
    const ner = (start: number, end: number, type: string): Span => ({ start, end, type, source: "ner" });
    const kept = applyPolicy(text, [ner(0, 14, "PERSON"), ner(20, 34, "ORG"), ner(38, 43, "LOCATION"), ner(49, 62, "PERSON")]);
    expect(kept.map((s) => text.slice(s.start, s.end))).toEqual(["Kenji Watanabe"]);
  });

  it("runs the model and merges its spans with the rules", async () => {
    const text = "Call Emily Carter at emily@example.com";
    const model = async (t: string): Promise<Span[]> => [{ start: t.indexOf("Emily"), end: t.indexOf(" at"), type: "PERSON", source: "ner" }];
    expect(masked(text, await detect(text, { model }))).toEqual(["Emily Carter", "emily@example.com"]);
  });
});

describe("spans", () => {
  it("merges overlapping and touching spans, keeping the first type", () => {
    const s = (start: number, end: number, type: string): Span => ({ start, end, type, source: "rule" });
    expect(mergeSpans([s(5, 9, "B"), s(0, 5, "A"), s(12, 14, "C"), s(13, 20, "D")])).toEqual([s(0, 9, "A"), s(12, 20, "C")]);
  });

  it("replaces spans with labels, giving the same value the same label", () => {
    const text = "Ann wrote to Bob, then Ann left.";
    const spans: Span[] = [0, 13, 23].map((start) => ({ start, end: start + 3, type: "PERSON", source: "dictionary" }));
    const labels = new Map<string, string>();
    const out = replaceSpans(text, spans, (type, original) => labels.get(original) ?? (labels.set(original, `<${type}_${labels.size + 1}>`), labels.get(original)!));
    expect(out).toBe("<PERSON_1> wrote to <PERSON_2>, then <PERSON_1> left.");
  });
});

describe("validators", () => {
  it("accept valid numbers and reject near misses", () => {
    expect([luhnValid("4111 1111 1111 1111"), luhnValid("4111 1111 1111 1112")]).toEqual([true, false]);
    expect([ibanValid("FR76 3000 6000 0112 3456 7890 189"), ibanValid("FR76 3000 6000 0112 3456 7890 188")]).toEqual([true, false]);
    expect([nirValid("2 85 07 75 116 238 95"), nirValid("2 85 07 75 116 238 94"), nirValid("2850775A1623895")]).toEqual([true, false, false]);
    expect([cnIdValid("11010519491231002X"), cnIdValid("110105194912310021")]).toEqual([true, false]);
  });
});
