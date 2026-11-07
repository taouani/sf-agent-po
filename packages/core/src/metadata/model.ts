/** What the metadata readers produce and the index stores (decision B, DE2). */

/** Metadata types the readers understand, named as in the Metadata API. */
export const COMPONENT_TYPES = ["CustomObject", "CustomField", "RecordType", "ValidationRule"] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

/**
 * How one component depends on another:
 * - part_of: a field, record type or rule belongs to its object;
 * - references: a lookup or master-detail field points at an object;
 * - reads: a formula or rule uses a field.
 */
export const EDGE_KINDS = ["part_of", "references", "reads"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface ParsedComponent {
  type: ComponentType;
  /** Full name: "Account" for an object, "Account.Industry__c" for a field. */
  name: string;
  /** The object a child component belongs to. */
  parent?: string;
  label?: string;
  /** True for a component only referenced, not in the project (a standard object or field). */
  missing?: boolean;
  /** The file it was read from, relative to the project root, with forward slashes. */
  file?: string;
  /** Structured attributes: field type, length, formula, referenceTo... */
  attrs: Record<string, unknown>;
  /**
   * Free text that can hold personal data (descriptions, help text, picklist values,
   * error messages). Stored as the project holds it; masked before any tool returns it.
   */
  text: string;
}

/** An edge between two components, each named by type and full name. */
export interface ParsedEdge {
  from: { type: ComponentType; name: string };
  to: { type: ComponentType; name: string };
  kind: EdgeKind;
}

export interface ParsedMetadata {
  components: ParsedComponent[];
  edges: ParsedEdge[];
  /** Files that could not be read, with the reason, relative to the root. */
  skipped: { file: string; reason: string }[];
  /** How many were skipped in all, when there were more than `skipped` lists. */
  skippedCount?: number;
}
