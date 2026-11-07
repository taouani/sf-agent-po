import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classify, Database, formulaFields, MetadataIndex, scanProject, type ParsedComponent } from "../src/index.js";

const fixtures = join(import.meta.dirname, "fixtures", "metadata");
const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});
const fresh = () => {
  const db = new Database(":memory:");
  open.push(db);
  return new MetadataIndex(db);
};

describe("classify", () => {
  it("knows object files and their children in both formats", () => {
    expect(classify("force-app/main/default/objects/Account/Account.object-meta.xml")).toEqual({ kind: "object", object: "Account" });
    expect(classify("x/objects/Account/fields/Industry.field-meta.xml")).toEqual({ kind: "field", object: "Account", child: "Industry" });
    expect(classify("x/objects/Account/validationRules/V.validationRule-meta.xml")).toEqual({ kind: "validationRule", object: "Account", child: "V" });
    expect(classify("src/objects/Claim__c.object")).toEqual({ kind: "mdapiObject", object: "Claim__c" });
    expect(classify("x/objects/Account/listViews/All.listView-meta.xml")).toBeUndefined();
    expect(classify("x/classes/Foo.cls")).toBeUndefined();
  });
});

describe("scanProject", () => {
  it("reads objects, fields, record types and rules in source format", async () => {
    const { components, edges, skipped } = await scanProject(join(fixtures, "source"));
    const byName = new Map(components.map((c) => [`${c.type}:${c.name}`, c]));

    const policy = byName.get("CustomObject:Policy__c")!;
    expect(policy).toMatchObject({ label: "Policy", file: "force-app/main/default/objects/Policy__c/Policy__c.object-meta.xml" });
    expect(policy.attrs).toMatchObject({ custom: true, sharingModel: "ReadWrite", nameField: { label: "Policy Number", type: "AutoNumber" } });
    // Free text, with entities decoded, goes to text, never to attrs.
    expect(policy.text).toBe("Insurance policy sold by Jeanne Dupont's team");

    expect(byName.get("CustomField:Policy__c.Holder__c")).toMatchObject({ parent: "Policy__c", attrs: { type: "Lookup", referenceTo: ["Account"] } });
    const status = byName.get("CustomField:Policy__c.Status__c")!;
    expect(status.attrs).toMatchObject({ type: "Picklist", required: true, restricted: true, picklist: [{ value: "Active", default: true }, { value: "Lapsed" }] });
    expect(status.text).toContain("Lapsed");
    expect(byName.get("RecordType:Policy__c.Motor")).toMatchObject({ label: "Motor", attrs: { active: true } });
    expect(byName.get("ValidationRule:Policy__c.Premium_Required")!.text).toBe("An active policy needs a premium");

    // Account has only a field folder: it is in the project, without an object file.
    expect(byName.get("CustomObject:Account")).toMatchObject({ file: "force-app/main/default/objects/Account", attrs: { custom: false } });
    expect(byName.get("CustomObject:Account")!.missing).toBeUndefined();
    // Referenced but outside the project: placeholders.
    expect(byName.get("CustomObject:User")?.missing).toBe(true);
    expect(byName.get("CustomField:Account.Industry")).toMatchObject({ missing: true, parent: "Account" });

    expect(skipped).toEqual([{ file: "force-app/main/default/objects/Account/fields/Broken__c.field-meta.xml", reason: "a document type declaration is not read" }]);

    const has = (from: string, kind: string, to: string) => edges.some((e) => `${e.from.type}:${e.from.name}` === from && e.kind === kind && `${e.to.type}:${e.to.name}` === to);
    expect(has("CustomField:Policy__c.Holder__c", "references", "CustomObject:Account")).toBe(true);
    expect(has("CustomField:Policy__c.Holder__c", "part_of", "CustomObject:Policy__c")).toBe(true);
    expect(has("ValidationRule:Policy__c.Premium_Required", "reads", "CustomField:Policy__c.Status__c")).toBe(true);
    expect(has("ValidationRule:Policy__c.Premium_Required", "reads", "CustomField:Policy__c.Premium__c")).toBe(true);
    // Through the lookup to Account, then the standard Owner relationship to User.
    expect(has("CustomField:Policy__c.Holder_Industry__c", "reads", "CustomField:Account.Industry")).toBe(true);
    expect(has("CustomField:Policy__c.Holder_Industry__c", "reads", "CustomField:Account.OwnerId")).toBe(true);
    expect(has("CustomField:Policy__c.Holder_Industry__c", "reads", "CustomField:User.Email")).toBe(true);
    // Function names, literals and $User are not fields.
    expect(edges.some((e) => /ISPICKVAL|ISBLANK|Active|Alias|admin/.test(e.to.name))).toBe(false);
  });

  it("reads children inside .object files in metadata format", async () => {
    const { components, edges, skipped } = await scanProject(join(fixtures, "mdapi"));
    expect(skipped).toEqual([]);
    const names = components.filter((c) => !c.missing).map((c) => `${c.type}:${c.name}`).sort();
    expect(names).toEqual([
      "CustomField:Claim__c.Amount__c",
      "CustomField:Claim__c.Policy__c",
      "CustomObject:Claim__c",
      "RecordType:Claim__c.Theft",
      "ValidationRule:Claim__c.Amount_Positive",
    ]);
    expect(components.find((c) => c.name === "Claim__c.Amount__c")!.file).toBe("src/objects/Claim__c.object");
    expect(edges).toContainEqual({ from: { type: "ValidationRule", name: "Claim__c.Amount_Positive" }, to: { type: "CustomField", name: "Claim__c.Amount__c" }, kind: "reads" });
    expect(components.find((c) => c.name === "Policy__c")).toMatchObject({ type: "CustomObject", missing: true });
  });
});

