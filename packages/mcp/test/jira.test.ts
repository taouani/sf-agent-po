import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AtlassianError, type AtlassianClient } from "@sf-agent-po/connectors";
import { ContextRepository, Database, Masker, newVaultKey, Vault, type EntityDetector, type Span } from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, createServer, mergeLabels, requestDigest, type ApprovalRequest, type Backlog, type Decision, type PublishRequest, type Reviewer } from "../src/index.js";

const fakeModel =
  (names: readonly string[]): EntityDetector =>
  async (text) => {
    const spans: Span[] = [];
    for (const name of names) for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) spans.push({ start: i, end: i + name.length, type: "PER", source: "ner" });
    return spans;
  };

type Issue = { fields: Record<string, any>; updated: number };

/** Jira as far as publishing uses it, recording every write. */
function fakeJira() {
  const issues = new Map<string, Issue>();
  const writes: { op: "create" | "update"; key: string; fields: Record<string, any> }[] = [];
  const links: string[] = [];
  let next = 1;
  let clock = 0;
  const fail: { on?: (op: string, fields: Record<string, any>) => boolean } = {};
  const client = {
    getProject: async (key: string) => {
      if (key !== "PORT") throw new AtlassianError("No project", 404);
      return { key, name: "Portal", issueTypes: ["Epic", "Story", "Task"] };
    },
    createIssue: async (fields: Record<string, any>) => {
      if (fail.on?.("create", fields)) throw new AtlassianError(`Bad request: summary "${fields.summary}" is invalid`, 400);
      const key = `PORT-${next++}`;
      issues.set(key, { fields: structuredClone(fields), updated: ++clock });
      writes.push({ op: "create", key, fields });
      return { key, url: `https://acme.atlassian.net/browse/${key}` };
    },
    getIssueState: async (key: string) => {
      const i = issues.get(key);
      if (!i) throw new AtlassianError("Issue does not exist", 404);
      return { updated: String(i.updated), summary: i.fields.summary, parentKey: i.fields.parent?.key, labels: i.fields.labels ?? [] };
    },
    updateIssue: async (key: string, fields: Record<string, any>) => {
      if (fail.on?.("update", fields)) throw new AtlassianError("Bad request", 400);
      const i = issues.get(key)!;
      Object.assign(i.fields, structuredClone(fields));
      i.updated = ++clock;
      writes.push({ op: "update", key, fields });
      return { key, url: `https://acme.atlassian.net/browse/${key}` };
    },
    linkBlocks: async (blocker: string, blocked: string) => {
      links.push(`${blocker}>${blocked}`);
      issues.get(blocker)!.updated = ++clock;
      issues.get(blocked)!.updated = ++clock;
    },
  };
  return { client: client as unknown as AtlassianClient, issues, writes, links, fail };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function connect(answers: (Partial<Omit<Decision, "digest">> | ((req: ApprovalRequest) => Decision))[] = []) {
  const db = new Database(":memory:");
  const vault = new Vault(db, newVaultKey());
  const contexts = new ContextRepository(db);
  const masker = new Masker({ vault, model: fakeModel(["Karim Benali", "Lea Martin"]) });
  const approval = new ApprovalServer();
  const jira = fakeJira();
  const seen: PublishRequest[] = [];
  const reviewer: Reviewer = {
    async review(req) {
      if (req.kind === "publish") seen.push(req);
      const a = answers.shift() ?? { status: "approved" };
      return typeof a === "function" ? a(req) : { status: "approved", missed: [], ...a, digest: requestDigest(req) };
    },
  };
  const server = createServer({ contexts, masker, approval, recognizer: async () => Promise.reject(new Error("no OCR")), version: "1.0.0", reviewer: () => reviewer, atlassian: () => jira.client });
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
  // An input, so the context knows Karim Benali as [PERSON_1] and the secret as [SECRET_1].
  await call("context_add_text", { context: "acme", title: "Call", content: "Karim Benali owns the VIP flag. Login secret: password: hunter22x", kind: "meeting-notes" });
  const input = contexts.documents("acme")[0]!;
  return { call, contexts, seen, jira, masker, input };
}

const backlog = (sourceId: string, over: (b: Backlog) => void = () => {}): Backlog => {
  const b: Backlog = {
    title: "VIP flag backlog",
    epics: [
      {
        id: "E1",
        summary: "VIP flag for [PERSON_1]",
        outcome: "Agents see which customers are VIPs at a glance.",
        priority: "must",
        sourceIds: [sourceId],
        stories: [
          {
            id: "S1",
            type: "story",
            summary: "Show the VIP flag",
            persona: "Renewals agent",
            want: "to see the VIP flag that Lea Martin sets",
            benefit: "I treat VIPs first",
            acceptanceCriteria: [{ given: "a VIP account", when: "I open it", then: "the flag shows, owned by [PERSON_1]" }],
            priority: "must",
            storyPoints: 3,
            labels: ["vip"],
          },
          {
            id: "S2",
            type: "story",
            summary: "Set the VIP flag",
            persona: "Sales manager",
            want: "to set the flag with the service login [SECRET_1]",
            benefit: "the agents know",
            acceptanceCriteria: [{ given: "an account", when: "I tick VIP", then: "it is saved" }],
            dependsOn: ["S1"],
          },
          {
            id: "S3",
            type: "story",
            summary: "Export the VIP list",
            persona: "Sales manager",
            want: "an export",
            benefit: "I can share it",
            acceptanceCriteria: [{ given: "VIPs", when: "I export", then: "a CSV is made" }],
            priority: "wont",
          },
        ],
      },
    ],
  };
  over(b);
  return b;
};

async function saveBacklog(call: Awaited<ReturnType<typeof connect>>["call"], b: Backlog) {
  const r = await call("backlog_save", { context: "acme", backlog: b });
  expect(r.isError).toBeFalsy();
  return { id: /as (doc-\w+)/.exec(r.text)![1]!, text: r.text };
}

describe("saving backlogs", () => {
  it("masks what the agent wrote in clear, keeps its pseudonyms and ids, and runs the check", async () => {
    const { call, contexts, input } = await connect();
    const { id, text } = await saveBacklog(call, backlog(input.id));
    expect(text).toContain('Saved backlog "VIP flag backlog"');
    expect(text).toContain("version 1 (1 epics, 3 stories, status draft)");
    expect(text).toContain("1 value(s) written in clear were masked");
    expect(text).toContain("Quality check:");
    expect(text).not.toMatch(/Lea|Karim/);
    const doc = contexts.getDocument("acme", id)!;
    expect(doc.masked).toBe(true);
    expect(doc.content).toContain("to see the VIP flag that [PERSON_2] sets");
    expect(doc.content).not.toMatch(/Lea|Karim/);
    const stored = (doc.metadata as { backlog: Backlog }).backlog;
    expect(stored.epics[0]!.stories[0]!.want).toBe("to see the VIP flag that [PERSON_2] sets");
    expect(stored.epics[0]!.stories[1]!.dependsOn).toEqual(["S1"]);

    const got = await call("backlog_get", { context: "acme", artifactId: id });
    expect(got.text).toContain('"want": "to see the VIP flag that [PERSON_2] sets"');
    expect((await call("backlog_save", { context: "acme", backlog: backlog(input.id) })).text).toContain("version 1");
  });
});

describe("publishing to Jira", () => {
  it("shows every issue with the real values, writes exactly that once approved, and tells the model only pseudonyms", async () => {
    const { call, contexts, seen, jira, input } = await connect();
    const { id } = await saveBacklog(call, backlog(input.id));
    const r = await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT", storyPointsField: "customfield_10016" });
    expect(r.isError).toBeFalsy();

    const shown = seen.at(-1)!;
    expect(shown.title).toBe("VIP flag backlog");
    expect(shown.target).toContain("Jira project PORT (Portal): 3 to create, 0 to update, 0 unchanged, 1 skipped, 1 dependency link(s) to add");
    expect(shown.body).toContain("E1 · VIP flag for Karim Benali: create Epic");
    expect(shown.body).toContain("to see the VIP flag that Lea Martin sets");
    expect(shown.body).toContain("S3 · Export the VIP list: skipped, won't have");
    expect(shown.body).toContain("- S1 blocks S2");
    expect(shown.body).toContain("Story points (customfield_10016): 3");
    expect(shown.kept).toEqual(["[SECRET_1]"]);
    expect(shown.body).not.toContain("hunter");

    expect(jira.writes.map((w) => w.op)).toEqual(["create", "create", "create"]);
    const [epic, s1, s2] = jira.writes;
    expect(epic!.fields.summary).toBe("VIP flag for Karim Benali");
    expect(epic!.fields.labels).toEqual(["sf-agent-po", "moscow-must"]);
    expect(JSON.stringify(s1!.fields.description)).toContain("to see the VIP flag that Lea Martin sets");
    expect(JSON.stringify(s1!.fields.description)).toContain("owned by Karim Benali");
    expect(s1!.fields).toMatchObject({ parent: { key: "PORT-1" }, customfield_10016: 3, labels: ["sf-agent-po", "vip", "moscow-must"] });
    expect(JSON.stringify(s2!.fields.description)).toContain("[SECRET_1]");
    expect(jira.links).toEqual(["PORT-2>PORT-3"]);

    expect(r.text).toContain("Created PORT-1 VIP flag for [PERSON_1]");
    expect(r.text).toContain("Linked PORT-2 blocks PORT-3");
    expect(r.text).toContain("Skipped 1 won't-have item(s)");
    expect(r.text).not.toMatch(/Karim|Lea/);
    const meta = contexts.getDocument("acme", id)!.metadata as { status: string; jira: { items: Record<string, { key: string; labels: string[] }>; publishedVersion: number } };
    expect(meta.status).toBe("published");
    expect(meta.jira.items.S1!.key).toBe("PORT-2");
    expect(meta.jira.publishedVersion).toBe(1);

    // Nothing changed: no page, no write.
    const again = await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT", storyPointsField: "customfield_10016" });
    expect(again.text).toContain("Nothing to publish");
    expect(seen).toHaveLength(1);
    expect(jira.writes).toHaveLength(3);
  });

  it("updates changed issues, keeps labels added in Jira, and warns about edits made there", async () => {
    const { call, seen, jira, input } = await connect();
    const { id } = await saveBacklog(call, backlog(input.id));
    await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    // Someone edits S1 in Jira and adds a label.
    const s1 = jira.issues.get("PORT-2")!;
    Object.assign(s1.fields, { summary: "Edited by Karim Benali", labels: [...s1.fields.labels, "team-a"] });
    s1.updated += 100;
    await saveBacklog(
      call,
      backlog(input.id, (b) => {
        b.epics[0]!.stories[0]!.labels = ["vip-v2"];
      }),
    );
    const r = await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    expect(r.text).toContain("Updated PORT-2 Show the VIP flag");
    const shown = seen.at(-1)!;
    expect(shown.body).toContain('S1 · Show the VIP flag: update PORT-2; its summary is now "Edited by Karim Benali"; WARNING: edited in Jira');
    expect(shown.target).toContain("1 to update");
    const update = jira.writes.at(-1)!;
    expect(update).toMatchObject({ op: "update", key: "PORT-2" });
    expect(update.fields.labels).toEqual(["team-a", "sf-agent-po", "vip-v2", "moscow-must"]);
    expect(update.fields.summary).toBe("Show the VIP flag");
    expect(r.text).not.toContain("Karim");
  });

  it("writes nothing when the user rejects, and passes on their comment masked", async () => {
    const { call, jira, input } = await connect([{ status: "rejected", comment: "Ask Lea Martin first." }]);
    const { id } = await saveBacklog(call, backlog(input.id));
    const r = await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    expect(r.text).toContain("Nothing was written: the user rejected it. Their comment: Ask [PERSON_2] first.");
    expect(jira.writes).toEqual([]);
  });

  it("refuses a decision about anything but what was shown", async () => {
    const { call, jira, input } = await connect([(req) => ({ status: "approved", missed: [], digest: requestDigest({ ...req, title: "other" } as ApprovalRequest) })]);
    const { id } = await saveBacklog(call, backlog(input.id));
    const r = await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    expect(r.isError).toBe(true);
    expect(jira.writes).toEqual([]);
  });

  it("reports only Jira's status on a failure, keeps what was done, and does not duplicate it on the next publish", async () => {
    const { call, jira, input } = await connect();
    jira.fail.on = (op, fields) => op === "create" && fields.summary === "Set the VIP flag";
    const { id } = await saveBacklog(call, backlog(input.id));
    const r = await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Jira refused to create S2 (HTTP 400).");
    expect(r.text).toContain("- Created PORT-1 VIP flag for [PERSON_1]");
    expect(r.text).not.toContain("Karim");
    jira.fail.on = undefined;
    const again = await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    expect(again.text).toContain("Created PORT-3 Set the VIP flag");
    expect(again.text).not.toContain("Created PORT-1");
    expect([...jira.issues.keys()]).toEqual(["PORT-1", "PORT-2", "PORT-3"]);
  });

  it("creates again an issue deleted in Jira", async () => {
    const { call, seen, jira, input } = await connect();
    const { id } = await saveBacklog(call, backlog(input.id));
    await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    jira.issues.delete("PORT-3");
    const r = await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    expect(seen.at(-1)!.body).toContain("create Story (its earlier issue PORT-3 was deleted)");
    expect(r.text).toContain("Created PORT-4 Set the VIP flag");
  });

  it("refuses a backlog with errors, another project, or an unknown issue type", async () => {
    const { call, input } = await connect();
    const bad = await saveBacklog(
      call,
      backlog(input.id, (b) => {
        b.title = "Broken backlog";
        b.epics[0]!.stories[1]!.dependsOn = ["S9"];
      }),
    );
    expect((await call("jira_publish", { context: "acme", artifactId: bad.id, projectKey: "PORT" })).text).toContain("Fix the backlog errors");
    const { id } = await saveBacklog(call, backlog(input.id));
    expect((await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT", storyIssueType: "Bug" })).text).toContain('no issue type "Bug"');
    expect((await call("jira_publish", { context: "acme", artifactId: id, projectKey: "OTHER" })).text).toContain("Jira refused to return the project (HTTP 404)");
  });

  it("takes over a 0.x backlog published to Jira, without its clear metadata", async () => {
    const { call, contexts, jira, input } = await connect();
    contexts.addDocuments("acme", [
      {
        kind: "backlog",
        title: "VIP flag backlog",
        source: "artifact:backlog:vip-flag-backlog",
        content: "Owner: Karim Benali",
        metadata: {
          artifact: true,
          version: 4,
          status: "published",
          jira: {
            projectKey: "PORT",
            items: { E1: { key: "PORT-7", url: "https://acme.atlassian.net/browse/PORT-7/Karim", hash: "h", labels: ["karim"], updated: "1" } },
            links: ["PORT-7>PORT-8", "Karim"],
          },
        },
        masked: false,
      },
    ]);
    jira.issues.set("PORT-7", { fields: { summary: "Old epic", labels: ["karim"] }, updated: 1 });
    const { id } = await saveBacklog(call, backlog(input.id));
    const meta = contexts.getDocument("acme", id)!.metadata as { version: number; jira: unknown };
    expect(meta.version).toBe(5);
    expect(meta.jira).toEqual({ projectKey: "PORT", items: { E1: { key: "PORT-7", url: "https://acme.atlassian.net/browse/PORT-7", updated: "1" } }, links: ["PORT-7>PORT-8"] });
    const r = await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    expect(r.text).toContain("Updated PORT-7 VIP flag for [PERSON_1]");
  });

  it("masks what the user's comment quotes from Jira, as the page showed it", async () => {
    const { call, jira, input } = await connect([{ status: "approved" }, { status: "rejected", comment: "Keep Call Kimberly about renewals as the summary." }]);
    const { id } = await saveBacklog(call, backlog(input.id));
    await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    const s1 = jira.issues.get("PORT-2")!;
    s1.fields.summary = "Call Kimberly about renewals";
    s1.updated += 1;
    await saveBacklog(
      call,
      backlog(input.id, (b) => {
        b.epics[0]!.stories[0]!.want = "to see the VIP flag at once";
      }),
    );
    const r = await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    expect(r.text).toContain("Their comment: Keep [PRIVATE_");
    expect(r.text).not.toContain("Kimberly");
  });

  it("records nothing when nothing of the backlog goes to Jira, and links a repeated dependency once", async () => {
    const { call, contexts, jira, input } = await connect();
    const none = await saveBacklog(
      call,
      backlog(input.id, (b) => {
        b.title = "Later backlog";
        b.epics[0]!.priority = "wont";
      }),
    );
    expect((await call("jira_publish", { context: "acme", artifactId: none.id, projectKey: "PORT" })).text).toContain("Nothing to publish");
    expect(contexts.getDocument("acme", none.id)!.metadata).not.toHaveProperty("jira");
    const { id } = await saveBacklog(
      call,
      backlog(input.id, (b) => {
        b.epics[0]!.stories[1]!.dependsOn = ["S1", "S1"];
      }),
    );
    await call("jira_publish", { context: "acme", artifactId: id, projectKey: "PORT" });
    expect(jira.links).toEqual(["PORT-2>PORT-3"]);
  });

  it("takes only context document ids as sources", async () => {
    const { call, input } = await connect();
    const r = await call("backlog_save", { context: "acme", backlog: backlog(input.id, (b) => (b.epics[0]!.sourceIds = ["call with Karim Benali"])) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("context document id");
  });

  it("merges labels: keeps Jira's own, replaces the ones this backlog set", () => {
    expect(mergeLabels(["team-a", "old", "moscow-could", "sf-agent-po"], ["old"], ["sf-agent-po", "new"])).toEqual(["team-a", "sf-agent-po", "new"]);
  });
});
