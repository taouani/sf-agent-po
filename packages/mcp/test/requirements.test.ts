import { ContextRepository, Database, Masker, newVaultKey, RequirementRepository, Vault, type EntityDetector, type Span } from "@sf-agent-po/core";
import { describe, expect, it } from "vitest";
import {
  checkRequirements,
  proposeRequirements,
  requestDigest,
  requirementProposalSchema,
  requirementsToText,
  type ApprovalRequest,
  type Decision,
  type ProposedRequirement,
  type RequirementsRequest,
} from "../src/index.js";

const fakeModel =
  (names: readonly string[]): EntityDetector =>
  async (text) => {
    const spans: Span[] = [];
    for (const name of names) for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) spans.push({ start: i, end: i + name.length, type: "PER", source: "ner" });
    return spans;
  };

/** A context with a meeting note, a security policy and a design the agents wrote. */
async function setup(decide: (req: RequirementsRequest) => Partial<Decision> = () => ({})) {
  const db = new Database(":memory:");
  const masker = new Masker({ vault: new Vault(db, newVaultKey()), model: fakeModel(["Karim Haddad"]) });
  const contexts = new ContextRepository(db);
  const requirements = new RequirementRepository(db);
  const [notes, policy, design] = await masker.addDocuments(contexts, "renewals", [
    { kind: "meeting-notes", title: "Workshop with Karim Haddad", source: "notes.md", content: "Karim Haddad wants the renewal letter sent 30 days before the end date." },
    { kind: "other", title: "Security policy", source: "policy.md", content: "Renewal data is personal data under GDPR: keep it 7 years, then delete it." },
    { kind: "other", title: "Design v1", source: "design.md", content: "A flow sends the letter.", metadata: { artifact: true } },
  ]);
  const seen: RequirementsRequest[] = [];
  const reviewer = {
    review: async (req: ApprovalRequest): Promise<Decision> => {
      const r = req as RequirementsRequest;
      seen.push(structuredClone(r));
      return { status: "approved", choice: "approved", missed: [], selected: r.items.map((i) => i.key), digest: requestDigest(req), ...decide(r) };
    },
  };
  const kit = { contexts, requirements, masker, reviewer };
  return { kit, seen, requirements, masker, docs: { notes: notes!, policy: policy!, design: design! } };
}

describe("requirement checks", () => {
  const doc = (id: string, title: string, content: string, extra: object = {}) => ({ id, kind: "other" as const, title, source: "x", content, metadata: {}, masked: true, addedAt: "", updatedAt: "", ...extra });
  const req = (r: Partial<ProposedRequirement> & { statement: string }): ProposedRequirement => ({ kind: "functional", priority: "must", sourceIds: ["doc-000000000a"], ...r });

  it("stops on unknown ids, duplicates and sources that are missing or not in the context", () => {
    const docs = [doc("doc-000000000a", "Notes", "Send the letter.")];
    const findings = checkRequirements(
      [req({ id: "R4", statement: "Send the letter" }), req({ statement: "send the  letter." }), req({ statement: "Log every call", sourceIds: [] }), req({ statement: "Print it", sourceIds: ["doc-00000000ff"] }), req({ id: "R4", statement: "Other" })],
      [],
      docs,
    );
    const errors = findings.filter((f) => f.level === "error").map((f) => `${f.where}: ${f.message}`);
    expect(errors).toEqual([
      "R4: R4 is not a requirement of this context. Leave the id out for a new requirement.",
      "new 2: Says the same as R4; keep one of them.",
      "new 3: No source: cite the documents the requirement comes from.",
      "new 4: Source doc-00000000ff is not a document in this context.",
      "R4: R4 is not a requirement of this context. Leave the id out for a new requirement.",
      "R4: R4 is in the proposal 2 times.",
    ]);
  });

  it("warns about several sentences, vague targets, artifacts cited, and inputs nobody cites", () => {
    const docs = [
      doc("doc-000000000a", "Notes", "Send the letter."),
      doc("doc-000000000b", "Security policy", "Keep audit logs."),
      doc("doc-000000000c", "Other notes", "Nothing much."),
      doc("doc-000000000d", "Design v1", "A flow.", { metadata: { artifact: true } }),
      doc("doc-000000000e", "Org", "Objects", { kind: "org" }),
    ];
    const existing = [{ context: "c", id: "R1", kind: "functional" as const, statement: "Old", priority: "must" as const, status: "confirmed" as const, origin: "user" as const, sourceIds: [], createdAt: "", updatedAt: "" }];
    const findings = checkRequirements(
      [
        req({ statement: "Send the letter, e.g. by post. Then log it." }),
        req({ kind: "non-functional", statement: "The page loads fast, i.e. quickly", sourceIds: ["doc-000000000b"] }),
        req({ statement: "Use the flow", sourceIds: ["doc-000000000d"] }),
      ],
      existing,
      docs,
    );
    const text = findings.map((f) => `${f.level} ${f.where}: ${f.message}`);
    expect(text).toEqual([
      "warning new 1: States more than one sentence; a requirement should state one thing, so split it if it holds several.",
      'warning new 2: "fast" cannot be tested; state a measurable target.',
      'warning new 3: Source doc-000000000d ("Design v1") is not an input but something the agents wrote or the org\'s metadata; cite the inputs it comes from.',
      "info proposal: R1 is not in the proposal; the user sees it on the page as kept from before.",
      'info doc-000000000c: "Other notes" is not cited by any requirement.',
    ]);
    // A user's own requirement needs no source; a sensitive input cited only by functional ones is flagged.
    const again = checkRequirements([req({ id: "R1", statement: "Old", sourceIds: [] }), req({ statement: "Keep logs", sourceIds: ["doc-000000000b", "doc-000000000a", "doc-000000000c"] })], existing, docs);
    expect(again.map((f) => `${f.level} ${f.where}: ${f.message}`)).toEqual([
      'warning doc-000000000b: "Security policy" mentions security or compliance, but no compliance, non-functional or constraint requirement cites it.',
    ]);
  });

  it("validates the proposal's shape", () => {
    expect(requirementProposalSchema.safeParse([req({ id: "R0", statement: "Send it now" })]).success).toBe(false);
    expect(requirementProposalSchema.safeParse([req({ statement: "Send it now", sourceIds: ["notes.md"] })]).success).toBe(false);
    expect(requirementProposalSchema.safeParse([]).success).toBe(false);
    expect(requirementProposalSchema.safeParse([req({ id: "R12", statement: "  Send it now  " })]).data?.[0]?.statement).toBe("Send it now");
  });
});

