// What the agents produce (designs and backlogs) lives in the requirement context as
// ordinary documents, so whichever agent runs second reads the first one's output. Artifacts
// are stored masked, like inputs: the pseudonyms the agents used stay, and what they wrote in
// clear is masked (Masker.maskOutput).

import { createHash } from "node:crypto";
import type { ContextRepository, DocumentKind, SourceDocument } from "@sf-agent-po/core";

export interface ArtifactMeta {
  artifact: true;
  /** e.g. "high-level" or "detailed" for designs. */
  artifactType?: string;
  version: number;
  /** "changed" means edited since it was last published. */
  status: "draft" | "published" | "changed";
  /** Context document ids the artifact was derived from. */
  sourceIds?: string[];
  confluence?: { pageId: string; url: string; pageVersion: number; artifactVersion: number; publishedAt: string };
  /** Where a backlog's items were published in Jira (jira.ts). */
  jira?: JiraMapping;
  /** Identifies the saved version: a hash of the content unless the caller gives one. */
  fingerprint?: string;
  /** When this version's content was saved: a save with unchanged content, or a publish, keeps it. */
  savedAt?: string;
  [key: string]: unknown;
}

/** Where each backlog item was published in Jira, so publishing again updates instead of duplicating. */
export interface JiraMapping {
  projectKey: string;
  /**
   * `hash` covers the masked fields last sent; `labels` are the masked labels this backlog set,
   * so a label removed here is removed in Jira while labels added in Jira stay; `updated` is
   * Jira's timestamp right after our last write, to spot edits made in Jira since.
   */
  items: Record<string, { key: string; url: string; hash?: string; labels?: string[]; updated?: string; sent?: SentStory }>;
  /** The story points field last published to, so the Jira diff reads the same one. */
  storyPointsField?: string;
  /** Dependency links already created, as "BLOCKER>BLOCKED" issue keys. */
  links: string[];
  publishedVersion?: number;
}

/** What a story was published as, masked: what the Jira diff compares Jira with. */
export interface SentStory {
  summary: string;
  /** The description as plain text. */
  text: string;
  points?: number;
}

export type Artifact = SourceDocument & { metadata: ArtifactMeta };

export interface SaveArtifactInput {
  kind: DocumentKind;
  /** The masked title. */
  title: string;
  /** The masked content. */
  content: string;
  artifactType?: string;
  sourceIds?: string[];
  extra?: Record<string, unknown>;
  fingerprint?: string;
}

export const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The identity of an artifact: its kind, its type (a high-level and a detailed design with the
 * same title stay apart) and its masked title, so no clear value ends up in its source.
 */
export function artifactSource(kind: DocumentKind, title: string, artifactType?: string): string {
  const slug = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/[\s_-]+/g, "-");
  const name = slug || `title-${hash(title).slice(0, 12)}`;
  return `artifact:${kind}:${artifactType ? `${artifactType}:` : ""}${name}`;
}

/** Saves an artifact, bumping its version when the content changed and keeping where it was published. */
export function saveArtifact(contexts: ContextRepository, context: string, input: SaveArtifactInput): Artifact {
  const source = artifactSource(input.kind, input.title, input.artifactType);
  return contexts.upsertDocument(context, source, (found) => {
    // An artifact imported from 0.x and not masked yet: its metadata is in clear. Only where it
    // was published is kept (ids and numbers, and the link without its title part), so the
    // next publish updates the same page.
    const existing = found && !found.masked ? { ...found, content: "", metadata: legacyMeta(found.metadata) } : found;
    const prev = existing?.metadata as ArtifactMeta | undefined;
    const fingerprint = input.fingerprint ?? hash(input.content);
    const changed = !existing || (prev?.fingerprint ?? hash(existing.content)) !== fingerprint;
    const version = prev?.artifact ? prev.version + (changed ? 1 : 0) : 1;
    const status: ArtifactMeta["status"] = !prev?.confluence && !prev?.jira ? "draft" : changed ? "changed" : prev.status;
    const metadata: ArtifactMeta = {
      ...prev,
      ...input.extra,
      artifact: true,
      artifactType: input.artifactType ?? prev?.artifactType,
      version,
      status,
      sourceIds: input.sourceIds ?? prev?.sourceIds,
      fingerprint,
      savedAt: changed ? new Date().toISOString() : (prev?.savedAt ?? existing!.updatedAt),
    };
    return { kind: input.kind, title: input.title, source, content: input.content, metadata, masked: true };
  }) as Artifact;
}

