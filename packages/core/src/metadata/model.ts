/** What the metadata readers produce and the index stores (decision B, DE2). */

/**
 * Metadata types the readers understand in detail, named as in the Metadata API. Every other
 * type in the registry is indexed by name and file only.
 */
export const COMPONENT_TYPES = [
  "CustomObject", "CustomField", "RecordType", "ValidationRule", "Flow", "ApexClass", "ApexTrigger",
  "PermissionSet", "Profile", "PermissionSetGroup", "Layout", "FieldSet", "ApexPage", "ApexComponent", "EmailTemplate",
  "Report", "Dashboard", "ReportType",
  "NamedCredential", "ExternalCredential", "RemoteSiteSetting", "ConnectedApp", "ExternalServiceRegistration",
  "PlatformEventChannel", "PlatformEventChannelMember", "Workflow", "WorkflowOutboundMessage", "CustomMetadata",
  "SharingRules", "Role", "Group", "Queue",
] as const;
/** A Metadata API type name: one of COMPONENT_TYPES, or any other the registry knows. */
export type ComponentType = (typeof COMPONENT_TYPES)[number] | (string & {});

/**
 * How one component depends on another:
 * - part_of: a field, record type or rule belongs to its object;
 * - references: a sharing rule shares to or from a group, role or queue; a role sits under its
 *   parent role; a queue owns records of an object and holds roles and groups; a lookup or
 *   master-detail field points at an object, a flow variable is of
 *   an Apex-defined type, or a person account field (Account.Foo__pc) stands for its contact
 *   field (Contact.Foo__c); a named credential uses an external credential (or, the legacy
 *   kind, an auth provider), an external credential uses an auth provider, and an external
 *   service calls through a named credential;
 * - reads: a formula, rule, flow, code, page or email template uses a field (or queries an object);
 *   a report shows, groups or filters on a field and is built on a report type; a dashboard
 *   shows a report; a report type is built on objects and offers their fields;
 * - writes: a flow sets a field (or creates, updates or deletes records of an object); Apex
 *   publishes a platform event (EventBus.publish of a new Foo__e);
 * - triggers_on: a flow, process or Apex trigger runs for records of an object: when they change
 *   (record-triggered) or on a schedule. Draft and obsolete flows have the edge too, since
 *   they would run once activated: their `status` attr says whether they do now;
 * - calls: a flow runs an Apex action, a subflow, an email alert, a quick action, an external
 *   service or a custom screen component; Apex uses another class, starts a flow or calls out
 *   through a named credential (callout:Name); a Visualforce page or component uses its
 *   controller, extensions and components;
 * - grants: a permission set or profile gives access to an object, field, class, page, flow,
 *   record type, app, custom permission or layout (how much is in its attrs); an object's
 *   sharing rules give access to its records;
 * - includes: a permission set group holds a permission set;
 * - shows: a layout puts a field, button, related list, page or action in front of users; a
 *   field set lists a field;
 * - may_read: Apex builds a query in strings that reads an object or field (a weaker link than
 *   reads: the query is pieced together from the strings and string constants the code holds);
 *   the records of a custom metadata type name an object or field (a mapping the code that
 *   reads the type may follow).
 */
export const EDGE_KINDS = ["part_of", "references", "reads", "writes", "triggers_on", "calls", "grants", "includes", "shows", "may_read"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * A dependency a reader found but cannot name in full yet: the linker resolves it once every
 * component is known. With `path`, the fields a formula-style path reads on `object`
 * ("Account__r.Owner.Email"); a write writes the field at its end, and that field's object;
 * with `object` alone, the object; with `type` and `name`, that component. Several types are
 * alternatives, best first: the first the project has, or else the first.
 * With `known`, the reference is dropped unless the project has the component: code names
 * many things ("System.debug") that only might be a class or an object.
 * With `field` alone, a custom field named without its object (reached through something the
 * reader cannot type, or named in a string): linked only when the component has no other link
 * to a field of that name and one object alone has it (Foo__pc is always Account's). With
 * `among`, it is a field of each of those objects that has it (an email's recipient is a
 * contact, a lead or a user).
 */
export type Ref =
  | { kind: EdgeKind; field: string; among?: readonly string[] }
  | { kind: EdgeKind; object: string; path?: string; known?: boolean }
  | { kind: EdgeKind; type: ComponentType | readonly ComponentType[]; name: string; known?: boolean };

export interface ParsedComponent {
  type: ComponentType;
  /**
   * Full name: "Account" for an object, "Account.Industry__c" for a field. Names of types kept
   * in folders people create and name (reports, dashboards, documents, email templates) can
   * name clients or people, as `text` can: tools mask them, and `file`, the same way.
   */
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
  /**
   * The code of an Apex class or trigger, comments included, with the secrets written in its
   * strings hidden: stored apart from `text` (it is not searched) and masked before any tool returns it.
   */
  body?: string;
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
  /** With a parse cache: the files read in detail, and how many of them came from the cache. */
  files?: { read: number; reused: number };
}

/**
 * What the last run read from each file, by its content's hash, so that a run parses only
 * the files that changed. `get` gives the components of a file whose hash has not changed;
 * `put` records a file's components for the next run.
 */
export interface ParseCache {
  get(file: string, hash: string): ParsedComponent[] | undefined;
  put(file: string, hash: string, components: ParsedComponent[]): void;
}
