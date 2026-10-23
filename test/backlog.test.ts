import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Backlog, backlogToMarkdown, checkBacklog } from "../src/artifacts/backlog.js";
import type { SourceDocument } from "../src/context/types.js";
import { type FakeRequest, idFrom, startServer, tokenFrom } from "./helpers.js";

const ac = (then: string) => ({ given: "a policy due for renewal", when: "the agent opens it", then });

function sampleBacklog(overrides: Partial<Backlog> = {}): Backlog {
  return {
    title: "Policy renewal portal backlog",
    epics: [
      {
        id: "E1",
        summary: "Online policy renewal",
        outcome: "Policyholders renew online without calling an agent.",
        priority: "must",
        sourceIds: ["doc-notes"],
        stories: [
          {
            id: "S1",
            type: "story",
            summary: "Renew a policy online",
            persona: "Policyholder",
            want: "to renew my policy in the portal",
            benefit: "I stay covered without calling",
            acceptanceCriteria: [ac("the renewal quote is shown with the new premium")],
            storyPoints: 5,
            priority: "must",
            sourceIds: ["doc-notes"],
          },
          {
            id: "S2",
            type: "story",
            summary: "Enforce MFA for portal users",
            persona: "Security officer",
            want: "portal users to sign in with MFA",
            benefit: "policyholder data stays protected",
            acceptanceCriteria: [{ given: "a portal user", when: "they sign in", then: "a second factor is required" }],
            dependsOn: ["S1"],
            sourceIds: ["doc-security"],
          },
        ],
      },
      {
        id: "E2",
        summary: "Renewal reminders for agents",
        outcome: "Agents are told about renewals 30 days ahead.",
        stories: [
          {
            id: "S3",
            type: "spike",
            summary: "Confirm reminder channel with the business",
            persona: "Renewals agent",
            want: "to know whether reminders come by email or in Salesforce",
            benefit: "we build the right channel",
            acceptanceCriteria: [{ given: "the spike", when: "it is done", then: "the chosen channel is documented in the HLD" }],
            sourceIds: ["doc-notes"],
          },
        ],
      },
    ],
    ...overrides,
  };
}

const doc = (id: string, kind: SourceDocument["kind"], title: string, content: string): SourceDocument => ({
  id,
  kind,
  title,
  source: id,
  content,
  addedAt: "",
});

describe("checkBacklog", () => {
  const docs = [doc("doc-notes", "meeting-notes", "Kickoff", "Renew online"), doc("doc-security", "email", "Security requirements", "MFA is mandatory")];

  it("passes a clean backlog", () => {
    expect(checkBacklog(sampleBacklog(), docs).filter((f) => f.level !== "info")).toEqual([]);
  });

  it("flags structural errors, weak stories and untraced security inputs", () => {
    const b = sampleBacklog();
    b.epics[0].stories[0].persona = "user";
    b.epics[0].stories[0].storyPoints = 13;
    b.epics[0].stories[0].acceptanceCriteria.push(ac("the page loads fast"));
    b.epics[0].stories[1].dependsOn = ["S9"];
    b.epics[0].stories[1].sourceIds = [];
    b.epics[1].stories[0].id = "S1";
    b.epics[1].stories[0].jiraKey = "PORT-1";
    b.epics[0].stories[0].jiraKey = "PORT-1";
    const findings = checkBacklog(b, docs);
    const msgs = findings.map((f) => `${f.level} ${f.where}: ${f.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^error S1: Id S1 is used 2 times/),
        expect.stringMatching(/^error S1: Jira issue PORT-1 is also set/),
        expect.stringMatching(/^error S2: Depends on S9/),
        expect.stringMatching(/^warning S1: Persona "user" is generic/),
        expect.stringMatching(/^warning S1: At 13 points/),
        expect.stringMatching(/^warning S1 AC2: "fast" is not testable/),
        expect.stringMatching(/^warning doc-security: "Security requirements" mentions security/),
      ]),
    );
  });

  it("finds dependency cycles, won't-have conflicts and off-scale points, and accepts Salesforce terms", () => {
    const b = sampleBacklog();
    b.epics[0].stories[0].dependsOn = ["S2"];
    b.epics[0].stories[0].storyPoints = 21;
    b.epics[0].stories[0].acceptanceCriteria.push(ac("a Renew quick action is shown on the policy"));
    b.epics[1].priority = "wont";
    b.epics[1].stories[0].priority = "must";
    b.epics[0].stories[1].dependsOn = ["S1", "S3"];
    const msgs = checkBacklog(b, docs).map((f) => `${f.level} ${f.where}: ${f.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        "error S1: Circular dependency: S1 depends on S2 depends on S1. None of these stories can start first.",
        "warning S1: Story points 21 is not on the 1, 2, 3, 5, 8, 13 scale.",
        "warning S2: Depends on S3, which is won't have and is not published to Jira.",
        "warning S3: Priority is must but epic E2 is won't have, so the story is not published to Jira.",
      ]),
    );
    expect(msgs.filter((m) => m.startsWith("error"))).toHaveLength(1);
    expect(msgs.some((m) => m.includes("quick"))).toBe(false);
  });

  it("renders Markdown with ids, user stories and Given/When/Then", () => {
    const md = backlogToMarkdown(sampleBacklog());
    expect(md).toContain("## E1: Online policy renewal");
    expect(md).toContain("### S3: Confirm reminder channel with the business (spike)");
    expect(md).toContain("As a Policyholder, I want to renew my policy in the portal, so that I stay covered without calling.");
    expect(md).toContain("1. **Given** a policy due for renewal **when** the agent opens it **then** the renewal quote is shown");
    expect(md).toContain("Depends on: S1");
  });
});

