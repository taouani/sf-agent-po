import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextRepository, Database, FeedbackRepository, MIGRATIONS, schemaVersion, type FeedbackEntry, type FeedbackInput } from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseReportArgs, REPORT_USAGE, runReport } from "../src/report-command.js";
import { feedbackReport, formatReport, meets, percent, reportCsv, storyOutcomes } from "../src/report.js";
import { databaseFile } from "../src/startup.js";

const at = "2026-11-11T00:00:00.000Z";
const entry = (e: Partial<FeedbackEntry> & Pick<FeedbackEntry, "item" | "kind" | "value">): FeedbackEntry => ({
  context: "acme",
  artifact: "doc-1",
  artifactVersion: 1,
  role: e.kind === "jira_diff" ? "" : "po",
  details: {},
  recordedAt: at,
  ...e,
});

describe("the success measure", () => {
  it("counts a person's verdict before the Jira diff's guess, the PO's first", () => {
    const outcomes = storyOutcomes([
      // S1: the diff says major, the PO says minor: accepted. The label is the diff's.
      entry({ item: "S1", kind: "jira_diff", value: "major", model: "Opus 5.5 on Copilot", workflow: "po_backlog" }),
      entry({ item: "S1", kind: "verdict", value: "minor", model: "GPT on Cursor" }),
      // S2: the dev team says rejected, the PO accepted: the PO's word counts.
      entry({ item: "S2", kind: "verdict", role: "dev", value: "rejected" }),
      entry({ item: "S2", kind: "verdict", role: "po", value: "accepted" }),
      // S3: only the diff, deleted.
      entry({ item: "S3", kind: "jira_diff", value: "deleted" }),
      // S4: the SA before the dev team.
      entry({ item: "S4", kind: "verdict", role: "dev", value: "accepted" }),
      entry({ item: "S4", kind: "verdict", role: "sa", value: "major" }),
      // S1 at another version: an outcome of its own here; the report keeps one.
      entry({ item: "S1", kind: "jira_diff", value: "unchanged", artifactVersion: 2 }),
      // Ratings are not stories.
      entry({ item: "solution", kind: "rating", value: "4" }),
    ]);
    expect(outcomes.map((o) => `${o.item}@${o.artifactVersion}:${o.by}:${o.value}:${o.accepted}`)).toEqual([
      "S1@1:po:minor:true",
      "S2@1:po:accepted:true",
      "S3@1:jira:deleted:false",
      "S4@1:sa:major:false",
      "S1@2:jira:unchanged:true",
    ]);
    expect(outcomes[0]).toMatchObject({ model: "Opus 5.5 on Copilot", workflow: "po_backlog" });
  });

  it("counts each story once: at the version last sent and still in the backlog with a scope, else its latest", () => {
    const rows = [
      entry({ item: "S1", kind: "verdict", value: "rejected" }),
      entry({ item: "S1", kind: "jira_diff", value: "unchanged", artifactVersion: 2, model: "old label" }),
      entry({ item: "S2", kind: "verdict", value: "accepted" }),
      // S5 was taken out of the backlog: its verdict no longer counts with a scope.
      entry({ item: "S5", kind: "verdict", value: "rejected" }),
      entry({ item: "solution", kind: "rating", value: "2", details: { design: "high-level" } }),
      entry({ item: "solution", kind: "rating", value: "5", artifactVersion: 2, details: { design: "high-level" } }),
    ];
    const plain = feedbackReport(rows);
    expect(plain).toMatchObject({ stories: 3, accepted: 2 });
    expect(plain.ratings).toEqual([{ context: "acme", design: "high-level", section: "solution", ratings: 1, average: 5 }]);
    const k = (...p: (string | number)[]) => JSON.stringify(p);
    const scope = {
      stories: new Map([
        [k("acme", "doc-1", "S1"), { version: 2, model: "Opus 5.5 on Copilot" }],
        [k("acme", "doc-1", "S2"), { version: 1 }],
        [k("acme", "doc-1", "S3"), { version: 1 }],
      ]),
      designs: new Map([[k("acme", "doc-1"), 1]]),
    };
    const scoped = feedbackReport(rows, scope);
    expect(scoped).toMatchObject({ stories: 2, accepted: 2, published: 3 });
    // The label the backlog was published under wins.
    expect(scoped.groups.map((g) => g.model)).toEqual([undefined, "Opus 5.5 on Copilot"]);
    expect(scoped.ratings).toEqual([{ context: "acme", design: "high-level", section: "solution", ratings: 1, average: 2 }]);
    expect(formatReport(scoped)).toContain("1 more published story has no feedback yet.");
  });

  it("never rounds a share up to the target", () => {
    expect(percent(26, 29)).toBe("89.6%");
    expect(percent(9, 10)).toBe("90%");
    expect(percent(1, 3)).toBe("33.3%");
    expect(meets(26, 29)).toBe(false);
    expect(meets(9, 10)).toBe(true);
    expect(meets(27, 30)).toBe(true);
    expect(meets(0, 0)).toBe(false);
    const report = feedbackReport(Array.from({ length: 29 }, (_, i) => entry({ item: `S${i}`, kind: "jira_diff", value: i < 26 ? "unchanged" : "major" })));
    expect(formatReport(report)).toContain("26 of 29 stories with feedback (89.6%), against the 90% target: not met.");
  });

  it("groups by context, model label and workflow, averages ratings by section, and writes safe CSV", () => {
    const report = feedbackReport([
      ...["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"].map((item) => entry({ item, kind: "jira_diff", value: "unchanged", model: "Opus 5.5 on Copilot" })),
      entry({ item: "S10", kind: "verdict", value: "major", model: "Opus 5.5 on Copilot" }),
      entry({ context: "beta", item: "S1", kind: "jira_diff", value: "major", workflow: "po_backlog", model: "two\nlines" }),
      entry({ item: "solution", kind: "rating", value: "4", details: { design: "high-level" } }),
      entry({ item: "solution", kind: "rating", role: "sa", value: "1", details: { design: "high-level" } }),
      ...["=cmd", "+x", "-1", "@a", "\tt", 'say "hi"\r\nok'].map((item) => entry({ item, kind: "rating", value: "5" })),
    ]);
    expect(report).toMatchObject({ stories: 11, accepted: 9, byPeople: 1 });
    expect(report.groups).toEqual([
      { context: "acme", model: "Opus 5.5 on Copilot", stories: 10, accepted: 9, byPeople: 1 },
      // A label is kept on one line.
      { context: "beta", model: "two lines", workflow: "po_backlog", stories: 1, accepted: 0, byPeople: 0 },
    ]);
    expect(report.ratings.find((r) => r.section === "solution")).toEqual({ context: "acme", design: "high-level", section: "solution", ratings: 2, average: 2.5 });
    const text = formatReport(report);
    expect(text).toContain("Stories accepted without major edits: 9 of 11 stories with feedback (81.8%), against the 90% target: not met.");
    expect(text).toContain("1 decided by people (a guess left as it is on the review page counts as theirs), 10 by the Jira diff's guess only.");
    expect(text).toContain('- acme, "Opus 5.5 on Copilot", no workflow: 9 of 10 (90%), 1 by people');
    expect(text).toContain('- beta, "two lines", po_backlog: 0 of 1 (0%), 0 by people');
    expect(text).toContain("- acme, high-level, solution: 2.5 (2 ratings)");

    const csv = reportCsv(report).split("\r\n");
    expect(csv[0]).toBe("measure,context,model,workflow,design,section,count,accepted,by_people,value");
    expect(csv[1]).toBe('"accepted_share_total",,,,,,11,9,1,0.818');
    expect(csv[2]).toBe('"accepted_share","acme","Opus 5.5 on Copilot",,,,10,9,1,0.9');
    // Cells a spreadsheet would run as a formula are kept as text; quotes and line breaks stay inside their cell.
    const cells = csv.filter((l) => l.startsWith('"rating"')).join("\n");
    for (const v of ["'=cmd", "'+x", "'-1", "'@a", "'\tt"]) expect(cells).toContain(`"${v}"`);
    expect(reportCsv(report)).toContain('"say ""hi""\r\nok"');
    expect(csv.at(-1)).toBe("");

    expect(formatReport(feedbackReport([]))).toMatch(/^No feedback recorded yet/);
    expect(formatReport(feedbackReport([entry({ item: "s", kind: "rating", value: "3" })]))).toContain("No published story has feedback yet.");
    expect(formatReport(feedbackReport(["S1"].map((item) => entry({ item, kind: "verdict", value: "accepted" }))))).toContain("target: met");
  });
});

