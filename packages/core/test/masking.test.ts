import { describe, expect, it } from "vitest";
import {
  applyPolicy,
  cnIdValid,
  detect,
  compileDictionary,
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

/** Built at run time, so GitHub's push protection does not take the test value for a real token. */
const FAKE_REFRESH_TOKEN = ["5Aep", "861abcdEFGH.ijklMNOP1234"].join("");

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
    // URLs and emails
    ["See http://intranet:8080/home or write to bob@example.com", ["bob@example.com"]],
    ["redis://:R3dis-pass@cache.internal:6379", ["R3dis-pass"]],
    [`sfdx force://PlatformCLI::${FAKE_REFRESH_TOKEN}@acme.my.salesforce.com`, [FAKE_REFRESH_TOKEN]],
    ["postgres://app:Pg_2026!x@db.example.com/sales", ["Pg_2026!x"]],
    // keyword secrets in code and config
    ["const dbPassword = 'Hunter2-Prod';", ["Hunter2-Prod"]],
    ["DB_PASSWORD=Spring2026 npm start", ["Spring2026"]],
    ['{"client_secret":"a1b2 c3d4 e5f6","user":"bob"}', ["a1b2 c3d4 e5f6"]],
    ["<password>Sup3rS3cret</password>", ["Sup3rS3cret"]],
    ["spring.datasource.password: Pa55word!", ["Pa55word!"]],
    ["The refresh token was 7f3a9c2e1b", ["7f3a9c2e1b"]],
    ["密码是Aurelle#2026。", ["Aurelle#2026"]],
    ["令牌 abc123xyz 已过期", ["abc123xyz"]],
    ["Le jeton est Xy7-Qw2-Zz9 pour la prod.", ["Xy7-Qw2-Zz9"]],
    ["String password = getPassword();", []],
    ["Password__c: Text(255)", []],
    ["password: {!$Credential.Password}", []],
    ["token = response.access_token;", []],
    ["The password field is required: see docs", []],
    // new token formats
    ["github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVW leaked", ["github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVW"]],
    ["key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q in the app", ["AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"]],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1b2c3\nd4e5f6g7==\n(truncated)", ["-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1b2c3\nd4e5f6g7=="]],
    // phones
    ["Call +44 20 7946 0958 now", ["+44 20 7946 0958"]],
    ["Call +1 (212) 555-0147 now", ["+1 (212) 555-0147"]],
    ["Ring 0033 1 42 68 53 00 today", ["0033 1 42 68 53 00"]],
    ["UK office 020 7946 0958.", ["020 7946 0958"]],
    ["Berlin 030-12345678 bitte", ["030-12345678"]],
    ["手机138 1234 5678，座机010-12345678", ["138 1234 5678", "010-12345678"]],
    ["DE +49 30 12345678, CN (021) 6288 1234, US 1-800-555-0199", ["+49 30 12345678", "(021) 6288 1234", "1-800-555-0199"]],
    ["Case 00123456 and order 00012345 are closed", []],
    ["Meeting on 05.03.2026 at 10:30", []],
    // bank, cards, ids
    ["iban fr76 3000 6000 0112 3456 7890 189 please", ["fr76 3000 6000 0112 3456 7890 189"]],
    ["IBAN FR76-3000-6000-0112-3456-7890-189", ["FR76-3000-6000-0112-3456-7890-189"]],
    ["Amex 3782 822463 10005 on file", ["3782 822463 10005"]],
    ["NIR 2-85-07-75-116-238-95", ["2-85-07-75-116-238-95"]],
    ["SSN 536 22 8094", ["536 22 8094"]],
    ["身份证 110105 19491231 002X", ["110105 19491231 002X"]],
    // IP addresses, not versions
    ["Server 10.24.3.17 is down", ["10.24.3.17"]],
    ["Upgrade to version 10.0.0.1 or v1.2.3.4 then 1.2.3.4.5", []],
    // addresses
    ["Ship to 221B Baker Street London NW1 6XE today", ["221B Baker Street London NW1 6XE"]],
    ["Office at 350 5th Avenue, Suite 300, New York, NY 10118.", ["350 5th Avenue, Suite 300, New York, NY 10118"]],
    ["Send it to 12 Main St., Springfield", ["12 Main St., Springfield"]],
    ["Envoyer au 12 avenue du Mal. Foch, 75116 Paris.", ["12 avenue du Mal. Foch, 75116 Paris"]],
    ["Adresse : 14 B RUE DE LA PAIX 75002 PARIS", ["14 B RUE DE LA PAIX 75002 PARIS"]],
    ["Le client habite 5 r. de l'Église, bât. B, 69002 Lyon.", ["5 r. de l'Église, bât. B, 69002 Lyon"]],
    ["Il reste 2 cours de formation et 3 place pour le chemin critique.", []],
    ["收货地址：江苏省苏州市工业园区星湖街328号", ["江苏省苏州市工业园区星湖街328号"]],
    ["客户住在昆山市前进中路88号3栋1201室，周五送货。", ["昆山市前进中路88号3栋1201室"]],
    ["客户在上海的门店买了一只表。", []],
    ["地址：北京市朝阳区建国路88号院3号楼2单元501室", ["北京市朝阳区建国路88号院3号楼2单元501室"]],
    ["WHERE Email='jane.doe@example.com'", ["jane.doe@example.com"]],
    ["commit 4111111111111111abc", []],
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
    const joined = "SarahWhitfield and sarah.whitfield and sarah_whitfield";
    expect(masked(joined, detectWithDictionary(joined, entries))).toEqual(["SarahWhitfield", "sarah.whitfield", "sarah_whitfield"]);
    const ja = "担当はやまだたろうです";
    expect(masked(ja, detectWithDictionary(ja, [{ value: "やまだ", type: "PERSON" }]))).toEqual(["やまだ"]);
  });

  it("finds the longest of values that share a start, each with its own type, and keeps case when asked", () => {
    const entries = [
      { value: "Anna", type: "PERSON" },
      { value: "Anna Smith", type: "PERSON" },
      { value: "Annabel Road 5", type: "ADDRESS" },
      { value: "Grace", type: "PERSON", caseSensitive: true },
      { value: "C++ (team)", type: "PERSON" },
    ];
    const text = "Anna Smith, anna, Annabel Road 5, Annabelle, Grace, grace, C++ (team)";
    const spans = detectWithDictionary(text, entries);
    expect(spans.map((s) => [text.slice(s.start, s.end), s.type])).toEqual([
      ["Anna Smith", "PERSON"],
      ["anna", "PERSON"],
      ["Annabel Road 5", "ADDRESS"],
      ["C++ (team)", "PERSON"],
      ["Grace", "PERSON"],
    ]);
    // Compiled once, a long list still finds its values in one pass.
    const many = compileDictionary(Array.from({ length: 3000 }, (_, i) => ({ value: `Name${i} Family${i}`, type: "PERSON" })));
    expect(many.size).toBe(3000);
    expect(many.find("met name2999 family2999 and Name12 Family1").map((s) => s.start)).toEqual([4]);
  });
});

