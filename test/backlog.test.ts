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
function fakeJira(opts: { failOnSummary?: string } = {}) {
  let next = 1;
  let clock = 0;
  const stamp = () => `2026-10-24T00:00:${String(clock++).padStart(2, "0")}.000+0000`;
  const issues = new Map<string, any>([["PORT-99", { summary: "Old story", updated: stamp() }]]);
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
      issues.get(put[1]).updated = stamp();
      return { status: 204, body: "" };
    }
    const get = req.path.match(/^\/rest\/api\/3\/issue\/(PORT-\d+)\?fields=updated$/);
    if (req.method === "GET" && get && issues.has(get[1])) return { body: { key: get[1], fields: { updated: issues.get(get[1]).updated } } };
    if (req.method === "POST" && req.path === "/rest/api/3/issueLink") return { status: 201, body: "" };
    return undefined;
  };
  /** Simulates someone editing an issue directly in Jira. */
  const editInJira = (key: string) => (issues.get(key).updated = stamp());
  return Object.assign(handler, { issues, editInJira });
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
      expect(preview.text).toContain("5 to create, 0 to update, 0 unchanged, 1 dependency link(s) to add");
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
      expect(link.body).toEqual({ type: { name: "Blocks" }, outwardIssue: { key: "PORT-2" }, inwardIssue: { key: "PORT-3" } });

      const again = await s.call("jira_publish_preview", target);
      expect(again.text).toContain("0 to create, 0 to update, 5 unchanged, 0 dependency link(s) to add");

      const revised = sampleBacklog();
      revised.epics[0].stories[0].acceptanceCriteria.push({ given: "an expired policy", when: "the policyholder opens it", then: "renewal is refused with a reason" });
      expect((await s.call("backlog_save", { backlog: revised })).text).toContain("version 2");
      const stale = await s.call("jira_publish", { ...target, approvalToken: tokenFrom(preview.text) });
      expect(stale.isError).toBe(true);

      const updatePreview = await s.call("jira_publish_preview", target);
      expect(updatePreview.text).toContain("0 to create, 1 to update, 4 unchanged");
      expect(updatePreview.text).toContain("S1 Renew a policy online: update PORT-2");
      expect(updatePreview.text).toContain("overwrites the summary, description and labels");
      const before = s.requests.length;
      const updated = await s.call("jira_publish", { ...target, approvalToken: tokenFrom(updatePreview.text) });
      expect(updated.isError).toBeFalsy();
      expect(updated.text).toContain("Updated PORT-2 Renew a policy online");
      const writes = s.requests.slice(before).filter((r) => r.method !== "GET");
      expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /rest/api/3/issue/PORT-2"]);
      expect(writes[0].body.fields.parent).toEqual({ key: "PORT-1" });

      expect((await s.call("jira_publish_preview", { ...target, projectKey: "OTHER" })).text).toContain("was published to Jira project PORT");
    });

    it("updates existing issues named by jiraKey instead of creating them", async () => {
      const b = sampleBacklog();
      b.epics = [b.epics[1]];
      b.epics[0].stories[0].jiraKey = "PORT-99";
      const id = idFrom((await s.call("backlog_save", { backlog: b })).text);
      const preview = await s.call("jira_publish_preview", { artifactId: id, projectKey: "PORT" });
      expect(preview.text).toContain("S3 Confirm reminder channel with the business: update PORT-99");
      const r = await s.call("jira_publish", { artifactId: id, projectKey: "PORT", approvalToken: tokenFrom(preview.text) });
      expect(r.isError).toBeFalsy();
      const put = s.requests.find((r) => r.method === "PUT")!;
      expect(put.path).toBe("/rest/api/3/issue/PORT-99");
      expect(put.body.fields.parent).toEqual({ key: "PORT-1" });
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
      expect(preview.text).toContain("S1 Renew a home or motor policy online: update PORT-2 WARNING: edited in Jira since the last publish");
      expect(preview.text).toContain("S3 Confirm the reminder channel: create Story (its earlier issue was deleted)");

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