describe("formulaFields", () => {
  const fields = new Map<string, Map<string, ParsedComponent>>([
    ["Case", new Map([["Contract__c", { type: "CustomField", name: "Case.Contract__c", attrs: { referenceTo: ["Contract__c"] }, text: "" }]])],
    ["Contract__c", new Map()],
  ]);
  const of = (o: string) => fields.get(o);

  it("follows custom and standard relationships", () => {
    expect(formulaFields("Contract__r.Owner.Name & Account.Name", "Case", of).sort()).toEqual(
      ["Account.Name", "Case.AccountId", "Case.Contract__c", "Contract__c.OwnerId", "User.Name"].sort(),
    );
  });

  it("leaves out functions, keywords, literals, comments and globals", () => {
    expect(formulaFields('IF( NOT(IsClosed), "Open: Status", TRUE ) /* Priority */ && $Profile.Name = \'x\'', "Case", of)).toEqual(["Case.IsClosed"]);
  });
});

describe("MetadataIndex", () => {
  it("stores a snapshot, finds components and walks the graph", async () => {
    const index = fresh();
    const snap = await index.build({ source: "repo:source", kind: "repo", revision: "abc123" }, () => scanProject(join(fixtures, "source")));
    expect(snap).toMatchObject({ status: "ready", revision: "abc123", stats: { counts: { CustomObject: 2, CustomField: 5, RecordType: 1, ValidationRule: 1 } } });
    expect(snap.stats.skipped).toHaveLength(1);
    expect(index.latest("repo:source")?.id).toBe(snap.id);

    // Part of an API name, a label with an accent folded, and a word of the free text.
    expect(index.search(snap.id, "Premium").map((c) => c.name)).toContain("Policy__c.Premium__c");
    expect(index.search(snap.id, "annuelle")[0]?.name).toBe("Policy__c.Premium__c");
    expect(index.search(snap.id, "reclame")).toEqual([]);
    expect(index.search(snap.id, "lapsed").map((c) => c.name)).toEqual(["Policy__c.Status__c"]);
    // An exact name comes first; types filter; short words match by substring.
    expect(index.search(snap.id, "policy__c")[0]?.name).toBe("Policy__c");
    expect(index.search(snap.id, "Policy", { types: ["RecordType"] }).map((c) => c.name)).toEqual(["Policy__c.Motor"]);
    expect(index.search(snap.id, "Id").map((c) => c.name)).toContain("Account.OwnerId");
    expect(index.search(snap.id, '"; DROP')).toEqual([]);

    expect(index.children(snap.id, "policy__c").map((c) => c.name)).toEqual([
      "Policy__c.Holder_Industry__c",
      "Policy__c.Holder__c",
      "Policy__c.Premium__c",
      "Policy__c.Status__c",
      "Policy__c.Motor",
      "Policy__c.Premium_Required",
    ]);

    const premium = index.component(snap.id, "CustomField", "Policy__c.Premium__c")!;
    const near = index.related(premium.id);
    expect(near.map((r) => `${r.direction} ${r.kind} ${r.component.name}`)).toEqual(["out part_of Policy__c", "in reads Policy__c.Premium_Required"]);
    // Two hops out from the formula field: through Account to its owner field and User.
    const formula = index.component(snap.id, "CustomField", "Policy__c.Holder_Industry__c")!;
    const deep = index.related(formula.id, { depth: 2 }).filter((r) => r.direction === "out");
    expect(deep.find((r) => r.component.name === "User")).toMatchObject({ depth: 2, component: { missing: true } });
    expect(index.related(formula.id, { kinds: ["references"] })).toEqual([]);
  });

  it("keeps only the newest snapshot of a source, and the old one when a run fails", async () => {
    const index = fresh();
    const first = await index.build({ source: "s", kind: "repo" }, () => scanProject(join(fixtures, "mdapi")));
    await expect(index.build({ source: "s", kind: "repo" }, () => Promise.reject(new Error("disk gone")))).rejects.toThrow("disk gone");
    expect(index.latest("s")?.id).toBe(first.id);
    expect(index.snapshots()[0]).toMatchObject({ status: "failed", stats: { error: "disk gone" } });

    const second = await index.build({ source: "s", kind: "repo" }, () => scanProject(join(fixtures, "mdapi")));
    expect(index.snapshots().map((s) => s.id)).toEqual([second.id]);
    expect(index.search(second.id, "Claim").length).toBeGreaterThan(0);
    expect(index.search(first.id, "Claim")).toEqual([]);
  });
});