/** A stateful fake Jira project with Epic and Story types. */
function fakeJira(opts: { failOnSummary?: string; failStateReads?: boolean } = {}) {
  let next = 1;
  let clock = 0;
  const stamp = () => `2026-10-24T00:00:${String(clock++).padStart(2, "0")}.000+0000`;
  const issues = new Map<string, any>([["PORT-99", { summary: "Old story", labels: ["team-a", "moscow-could"], updated: stamp() }]]);
  const handler = (req: FakeRequest) => {
    if (req.path === "/rest/api/3/project/PORT") {
      return { body: { key: "PORT", name: "Portal", issueTypes: [{ name: "Epic" }, { name: "Story" }, { name: "Task" }, { name: "Subtask", subtask: true }] } };
    }
    if (req.method === "POST" && req.path === "/rest/api/3/issue") {
      if (opts.failOnSummary && req.body.fields.summary === opts.failOnSummary) {
        opts.failOnSummary = undefined; // fail once
        return { status: 400, body: { errors: { summary: "rejected" } } };
      }
      const key = `PORT-${next++}`;
      issues.set(key, { ...req.body.fields, updated: stamp() });
      return { status: 201, body: { id: String(next), key } };
    }
    const put = req.path.match(/^\/rest\/api\/3\/issue\/(PORT-\d+)$/);
    if (req.method === "PUT" && put && issues.has(put[1])) {
      Object.assign(issues.get(put[1]), req.body.fields, { updated: stamp() });
      return { status: 204, body: "" };
    }
    const get = req.path.match(/^\/rest\/api\/3\/issue\/(PORT-\d+)\?fields=updated,summary,parent,labels$/);
    if (req.method === "GET" && get && issues.has(get[1])) {
      if (opts.failStateReads) return { status: 500, body: { errorMessages: ["unavailable"] } };
      const i = issues.get(get[1]);
      return { body: { key: get[1], fields: { updated: i.updated, summary: i.summary, labels: i.labels ?? [], ...(i.parent ? { parent: { key: i.parent.key } } : {}) } } };
    }
    if (req.method === "POST" && req.path === "/rest/api/3/issueLink") {
      // Like Jira, a new link changes both issues' updated time.
      for (const side of [req.body.inwardIssue.key, req.body.outwardIssue.key]) issues.get(side).updated = stamp();
      return { status: 201, body: "" };
    }
    return undefined;
  };
  /** Simulates someone editing an issue directly in Jira. */
  const editInJira = (key: string) => (issues.get(key).updated = stamp());
  return Object.assign(handler, { issues, editInJira, opts });
}