describe("report command", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A workspace with a published backlog of two stories in each of two contexts, and their Jira diffs. */
  function workspace(migrations = MIGRATIONS): string {
    const dir = mkdtempSync(path.join(tmpdir(), "sfpo-report-"));
    dirs.push(dir);
    const db = new Database(databaseFile(dir), migrations);
    if (migrations === MIGRATIONS) {
      const contexts = new ContextRepository(db);
      const feedback = new FeedbackRepository(db);
      for (const name of ["acme", "beta"]) {
        contexts.ensure(name);
        const backlog = { title: "B", epics: [{ id: "E1", summary: "E", outcome: "o", stories: ["S1", "S2"].map((id) => ({ id, type: "story", summary: id, persona: "p", want: "w", benefit: "b", acceptanceCriteria: [] })) }] };
        const jira = { projectKey: "PORT", items: { E1: { key: "PORT-1", url: "u" }, S1: { key: "PORT-2", url: "u" }, S2: { key: "PORT-3", url: "u" } }, links: [], publishedVersion: 1, model: "Opus 5.5 on Copilot" };
        const [doc] = contexts.addDocuments(name, [{ kind: "backlog", title: "Backlog", source: "artifact://backlog", content: "x", metadata: { artifact: true, version: 1, status: "published", backlog, jira } }]);
        const [design] = contexts.addDocuments(name, [{ kind: "design", title: "HLD", source: "artifact://hld", content: "## Solution", metadata: { artifact: true, version: 1, status: "draft" } }]);
        const rows: FeedbackInput[] = [
          { context: name, artifact: doc!.id, artifactVersion: 1, item: "S1", kind: "jira_diff", value: name === "acme" ? "unchanged" : "major" },
          { context: name, artifact: design!.id, artifactVersion: 1, item: "solution", kind: "rating", role: "sa", value: "4", details: { design: "high-level" } },
        ];
        feedback.record(rows);
      }
    }
    db.close();
    return dir;
  }
  const cwd = path.resolve("/work");

  it("reads its options", () => {
    expect(parseReportArgs([], {}, cwd)).toEqual({ workspace: path.join(cwd, ".sf-agent") });
    expect(parseReportArgs([], { SF_AGENT_WORKSPACE: "ws" }, cwd)).toEqual({ workspace: path.join(cwd, "ws") });
    expect(parseReportArgs(["--context", "acme", "--csv", "out.csv", "--workspace", "w"], { SF_AGENT_WORKSPACE: "/ws" }, cwd)).toEqual({ workspace: path.join(cwd, "w"), context: "acme", csv: path.join(cwd, "out.csv") });
    expect(parseReportArgs(["--help"])).toEqual({ help: REPORT_USAGE });
    expect(() => parseReportArgs(["--csv"])).toThrow(/--csv needs a value/);
    expect(() => parseReportArgs(["--workspace", "--csv"])).toThrow(/--workspace needs a value/);
    expect(() => parseReportArgs(["--json"])).toThrow(/Unknown option "--json"/);
  });

  it("prints the report for every context or one, and writes the CSV file readable only by you", async () => {
    const dir = workspace();
    const out: string[] = [];
    expect(await runReport({ workspace: dir }, { out: (t) => out.push(t) })).toBe(0);
    const all = out.join("\n");
    expect(all).toContain("Stories accepted without major edits: 1 of 2 stories with feedback (50%)");
    expect(all).toContain("2 more published stories have no feedback yet.");
    expect(all).toContain('- acme, "Opus 5.5 on Copilot", no workflow: 1 of 1 (100%)');
    out.length = 0;
    const csvDir = mkdtempSync(path.join(tmpdir(), "sfpo-csv-"));
    dirs.push(csvDir);
    const csv = path.join(csvDir, "report.csv");
    // An existing file readable by others is replaced by one that is not.
    writeFileSync(csv, "old", { mode: 0o644 });
    await runReport({ workspace: dir, context: "acme", csv }, { out: (t) => out.push(t) });
    expect(out.join("\n")).toContain("1 of 1 stories with feedback (100%)");
    expect(out.join("\n")).toContain(`Wrote 3 row(s) to ${csv}.`);
    const written = readFileSync(csv, "utf8");
    expect(written.startsWith("﻿measure,")).toBe(true);
    expect(written.split("\r\n")).toHaveLength(5);
    if (process.platform !== "win32") expect(statSync(csv).mode & 0o077).toBe(0);
    expect(readdirSync(csvDir)).toEqual(["report.csv"]);
    await expect(runReport({ workspace: dir, csv: path.join(dir, "sf-agent.db") }, { out: () => {} })).rejects.toThrow(/outside the workspace folder/);
    await expect(runReport({ workspace: dir, context: "nope" }, { out: () => {} })).rejects.toThrow(/There is no context "nope".*Contexts: acme, beta/);
    await expect(runReport({ workspace: path.join(dir, "missing") }, { out: () => {} })).rejects.toThrow(/There is no workspace/);
  });

  it("only reads the workspace: an older one is not upgraded, and a newer one is refused", async () => {
    const old = workspace(MIGRATIONS.filter((m) => m.version < 12));
    const out: string[] = [];
    expect(await runReport({ workspace: old }, { out: (t) => out.push(t) })).toBe(0);
    expect(out.join("\n")).toContain("this workspace predates feedback");
    const db = new Database(databaseFile(old), MIGRATIONS, { readOnly: true });
    expect(schemaVersion(db)).toBe(11);
    db.close();

    const newer = workspace();
    const raw = new DatabaseSync(databaseFile(newer));
    raw.prepare("INSERT INTO schema_migration (version, name, applied_at) VALUES (999, 'future', '2026-11-11')").run();
    raw.close();
    await expect(runReport({ workspace: newer }, { out: () => {} })).rejects.toThrow(/written by a newer sf-agent-po \(schema 999/);
  });
});