describe("the policy (MA1)", () => {
  it("keeps the model's people, and drops its places, organisations and allowlisted terms", () => {
    const text = "Kenji Watanabe from Maison Aurelle in Tokyo uses Service Cloud";
    const ner = (start: number, end: number, type: string): Span => ({ start, end, type, source: "ner" });
    const kept = applyPolicy(text, [ner(0, 14, "PERSON"), ner(20, 34, "ORG"), ner(38, 43, "LOCATION"), ner(49, 62, "PERSON")]);
    expect(kept.map((s) => text.slice(s.start, s.end))).toEqual(["Kenji Watanabe"]);
  });

  it("never takes a field type for a person (the eval saw Currency masked)", () => {
    const text = "Premium__c is a Currency field, Rate__c a Percent";
    const ner = (word: string): Span => ({ start: text.indexOf(word), end: text.indexOf(word) + word.length, type: "PERSON", source: "ner" });
    expect(applyPolicy(text, [ner("Currency"), ner("Percent")])).toEqual([]);
  });

  it("runs the model and merges its spans with the rules", async () => {
    const text = "Call Emily Carter at emily@example.com";
    const model = async (t: string): Promise<Span[]> => [{ start: t.indexOf("Emily"), end: t.indexOf(" at"), type: "PERSON", source: "ner" }];
    expect(masked(text, await detect(text, { model }))).toEqual(["Emily Carter", "emily@example.com"]);
  });

  it("maps the model's labels and masks types it does not know (fail closed)", async () => {
    const text = "Kenji met Ines in Paris about X-42";
    const model = async (): Promise<Span[]> => [
      { start: 0, end: 5, type: "B-PER", source: "ner" },
      { start: 10, end: 14, type: "PER", source: "ner" },
      { start: 18, end: 23, type: "LOC", source: "ner" },
      { start: 30, end: 34, type: "SOMETHING_NEW", source: "ner" },
    ];
    const spans = await detect(text, { model });
    expect(spans.map((s) => [text.slice(s.start, s.end), s.type])).toEqual([["Kenji", "PERSON"], ["Ines", "PERSON"], ["X-42", "SOMETHING_NEW"]]);
  });

  it("clamps or drops malformed model spans", async () => {
    const text = "Call Emily";
    const model = async (): Promise<Span[]> => [
      { start: 4.5, end: 99, type: "PERSON", source: "ner" },
      { start: Number.NaN, end: 3, type: "PERSON", source: "ner" },
      { start: 6, end: 2, type: "PERSON", source: "ner" },
    ];
    expect(masked(text, await detect(text, { model }))).toEqual([" Emily"]);
  });
});