describe("Product Owner tools", () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  afterEach(() => s.close());

  describe("with a working Jira", () => {
    let jira: ReturnType<typeof fakeJira>;
    beforeEach(async () => {
      jira = fakeJira();
      s = await startServer(jira);
    });

    it("exposes the PO prompts", async () => {
      const { prompts } = await s.client.listPrompts();
      expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(["po_backlog", "po_review_stories"]));
      const p = await s.client.getPrompt({ name: "po_backlog", arguments: { context: "renewal" } });
      const body = (p.messages[0].content as { text: string }).text;
      expect(body).toContain('`context: "renewal"`');
      expect(body).toContain("Given / When / Then");
      expect(body).toContain("backlog_save");
    });

    it("saves, checks and returns the backlog for revision", async () => {
      const saved = await s.call("backlog_save", { backlog: sampleBacklog() });
      expect(saved.isError).toBeFalsy();
      expect(saved.text).toContain("version 1 (2 epics, 3 stories, status draft)");
      expect(saved.text).toContain("Quality check:");
      const id = idFrom(saved.text);

      const json = JSON.parse((await s.call("backlog_get", { artifactId: id })).text);
      expect(json.epics[0].stories[1].dependsOn).toEqual(["S1"]);

      const read = await s.call("context_read", { kinds: ["backlog"] });
      expect(read.text).toContain("## E1: Online policy renewal");
      expect(read.text).not.toContain('"backlog":');
    });

    it("makes a new version when only labels or Jira keys change", async () => {
      const b = sampleBacklog();
      expect((await s.call("backlog_save", { backlog: b })).text).toContain("version 1");
      expect((await s.call("backlog_save", { backlog: b })).text).toContain("version 1");
      b.epics[0].stories[0].labels = ["renewals"];
      expect((await s.call("backlog_save", { backlog: b })).text).toContain("version 2");
      b.epics[0].jiraKey = "PORT-40";
      expect((await s.call("backlog_save", { backlog: b })).text).toContain("version 3");
    });

    it("rejects an invalid backlog shape", async () => {
      const bad = sampleBacklog();
      (bad.epics[0].stories[0] as any).acceptanceCriteria = [];
      const r = await s.call("backlog_save", { backlog: bad });
      expect(r.isError).toBe(true);
    });

    it("publishes epics, then stories under them, then dependency links, and updates only what changed", async () => {
      const id = idFrom((await s.call("backlog_save", { backlog: sampleBacklog() })).text);
      const target = { artifactId: id, projectKey: "PORT", storyPointsField: "customfield_10016" };

      const preview = await s.call("jira_publish_preview", target);
      expect(preview.text).toContain("5 to create, 0 to update, 0 unchanged, 0 skipped, 1 dependency link(s) to add");
      expect(preview.text).toContain("- S1 blocks S2");
      expect(s.requests.filter((r) => r.method !== "GET")).toEqual([]);

      expect((await s.call("jira_publish", { ...target, approvalToken: "AAAAAAAAAAAAAAAAAAAAAA" })).isError).toBe(true);
      expect((await s.call("jira_publish", { ...target, storyPointsField: undefined, approvalToken: tokenFrom(preview.text) })).isError).toBe(true);

      const published = await s.call("jira_publish", { ...target, approvalToken: tokenFrom(preview.text) });
      expect(published.isError).toBeFalsy();
      expect(published.text).toContain("Linked PORT-2 blocks PORT-3");
      const posts = s.requests.filter((r) => r.method === "POST" && r.path === "/rest/api/3/issue").map((r) => r.body.fields);
      expect(posts.map((f) => [f.summary, f.issuetype.name, f.parent?.key])).toEqual([
        ["Online policy renewal", "Epic", undefined],
        ["Renew a policy online", "Story", "PORT-1"],
        ["Enforce MFA for portal users", "Story", "PORT-1"],
        ["Renewal reminders for agents", "Epic", undefined],
        ["Confirm reminder channel with the business", "Story", "PORT-4"],
      ]);
      expect(posts[1].customfield_10016).toBe(5);
      expect(posts[1].labels).toEqual(["sf-agent-po", "moscow-must"]);
      expect(posts[4].labels).toEqual(["sf-agent-po", "spike"]);
      expect(posts[1].description.type).toBe("doc");
      expect(JSON.stringify(posts[1].description)).toContain("the renewal quote is shown with the new premium");
      const link = s.requests.find((r) => r.path === "/rest/api/3/issueLink")!;
      // In this endpoint the inward issue is the blocker: PORT-2 (S1) blocks PORT-3 (S2).
      expect(link.body).toEqual({ type: { name: "Blocks" }, inwardIssue: { key: "PORT-2" }, outwardIssue: { key: "PORT-3" } });

      const again = await s.call("jira_publish_preview", target);
      expect(again.text).toContain("0 to create, 0 to update, 5 unchanged, 0 skipped, 0 dependency link(s) to add");

      const revised = sampleBacklog();
      revised.epics[0].stories[0].acceptanceCriteria.push({ given: "an expired policy", when: "the policyholder opens it", then: "renewal is refused with a reason" });
      expect((await s.call("backlog_save", { backlog: revised })).text).toContain("version 2");
      const stale = await s.call("jira_publish", { ...target, approvalToken: tokenFrom(preview.text) });
      expect(stale.isError).toBe(true);

      const updatePreview = await s.call("jira_publish_preview", target);
      expect(updatePreview.text).toContain("0 to create, 1 to update, 4 unchanged");
      expect(updatePreview.text).toContain("- S1 Renew a policy online: update PORT-2\n");
      // The link added in the first publish is not mistaken for an edit made in Jira.
      expect(updatePreview.text).not.toContain("WARNING");
      expect(updatePreview.text).toContain("overwrites the summary and description");
      expect(updatePreview.text).toContain("Labels added in Jira, status, assignee and comments are kept.");
      const before = s.requests.length;
      const updated = await s.call("jira_publish", { ...target, approvalToken: tokenFrom(updatePreview.text) });
      expect(updated.isError).toBeFalsy();
      expect(updated.text).toContain("Updated PORT-2 Renew a policy online");
      const writes = s.requests.slice(before).filter((r) => r.method !== "GET");
      expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /rest/api/3/issue/PORT-2"]);
      // The story stays where it is: no parent is sent when it does not move.
      expect(writes[0].body.fields.parent).toBeUndefined();

      expect((await s.call("jira_publish_preview", { ...target, projectKey: "OTHER" })).text).toContain("was published to Jira project PORT");
    });

    it("updates existing issues named by jiraKey instead of creating them", async () => {
      const b = sampleBacklog();
      b.epics = [b.epics[1]];
      b.epics[0].stories[0].jiraKey = "PORT-99";
      const id = idFrom((await s.call("backlog_save", { backlog: b })).text);
      const preview = await s.call("jira_publish_preview", { artifactId: id, projectKey: "PORT" });
      expect(preview.text).toContain('S3 Confirm reminder channel with the business: update PORT-99; now "Old story"; moves from no epic to the new epic E2');
      const r = await s.call("jira_publish", { artifactId: id, projectKey: "PORT", approvalToken: tokenFrom(preview.text) });
      expect(r.isError).toBeFalsy();
      expect(r.text).toContain("Updated PORT-99 Confirm reminder channel with the business, now under epic PORT-1");
      const put = s.requests.find((r) => r.method === "PUT")!;
      expect(put.path).toBe("/rest/api/3/issue/PORT-99");
      expect(put.body.fields.parent).toEqual({ key: "PORT-1" });
      // A label another team added stays; the old MoSCoW label is replaced.
      expect(put.body.fields.labels).toEqual(["team-a", "sf-agent-po", "spike"]);
    });

    it("rejects jiraKeys outside the project, and two items on one issue", async () => {
      const b = sampleBacklog();
      b.epics[1].stories[0].jiraKey = "OTHER-3";
      const id = idFrom((await s.call("backlog_save", { backlog: b })).text);
      const target = { artifactId: id, projectKey: "PORT" };
      expect((await s.call("jira_publish_preview", target)).text).toContain("S3 revises OTHER-3, which is not in project PORT.");

      delete b.epics[1].stories[0].jiraKey;
      await s.call("backlog_save", { backlog: b });
      await s.call("jira_publish", { ...target, approvalToken: tokenFrom((await s.call("jira_publish_preview", target)).text) });
      b.epics[1].stories.push({ ...b.epics[1].stories[0], id: "S4", jiraKey: "PORT-2" });
      await s.call("backlog_save", { backlog: b });
      const r = await s.call("jira_publish_preview", target);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("S1 and S4 both point at PORT-2");
    });

    it("skips won't-have items and their links, and lists issues no longer in the backlog", async () => {
      const id = idFrom((await s.call("backlog_save", { backlog: sampleBacklog() })).text);
      const target = { artifactId: id, projectKey: "PORT" };
      await s.call("jira_publish", { ...target, approvalToken: tokenFrom((await s.call("jira_publish_preview", target)).text) });

      const b = sampleBacklog();
      b.epics[1].stories = [];
      b.epics[1].priority = "wont";
      b.epics[0].stories.push({ ...b.epics[0].stories[0], id: "S5", summary: "Renew with a payment plan", priority: "wont", dependsOn: undefined, storyPoints: 3 });
      b.epics[0].stories[1].dependsOn = ["S1", "S5"];
      const saved = await s.call("backlog_save", { backlog: b });
      expect(saved.text).toContain("ERROR [E2] Epic has no stories.");
      b.epics[1].stories = [{ ...sampleBacklog().epics[1].stories[0], id: "S6", summary: "Confirm the escalation channel" }];
      await s.call("backlog_save", { backlog: b });

      const preview = await s.call("jira_publish_preview", target);
      expect(preview.text).toContain("0 to create, 0 to update, 3 unchanged, 3 skipped, 0 dependency link(s) to add");
      expect(preview.text).toContain("- E2 Renewal reminders for agents: skipped, won't have; PORT-4 is left as it is in Jira");
      expect(preview.text).toContain("  - S5 Renew with a payment plan: skipped, won't have\n");
      expect(preview.text).toContain("  - S6 Confirm the escalation channel: skipped, its epic E2 is won't have");
      expect(preview.text).toContain("No longer in this backlog, left as they are in Jira: S3 (PORT-5)");

      const before = s.requests.length;
      const r = await s.call("jira_publish", { ...target, approvalToken: tokenFrom(preview.text) });
      expect(r.text).toContain("Nothing to publish");
      expect(r.text).toContain("Skipped 3 won't-have item(s)");
      expect(s.requests.slice(before).filter((q) => q.method !== "GET")).toEqual([]);
    });

    it("recreates a deleted epic and moves its stories under the new one", async () => {
      const id = idFrom((await s.call("backlog_save", { backlog: sampleBacklog() })).text);
      const target = { artifactId: id, projectKey: "PORT" };
      await s.call("jira_publish", { ...target, approvalToken: tokenFrom((await s.call("jira_publish_preview", target)).text) });
      jira.issues.delete("PORT-1");

      const preview = await s.call("jira_publish_preview", target);
      expect(preview.text).toContain("1 to create, 2 to update, 2 unchanged");
      expect(preview.text).toContain("- E1 Online policy renewal: create Epic (its earlier issue PORT-1 was deleted)");
      expect(preview.text).toContain("  - S1 Renew a policy online: update PORT-2; moves from epic PORT-1 to the new epic E1");
      const r = await s.call("jira_publish", { ...target, approvalToken: tokenFrom(preview.text) });
      expect(r.isError).toBeFalsy();
      expect(r.text).toContain("Created PORT-6 Online policy renewal");
      expect(r.text).toContain("Updated PORT-3 Enforce MFA for portal users, now under epic PORT-6");
      expect(jira.issues.get("PORT-2").parent).toEqual({ key: "PORT-6" });
      expect((await s.call("jira_publish_preview", target)).text).toContain("0 to create, 0 to update, 5 unchanged");
    });

    it("moves a story back when it was put under another epic in Jira", async () => {
      const id = idFrom((await s.call("backlog_save", { backlog: sampleBacklog() })).text);
      const target = { artifactId: id, projectKey: "PORT" };
      await s.call("jira_publish", { ...target, approvalToken: tokenFrom((await s.call("jira_publish_preview", target)).text) });
      jira.issues.get("PORT-2").parent = { key: "PORT-4" };

      const preview = await s.call("jira_publish_preview", target);
      expect(preview.text).toContain("S1 Renew a policy online: update PORT-2; moves from epic PORT-4 to PORT-1");
    });

    it("runs one publish at a time, so a repeated call cannot create duplicates", async () => {
      const id = idFrom((await s.call("backlog_save", { backlog: sampleBacklog() })).text);
      const target = { artifactId: id, projectKey: "PORT" };
      const token = tokenFrom((await s.call("jira_publish_preview", target)).text);
      const results = await Promise.all([s.call("jira_publish", { ...target, approvalToken: token }), s.call("jira_publish", { ...target, approvalToken: token })]);
      expect(results.filter((r) => r.isError)).toHaveLength(1);
      expect(s.requests.filter((r) => r.method === "POST" && r.path === "/rest/api/3/issue")).toHaveLength(5);
    });

    it("keeps the mapping when Jira cannot be read back after a write", async () => {
      const id = idFrom((await s.call("backlog_save", { backlog: sampleBacklog() })).text);
      const target = { artifactId: id, projectKey: "PORT" };
      const preview = await s.call("jira_publish_preview", target);
      jira.opts.failStateReads = true;
      const r = await s.call("jira_publish", { ...target, approvalToken: tokenFrom(preview.text) });
      expect(r.isError).toBeFalsy();
      jira.opts.failStateReads = false;
      expect((await s.call("jira_publish_preview", target)).text).toContain("0 to create, 0 to update, 5 unchanged");
    });

    it("warns about edits made in Jira, recreates deleted issues, and rejects a token after Jira changed", async () => {
      const id = idFrom((await s.call("backlog_save", { backlog: sampleBacklog() })).text);
      const target = { artifactId: id, projectKey: "PORT" };
      await s.call("jira_publish", { ...target, approvalToken: tokenFrom((await s.call("jira_publish_preview", target)).text) });

      const revised = sampleBacklog();
      revised.epics[0].stories[0].summary = "Renew a home or motor policy online";
      revised.epics[1].stories[0].summary = "Confirm the reminder channel";
      await s.call("backlog_save", { backlog: revised });
      jira.editInJira("PORT-2");
      jira.issues.delete("PORT-5");

      const preview = await s.call("jira_publish_preview", target);
      expect(preview.text).toContain(
        'S1 Renew a home or motor policy online: update PORT-2; now "Renew a policy online"; WARNING: edited in Jira since the last publish',
      );
      expect(preview.text).toContain("S3 Confirm the reminder channel: create Story (its earlier issue PORT-5 was deleted)");

      jira.editInJira("PORT-2"); // edited again after the preview
      expect((await s.call("jira_publish", { ...target, approvalToken: tokenFrom(preview.text) })).isError).toBe(true);

      const again = await s.call("jira_publish_preview", target);
      const done = await s.call("jira_publish", { ...target, approvalToken: tokenFrom(again.text) });
      expect(done.isError).toBeFalsy();
      expect(done.text).toContain("Created PORT-6 Confirm the reminder channel");
      expect((await s.call("jira_publish_preview", target)).text).not.toContain("WARNING");
    });

    it("explains a missing issue type", async () => {
      const id = idFrom((await s.call("backlog_save", { backlog: sampleBacklog() })).text);
      const r = await s.call("jira_publish_preview", { artifactId: id, projectKey: "PORT", storyIssueType: "User Story" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('no issue type "User Story". Available: Epic, Story, Task');
    });
  });

  it("resumes after a failure part-way without duplicating issues", async () => {
    s = await startServer(fakeJira({ failOnSummary: "Enforce MFA for portal users" }));
    const id = idFrom((await s.call("backlog_save", { backlog: sampleBacklog() })).text);
    const target = { artifactId: id, projectKey: "PORT" };

    const preview = await s.call("jira_publish_preview", target);
    const failed = await s.call("jira_publish", { ...target, approvalToken: tokenFrom(preview.text) });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("Created PORT-1 Online policy renewal");
    expect(failed.text).toContain("Created PORT-2 Renew a policy online");
    expect(failed.text).toContain("Progress is saved");

    const resume = await s.call("jira_publish_preview", target);
    expect(resume.text).toContain("3 to create, 0 to update, 2 unchanged");
    const resumed = await s.call("jira_publish", { ...target, approvalToken: tokenFrom(resume.text) });
    expect(resumed.isError).toBeFalsy();
    expect(resumed.text).toContain("Linked PORT-2 blocks PORT-3");
    const created = s.requests.filter((r) => r.method === "POST" && r.path === "/rest/api/3/issue").map((r) => r.body.fields.summary);
    expect(created.filter((t) => t === "Renew a policy online")).toHaveLength(1);
    expect(created.filter((t) => t === "Enforce MFA for portal users")).toHaveLength(2); // the failed attempt and the retry
  });
});

describe("Jira publish confirmation through elicitation", () => {
  it("writes nothing when the user declines", async () => {
    const s = await startServer(fakeJira(), { elicit: () => ({ action: "decline" }) });
    try {
      const id = idFrom((await s.call("backlog_save", { backlog: sampleBacklog() })).text);
      const preview = await s.call("jira_publish_preview", { artifactId: id, projectKey: "PORT" });
      const r = await s.call("jira_publish", { artifactId: id, projectKey: "PORT", approvalToken: tokenFrom(preview.text) });
      expect(r.isError).toBe(true);
      expect(s.elicitations).toEqual(["Create 5 and update 0 issue(s) in Jira project PORT, and add 1 dependency link(s)?"]);
      expect(s.requests.filter((q) => q.method !== "GET")).toEqual([]);
    } finally {
      await s.close();
    }
  });
});
