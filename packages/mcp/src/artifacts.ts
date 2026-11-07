// What the agents produce (designs, and later backlogs) lives in the requirement context as
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
  /** Identifies the saved version: a hash of the content unless the caller gives one. */
  fingerprint?: string;
  [key: string]: unknown;
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
    };
    return { kind: input.kind, title: input.title, source, content: input.content, metadata, masked: true };
  }) as Artifact;
}

/** What can be kept of a 0.x artifact's metadata: its version and Confluence page, nothing in clear. */
function legacyMeta(meta: Record<string, unknown>): Partial<ArtifactMeta> {
  const old = meta as Partial<ArtifactMeta>;
  const c = old.confluence;
  return {
    artifact: true,
    version: typeof old.version === "number" ? old.version : 0,
    status: c ? "published" : "draft",
    ...(c && { confluence: { pageId: String(c.pageId), url: pageLink(String(c.url)), pageVersion: Number(c.pageVersion), artifactVersion: Number(c.artifactVersion), publishedAt: String(c.publishedAt) } }),
  };
}

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
