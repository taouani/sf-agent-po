import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// The 0.x texts, to check that the Markdown files carry them over word for word.
import * as legacy from "../../../src/agents/industries.js";
import { HIGH_LEVEL_DESIGN_TEMPLATE, DETAILED_DESIGN_TEMPLATE, SA_PRINCIPLES, SA_ROLE } from "../../../src/agents/solution-architect.js";
import { PO_PRACTICES, PO_ROLE } from "../../../src/agents/product-owner.js";
import { ContentLibrary, parseIndustry } from "../src/index.js";

const library = new ContentLibrary();
const dir = mkdtempSync(join(tmpdir(), "sf-agent-content-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("built-in content", () => {
  it("carries over every 0.x industry template word for word", () => {
    for (const old of legacy.INDUSTRIES) {
      const t = library.industry(old.id)!;
      expect({ id: t.id, name: t.name, products: t.products, dataModel: t.dataModel, regulations: t.regulations, integrations: t.integrations, watchFor: t.watchFor }).toEqual(old);
      expect(library.industryGuidance(old.id)).toBe(legacy.industryGuidance(old.id));
    }
  });

  it("resolves what users type as 0.x did", () => {
    const typed = ["Insurance", "energy & utilities", "Energy and Utilities", "banking", "FSI", "k-12", "Life_Sciences", "telco", "retail", "nope", ""];
    for (const value of typed) expect(library.industry(value)?.id, value).toBe(legacy.resolveIndustry(value));
  });

  it("carries over the agents' roles, practices and design templates", () => {
    expect(library.agent("sa-role")).toBe(SA_ROLE);
    expect(library.agent("sa-principles")).toBe(SA_PRINCIPLES);
    expect(library.agent("po-role")).toBe(PO_ROLE);
    expect(library.agent("po-practices")).toBe(PO_PRACTICES);
    expect(library.template("high-level-design")).toBe(HIGH_LEVEL_DESIGN_TEMPLATE);
    expect(library.template("detailed-design")).toBe(DETAILED_DESIGN_TEMPLATE);
    expect(() => library.template("nope")).toThrow(/No templates content "nope". Available: detailed-design, high-level-design/);
  });

  it("adds the luxury template", () => {
    const t = library.industry("Jewellery")!;
    expect(t.id).toBe("luxury");
    expect(library.industry("fashion")?.id).toBe("luxury");
    expect(library.industryGuidance("luxury")).toContain("## Industry: Luxury");
    expect(t.regulations).toContain("PIPL");
    expect(library.industries()).toHaveLength(legacy.INDUSTRIES.length + 1);
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
    expect(lib.agent("sa-role")).toBe(SA_ROLE);
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