/**
 * What can be kept of a 0.x artifact's metadata, nothing in clear: its version, its Confluence
 * page, and the Jira issues and links its items were published to (keys, links and Jira's
 * timestamps; not the labels, nor the hashes of what was sent).
 */
function legacyMeta(meta: Record<string, unknown>): Partial<ArtifactMeta> {
  const old = meta as Partial<ArtifactMeta>;
  const c = old.confluence;
  const j = old.jira;
  const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
  const items = Object.entries(j?.items ?? {}).flatMap(([id, i]) =>
    /^[A-Za-z][\w-]{0,31}$/.test(id) && KEY.test(String(i?.key)) ? [[id, { key: String(i.key), url: browseLink(String(i.url), String(i.key)), ...(typeof i.updated === "string" && { updated: i.updated }) }] as const] : [],
  );
  return {
    artifact: true,
    version: typeof old.version === "number" ? old.version : 0,
    status: c || (j && items.length) ? "published" : "draft",
    ...(c && { confluence: { pageId: String(c.pageId), url: pageLink(String(c.url)), pageVersion: Number(c.pageVersion), artifactVersion: Number(c.artifactVersion), publishedAt: String(c.publishedAt) } }),
    ...(j &&
      items.length &&
      /^[A-Z][A-Z0-9_]+$/.test(String(j.projectKey)) && {
        jira: {
          projectKey: String(j.projectKey),
          items: Object.fromEntries(items),
          links: (Array.isArray(j.links) ? j.links : []).filter((l): l is string => typeof l === "string" && /^[A-Z][A-Z0-9_]+-\d+>[A-Z][A-Z0-9_]+-\d+$/.test(l)),
        },
      }),
  };
}

/** An issue's link, from where Jira says it is: the site and /browse/KEY, nothing else. */
const browseLink = (url: string, key: string) => {
  const site = url.match(/^https:\/\/[^/?#]+/)?.[0];
  return site ? `${site}/browse/${key}` : "";
};

/** A page link without its title part ("/pages/123/Call+with+Karim"), which may hold a real name. */
export const pageLink = (url: string) => url.replace(/(\/pages\/\d+)\/[^?#]*/, "$1");

export function getArtifact(contexts: ContextRepository, context: string, id: string): Artifact {
  const doc = contexts.getDocument(context, id);
  if (!doc) throw new Error(`No document ${id} in context "${context}".`);
  if (!(doc.metadata as Partial<ArtifactMeta>).artifact) {
    throw new Error(`Document ${id} is an input (${doc.kind}), not an artifact the agents produced. Only designs and backlogs can be published.`);
  }
  if (!doc.masked) throw new Error(`Artifact ${id} is not masked yet, so it cannot be published.`);
  return doc as Artifact;
}

/** Records publish results on an artifact without touching its content or version. */
export function updateArtifactMeta(contexts: ContextRepository, context: string, doc: SourceDocument, patch: (meta: ArtifactMeta) => Partial<ArtifactMeta>): Artifact {
  return contexts.upsertDocument(context, doc.source, (existing) => {
    if (!existing) throw new Error(`Artifact ${doc.id} was removed while publishing.`);
    const meta = existing.metadata as ArtifactMeta;
    return { ...existing, metadata: { ...meta, ...patch(meta) } };
  }) as Artifact;
}

/** One task at a time per key, so a retried or parallel publish of one artifact cannot write twice. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
