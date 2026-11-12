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
    // A repository is read when the run starts, which checks it.
    expect(parseIndexArgs(["--repo", "github:acme/core#main"], {}, cwd)).toMatchObject({ target: { kind: "remote", repo: "github:acme/core#main" } });
  });

  it("refuses missing, doubled and unknown options", () => {
    expect(() => parseIndexArgs([], {}, cwd)).toThrow(/Give --org, --project or --repo/);
    expect(() => parseIndexArgs(["--org"], {}, cwd)).toThrow(/--org needs a value/);
    expect(() => parseIndexArgs(["--org", "--force"], {}, cwd)).toThrow(/--org needs a value/);
    expect(() => parseIndexArgs(["--org", "a", "--project", "b"], {}, cwd)).toThrow(/one of/);
    expect(() => parseIndexArgs(["--repo", "github:a/b", "--org", "b"], {}, cwd)).toThrow(/one of/);
    expect(() => parseIndexArgs(["--orgs", "a"], {}, cwd)).toThrow(/Unknown option "--orgs"/);
    expect(parseIndexArgs(["--org", "prod", "--parallel", "3"], {}, cwd)).toMatchObject({ parallel: 3 });
    expect(() => parseIndexArgs(["--org", "prod", "--parallel", "4"], {}, cwd)).toThrow(/1, 2 or 3/);
    expect(() => parseIndexArgs(["--project", "p", "--parallel", "2"], {}, cwd)).toThrow(/only goes with --org/);
  });

  it("takes a folder set of a project or a repository, with its name and org", () => {
    expect(parseIndexArgs(["--project", "mono", "--packages", "common-app, row-app,sdg-app", "--name", "row", "--for-org", "prod"], {}, cwd)).toMatchObject({
      target: { kind: "project", dir: path.resolve(cwd, "mono"), set: { name: "row", packages: ["common-app", "row-app", "sdg-app"], forOrg: "prod" } },
    });
    expect(parseIndexArgs(["--repo", "github:a/b", "--packages", "row-app", "--name", "row"], {}, cwd)).toMatchObject({ target: { kind: "remote", repo: "github:a/b", set: { name: "row", packages: ["row-app"] } } });
    expect(() => parseIndexArgs(["--project", "mono", "--packages", "row-app"], {}, cwd)).toThrow(/needs --name/);
    expect(() => parseIndexArgs(["--project", "mono", "--name", "row"], {}, cwd)).toThrow(/go with --packages/);
    expect(() => parseIndexArgs(["--org", "prod", "--packages", "row-app", "--name", "row"], {}, cwd)).toThrow(/goes with --project or --repo/);
    expect(() => parseIndexArgs(["--project", "mono", "--packages", " , ", "--name", "row"], {}, cwd)).toThrow(/at least one folder/);
    expect(INDEX_USAGE).toContain("--packages <a,b,...> --name <set> [--for-org <alias or username>]");
    const lines = describeSnapshot({
      id: 2,
      source: "repo:mono:row#12345678",
      kind: "repo",
      status: "ready",
      startedAt: "2026-11-07T00:00:00Z",
      stats: { counts: { ApexClass: 3 }, referenced: 1, edges: 2, target: { name: "row", packages: ["common-app", "row-app"], org: "org:00D000000000001AAA" } },
    });
    expect(lines[0]).toBe("Folder set row (common-app, row-app) of the repository, as repo:mono:row#12345678, deployed to org:00D000000000001AAA.");
    expect(lines[1]).toBe("Indexed 3 components, 2 links, 1 referenced from outside the set.");
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
