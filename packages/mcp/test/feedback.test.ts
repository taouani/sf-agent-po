import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AtlassianError, type AtlassianClient } from "@sf-agent-po/connectors";
import { ContextRepository, Database, FeedbackRepository, Masker, newVaultKey, Vault, WorkflowRepository, RequirementRepository, type EntityDetector, type Span } from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, createServer, requestDigest, type Backlog, type Reviewer } from "../src/index.js";
import { changedShare, compareStory, criteriaCount, storyBody, words } from "../src/feedback.js";

const fakeModel =
  (names: readonly string[]): EntityDetector =>
  async (text) => {
    const spans: Span[] = [];
    for (const name of names) for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) spans.push({ start: i, end: i + name.length, type: "PER", source: "ner" });
    return spans;
  };

/** Jira as publishing and the diff use it. */
function fakeJira() {
  const issues = new Map<string, { fields: Record<string, any>; updated: number }>();
  let next = 1;
  let clock = 0;
  const reads: string[] = [];
  const client = {
    getProject: async (key: string) => ({ key, name: "Portal", issueTypes: ["Epic", "Story"], subtaskTypes: [] }),
    createIssue: async (fields: Record<string, any>) => {
      const key = `PORT-${next++}`;
      issues.set(key, { fields: structuredClone(fields), updated: ++clock });
      return { key, url: `https://acme.atlassian.net/browse/${key}` };
    },
    getIssueState: async (key: string) => {
      const i = issues.get(key);
      if (!i) throw new AtlassianError("Issue does not exist", 404);
      return { updated: String(i.updated), summary: i.fields.summary, labels: i.fields.labels ?? [] };
    },
    updateIssue: async (key: string, fields: Record<string, any>) => {
      Object.assign(issues.get(key)!.fields, structuredClone(fields));
      return { key, url: `https://acme.atlassian.net/browse/${key}` };
    },
    linkBlocks: async () => {},
    getStory: async (key: string, pointsField?: string) => {
      reads.push(`${key}:${pointsField ?? ""}`);
      const i = issues.get(key);
      if (!i) return undefined;
      return { summary: i.fields.summary, description: i.fields.description, status: i.fields.status ?? "In Progress", updated: String(i.updated), ...(pointsField && typeof i.fields[pointsField] === "number" && { points: i.fields[pointsField] }) };
    },
  };
  return { client: client as unknown as AtlassianClient, issues, reads };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function connect() {
  const db = new Database(":memory:");
  const contexts = new ContextRepository(db);
  const masker = new Masker({ vault: new Vault(db, newVaultKey()), model: fakeModel(["Karim Benali", "Lea Martin"]) });
  const approval = new ApprovalServer();
  const jira = fakeJira();
  const feedback = new FeedbackRepository(db);
  const runs = new WorkflowRepository(db);
  const reviewer: Reviewer = { review: async (req) => ({ status: "approved", missed: [], digest: requestDigest(req) }) };
  const server = createServer({
    contexts,
    masker,
    approval,
    recognizer: async () => Promise.reject(new Error("no OCR")),
    version: "1.0.0",
    reviewer: () => reviewer,
    atlassian: () => jira.client,
    feedback,
    workflows: { requirements: new RequirementRepository(db), runs },
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(async () => {
    await client.close();
    await approval.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: r.isError, text: r.content.map((c) => c.text).join("\n") };
  };
  await call("context_add_text", { context: "acme", title: "Call", content: "Karim Benali owns the VIP flag. Lea Martin sets it.", kind: "meeting-notes" });
  return { call, contexts, jira, feedback, runs, masker };
}

const story = (id: string, summary: string, want: string, criteria = 1): Backlog["epics"][number]["stories"][number] => ({
  id,
  type: "story",
  summary,
  persona: "Renewals agent",
  want,
  benefit: "I treat VIPs first",
  acceptanceCriteria: Array.from({ length: criteria }, (_, i) => ({ given: `a VIP account ${i}`, when: "I open it", then: "the flag shows" })),
  storyPoints: 3,
});

const backlog = (): Backlog => ({
  title: "VIP flag backlog",
  epics: [
    {
      id: "E1",
      summary: "VIP flag for [PERSON_1]",
      outcome: "Agents see which customers are VIPs at a glance.",
      stories: [
        story("S1", "Show the VIP flag", "to see the VIP flag that [PERSON_2] sets"),
        story("S2", "Set the VIP flag", "to set the flag on an account from its page, with a reason that the team reviews every month"),
        story("S3", "Report on VIPs", "a report of the accounts flagged as VIP this quarter"),
        story("S4", "Export the VIP list", "an export of the VIP accounts"),
      ],
    },
  ],
});

/** The text of an ADF document, edited by `f`. */
const editText = (node: any, f: (t: string) => string): any => ({ ...node, ...(node.text !== undefined && { text: f(node.text) }), ...(node.content && { content: node.content.map((c: any) => editText(c, f)) }) });

describe("comparing a story with Jira", () => {
  it("counts the share of words changed and the acceptance criteria", () => {
    expect(words("The VIP-flag, shown!")).toEqual(["the", "vip", "flag", "shown"]);
    expect(changedShare(["a", "b", "c", "d"], ["a", "b", "c", "d"])).toBe(0);
    expect(changedShare(["a", "b", "c", "d"], ["a", "b", "x", "d"])).toBeCloseTo(0.25);
    expect(changedShare(["a", "b"], ["c", "d"])).toBe(1);
    expect(changedShare([], [])).toBe(0);
    const text = "As a user...\n\n### Acceptance criteria\n\n- Given a when b then c\n- Given d when e then f\n\n### Technical notes\n\n- not a criterion\n\n#### Sources\n\n- Call (doc-1)\n\nGenerated by sf-agent-po from backlog \"X\".";
    expect(criteriaCount(text)).toBe(2);
    expect(criteriaCount("No heading\n- item")).toBe(0);
    expect(storyBody(text)).not.toContain("Sources");
    expect(storyBody(text)).toContain("Technical notes");

    const sent = { summary: "Show the flag", text, points: 3 };
    expect(compareStory(sent, { ...sent, text: `${text}\n\n#### Sources\n\n- another` }).value).toBe("unchanged");
    expect(compareStory(sent, { ...sent, points: 5 })).toMatchObject({ value: "minor", points: [3, 5] });
    expect(compareStory(sent, { ...sent, summary: "Show the VIP flag" }).value).toBe("minor");
    expect(compareStory(sent, { ...sent, text: text.replace("- Given d when e then f\n", "") })).toMatchObject({ value: "major", criteria: [2, 1] });
    expect(compareStory(sent, { ...sent, text: "Rewritten from scratch by the team." }).value).toBe("major");
    // The threshold is a setting: past it is major.
    const small = { ...sent, summary: "Show the whole flag" };
    expect(compareStory(sent, small, 0.01).value).toBe("major");
  });
});

describe("feedback_jira_diff", () => {
  it("compares each published story with Jira in memory, records the guess, and returns no Jira text", async () => {
    const { call, contexts, jira, feedback } = await connect();
    const saved = await call("backlog_save", { context: "acme", backlog: backlog() });
    const id = /as (doc-\w+)/.exec(saved.text)![1]!;
    expect((await call("feedback_jira_diff", { context: "acme", artifactId: id })).text).toContain("has not been published to Jira yet");
    expect((await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT", storyPointsField: "customfield_10016" })).isError).toBeFalsy();
    const keys = Object.fromEntries([...jira.issues].map(([k, i]) => [i.fields.summary, k]));
    // What the team did in Jira: S1 untouched (it holds a real name), S2 a word changed and its
    // points, S3 a criterion added and a secret note, S4 deleted.
    const s2 = jira.issues.get(keys["Set the VIP flag"]!)!.fields;
    s2.description = editText(s2.description, (t) => t.replace("every month", "each month"));
    s2.customfield_10016 = 5;
    const s3 = jira.issues.get(keys["Report on VIPs"]!)!.fields;
    s3.description = editText(s3.description, (t) => t.replace("this quarter", "this quarter, CONFIDENTIAL for Karim Benali"));
    const list = s3.description.content.find((n: any) => n.type === "orderedList");
    list.content.push(structuredClone(list.content[0]));
    jira.issues.delete(keys["Export the VIP list"]!);

    const r = await call("feedback_jira_diff", { context: "acme", artifactId: id, model: "Opus 5.5 on Copilot" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Jira diff of "VIP flag backlog" in project PORT: 4 of 4 published stories compared, model label "Opus 5.5 on Copilot".');
    expect(r.text).toContain("1 unchanged, 1 minor edit(s), 1 major edit(s), 1 deleted (major: more than 30% of the words changed, or a criterion added or removed).");
    expect(r.text).toContain("So far 2 of 4 (50%) show no major edit, against the 90% target.");
    expect(r.text).toMatch(/- S1 PORT-\d+ "Show the VIP flag": unchanged \(status In Progress\)/);
    expect(r.text).toMatch(/- S2 PORT-\d+ "Set the VIP flag": minor edit \(\d+% of the words changed, story points 3 → 5, status In Progress\)/);
    expect(r.text).toMatch(/- S3 PORT-\d+ "Report on VIPs": major edit \(\d+% of the words changed, acceptance criteria 1 → 2, status In Progress\)/);
    expect(r.text).toMatch(/- S4 PORT-\d+ "Export the VIP list": deleted in Jira/);
    // Neither Jira's text nor a real name comes back.
    expect(r.text).not.toMatch(/CONFIDENTIAL|Karim|Lea/);
    // The points field given at publish is read back.
    expect(jira.reads.every((k) => k.endsWith(":customfield_10016"))).toBe(true);

    const rows = feedback.list("acme", { artifact: id });
    expect(rows.map((f) => `${f.item}:${f.value}`)).toEqual(["S1:unchanged", "S2:minor", "S3:major", "S4:deleted"]);
    expect(rows[2]).toMatchObject({ kind: "jira_diff", role: "", model: "Opus 5.5 on Copilot", details: { criteria: [1, 2], status: "In Progress", majorEditShare: 0.3 } });
    expect(JSON.stringify(rows)).not.toMatch(/CONFIDENTIAL|Karim|Lea/);
    expect(contexts.get("acme")!.settings.model).toBe("Opus 5.5 on Copilot");

    // Run again with a stricter threshold: the rows are replaced, not added to.
    const strict = await call("feedback_jira_diff", { context: "acme", artifactId: id, majorEditShare: 0.01 });
    expect(strict.text).toContain("0 minor edit(s), 2 major edit(s)");
    expect(feedback.list("acme", { artifact: id })).toHaveLength(4);
    expect(contexts.get("acme")!.settings.majorEditShare).toBe(0.01);
  });

  it("compares a backlog published before what was sent was kept, while it was not saved again", async () => {
    const { call, contexts } = await connect();
    const saved = await call("backlog_save", { context: "acme", backlog: backlog() });
    const id = /as (doc-\w+)/.exec(saved.text)![1]!;
    await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    // As an earlier version left it: no snapshot of what was sent.
    const doc = contexts.getDocument("acme", id)!;
    const meta = doc.metadata as any;
    for (const item of Object.values(meta.jira.items) as any[]) delete item.sent;
    contexts.upsertDocument("acme", doc.source, (d) => ({ ...d!, metadata: meta }));
    const r = await call("feedback_jira_diff", { context: "acme", artifactId: id });
    expect(r.text).toContain("4 unchanged, 0 minor edit(s), 0 major edit(s), 0 deleted");
    expect(r.text).toContain("No model label is set for this context");

    const edited = backlog();
    edited.epics[0]!.stories[0]!.benefit = "I serve VIPs first";
    await call("backlog_save", { context: "acme", backlog: edited });
    const again = await call("feedback_jira_diff", { context: "acme", artifactId: id });
    expect(again.text).toContain("0 of 4 published stories compared");
    expect(again.text).toContain("not compared: published before the diff kept what was sent, and the backlog was saved again since");
  });
});

describe("FeedbackRepository", () => {
  it("replaces an entry by artifact, item, kind and role, and checks values and roles", () => {
    const db = new Database(":memory:");
    const repo = new FeedbackRepository(db);
    repo.record([{ context: "acme", artifact: "doc-1", item: "S1", kind: "verdict", role: "po", value: "accepted" }]);
    repo.record([
      { context: "acme", artifact: "doc-1", item: "S1", kind: "verdict", role: "po", value: "major", comment: "[PERSON_1] rewrote it" },
      { context: "acme", artifact: "doc-1", item: "S1", kind: "verdict", role: "dev", value: "accepted" },
      { context: "acme", artifact: "doc-1", item: "Data model", kind: "rating", role: "sa", value: "4" },
    ]);
    expect(repo.list("acme").map((f) => `${f.item}:${f.kind}:${f.role}:${f.value}`)).toEqual(["Data model:rating:sa:4", "S1:verdict:dev:accepted", "S1:verdict:po:major"]);
    expect(repo.list("acme", { kind: "rating" })).toHaveLength(1);
    expect(() => repo.record([{ context: "acme", artifact: "d", item: "S1", kind: "verdict", role: "po", value: "fine" }])).toThrow(/not a verdict value/);
    expect(() => repo.record([{ context: "acme", artifact: "d", item: "S1", kind: "rating", role: "sa", value: "6" }])).toThrow(/rating from 1 to 5/);
    expect(() => repo.record([{ context: "acme", artifact: "d", item: "S1", kind: "verdict", value: "accepted" }])).toThrow(/name who gave them/);
    expect(() => repo.record([{ context: "acme", artifact: "d", item: "S1", kind: "jira_diff", role: "po", value: "minor" }])).toThrow(/no role/);
    expect(() => repo.record([{ context: "acme", artifact: "d", item: "S1", kind: "verdict", role: "boss" as never, value: "accepted" }])).toThrow(/Unknown role/);
    // A failed batch writes nothing.
    expect(() =>
      repo.record([
        { context: "acme", artifact: "doc-2", item: "S1", kind: "verdict", role: "po", value: "accepted" },
        { context: "acme", artifact: "doc-2", item: "S2", kind: "verdict", role: "po", value: "nope" },
      ]),
    ).toThrow();
    expect(repo.list("acme", { artifact: "doc-2" })).toEqual([]);
  });
});
