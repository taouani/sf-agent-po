import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AtlassianError, type AtlassianClient } from "@sf-agent-po/connectors";
import { ContextRepository, Database, FeedbackRepository, Masker, MAX_PUBLISHED_TEXT, newVaultKey, Vault, WorkflowRepository, RequirementRepository, type EntityDetector, type Span } from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, createServer, requestDigest, type ApprovalRequest, type Backlog, type Decision, type FeedbackRequest, type Reviewer } from "../src/index.js";
import { changedShare, compareStory, criteriaInAdf, designSections, storyBody, words } from "../src/feedback.js";

const fakeModel =
  (names: readonly string[]): EntityDetector =>
  async (text) => {
    const spans: Span[] = [];
    for (const name of names) for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) spans.push({ start: i, end: i + name.length, type: "PER", source: "ner" });
    return spans;
  };

/** Jira as publishing and the diff use it. */
function fakeJira() {
  const issues = new Map<string, { fields: Record<string, any>; updated: number; status?: "new" | "indeterminate" | "done" }>();
  let next = 1;
  let clock = 0;
  const reads: string[] = [];
  const hooks: { project?: () => void; read?: () => Promise<void> } = {};
  const client = {
    getProject: async (key: string) => {
      hooks.project?.();
      return { key, name: "Portal", issueTypes: ["Epic", "Story"], subtaskTypes: [] };
    },
    createIssue: async (fields: Record<string, any>) => {
      const key = `PORT-${next++}`;
      issues.set(key, { fields: structuredClone(fields), updated: ++clock });
      return { key, url: `https://acme.atlassian.net/browse/${key}` };
    },
    getIssueState: async (key: string) => {
      const i = issues.get(key);
      if (!i) throw new AtlassianError("Issue does not exist", 404);
      return { updated: String(i.updated), summary: i.fields.summary, labels: i.fields.labels ?? [], ...(i.fields.parent && { parentKey: i.fields.parent.key }) };
    },
    updateIssue: async (key: string, fields: Record<string, any>) => {
      const i = issues.get(key)!;
      Object.assign(i.fields, structuredClone(fields));
      i.updated = ++clock;
      return { key, url: `https://acme.atlassian.net/browse/${key}` };
    },
    linkBlocks: async () => {},
    getStories: async (keys: readonly string[], pointsField?: string) => {
      await hooks.read?.();
      const out = new Map<string, unknown>();
      for (const key of keys) {
        reads.push(`${key}:${pointsField ?? ""}`);
        const i = issues.get(key);
        if (!i) continue;
        out.set(key, {
          summary: i.fields.summary,
          description: i.fields.description,
          status: i.status ?? "indeterminate",
          updated: String(i.updated),
          ...(pointsField && typeof i.fields[pointsField] === "number" && { points: i.fields[pointsField] }),
        });
      }
      return out;
    },
  };
  return { client: client as unknown as AtlassianClient, issues, reads, hooks };
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
  // The page's answer: approved as shown, unless a test sets what the user does.
  const page: { answer?: (req: ApprovalRequest) => Partial<Decision>; shown: ApprovalRequest[] } = { shown: [] };
  const reviewer: Reviewer = {
    review: async (req) => {
      page.shown.push(req);
      return { status: "approved", missed: [], ...(req.kind === "feedback" ? page.answer?.(req) : {}), digest: requestDigest(req) };
    },
  };
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
  return { call, contexts, jira, feedback, runs, masker, db, page };
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

/** An ADF description with an "Acceptance criteria" heading and a list of `n` items. */
const adfStory = (n: number, extra: any[] = []) => ({
  type: "doc",
  version: 1,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "As a user..." }] },
    { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Acceptance criteria" }] },
    { type: "orderedList", content: Array.from({ length: n }, (_, i) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `Given ${i}` }] }] })) },
    ...extra,
  ],
});

const publishedRows = (db: Database, id: string) => db.db.prepare("SELECT item FROM published_story WHERE artifact = ? ORDER BY item").all(id) as { item: string }[];

