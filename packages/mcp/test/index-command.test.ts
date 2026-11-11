import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeSnapshot, INDEX_USAGE, parseIndexArgs } from "../src/index-command.js";

describe("index command", () => {
  const cwd = path.resolve("/work");
  it("reads an org or a project, and the workspace", () => {
    expect(parseIndexArgs(["--org", "dev"], {}, cwd)).toEqual({ target: { kind: "org", targetOrg: "dev" }, workspace: path.join(cwd, ".sf-agent"), force: false, full: false });
    expect(parseIndexArgs(["--project", "repo", "--force", "--full"], { SF_AGENT_WORKSPACE: "/ws" }, cwd)).toEqual({
      target: { kind: "project", dir: path.join(cwd, "repo") },
      workspace: path.resolve("/ws"),
      force: true,
      full: true,
    });
    expect(parseIndexArgs(["--org", "dev", "--workspace", "w"], {}, cwd)).toMatchObject({ workspace: path.join(cwd, "w") });
    expect(parseIndexArgs(["--help"], {}, cwd)).toEqual({ help: INDEX_USAGE });
  });

  it("refuses missing, doubled and unknown options", () => {
    expect(() => parseIndexArgs([], {}, cwd)).toThrow(/Give --org or --project/);
    expect(() => parseIndexArgs(["--org"], {}, cwd)).toThrow(/--org needs a value/);
    expect(() => parseIndexArgs(["--org", "--force"], {}, cwd)).toThrow(/--org needs a value/);
    expect(() => parseIndexArgs(["--org", "a", "--project", "b"], {}, cwd)).toThrow(/one of/);
    expect(() => parseIndexArgs(["--orgs", "a"], {}, cwd)).toThrow(/Unknown option "--orgs"/);
  });

  it("says what a run found", () => {
    const lines = describeSnapshot({
      id: 1,
      source: "org:00D",
      kind: "org",
      status: "ready",
      startedAt: "2026-11-07T00:00:00Z",
      stats: { counts: { CustomField: 40, ApexClass: 3 }, referenced: 5, edges: 120, skipped: [{ file: "objects/X.object", reason: "not XML" }] },
    });
    expect(lines).toEqual([
      "Indexed 43 components, 120 links, 5 referenced from outside the project.",
      "  CustomField: 40",
      "  ApexClass: 3",
      "1 file could not be read:",
      "  objects/X.object: not XML",
    ]);
  });

  it("tells what the org did not return apart from what could not be read", () => {
    const lines = describeSnapshot({
      id: 1,
      source: "org:00D",
      kind: "org",
      status: "ready",
      startedAt: "2026-11-07T00:00:00Z",
      stats: {
        counts: { ApexClass: 1 },
        skipped: [
          { file: "(retrieve)", reason: "200 ListView components were listed but not returned, such as A.B" },
          { file: "classes/X.cls", reason: "too long" },
        ],
        skippedCount: 2,
      },
    });
    expect(lines.slice(2)).toEqual([
      "The org did not return everything it listed:",
      "  200 ListView components were listed but not returned, such as A.B",
      "1 file could not be read:",
      "  classes/X.cls: too long",
    ]);
  });
});
