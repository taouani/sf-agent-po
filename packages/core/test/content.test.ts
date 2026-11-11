import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CHECK_SECTIONS, ContentLibrary, parseChecks, parseIndustry } from "../src/index.js";

const library = new ContentLibrary();
const dir = mkdtempSync(join(tmpdir(), "sf-agent-content-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("built-in content", () => {
  it("has every industry template, with guidance for each", () => {
    const ids = ["financial-services", "insurance", "health", "manufacturing", "automotive", "energy-utilities", "public-sector", "nonprofit", "education", "retail-consumer-goods", "communications", "luxury"];
    expect(library.industries().map((t) => t.id).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const t = library.industry(id)!;
      for (const field of ["products", "dataModel", "regulations", "integrations", "watchFor"] as const) expect(t[field].length, `${id} ${field}`).toBeGreaterThan(0);
      expect(library.industryGuidance(id), id).toContain(`## Industry: ${t.name}`);
    }
  });

  it("resolves what users type as 0.x did", () => {
    const typed: [string, string | undefined][] = [
      ["Insurance", "insurance"],
      ["energy & utilities", "energy-utilities"],
      ["Energy and Utilities", "energy-utilities"],
      ["banking", "financial-services"],
      ["FSI", "financial-services"],
      ["k-12", "education"],
      ["Life_Sciences", "health"],
      ["telco", "communications"],
      ["retail", "retail-consumer-goods"],
      ["nope", undefined],
      ["", undefined],
    ];
    for (const [value, id] of typed) expect(library.industry(value)?.id, value).toBe(id);
  });

  it("has the agents' roles, practices and design templates", () => {
    for (const id of ["sa-role", "sa-principles", "po-role", "po-practices"]) expect(library.agent(id).length, id).toBeGreaterThan(100);
    expect(library.template("high-level-design")).toMatch(/^## 1\. Context and scope$[\s\S]*^## 4\. Solution overview$/m);
    expect(library.template("detailed-design")).toMatch(/^## 1\. Scope$[\s\S]*^## 2\. Data model changes$/m);
    expect(() => library.template("nope")).toThrow(/No templates content "nope". Available: detailed-design, high-level-design/);
  });

  it("adds the luxury template", () => {
    const t = library.industry("Jewellery")!;
    expect(t.id).toBe("luxury");
    expect(library.industry("fashion")?.id).toBe("luxury");
    expect(library.industryGuidance("luxury")).toContain("## Industry: Luxury");
    expect(t.regulations).toContain("PIPL");
  });
});

describe("check word lists", () => {
  it("has English and French lists with every section", () => {
    expect(library.checkLanguages()).toEqual(["en", "fr"]);
    const en = library.checks("en");
    const fr = library.checks("fr");
    expect(en.name).toBe("English");
    expect(fr.name).toBe("French");
    for (const key of Object.keys(CHECK_SECTIONS) as (keyof typeof CHECK_SECTIONS)[]) {
      expect(en[key].length, key).toBeGreaterThan(0);
      expect(fr[key].length, key).toBeGreaterThan(0);
    }
    expect(en.compliance).toContain("encrypt*");
    expect(fr.vague).toContain("rapidement");
    expect(fr.articles).toContain("l'");
    // A common word of both languages would not tell them apart.
    expect(en.common.filter((w) => fr.common.includes(w))).toEqual([]);
    expect(() => library.checks("de")).toThrow(/No check word lists for "de". Available: en, fr/);
  });

  it("refuses a list file that is not right", () => {
    const sections = (skip = "") =>
      Object.values(CHECK_SECTIONS)
        .filter((h) => h !== skip)
        .map((h) => `## ${h}\n\nWhat it is.\n\n- word`)
        .join("\n\n");
    const file = (lang: string, body: string) => `---\nlanguage: ${lang}\nname: Test\n---\n\n${body}\n`;
    expect(parseChecks(file("de", sections()), "/x/de.md").vague).toEqual(["word"]);
    expect(() => parseChecks(file("de", sections()), "/x/fr.md")).toThrow(/file name must be de.md/);
    expect(() => parseChecks(file("de", sections("Articles")), "/x/de.md")).toThrow(/"## Articles" is missing/);
    expect(() => parseChecks(file("de", `${sections()}\n\n## Other\n\n- x`), "/x/de.md")).toThrow(/unknown section\(s\) "Other"/);
    expect(() => parseChecks(file("de", sections().replace("- word", "- *word")), "/x/de.md")).toThrow(/"\*" may only end it/);
    expect(() => parseChecks(file("German", sections()), "/x/German.md")).toThrow(/language code/);
  });
});

describe("content folders", () => {
  const industry = (id: string, extra = "", aliases = "") => `---
id: ${id}
name: Team ${id}
aliases: [${aliases}]
---

## Salesforce products to consider

P${extra}

## Data model

D

## Regulation and compliance

R

## Typical integrations

I

## Watch for

W
`;

  it("lets a team folder replace and add industries and texts", () => {
    const team = join(dir, "team");
    mkdirSync(join(team, "industries"), { recursive: true });
    mkdirSync(join(team, "templates"), { recursive: true });
    writeFileSync(join(team, "industries", "luxury.md"), industry("luxury", " (team version)", "maison"));
    writeFileSync(join(team, "industries", "hospitality.md"), industry("hospitality", "", "hotels"));
    writeFileSync(join(team, "templates", "high-level-design.md"), "# Our HLD\n");
    // A folder that does not exist is skipped.
    const lib = new ContentLibrary([lib0(), join(dir, "missing"), team]);
    expect(lib.industry("luxury")?.products).toBe("P (team version)");
    expect(lib.industry("Hotels")?.id).toBe("hospitality");
    expect(lib.template("high-level-design")).toBe("# Our HLD");
    // What the team folder does not have comes from the built-in content.
    expect(lib.agent("sa-role")).toBe(library.agent("sa-role"));
  });

  it("explains what is wrong with an industry file", () => {
    const file = (name: string) => join(dir, `${name}.md`);
    expect(() => parseIndustry("no front matter", file("x"))).toThrow(/missing front matter/);
    expect(() => parseIndustry(industry("y"), file("x"))).toThrow(/file name must be y.md/);
    expect(() => parseIndustry(industry("x").replace("## Watch for\n\nW\n", ""), file("x"))).toThrow(/"## Watch for" is missing/);
    expect(() => parseIndustry(industry("x") + "\n## Pricing\n\nX\n", file("x"))).toThrow(/unknown section\(s\) "Pricing"/);
    expect(() => parseIndustry(industry("x").replace("aliases: []", "aliases: banking"), file("x"))).toThrow(/must be a list/);
    const doubled = industry("x").replace("## Data model\n\nD\n", "## Data model\n\nD\n\n## Data model\n\nE\n");
    expect(() => parseIndustry(doubled, file("x"))).toThrow(/"## Data model" appears twice/);
    expect(() => parseIndustry(industry("x").replace("\nW\n", "\nW\n\n### More\n\nX\n"), file("x"))).toThrow(/must be one paragraph/);
    expect(parseIndustry(industry("x").replace("name: Team x", 'name: "Team: x"'), file("x")).name).toBe("Team: x");
    expect(() => parseIndustry(industry("x", "", '"a, b", c'), file("x"))).toThrow(/without quotes/);
    // Files edited on Windows, or checked out there with CRLF, read the same.
    expect(parseIndustry(`\uFEFF${industry("x").replace(/\n/g, "\r\n")}`, file("x")).watchFor).toBe("W");
  });

  it("drops the aliases a replacing industry no longer lists", () => {
    const team = join(dir, "narrow");
    mkdirSync(join(team, "industries"), { recursive: true });
    writeFileSync(join(team, "industries", "luxury.md"), industry("luxury", "", "maison"));
    writeFileSync(join(team, "industries", "fashion-retail.md"), industry("fashion-retail", "", "fashion"));
    const lib = new ContentLibrary([lib0(), team]);
    expect(lib.industry("fashion")?.id).toBe("fashion-retail");
    expect(lib.industry("watches")).toBeUndefined();
  });

  it("refuses an alias that two industries claim", () => {
    const clash = join(dir, "clash");
    mkdirSync(join(clash, "industries"), { recursive: true });
    writeFileSync(join(clash, "industries", "hospitality.md"), industry("hospitality", "", "banking"));
    expect(() => new ContentLibrary([lib0(), clash])).toThrow(/alias "banking" is used by both financial-services \(.*financial-services\.md\) and hospitality .*add your own financial-services\.md/);
  });
});

function lib0(): string {
  return join(import.meta.dirname, "..", "content");
}
