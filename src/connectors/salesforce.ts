import { run } from "../util/exec.js";

export interface OrgInfo {
  alias?: string;
  username?: string;
  instanceUrl?: string;
  apiVersion?: string;
  orgId?: string;
}

export interface SObjectDescribe {
  name: string;
  label: string;
  custom: boolean;
  fields: { name: string; label: string; type: string; referenceTo: string[]; custom: boolean; nillable: boolean }[];
  recordTypes: string[];
  childRelationships: number;
}

type SfRunner = (args: string[]) => Promise<any>;

/** Runs the Salesforce CLI with --json and returns its `result` payload. */
const defaultRunner: SfRunner = async (args) => {
  const { stdout } = await run("sf", [...args, "--json"]);
  const parsed = JSON.parse(stdout);
  if (parsed.status !== 0) throw new Error(parsed.message ?? "sf command failed");
  return parsed.result;
};

/**
 * Reads org information through the `sf` CLI, so it uses whatever orgs the
 * user has already authorised with `sf org login`. Read-only by design.
 */
export class SalesforceOrg {
  constructor(
    private readonly targetOrg: string,
    private readonly sf: SfRunner = defaultRunner,
  ) {}

  async info(): Promise<OrgInfo> {
    const r = await this.sf(["org", "display", "--target-org", this.targetOrg]);
    // Deliberately drop accessToken and other secrets from the result.
    return { alias: r.alias, username: r.username, instanceUrl: r.instanceUrl, apiVersion: r.apiVersion, orgId: r.id };
  }

  async listCustomObjects(): Promise<string[]> {
    const r = await this.sf(["sobject", "list", "--sobject", "custom", "--target-org", this.targetOrg]);
    return (r as string[]).sort();
  }

  async describe(sobject: string): Promise<SObjectDescribe> {
    const r = await this.sf(["sobject", "describe", "--sobject", sobject, "--target-org", this.targetOrg]);
    return {
      name: r.name,
      label: r.label,
      custom: r.custom,
      fields: (r.fields ?? []).map((f: any) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        referenceTo: f.referenceTo ?? [],
        custom: f.custom,
        nillable: f.nillable,
      })),
      recordTypes: (r.recordTypeInfos ?? []).filter((rt: any) => !rt.master).map((rt: any) => rt.name),
      childRelationships: (r.childRelationships ?? []).length,
    };
  }
}

export function orgToMarkdown(info: OrgInfo, customObjects: string[], describes: SObjectDescribe[]): string {
  const lines = [
    `# Salesforce org ${info.alias ?? info.username ?? ""}`.trim(),
    ``,
    `- Username: ${info.username ?? "?"}`,
    `- Instance: ${info.instanceUrl ?? "?"}`,
    `- API version: ${info.apiVersion ?? "?"}`,
    ``,
    `## Custom objects (${customObjects.length})`,
    customObjects.join(", ") || "none",
  ];
  for (const d of describes) {
    lines.push(``, `## ${d.name} (${d.label})`);
    if (d.recordTypes.length) lines.push(`Record types: ${d.recordTypes.join(", ")}`);
    lines.push(`Child relationships: ${d.childRelationships}`);
    for (const f of d.fields.filter((f) => f.custom || f.referenceTo.length)) {
      const ref = f.referenceTo.length ? ` -> ${f.referenceTo.join("/")}` : "";
      lines.push(`- ${f.name}: ${f.type}${ref}${f.nillable ? "" : ", required"} "${f.label}"`);
    }
  }
  return lines.join("\n");
}
