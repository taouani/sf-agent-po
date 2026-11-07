/** What the metadata readers produce and the index stores (decision B, DE2). */

/**
 * Metadata types the readers understand in detail, named as in the Metadata API. Every other
 * type in the registry is indexed by name and file only.
 */
export const COMPONENT_TYPES = ["CustomObject", "CustomField", "RecordType", "ValidationRule", "Flow"] as const;
/** A Metadata API type name: one of COMPONENT_TYPES, or any other the registry knows. */
export type ComponentType = string;

/**
 * How one component depends on another:
 * - part_of: a field, record type or rule belongs to its object;
 * - references: a lookup or master-detail field points at an object;
 * - reads: a formula, rule or flow uses a field (or queries an object);
 * - writes: a flow sets a field (or creates, updates or deletes records of an object);
 * - triggers_on: a record-triggered flow runs when records of an object change;
 * - calls: a flow runs an Apex action or a subflow.
 */
export const EDGE_KINDS = ["part_of", "references", "reads", "writes", "triggers_on", "calls"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * A dependency a reader found but cannot name in full yet: the linker resolves it once every
 * component is known. With `path`, the fields a formula-style path reads on `object`
 * ("Account__r.Owner.Email"); with `object` alone, the object; with `type` and `name`, that
 * component.
 */
export type Ref =
  | { kind: EdgeKind; object: string; path?: string }
  | { kind: EdgeKind; type: ComponentType; name: string };

export interface ParsedComponent {
  type: ComponentType;
  /** Full name: "Account" for an object, "Account.Industry__c" for a field. */
  name: string;
  /** The component a child belongs to (its object, for a field). */
  parent?: string;
  /** The parent's type, when it is not CustomObject (a bot version's bot). */
  parentType?: ComponentType;
  label?: string;
  /** True for a component only referenced, not in the project (a standard object or field). */
  missing?: boolean;
  /** The file it was read from, relative to the project root, with forward slashes. */
  file?: string;
  /** Dependencies to resolve when linking; not stored. */
  refs?: Ref[];
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
