import { createHash } from "node:crypto";
import type { ContextStore } from "../context/store.js";
import type { DocumentKind, SourceDocument } from "../context/types.js";

/**
 * Artifacts are what the agents produce (designs, backlogs). They live in the
 * requirement context as ordinary documents, so whichever agent runs second
 * reads the first one's output: a PO working from the SA's high-level design,
 * or an SA designing from the PO's stories.
 */
export interface ArtifactMeta {
  artifact: true;
  /** e.g. "high-level" or "detailed" for designs. */
  artifactType?: string;
  version: number;
  /** "changed" means edited since it was last published. */
  status: "draft" | "published" | "changed";
  /** Context document ids the artifact was derived from, for traceability. */
  sourceIds?: string[];
  confluence?: { pageId: string; url: string; pageVersion: number; artifactVersion: number; publishedAt: string };
  [key: string]: unknown;
}

export interface SaveArtifactInput {
  kind: DocumentKind;
  title: string;
  content: string;
  artifactType?: string;
  sourceIds?: string[];
  /** Extra metadata to store, e.g. the structured backlog. */
  extra?: Record<string, unknown>;
}

/**
 * The identity of an artifact: its kind, its type (so a high-level and a
 * detailed design with the same title stay apart) and its title. Letters and
 * digits of any script are kept, so non-Latin titles stay distinct.
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
export function saveArtifact(store: ContextStore, context: string, input: SaveArtifactInput): Promise<SourceDocument> {
  const source = artifactSource(input.kind, input.title, input.artifactType);
  return store.upsertDocument(context, source, (existing) => {
    const prev = existing?.metadata as ArtifactMeta | undefined;
    const changed = !existing || hash(existing.content) !== hash(input.content);
    const version = prev ? prev.version + (changed ? 1 : 0) : 1;
    const status: ArtifactMeta["status"] = !prev?.confluence && !prev?.jira ? "draft" : changed ? "changed" : prev.status;
    const metadata: ArtifactMeta = {
      ...prev,
      ...input.extra,
      artifact: true,
      artifactType: input.artifactType ?? prev?.artifactType,
      version,
      status,
      sourceIds: input.sourceIds ?? prev?.sourceIds,
    };
    return { kind: input.kind, title: input.title, source, content: input.content, metadata };
  });
}

export async function getArtifact(store: ContextStore, context: string, id: string): Promise<SourceDocument & { metadata: ArtifactMeta }> {
  const doc = await store.getDocument(context, id);
  if (!doc) throw new Error(`No document ${id} in context "${context}".`);
  if (!(doc.metadata as ArtifactMeta | undefined)?.artifact) {
    throw new Error(`Document ${id} is an input (${doc.kind}), not an artifact produced by the agents. Only designs and backlogs can be published.`);
  }
  return doc as SourceDocument & { metadata: ArtifactMeta };
}

/** Records publish results on an artifact without touching its content or version. */
export function updateArtifactMeta(
  store: ContextStore,
  context: string,
  doc: SourceDocument,
  patch: (meta: ArtifactMeta) => Partial<ArtifactMeta>,
): Promise<SourceDocument> {
  return store.upsertDocument(context, doc.source, (existing) => {
    if (!existing) throw new Error(`Artifact ${doc.id} was removed while publishing.`);
    const meta = existing.metadata as ArtifactMeta;
    return { ...existing, metadata: { ...meta, ...patch(meta) } };
  });
}

export function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
