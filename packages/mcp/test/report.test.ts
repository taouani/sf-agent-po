import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextRepository, Database, FeedbackRepository, type FeedbackEntry, type FeedbackInput } from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseReportArgs, REPORT_USAGE, runReport } from "../src/report-command.js";
import { feedbackReport, formatReport, reportCsv, storyOutcomes } from "../src/report.js";
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
  it("counts a person's verdict before the Jira diff's guess, the PO's first, once per published version", () => {
    const outcomes = storyOutcomes([
      // S1: the diff says major, the PO says minor: accepted.
      entry({ item: "S1", kind: "jira_diff", value: "major", model: "Opus 5.5 on Copilot", workflow: "po_backlog" }),
      entry({ item: "S1", kind: "verdict", value: "minor" }),
      // S2: the dev team says rejected, the PO accepted: the PO's word counts.
      entry({ item: "S2", kind: "verdict", role: "dev", value: "rejected" }),
      entry({ item: "S2", kind: "verdict", role: "po", value: "accepted" }),
      // S3: only the diff, deleted.
      entry({ item: "S3", kind: "jira_diff", value: "deleted" }),
      // S4: the SA before the dev team.
      entry({ item: "S4", kind: "verdict", role: "dev", value: "accepted" }),
      entry({ item: "S4", kind: "verdict", role: "sa", value: "major" }),
      // S1 published again: counted on its own.
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
    // The model and workflow come from whichever row has them.
    expect(outcomes[0]).toMatchObject({ model: "Opus 5.5 on Copilot", workflow: "po_backlog" });
  });

  it("groups by context, model label and workflow, averages ratings by section, and writes safe CSV", () => {
    const report = feedbackReport([
      ...["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"].map((item) => entry({ item, kind: "jira_diff", value: "unchanged", model: "Opus 5.5 on Copilot" })),
      entry({ item: "S10", kind: "verdict", value: "major", model: "Opus 5.5 on Copilot" }),
      entry({ context: "beta", item: "S1", kind: "jira_diff", value: "major", workflow: "po_backlog" }),
      entry({ item: "solution", kind: "rating", value: "4", details: { design: "high-level" } }),
      entry({ item: "solution", kind: "rating", role: "sa", value: "1", details: { design: "high-level" } }),
      entry({ item: "=cmd", kind: "rating", value: "5" }),
    ]);
    expect(report).toMatchObject({ stories: 11, accepted: 9, byPeople: 1 });
    expect(report.groups).toEqual([
      { context: "acme", model: "Opus 5.5 on Copilot", stories: 10, accepted: 9, byPeople: 1 },
      { context: "beta", workflow: "po_backlog", stories: 1, accepted: 0, byPeople: 0 },
    ]);
    expect(report.ratings).toEqual([
      { context: "acme", design: "design", section: "=cmd", ratings: 1, average: 5 },
      { context: "acme", design: "high-level", section: "solution", ratings: 2, average: 2.5 },
    ]);
    const text = formatReport(report);
    expect(text).toContain("Stories accepted without major edits: 9 of 11 (82%), against the 90% target: not met.");
    expect(text).toContain("1 decided by people, 10 by the Jira diff's guess only.");
    expect(text).toContain('- acme, "Opus 5.5 on Copilot", no workflow: 9 of 10 (90%), 1 by people');
    expect(text).toContain("- beta, no model label, po_backlog: 0 of 1 (0%), 0 by people");
    expect(text).toContain("- acme, high-level, solution: 2.5 (2 ratings)");

    const csv = reportCsv(report).split("\r\n");
    expect(csv[0]).toBe("measure,context,model,workflow,design,section,count,accepted,value");
    expect(csv[1]).toBe('"accepted_share","acme","Opus 5.5 on Copilot",,,,10,9,0.9');
    // A cell a spreadsheet would run as a formula is kept as text.
    expect(csv[3]).toBe(`"rating","acme",,,"design","'=cmd",1,,5`);
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
  function workspace(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "sfpo-report-"));
    dirs.push(dir);
    const db = new Database(databaseFile(dir));
    const contexts = new ContextRepository(db);
    const feedback = new FeedbackRepository(db);
    for (const name of ["acme", "beta"]) {
      contexts.ensure(name);
      const [doc] = contexts.addDocuments(name, [{ kind: "other", title: "Backlog", source: "artifact://backlog", content: "x" }]);
      const rows: FeedbackInput[] = [
        { context: name, artifact: doc!.id, artifactVersion: 1, item: "S1", kind: "jira_diff", value: name === "acme" ? "unchanged" : "major" },
        { context: name, artifact: doc!.id, artifactVersion: 1, item: "solution", kind: "rating", role: "sa", value: "4", details: { design: "high-level" } },
      ];
      feedback.record(rows);
    }
    db.close();
    return dir;
  }
  const cwd = path.resolve("/work");

  it("reads its options", () => {
    expect(parseReportArgs([], {}, cwd)).toEqual({ workspace: path.join(cwd, ".sf-agent") });
    expect(parseReportArgs(["--context", "acme", "--csv", "out.csv", "--workspace", "w"], { SF_AGENT_WORKSPACE: "/ws" }, cwd)).toEqual({ workspace: path.join(cwd, "w"), context: "acme", csv: path.join(cwd, "out.csv") });
    expect(parseReportArgs(["--help"])).toEqual({ help: REPORT_USAGE });
    expect(() => parseReportArgs(["--csv"])).toThrow(/--csv needs a value/);
    expect(() => parseReportArgs(["--json"])).toThrow(/Unknown option "--json"/);
  });

  it("prints the report for every context or one, and writes the CSV file", async () => {
    const dir = workspace();
    const out: string[] = [];
    expect(await runReport({ workspace: dir }, { out: (t) => out.push(t) })).toBe(0);
    expect(out.join("\n")).toContain("Stories accepted without major edits: 1 of 2 (50%)");
    out.length = 0;
    const csv = path.join(dir, "report.csv");
    await runReport({ workspace: dir, context: "acme", csv }, { out: (t) => out.push(t) });
    expect(out.join("\n")).toContain("1 of 1 (100%)");
    expect(out.join("\n")).toContain(`Wrote 2 row(s) to ${csv}.`);
    expect(readFileSync(csv, "utf8").split("\r\n")).toHaveLength(4);
    if (process.platform !== "win32") expect(statSync(csv).mode & 0o077).toBe(0);
    await expect(runReport({ workspace: dir, context: "nope" }, { out: () => {} })).rejects.toThrow(/There is no context "nope".*Contexts: acme, beta/);
    await expect(runReport({ workspace: path.join(dir, "missing") }, { out: () => {} })).rejects.toThrow(/There is no workspace/);
  });
});
