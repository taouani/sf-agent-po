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

export interface PublishedPage {
  pageId: string;
  url: string;
  version: number;
}

/**
 * Jira and Confluence Cloud over REST with an API token. The write methods are
 * only called from publish tools, after the user approved a preview.
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

  async getSpaceId(spaceKey: string): Promise<string> {
    const r = await this.request(`/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`);
    const id = r.results?.[0]?.id;
    if (!id) throw new Error(`Confluence space "${spaceKey}" was not found or is not visible to this account.`);
    return String(id);
  }

  async getPageSummary(idOrUrl: string): Promise<{ pageId: string; title: string; spaceId: string; version: number; url: string }> {
    const id = confluencePageId(idOrUrl);
    const r = await this.request(`/wiki/api/v2/pages/${id}`);
    return { pageId: id, title: r.title, spaceId: String(r.spaceId), version: r.version?.number ?? 1, url: this.pageUrl(r, id) };
  }

  async createPage(input: { spaceId: string; parentId?: string; title: string; storage: string }): Promise<PublishedPage> {
    const r = await this.request("/wiki/api/v2/pages", {
      method: "POST",
      body: JSON.stringify({
        spaceId: input.spaceId,
        status: "current",
        title: input.title,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        body: { representation: "storage", value: input.storage },
      }),
    });
    return { pageId: String(r.id), url: this.pageUrl(r, String(r.id)), version: r.version?.number ?? 1 };
  }

  /** Replaces a page's title and body, bumping its version as Confluence requires. */
  async updatePage(input: { pageId: string; title: string; storage: string; message?: string }): Promise<PublishedPage> {
    const current = await this.getPageSummary(input.pageId);
    const r = await this.request(`/wiki/api/v2/pages/${current.pageId}`, {
      method: "PUT",
      body: JSON.stringify({
        id: current.pageId,
        status: "current",
        title: input.title,
        body: { representation: "storage", value: input.storage },
        version: { number: current.version + 1, message: input.message ?? "Updated by sf-agent-po" },
      }),
    });
    return { pageId: current.pageId, url: this.pageUrl(r, current.pageId), version: r.version?.number ?? current.version + 1 };
  }

  private pageUrl(page: any, id: string): string {
    return `${this.config.siteUrl}/wiki${page._links?.webui ?? `/pages/viewpage.action?pageId=${id}`}`;
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