describe("comparing a story with Jira", () => {
  it("counts the share of words changed, in any language", () => {
    expect(words("The VIP-flag, shown!")).toEqual(["the", "vip", "flag", "shown"]);
    // Chinese and Japanese have no spaces: still split into words.
    expect(words("显示贵宾标志").length).toBeGreaterThan(1);
    expect(words("Ｃａｆé")).toEqual(words("Ｃａｆé".normalize("NFC")));
    expect(changedShare(["a", "b", "c", "d"], ["a", "b", "c", "d"])).toBe(0);
    expect(changedShare(["a", "b", "c", "d"], ["a", "b", "x", "d"])).toBeCloseTo(0.25);
    expect(changedShare(["a", "b"], ["c", "d"])).toBe(1);
    expect(changedShare([], [])).toBe(0);
    expect(words(Array.from({ length: 5000 }, () => "w").join(" "))).toHaveLength(3000);
  });

  it("counts acceptance criteria from Jira's document, not its text", () => {
    expect(criteriaInAdf(adfStory(2))).toBe(2);
    // Sub-bullets the team added under a criterion are not criteria.
    const nested = adfStory(2);
    (nested.content[2] as any).content[0].content.push({ type: "bulletList", content: [{ type: "listItem", content: [] }, { type: "listItem", content: [] }] });
    expect(criteriaInAdf(nested)).toBe(2);
    // A list under a later heading is not counted; a heading with no list has none.
    const later = { ...adfStory(0), content: [adfStory(0).content[1], { type: "heading", content: [{ type: "text", text: "Notes" }] }, { type: "bulletList", content: [{ type: "listItem" }] }] };
    expect(criteriaInAdf(later)).toBe(0);
    // A paragraph reading only "Acceptance criteria:" counts as the heading.
    expect(criteriaInAdf({ content: [{ type: "paragraph", content: [{ type: "text", text: "Acceptance criteria:" }] }, { type: "bulletList", content: [{ type: "listItem" }] }] })).toBe(1);
    // No heading left: unknown, not zero.
    expect(criteriaInAdf({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Rewritten" }] }] })).toBeUndefined();
    expect(criteriaInAdf(undefined)).toBeUndefined();
  });

  it("finds major and minor edits", () => {
    const text = "As a user...\n\n### Acceptance criteria\n\n- Given a when b then c\n- Given d when e then f\n\n### Technical notes\n\n- not a criterion\n\n#### Sources\n\n- Call (doc-1)\n\nGenerated by sf-agent-po from backlog \"X\".";
    expect(storyBody(text)).not.toContain("Sources");
    expect(storyBody(text)).toContain("Technical notes");
    expect(storyBody("Body\n\nGenerated by sf-agent-po from backlog")).toBe("Body\n\n");

    const sent = { summary: "Show the flag", text, criteria: 2, points: 3 };
    // What the publisher adds at the end is not compared: a source added there is no edit.
    expect(compareStory(sent, { ...sent, text: text.replace("- Call (doc-1)", "- Call (doc-1)\n- Another (doc-2)") }).value).toBe("unchanged");
    expect(compareStory(sent, { ...sent, points: 5 })).toMatchObject({ value: "minor", points: [3, 5] });
    // Points only one side has are not an edit.
    expect(compareStory({ ...sent, points: undefined }, { ...sent, points: 5 })).toEqual({ value: "unchanged", changedShare: 0, criteria: [2, 2] });
    expect(compareStory(sent, { summary: sent.summary, text, criteria: 2 }).value).toBe("unchanged");
    expect(compareStory(sent, { ...sent, summary: "Show the VIP flag" }).value).toBe("minor");
    expect(compareStory(sent, { ...sent, criteria: 1 })).toMatchObject({ value: "major", criteria: [2, 1] });
    // No heading left: the words decide.
    expect(compareStory(sent, { summary: sent.summary, text })).toMatchObject({ value: "unchanged", criteria: [2, undefined] });
    expect(compareStory(sent, { ...sent, text: "Rewritten from scratch by the team." }).value).toBe("major");
    // The threshold is a setting: past it is major.
    expect(compareStory(sent, { ...sent, summary: "Show the whole flag" }, 0.01).value).toBe("major");
  });
});

/** Saves the backlog and publishes it; returns its id and the Jira key of each story by summary. */
async function published(c: Awaited<ReturnType<typeof connect>>, b = backlog(), args: Record<string, unknown> = {}) {
  const saved = await c.call("backlog_save", { context: "acme", backlog: b });
  const id = /as (doc-\w+)/.exec(saved.text)![1]!;
  const r = await c.call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT", ...args });
  expect(r.isError).toBeFalsy();
  const keys = Object.fromEntries([...c.jira.issues].map(([k, i]) => [i.fields.summary, k]));
  return { id, keys };
}

describe("feedback_jira_diff", () => {
  it("compares each published story with Jira in memory, records the guess, and returns no Jira text", async () => {
    const c = await connect();
    const { call, contexts, jira, feedback } = c;
    const saved = await call("backlog_save", { context: "acme", backlog: backlog() });
    const id = /as (doc-\w+)/.exec(saved.text)![1]!;
    expect((await call("feedback_jira_diff", { context: "acme", artifactId: id })).text).toContain("has not been published to Jira yet");
    expect((await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT", storyPointsField: "customfield_10016" })).isError).toBeFalsy();
    // What was sent is kept, masked, outside the artifact.
    expect(publishedRows(c.db, id).map((r) => r.item)).toEqual(["S1", "S2", "S3", "S4"]);
    expect(JSON.stringify(contexts.getDocument("acme", id)!.metadata)).not.toContain("Given a VIP account");
    expect(JSON.stringify([...feedback.sent("acme", id).values()])).not.toMatch(/Karim|Lea/);
    expect(feedback.sent("acme", id).get("S1")).toMatchObject({ criteria: 1, points: 3, pointsField: "customfield_10016", truncated: false });

    const keys = Object.fromEntries([...jira.issues].map(([k, i]) => [i.fields.summary, k]));
    // What the team did in Jira: S1 untouched (it holds a real name), S2 a word changed and its
    // points, S3 a criterion added and a secret note, S4 deleted.
    const s2 = jira.issues.get(keys["Set the VIP flag"]!)!.fields;
    s2.description = editText(s2.description, (t) => t.replace("every month", "each month"));
    s2.customfield_10016 = 5;
    const s3 = jira.issues.get(keys["Report on VIPs"]!)!;
    s3.fields.description = editText(s3.fields.description, (t) => t.replace("this quarter", "this quarter, CONFIDENTIAL for Karim Benali"));
    s3.status = "done";
    const list = s3.fields.description.content.find((n: any) => n.type === "orderedList");
    list.content.push(structuredClone(list.content[0]));
    jira.issues.delete(keys["Export the VIP list"]!);

    const r = await call("feedback_jira_diff", { context: "acme", artifactId: id, model: "Opus 5.5 on Copilot" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Jira diff of "VIP flag backlog" in project PORT: 4 of 4 published stories compared, model label "Opus 5.5 on Copilot".');
    expect(r.text).toContain("1 unchanged, 1 minor edit(s), 1 major edit(s), 1 deleted (major: more than 30% of the words changed, or a criterion added or removed).");
    expect(r.text).toContain("So far 2 of 4 (50%) show no major edit, against the 90% target.");
    expect(r.text).toMatch(/- S1 PORT-\d+ "Show the VIP flag": unchanged \(status in progress\)/);
    expect(r.text).toMatch(/- S2 PORT-\d+ "Set the VIP flag": minor edit \(\d+% of the words changed, story points 3 → 5, status in progress\)/);
    expect(r.text).toMatch(/- S3 PORT-\d+ "Report on VIPs": major edit \(\d+% of the words changed, acceptance criteria 1 → 2, status done\)/);
    expect(r.text).toMatch(/- S4 PORT-\d+ "Export the VIP list": deleted in Jira, or no longer visible to this login/);
    // Neither Jira's text nor a real name comes back.
    expect(r.text).not.toMatch(/CONFIDENTIAL|Karim|Lea/);
    // One bulk read, with the points field given at publish.
    expect(jira.reads).toHaveLength(4);
    expect(jira.reads.every((k) => k.endsWith(":customfield_10016"))).toBe(true);

    const rows = feedback.list("acme", { artifact: id });
    expect(rows.map((f) => `${f.item}:${f.value}`)).toEqual(["S1:unchanged", "S2:minor", "S3:major", "S4:deleted"]);
    expect(rows[2]).toMatchObject({ kind: "jira_diff", role: "", model: "Opus 5.5 on Copilot", artifactVersion: 1, details: { criteria: [1, 2], status: "done", majorEditShare: 0.3 } });
    expect(JSON.stringify(rows)).not.toMatch(/CONFIDENTIAL|Karim|Lea/);
    expect(contexts.get("acme")!.settings.model).toBe("Opus 5.5 on Copilot");

    // Run again with a stricter threshold: the rows are replaced, not added to.
    const strict = await call("feedback_jira_diff", { context: "acme", artifactId: id, majorEditShare: 0.01 });
    expect(strict.text).toContain("0 minor edit(s), 2 major edit(s)");
    expect(feedback.list("acme", { artifact: id })).toHaveLength(4);
    expect(contexts.get("acme")!.settings.majorEditShare).toBe(0.01);
  });

  it("keeps the diff of each published version, and drops a story taken out of the backlog", async () => {
    const c = await connect();
    const { id } = await published(c);
    await c.call("feedback_jira_diff", { context: "acme", artifactId: id });
    const edited = backlog();
    edited.epics[0]!.stories[1]!.benefit = "I serve VIPs first";
    edited.epics[0]!.stories.pop();
    await c.call("backlog_save", { context: "acme", backlog: edited });
    expect((await c.call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" })).isError).toBeFalsy();
    expect(c.feedback.sent("acme", id).get("S2")!.artifactVersion).toBe(2);
    expect(c.feedback.sent("acme", id).get("S1")!.artifactVersion).toBe(1);

    const r = await c.call("feedback_jira_diff", { context: "acme", artifactId: id });
    expect(r.text).toContain("3 of 3 published stories compared");
    const rows = c.feedback.list("acme", { artifact: id });
    expect(rows.map((f) => `${f.item}@${f.artifactVersion}:${f.value}`)).toEqual(["S1@1:unchanged", "S2@1:unchanged", "S3@1:unchanged", "S2@2:unchanged"]);
  });

  it("refuses when the login cannot see the project or any of its stories, and records nothing", async () => {
    const c = await connect();
    const { id } = await published(c);
    c.jira.hooks.project = () => {
      throw new AtlassianError("Forbidden", 403);
    };
    const r = await c.call("feedback_jira_diff", { context: "acme", artifactId: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Jira refused to show project PORT (HTTP 403)");
    delete c.jira.hooks.project;
    c.jira.issues.clear();
    const none = await c.call("feedback_jira_diff", { context: "acme", artifactId: id });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("Jira returned none of the 4 published stories of project PORT");
    expect(c.feedback.list("acme")).toEqual([]);
  });

  it("leaves out a story published again while it compared", async () => {
    const c = await connect();
    const { id } = await published(c);
    c.jira.hooks.read = async () => {
      const s1 = c.feedback.sent("acme", id).get("S1")!;
      await new Promise((r) => setTimeout(r, 5));
      c.feedback.saveSent([{ ...s1 }]);
    };
    const r = await c.call("feedback_jira_diff", { context: "acme", artifactId: id });
    expect(r.text).toContain("3 of 4 published stories compared");
    expect(r.text).toMatch(/- S1 PORT-\d+ "Show the VIP flag": not compared, published again while comparing/);
    expect(c.feedback.list("acme").map((f) => f.item)).toEqual(["S2", "S3", "S4"]);
  });

  it("compares a backlog published before what was sent was kept, only when its hash proves what was sent", async () => {
    const c = await connect();
    const { id } = await published(c);
    // As an earlier version left it: nothing kept of what was sent.
    c.db.db.prepare("DELETE FROM published_story").run();
    const r = await c.call("feedback_jira_diff", { context: "acme", artifactId: id });
    expect(r.text).toContain("4 unchanged, 0 minor edit(s), 0 major edit(s), 0 deleted");
    expect(r.text).toContain("No model label is set for this context");

    const edited = backlog();
    edited.epics[0]!.stories[0]!.benefit = "I serve VIPs first";
    await c.call("backlog_save", { context: "acme", backlog: edited });
    const again = await c.call("feedback_jira_diff", { context: "acme", artifactId: id });
    expect(again.text).toContain("3 of 4 published stories compared");
    expect(again.text).toMatch(/- S1 PORT-\d+ "Show the VIP flag": not compared, what was sent is not known/);
  });

  it("rebuilds what was sent with the points field given, and keeps unchanged stories on the next publish", async () => {
    const c = await connect();
    const { id } = await published(c, backlog(), { storyPointsField: "customfield_10016" });
    c.db.db.prepare("DELETE FROM published_story").run();
    // Without the field the rebuilt stories do not match what was sent.
    expect((await c.call("feedback_jira_diff", { context: "acme", artifactId: id })).text).toContain("0 of 4 published stories compared");
    const r = await c.call("feedback_jira_diff", { context: "acme", artifactId: id, storyPointsField: "customfield_10016" });
    expect(r.text).toContain("4 unchanged");
    expect(c.jira.reads.at(-1)).toMatch(/:customfield_10016$/);
    // Published again with nothing to change: what was sent is kept from then on.
    const again = await c.call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT", storyPointsField: "customfield_10016" });
    expect(again.text).toContain("Nothing to publish");
    expect(publishedRows(c.db, id).map((row) => row.item)).toEqual(["S1", "S2", "S3", "S4"]);
    expect(c.feedback.sent("acme", id).get("S1")).toMatchObject({ points: 3, pointsField: "customfield_10016" });
  });
});

const HLD = "# VIP flag: high-level design\n\n## 1. Context\n\nKarim Benali asked for it.\n\n## 3. Solution\n\nA checkbox.\n\n```md\n## Not a section\n```\n\n## 4. Data model ##\n\nOne field.\n\n## 4. Data model\n\nAgain.";

describe("design sections", () => {
  it("are the second-level headings outside code, with ids that survive renumbering", () => {
    expect(designSections(HLD)).toEqual([
      { id: "context", title: "1. Context" },
      { id: "solution", title: "3. Solution" },
      { id: "data-model", title: "4. Data model" },
      { id: "data-model-2", title: "4. Data model" },
    ]);
    expect(designSections("## 12. Sécurité et accès")[0]!.id).toBe("securite-et-acces");
    expect(designSections("## 显示")[0]!.id).toBe("显示");
    expect(designSections("## ***")[0]!.id).toBe("section");
    expect(designSections(Array.from({ length: 50 }, (_, i) => `## S${i}`).join("\n"))).toHaveLength(40);
  });
});

describe("feedback_review", () => {
  /** A published backlog whose first story cites a design, with a Jira diff run. */
  async function reviewed() {
    const c = await connect();
    const design = await c.call("design_save", { context: "acme", title: "VIP flag HLD", designType: "high-level", content: HLD });
    const designId = /(doc-[0-9a-f]{10})/.exec(design.text)![1]!;
    const b = backlog();
    b.epics[0]!.stories[0]!.sourceIds = [designId];
    const { id, keys } = await published(c, b);
    const s2 = c.jira.issues.get(keys["Set the VIP flag"]!)!.fields;
    s2.description = editText(s2.description, (t) => t.replace("every month", "each month"));
    await c.call("feedback_jira_diff", { context: "acme", artifactId: id });
    return { ...c, id, designId };
  }

  it("shows the stories with the Jira diff's guess and the design's sections, in clear, and records what the user saves", async () => {
    const c = await reviewed();
    c.page.answer = (req) => {
      const r = req as FeedbackRequest;
      return { role: "po", model: "Opus 5.5 on Copilot", verdicts: { S1: "accepted", S2: "major" }, ratings: { [r.sections[0]!.key]: { value: 4, comment: "Karim Benali liked it" }, [r.sections[1]!.key]: { value: 2 } } };
    };
    const r = await c.call("feedback_review", { context: "acme", artifactId: c.id });
    expect(r.isError).toBeFalsy();
    const shown = c.page.shown.at(-1) as FeedbackRequest;
    expect(shown).toMatchObject({ kind: "feedback", title: "VIP flag backlog", askModel: true });
    expect(shown.stories.map((st) => `${st.item}:${st.guess}:${st.verdict}`)).toEqual(["S1:unchanged:accepted", "S2:minor:minor", "S3:unchanged:accepted", "S4:unchanged:accepted"]);
    expect(shown.stories[1]).toMatchObject({ key: expect.stringMatching(/^PORT-\d+$/), url: expect.stringMatching(/^https:\/\/acme\.atlassian\.net\/browse\//), detail: expect.stringMatching(/% of the words changed/) });
    // The page is in clear: the real name is back in the summary and the design.
    expect(JSON.stringify(shown)).not.toMatch(/\[PERSON_\d+\]/);
    expect(shown.sections.map((sec) => sec.key.split(":")[1])).toEqual(["context", "solution", "data-model", "data-model-2"]);
    expect(shown.sections[0]).toMatchObject({ design: "VIP flag HLD", title: "1. Context" });

    expect(r.text).toContain('Recorded feedback from the Product Owner on "VIP flag backlog": 2 story verdict(s) (1 accepted, 1 major edit) and 2 design section rating(s), average 3.0 of 5.');
    expect(r.text).toContain("2 stories were left without a verdict");
    expect(r.text).toContain('The model label is now "Opus 5.5 on Copilot".');
    expect(r.text).not.toMatch(/Karim|Lea/);
    expect(c.contexts.get("acme")!.settings.model).toBe("Opus 5.5 on Copilot");

    const verdicts = c.feedback.list("acme", { kind: "verdict" });
    expect(verdicts.map((f) => `${f.item}:${f.role}:${f.value}`)).toEqual(["S1:po:accepted", "S2:po:major"]);
    expect(verdicts[1]).toMatchObject({ artifact: c.id, artifactVersion: 1, model: "Opus 5.5 on Copilot", details: { guess: "minor" } });
    const ratings = c.feedback.list("acme", { kind: "rating" });
    expect(ratings.map((f) => `${f.artifact === c.designId}:${f.item}:${f.value}`)).toEqual(["true:context:4", "true:solution:2"]);
    // The comment is masked before it is saved.
    expect(ratings[0]!.comment).toMatch(/^\[PERSON_\d+\] liked it$/);

    // Opened again: what was given is shown, and the model is not asked for again.
    c.page.answer = () => ({ role: "dev", verdicts: { S2: "minor" } });
    const again = await c.call("feedback_review", { context: "acme", artifactId: c.id });
    const second = c.page.shown.at(-1) as FeedbackRequest;
    expect(second.askModel).toBe(false);
    expect(second.stories[1]!.verdict).toBe("major");
    expect(second.sections[0]!.rating).toBe(4);
    expect(again.text).toContain("Recorded feedback from the dev team");
    // Each role keeps its own verdict.
    expect(c.feedback.list("acme", { kind: "verdict" }).map((f) => `${f.item}:${f.role}:${f.value}`)).toEqual(["S1:po:accepted", "S2:dev:minor", "S2:po:major"]);
  });

  it("records nothing when the user cancels, and refuses what cannot be reviewed", async () => {
    const c = await reviewed();
    c.page.answer = () => ({ status: "rejected" });
    expect((await c.call("feedback_review", { context: "acme", artifactId: c.id })).text).toContain("Nothing was recorded: the user cancelled the review.");
    c.page.answer = () => ({ status: "expired" });
    expect((await c.call("feedback_review", { context: "acme", artifactId: c.id })).text).toContain("did not send the page in time");
    expect(c.feedback.list("acme", { kind: "verdict" })).toEqual([]);

    const saved = await c.call("backlog_save", { context: "acme", backlog: { ...backlog(), title: "Other backlog" } });
    const draft = /as (doc-\w+)/.exec(saved.text)![1]!;
    expect((await c.call("feedback_review", { context: "acme", artifactId: draft })).text).toContain("has not been published to Jira yet");
    const input = c.contexts.documents("acme").find((d) => d.kind === "meeting-notes")!;
    expect((await c.call("feedback_review", { context: "acme", artifactId: input.id })).isError).toBe(true);
  });

  it("rates a design on its own", async () => {
    const c = await reviewed();
    c.page.answer = (req) => ({ role: "sa", ratings: { [(req as FeedbackRequest).sections[1]!.key]: { value: 5 } } });
    const r = await c.call("feedback_review", { context: "acme", artifactId: c.designId });
    expect((c.page.shown.at(-1) as FeedbackRequest).stories).toEqual([]);
    expect(r.text).toContain("Recorded feedback from the Solution Architect on \"VIP flag HLD\": 0 story verdict(s) and 1 design section rating(s), average 5.0 of 5.");
    expect(c.feedback.list("acme", { kind: "rating" })).toMatchObject([{ item: "solution", role: "sa", value: "5", artifactVersion: 1 }]);
  });
});

describe("FeedbackRepository", () => {
  const setup = () => {
    const db = new Database(":memory:");
    const contexts = new ContextRepository(db);
    contexts.ensure("acme");
    const [d1, d2] = contexts.addDocuments("acme", [
      { kind: "other", title: "Backlog", source: "artifact://backlog", content: "x" },
      { kind: "other", title: "Design", source: "artifact://design", content: "y" },
    ]);
    return { db, contexts, repo: new FeedbackRepository(db), d1: d1!.id, d2: d2!.id };
  };

  it("replaces an entry by artifact version, item, kind and role, and checks values and roles", () => {
    const { repo, d1, d2 } = setup();
    const v = { context: "acme", artifactVersion: 1 };
    repo.record([{ ...v, artifact: d1, item: "S1", kind: "verdict", role: "po", value: "accepted" }]);
    repo.record([
      { ...v, artifact: d1, item: "S1", kind: "verdict", role: "po", value: "major", comment: "[PERSON_1] rewrote it" },
      { ...v, artifact: d1, item: "S1", kind: "verdict", role: "dev", value: "accepted" },
      { ...v, artifact: d1, item: "Data model", kind: "rating", role: "sa", value: "4" },
      { ...v, artifactVersion: 2, artifact: d1, item: "S1", kind: "verdict", role: "po", value: "accepted" },
    ]);
    expect(repo.list("acme").map((f) => `${f.item}@${f.artifactVersion}:${f.kind}:${f.role}:${f.value}`)).toEqual([
      "Data model@1:rating:sa:4",
      "S1@1:verdict:dev:accepted",
      "S1@1:verdict:po:major",
      "S1@2:verdict:po:accepted",
    ]);
    expect(repo.list("acme", { kind: "rating" })).toHaveLength(1);
    const bad = (e: Record<string, unknown>) => () => repo.record([{ ...v, artifact: d1, item: "S1", ...e } as never]);
    expect(bad({ kind: "verdict", role: "po", value: "fine" })).toThrow(/not a verdict value/);
    expect(bad({ kind: "rating", role: "sa", value: "6" })).toThrow(/rating from 1 to 5/);
    expect(bad({ kind: "verdict", value: "accepted" })).toThrow(/name who gave them/);
    expect(bad({ kind: "jira_diff", role: "po", value: "minor" })).toThrow(/no role/);
    expect(bad({ kind: "verdict", role: "boss", value: "accepted" })).toThrow(/Unknown role/);
    expect(bad({ kind: "verdict", role: "po", value: "accepted", artifactVersion: 1.5 })).toThrow(/Not an artifact version/);
    // Feedback is on a document of the context.
    expect(bad({ kind: "verdict", role: "po", value: "accepted", artifact: "doc-missing" })).toThrow(/FOREIGN KEY/i);
    // A failed batch writes nothing.
    expect(() =>
      repo.record([
        { ...v, artifact: d2, item: "S1", kind: "verdict", role: "po", value: "accepted" },
        { ...v, artifact: d2, item: "S2", kind: "verdict", role: "po", value: "nope" },
      ]),
    ).toThrow();
    expect(repo.list("acme", { artifact: d2 })).toEqual([]);
  });

  it("records a Jira diff run: stale versions and removed items lose their rows, verdicts stay", () => {
    const { repo, d1 } = setup();
    const diff = (item: string, artifactVersion: number, value = "unchanged") => ({ context: "acme", artifact: d1, artifactVersion, item, kind: "jira_diff" as const, value });
    repo.recordJiraDiff("acme", d1, { results: [diff("S1", 1), diff("S2", 1), diff("S3", 1)], stale: [], items: ["S1", "S2", "S3"] });
    repo.record([{ context: "acme", artifact: d1, artifactVersion: 1, item: "S3", kind: "verdict", role: "po", value: "accepted" }]);
    repo.recordJiraDiff("acme", d1, { results: [diff("S1", 2, "minor")], stale: [{ item: "S2", artifactVersion: 1 }], items: ["S1", "S2"] });
    expect(repo.list("acme").map((f) => `${f.item}@${f.artifactVersion}:${f.kind}:${f.value}`)).toEqual(["S1@1:jira_diff:unchanged", "S3@1:verdict:accepted", "S1@2:jira_diff:minor"]);
    expect(() => repo.recordJiraDiff("acme", d1, { results: [{ ...diff("S1", 1), artifact: "other" }], stale: [], items: [] })).toThrow(/its own artifact/);
  });

  it("keeps what was sent per story, cut on a character, and deletes it with its document", () => {
    const { repo, contexts, d1 } = setup();
    const long = "a".repeat(MAX_PUBLISHED_TEXT - 1) + "😀" + "b";
    repo.saveSent([{ context: "acme", artifact: d1, item: "S1", artifactVersion: 1, issueKey: "PORT-1", summary: "S", text: long, criteria: 2 }]);
    const s1 = repo.sent("acme", d1).get("S1")!;
    expect(s1).toMatchObject({ truncated: true, criteria: 2, issueKey: "PORT-1" });
    expect(s1.text).toHaveLength(MAX_PUBLISHED_TEXT - 1);
    expect(s1.points).toBeUndefined();
    repo.saveSent([{ context: "acme", artifact: d1, item: "S1", artifactVersion: 2, issueKey: "PORT-1", summary: "T", text: "short", criteria: 1, points: 3, pointsField: "customfield_1" }]);
    expect(repo.sent("acme", d1).get("S1")).toMatchObject({ artifactVersion: 2, truncated: false, points: 3, pointsField: "customfield_1" });
    repo.record([{ context: "acme", artifact: d1, artifactVersion: 2, item: "S1", kind: "verdict", role: "po", value: "accepted" }]);
    contexts.removeDocument("acme", d1);
    expect(repo.sent("acme", d1).size).toBe(0);
    expect(repo.list("acme")).toEqual([]);
  });
});
