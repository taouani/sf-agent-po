import { htmlToText } from "./files.js";
import type { NewDocument } from "@sf-agent-po/core";

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

export class AtlassianError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface IssueState {
  updated: string;
  summary: string;
  parentKey?: string;
  labels: string[];
}

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
      // A form sets its own content type, with the boundary.
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json", ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init.headers },
    });
    if (!res.ok) {
      throw new AtlassianError(`Atlassian request ${path} failed with ${res.status}: ${(await res.text()).slice(0, 500)}`, res.status);
    }
    // Updates and links answer 204 or 201 with an empty body.
    const body = await res.text();
    return body ? JSON.parse(body) : undefined;
  }

  /**
   * One read call that needs a valid login: the current user in Jira, one space in
   * Confluence. For `doctor`; throws AtlassianError with the status when refused.
   */
  async ping(product: "jira" | "confluence"): Promise<void> {
    await this.request(product === "jira" ? "/rest/api/3/myself" : "/wiki/api/v2/spaces?limit=1");
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

  /** A project, with its standard issue types and, apart, its sub-task types (sites name them differently). */
  async getProject(projectKey: string): Promise<{ key: string; name: string; issueTypes: string[]; subtaskTypes: string[] }> {
    const r = await this.request(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
    const types = (r.issueTypes ?? []) as { name: string; subtask?: boolean }[];
    return { key: r.key, name: r.name, issueTypes: types.filter((t) => !t.subtask).map((t) => t.name), subtaskTypes: types.filter((t) => t.subtask).map((t) => t.name) };
  }

  async createIssue(fields: Record<string, unknown>): Promise<{ key: string; url: string }> {
    const r = await this.request("/rest/api/3/issue", { method: "POST", body: JSON.stringify({ fields }) });
    return { key: r.key, url: `${this.config.siteUrl}/browse/${r.key}` };
  }

  /** What an issue looks like in Jira now: used to detect edits, show what an update replaces, and keep other teams' labels. */
  async getIssueState(key: string): Promise<IssueState> {
    const r = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=updated,summary,parent,labels`);
    const f = r.fields ?? {};
    return { updated: String(f.updated ?? ""), summary: f.summary ?? "", parentKey: f.parent?.key, labels: f.labels ?? [] };
  }

  async updateIssue(key: string, fields: Record<string, unknown>): Promise<{ key: string; url: string }> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ fields }) });
    return { key, url: `${this.config.siteUrl}/browse/${key}` };
  }

  /**
   * Records that `blocker` blocks `blocked`, using Jira's default "Blocks" link type.
   * In this endpoint the inward issue is the one that blocks and the outward
   * issue the one that is blocked, the reverse of what the field names suggest.
   */
  async linkBlocks(blocker: string, blocked: string): Promise<void> {
    await this.request("/rest/api/3/issueLink", {
      method: "POST",
      body: JSON.stringify({ type: { name: "Blocks" }, inwardIssue: { key: blocker }, outwardIssue: { key: blocked } }),
    });
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

  /**
   * Replaces a page's title and body. `expectedVersion` is the version the user
   * saw in the preview; Confluence rejects the update with 409 if the page has
   * moved on since, so edits made in between are never silently overwritten.
   */
  async updatePage(input: { pageId: string; expectedVersion: number; title: string; storage: string; message?: string }): Promise<PublishedPage> {
    let r;
    try {
      r = await this.request(`/wiki/api/v2/pages/${input.pageId}`, {
        method: "PUT",
        body: JSON.stringify({
          id: input.pageId,
          status: "current",
          title: input.title,
          body: { representation: "storage", value: input.storage },
          version: { number: input.expectedVersion + 1, message: input.message ?? "Updated by sf-agent-po" },
        }),
      });
    } catch (err) {
      if (err instanceof AtlassianError && err.status === 409) {
        throw new Error(`The page changed in Confluence after the preview (it is no longer at version ${input.expectedVersion}). Nothing was written. Publish again to see the page as it is now.`);
      }
      throw err;
    }
    return { pageId: input.pageId, url: this.pageUrl(r, input.pageId), version: r.version?.number ?? input.expectedVersion + 1 };
  }

  /**
   * Adds a file to a page, or a new version of the page's file with that name. Returns the
   * file's version, which a macro showing it names. The page's own version does not change.
   */
  async attachFile(input: { pageId: string; name: string; mediaType: string; content: string }): Promise<{ version: number }> {
    const form = new FormData();
    form.append("file", new Blob([input.content], { type: input.mediaType }), input.name);
    form.append("minorEdit", "true");
    const r = await this.request(`/wiki/rest/api/content/${encodeURIComponent(input.pageId)}/child/attachment`, {
      method: "PUT",
      headers: { "X-Atlassian-Token": "no-check" },
      body: form,
    });
    const file = (r?.results ?? []).find((f: any) => f?.title === input.name);
    const version = Number(file?.version?.number);
    // A macro naming a wrong version would show an old diagram without a word.
    if (!Number.isInteger(version) || version < 1) throw new Error(`Confluence did not return the version of the attached file ${input.name}.`);
    return { version };
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
  return m[1]!;
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