describe("proposeRequirements", () => {
  it("shows real values on the page, stores masked statements, and keeps the user's choices", async () => {
    const { kit, seen, requirements, docs } = await setup((r) => ({
      selected: ["n1", "n2"],
      priorities: { n2: "should" },
      lines: ["Karim Haddad signs every letter"],
      comment: "Ask Karim Haddad about the 30 days",
    }));
    const out = await proposeRequirements(kit, "renewals", [
      { kind: "functional", statement: "Send the renewal letter 30 days before the end date, as Karim Haddad asked.", priority: "must", sourceIds: [docs.notes.id, docs.notes.id] },
      { kind: "compliance", statement: "Delete renewal data after 7 years.", priority: "must", sourceIds: [docs.policy.id] },
      { kind: "functional", statement: "Print the letter in color.", priority: "could", sourceIds: [docs.notes.id] },
    ]);
    expect(out.status).toBe("approved");
    // The page has the real name; the model and the store have a pseudonym.
    const page = seen[0]!;
    expect(page.title).toBe("renewals");
    expect(page.items.map((i) => [i.key, i.note, i.sources])).toEqual([
      ["n1", "New", ["Workshop with Karim Haddad"]],
      ["n2", "New", ["Security policy"]],
      ["n3", "New", ["Workshop with Karim Haddad"]],
    ]);
    expect(page.items[0]!.statement).toContain("as Karim Haddad asked");
    expect(JSON.stringify(out)).not.toContain("Karim");
    expect(out.requirements.map((r) => [r.id, r.kind, r.priority, r.origin])).toEqual([
      ["R1", "functional", "must", "agent"],
      ["R2", "compliance", "should", "agent"],
      ["R3", "functional", "must", "user"],
    ]);
    expect(out.requirements[0]!.statement).toMatch(/as \[PERSON_\d+\] asked/);
    expect(out.requirements[0]!.sourceIds).toEqual([docs.notes.id]);
    expect(out.requirements[2]!.statement).toMatch(/^\[PERSON_\d+\] signs every letter$/);
    expect(out.typed).toEqual(["R3"]);
    expect(out.comment).toMatch(/^Ask \[PERSON_\d+\] about the 30 days$/);
    expect(requirementsToText(out.requirements)).toContain(`- R1 [functional, must] Send the renewal letter`);
    expect(requirementsToText(out.requirements)).toContain("(typed by the user)");
    // The unticked new one is not saved at all.
    expect(requirements.list("renewals", { dropped: true })).toHaveLength(3);
  });

  it("revises existing requirements, shows those left out, and drops the ones the user unticks", async () => {
    const { kit, seen, requirements, docs } = await setup();
    await proposeRequirements(kit, "renewals", [
      { kind: "functional", statement: "Send the renewal letter 30 days before the end date.", priority: "must", sourceIds: [docs.notes.id] },
      { kind: "compliance", statement: "Delete renewal data after 7 years.", priority: "must", sourceIds: [docs.policy.id] },
      { kind: "functional", statement: "Send a reminder by SMS.", priority: "could", sourceIds: [docs.notes.id] },
    ]);
    const before = requirements.get("renewals", "R2")!;
    let choose: Partial<Decision> = {};
    kit.reviewer = { review: async (req) => (seen.push(structuredClone(req as RequirementsRequest)), { status: "approved", choice: "approved", missed: [], digest: requestDigest(req), selected: (req as RequirementsRequest).items.map((i) => i.key), ...choose }) };
    choose = { selected: ["R1", "R2", "n1"] };
    const out = await proposeRequirements(kit, "renewals", [
      // R1 changes; a new one says what R2 says, so it takes R2's id; R3 is left out.
      { id: "R1", kind: "functional", statement: "Send the renewal letter 45 days before the end date.", priority: "must", sourceIds: [docs.notes.id] },
      { kind: "compliance", statement: "delete renewal data after 7 years", priority: "must", sourceIds: [docs.policy.id] },
      { kind: "non-functional", statement: "Letters are generated within 2 minutes.", priority: "should", sourceIds: [docs.notes.id] },
    ]);
    expect(seen[1]!.items.map((i) => [i.key, i.note])).toEqual([
      ["R1", "Changed"],
      ["R2", "Changed"],
      ["n1", "New"],
      ["R3", "Kept from before"],
    ]);
    expect(out.dropped).toEqual(["R3"]);
    expect(out.requirements.map((r) => r.id)).toEqual(["R1", "R2", "R4"]);
    expect(out.requirements[0]!.statement).toContain("45 days");
    expect(requirements.get("renewals", "R2")!.statement).toBe("delete renewal data after 7 years");
    expect(requirements.get("renewals", "R2")!.createdAt).toBe(before.createdAt);
    expect(requirements.get("renewals", "R3")!.status).toBe("dropped");

    // Proposing R3 again shows it as dropped before; confirming brings it back with its id.
    choose = {};
    const back = await proposeRequirements(kit, "renewals", [{ kind: "functional", statement: "Send a reminder by SMS", priority: "could", sourceIds: [docs.notes.id] }]);
    expect(seen[2]!.items.map((i) => [i.key, i.note])).toEqual([
      ["R3", "Dropped before, proposed again"],
      ["R1", "Kept from before"],
      ["R2", "Kept from before"],
      ["R4", "Kept from before"],
    ]);
    expect(back.requirements.map((r) => r.id)).toEqual(["R1", "R2", "R3", "R4"]);
  });

  it("stops before the page on errors, and changes nothing when the user rejects or the request expires", async () => {
    const { kit, seen, requirements, docs } = await setup();
    const bad = await proposeRequirements(kit, "renewals", [{ id: "R7", kind: "functional", statement: "Send the letter", priority: "must", sourceIds: [docs.notes.id] }]);
    expect(bad.status).toBe("invalid");
    expect(bad.findings.some((f) => f.level === "error" && f.where === "R7")).toBe(true);
    expect(seen).toHaveLength(0);

    for (const status of ["rejected", "expired"] as const) {
      kit.reviewer = { review: async (req) => ({ status, missed: [], digest: requestDigest(req), comment: "Not now, Karim Haddad" }) };
      const out = await proposeRequirements(kit, "renewals", [{ kind: "functional", statement: "Send the letter", priority: "must", sourceIds: [docs.notes.id] }]);
      expect(out.status).toBe(status);
      expect(out.comment).toMatch(/^Not now, \[PERSON_\d+\]$/);
      expect(requirements.list("renewals", { dropped: true })).toEqual([]);
    }

    // A decision about other content than what was shown is refused.
    kit.reviewer = { review: async () => ({ status: "approved", missed: [], digest: "other", selected: ["n1"] }) };
    await expect(proposeRequirements(kit, "renewals", [{ kind: "functional", statement: "Send the letter", priority: "must", sourceIds: [docs.notes.id] }])).rejects.toThrow(/does not match/);
    expect(requirements.list("renewals")).toEqual([]);
  });

  it("refuses a statement that repeats a kept requirement, and gives an existing id to one new twin only", async () => {
    const { kit, seen, requirements, docs } = await setup();
    await proposeRequirements(kit, "renewals", [
      { kind: "functional", statement: "Send the renewal letter.", priority: "must", sourceIds: [docs.notes.id] },
      { kind: "functional", statement: "Log the call.", priority: "must", sourceIds: [docs.notes.id] },
    ]);
    // R1 rewritten to say what R2, kept from before, says.
    const rewrite = await proposeRequirements(kit, "renewals", [{ id: "R1", kind: "functional", statement: "Log the call", priority: "must", sourceIds: [docs.notes.id] }]);
    expect(rewrite.status).toBe("invalid");
    expect(rewrite.findings.filter((f) => f.level === "error").map((f) => `${f.where}: ${f.message}`)).toEqual([
      "R1: Says the same as R2, which the context keeps; revise R2 with its id instead, or say something else.",
    ]);
    // Two new items both say what R1 says: the first takes R1, the second is reported in its own place.
    const twins = await proposeRequirements(kit, "renewals", [
      { kind: "functional", statement: "send the renewal letter", priority: "must", sourceIds: [docs.notes.id] },
      { kind: "functional", statement: "Send the renewal letter", priority: "must", sourceIds: [docs.notes.id] },
    ]);
    expect(twins.findings.filter((f) => f.level === "error").map((f) => `${f.where}: ${f.message}`)).toEqual(["new 2: Says the same as R1; keep one of them."]);
    expect(seen).toHaveLength(1);
    expect(requirements.list("renewals").map((r) => r.statement)).toEqual(["Send the renewal letter.", "Log the call."]);
  });

  it("matches a new statement to the requirement in use, not a dropped one that says the same", async () => {
    const { kit, seen, requirements, docs } = await setup();
    requirements.save("renewals", [
      { kind: "functional", statement: "Send the letter", priority: "must", status: "dropped", sourceIds: [docs.notes.id] },
      { kind: "functional", statement: "Send the letter.", priority: "must", status: "confirmed", origin: "user", sourceIds: [] },
    ]);
    await proposeRequirements(kit, "renewals", [{ kind: "functional", statement: "Send the letter", priority: "should", sourceIds: [docs.notes.id] }]);
    expect(seen[0]!.items.map((i) => [i.key, i.note])).toEqual([["R2", "Changed"]]);
  });

  it("does not add typed lines that repeat a kept requirement or each other", async () => {
    const { kit, requirements, docs } = await setup(() => ({ lines: ["send the letter.", "Call the client", "call the client"] }));
    const out = await proposeRequirements(kit, "renewals", [{ kind: "functional", statement: "Send the letter", priority: "must", sourceIds: [docs.notes.id] }]);
    expect(out.repeatedLines).toBe(2);
    expect(out.typed).toEqual(["R2"]);
    expect(requirements.list("renewals").map((r) => r.statement)).toEqual(["Send the letter", "Call the client"]);
  });

  it("saves nothing when the requirements or the context changed while the user decided", async () => {
    const { kit, requirements, docs } = await setup();
    const proposal = [{ kind: "functional" as const, statement: "Send the letter", priority: "must" as const, sourceIds: [docs.notes.id] }];
    const approve = kit.reviewer.review;
    // Another confirmation saved meanwhile.
    kit.reviewer = {
      review: async (req) => {
        requirements.save("renewals", [{ kind: "functional", statement: "Something else", priority: "could", status: "confirmed", sourceIds: [docs.notes.id] }]);
        return approve(req);
      },
    };
    const out = await proposeRequirements(kit, "renewals", proposal);
    expect(out.status).toBe("changed");
    expect(requirements.list("renewals").map((r) => r.statement)).toEqual(["Something else"]);
    // The context deleted meanwhile: it is not brought back.
    kit.reviewer = {
      review: async (req) => {
        kit.contexts.delete("renewals");
        return approve(req);
      },
    };
    expect((await proposeRequirements(kit, "renewals", [{ ...proposal[0]!, statement: "Send the letter now" }])).status).toBe("changed");
    expect(kit.contexts.get("renewals")).toBeUndefined();
    expect(requirements.list("renewals", { dropped: true })).toEqual([]);
  });

  it("refuses an approval that does not say what the user kept", async () => {
    const { kit, requirements, docs } = await setup();
    await proposeRequirements(kit, "renewals", [{ kind: "functional", statement: "Send the letter", priority: "must", sourceIds: [docs.notes.id] }]);
    kit.reviewer = { review: async (req) => ({ status: "approved", missed: [], digest: requestDigest(req) }) };
    await expect(proposeRequirements(kit, "renewals", [{ kind: "functional", statement: "Log the call", priority: "must", sourceIds: [docs.notes.id] }])).rejects.toThrow(/which requirements the user kept/);
    expect(requirements.list("renewals").map((r) => r.id)).toEqual(["R1"]);
  });

  it("puts the checks' warnings on the page with the real values", async () => {
    const { kit, seen, docs } = await setup();
    await proposeRequirements(kit, "renewals", [{ kind: "functional", statement: "Send the letter", priority: "must", sourceIds: [docs.notes.id, docs.design.id] }]);
    expect(seen[0]!.warnings).toEqual([
      `new 1: Source ${docs.design.id} ("Design v1") is not an input but something the agents wrote or the org's metadata; cite the inputs it comes from.`,
      `${docs.policy.id}: "Security policy" is not cited by any requirement, and it mentions security or compliance.`,
    ]);
  });
});