describe("spans", () => {
  it("merges overlapping spans and keeps touching ones apart", () => {
    const s = (start: number, end: number, type: string): Span => ({ start, end, type, source: "rule" });
    expect(mergeSpans([s(5, 9, "B"), s(0, 5, "A"), s(12, 14, "C"), s(13, 20, "D")])).toEqual([s(0, 5, "A"), s(5, 9, "B"), s(12, 20, "D")]);
  });

  it("gives a merged span the type of a secret, else of the longest span", () => {
    const s = (start: number, end: number, type: string): Span => ({ start, end, type, source: "rule" });
    expect(mergeSpans([s(0, 30, "EMAIL"), s(0, 8, "SECRET")]).map((x) => x.type)).toEqual(["SECRET"]);
    expect(mergeSpans([s(0, 5, "PERSON"), s(0, 20, "EMAIL")]).map((x) => x.type)).toEqual(["EMAIL"]);
  });

  it("labels adjacent spans of different types separately", () => {
    const text = "AnnBob";
    const spans: Span[] = [
      { start: 0, end: 3, type: "PERSON", source: "dictionary" },
      { start: 3, end: 6, type: "EMAIL", source: "rule" },
    ];
    expect(replaceSpans(text, spans, (type) => `<${type}>`)).toBe("<PERSON><EMAIL>");
  });

  it("ignores spans outside the text when replacing", () => {
    const spans: Span[] = [{ start: 2, end: 99, type: "PERSON", source: "ner" }];
    expect(replaceSpans("Hi Ann", spans, (type) => `<${type}>`)).toBe("Hi<PERSON>");
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

describe("performance", () => {
  it("scans 1 MB of minified JSON in linear time", () => {
    const record = JSON.stringify({ id: "a0B5g00000XyZ12EAB", name: "Order-12345", url: "https://example.com/a/b?c=d", email: "x.y@example.com", amount: 1234.5 });
    const json = `[${Array.from({ length: Math.ceil(1_000_000 / record.length) }, () => record).join(",")}]`;
    const longRun = "a".repeat(200_000) + "@" + "b.".repeat(100_000);
    const started = performance.now();
    detectWithRules(json);
    detectWithRules(longRun);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
