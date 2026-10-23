/**
 * The requirement context is the shared input both agents read. Every source
 * (meeting notes, emails, Jira, Confluence, metadata, org) is normalised into
 * a SourceDocument so the agents can reason over them uniformly.
 */

export const DOCUMENT_KINDS = [
  "meeting-notes",
  "email",
  "pi-planning",
  "jira",
  "confluence",
  "metadata",
  "org",
  "design",
  "backlog",
  "other",
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface SourceDocument {
  id: string;
  kind: DocumentKind;
  title: string;
  /** Where the document came from: a file path, URL, issue key, org alias, etc. */
  source: string;
  content: string;
  /** Structured extras, e.g. email sender or Jira status. */
  metadata?: Record<string, unknown>;
  addedAt: string;
}

export interface RequirementContext {
  name: string;
  createdAt: string;
  updatedAt: string;
  documents: SourceDocument[];
}
