import { htmlToText } from "../loaders/documents.js";
import type { NewDocument } from "../context/store.js";

export interface AtlassianConfig {
  /** e.g. https://your-company.atlassian.net */
  siteUrl: string;
  email: string;
  apiToken: string;
}

export function atlassianConfigFromEnv(env = process.env): AtlassianConfig | undefined {
  const { ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN } = env;
  if (!ATLASSIAN_SITE_URL || !ATLASSIAN_EMAIL || !ATLASSIAN_API_TOKEN) return undefined;
  return { siteUrl: ATLASSIAN_SITE_URL.replace(/\/+$/, ""), email: ATLASSIAN_EMAIL, apiToken: ATLASSIAN_API_TOKEN };
}

const JIRA_FIELDS = ["summary", "description", "status", "issuetype", "priority", "labels", "parent", "fixVersions", "components"];

/**
 * Read access to Jira and Confluence Cloud over REST with an API token.
 * Writing (creating stories and pages) comes in later steps, behind a review gate.
 */
export class AtlassianClient {
  constructor(
    private readonly config: AtlassianConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const auth = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString("base64");
    const res = await this.fetchImpl(`${this.config.siteUrl}${path}`, {
      ...init,
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json", "Content-Type": "application/json", ...init.headers },
    });
    if (!res.ok) {
      throw new Error(`Atlassian request ${path} failed with ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    return res.json();
  }

  /** Follows nextPageToken until maxResults issues are collected or Jira reports the last page. */
  async searchIssues(jql: string, maxResults = 50): Promise<NewDocument[]> {
    const docs: NewDocument[] = [];
    let nextPageToken: string | undefined;
    do {
      const r = await this.request("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({ jql, fields: JIRA_FIELDS, maxResults: Math.min(maxResults - docs.length, 100), nextPageToken }),
      });
      docs.push(...(r.issues ?? []).map((i: any) => this.issueToDocument(i)));
      nextPageToken = r.isLast ? undefined : r.nextPageToken;
    } while (nextPageToken && docs.length < maxResults);
    return docs.slice(0, maxResults);
  }

  async getIssue(key: string): Promise<NewDocument> {
    const r = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${JIRA_FIELDS.join(",")}`);
    return this.issueToDocument(r);
  }

  async getPage(idOrUrl: string): Promise<NewDocument> {
    const id = confluencePageId(idOrUrl);
    const r = await this.request(`/wiki/api/v2/pages/${id}?body-format=storage`);
    return {
      kind: "confluence",
      title: r.title,
      source: `${this.config.siteUrl}/wiki${r._links?.webui ?? `/pages/${id}`}`,
      content: htmlToText(r.body?.storage?.value ?? ""),
      metadata: { pageId: id, spaceId: r.spaceId, version: r.version?.number },
    };
  }

  private issueToDocument(issue: any): NewDocument {
    const f = issue.fields ?? {};
    const header = [
      `Type: ${f.issuetype?.name ?? "?"}`,
      `Status: ${f.status?.name ?? "?"}`,
      f.priority ? `Priority: ${f.priority.name}` : undefined,
      f.parent ? `Parent: ${f.parent.key} ${f.parent.fields?.summary ?? ""}`.trim() : undefined,
      f.labels?.length ? `Labels: ${f.labels.join(", ")}` : undefined,
      f.fixVersions?.length ? `Fix versions: ${f.fixVersions.map((v: any) => v.name).join(", ")}` : undefined,
    ].filter(Boolean);
    return {
      kind: "jira",
      title: `${issue.key} ${f.summary ?? ""}`.trim(),
      source: `${this.config.siteUrl}/browse/${issue.key}`,
      content: `${header.join("\n")}\n\n${adfToText(f.description)}`.trim(),
      metadata: { key: issue.key, type: f.issuetype?.name, status: f.status?.name },
    };
  }
}

export function confluencePageId(idOrUrl: string): string {
  if (/^\d+$/.test(idOrUrl)) return idOrUrl;
  const m = idOrUrl.match(/\/pages\/(?:edit-v2\/|edit\/)?(\d+)/) ?? idOrUrl.match(/[?&]pageId=(\d+)/);
  if (!m) {
    throw new Error(`Could not find a Confluence page id in "${idOrUrl}". Use the page id or the full page URL (short /x/ links are not supported).`);
  }
  return m[1];
}

/** Converts Atlassian Document Format (Jira rich text) to plain text. */
export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  const children = (node.content ?? []).map(adfToText);
  switch (node.type) {
    case "text": {
      const href = node.marks?.find((m: any) => m.type === "link")?.attrs?.href;
      return href && href !== node.text ? `${node.text} (${href})` : (node.text ?? "");
    }
    case "hardBreak":
      return "\n";
    case "paragraph":
      return children.join("") + "\n\n";
    case "heading":
      return `${"#".repeat(node.attrs?.level ?? 1)} ${children.join("")}\n\n`;
    case "bulletList":
    case "orderedList":
      return children.join("") + "\n";
    case "listItem":
      return `- ${children.join("").trim()}\n`;
    case "taskList":
    case "decisionList":
      return children.join("") + "\n";
    case "taskItem":
      return `- [${node.attrs?.state === "DONE" ? "x" : " "}] ${children.join("").trim()}\n`;
    case "decisionItem":
      return `- Decision: ${children.join("").trim()}\n`;
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return node.attrs?.url ?? "";
    case "status":
      return `[${node.attrs?.text ?? ""}]`;
    case "date":
      return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : "";
    case "emoji":
      return node.attrs?.text ?? node.attrs?.shortName ?? "";
    case "codeBlock":
      return "```\n" + children.join("") + "\n```\n\n";
    case "tableRow":
      return `| ${children.map((c: string) => c.trim()).join(" | ")} |\n`;
    case "mention":
      return node.attrs?.text ?? "";
    default:
      return children.join("");
  }
}
