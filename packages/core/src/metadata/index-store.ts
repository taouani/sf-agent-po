import type { Database } from "../store/db.js";
import type { ComponentType, EdgeKind, ParseCache, ParsedComponent, ParsedMetadata } from "./model.js";
import { componentKey } from "./objects.js";
import { readerVersion } from "./reader-version.js";

/**
 * How long a run that has not finished keeps others from indexing the same source. A run
 * that died (the host closed) holds it no longer than this, and is then cleared away.
 */
export const BUILD_LEASE_MS = 60 * 60 * 1000;

/**
 * A file parsed longer ago than this is parsed again, even unchanged: every file is read
 * afresh at least weekly, which catches what the cache or a changed-date listing could miss.
 */
export const FULL_RUN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface SnapshotSource {
  /** What was indexed: a folder path, a repository URL, or an org alias. */
  source: string;
  kind: "repo" | "org";
  /** A commit, or the retrieve time of an org. */
  revision?: string;
}

export interface SnapshotInfo extends SnapshotSource {
  id: number;
  status: "building" | "ready" | "failed";
  startedAt: string;
  finishedAt?: string;
  stats: SnapshotStats;
}

export interface SnapshotStats {
  /** Components read from the project, per type. */
  counts?: Partial<Record<ComponentType, number>>;
  /** Components only referenced (standard objects and fields outside the project). */
  referenced?: number;
  edges?: number;
  skipped?: { file: string; reason: string }[];
  /** How many were skipped in all, when there were more than `skipped` lists. */
  skippedCount?: number;
  /** Whether every file was parsed, with no use of the parse cache. */
  full?: boolean;
  /** The files read in detail, and how many came unchanged from the parse cache. */
  files?: { read: number; reused: number };
  error?: string;
}

/**
 * A component as the index holds it. `text` and the formulas in `attrs` are as the project
 * holds them, unmasked: whatever passes them to a model must mask them first.
 */
export interface IndexedComponent {
  id: number;
  type: ComponentType;
  name: string;
  parent?: string;
  /** The parent's type, with `parent`: CustomObject for a field, Bot for a bot version. */
  parentType?: ComponentType;
  label?: string;
  file?: string;
  missing: boolean;
  attrs: Record<string, unknown>;
  text: string;
}

/** Which link to name first when there are several: what changes data before what reads it. */
const KIND_ORDER: readonly EdgeKind[] = ["writes", "triggers_on", "calls", "reads", "grants", "shows", "references", "includes", "part_of"];

export interface Related {
  component: IndexedComponent;
  /** The strongest link (writes before reads): the first of `kinds`. */
  kind: EdgeKind;
  /** Every kind of link at that distance. */
  kinds: EdgeKind[];
  /** "out": the component depends on this one; "in": this one depends on the component. */
  direction: "out" | "in";
  depth: number;
}

/** An object of the project, with what is built on it. */
export interface ObjectSummary {
  name: string;
  label?: string;
  fields: number;
  rules: number;
  /** Flows (record-triggered or scheduled, any status) and Apex triggers that run on its records. */
  flows: number;
  triggers: number;
  /** Components that link to it, other than its own children. */
  linked: number;
}

/** A component the scope holds, besides its objects and their children. */
export interface ScopeMember {
  component: IndexedComponent;
  /** 1: linked to an object of the scope or one of its children; 2: called by or calling one of those. */
  hop: 1 | 2;
  /** How it is linked, most telling first. */
  kinds: EdgeKind[];
}

/** An object outside the scope that the scope's components touch: a candidate to add. */
export interface ScopeNeighbour {
  object: IndexedComponent;
  /** The scope's components linked to it (or to its fields), first ones. */
  via: { component: IndexedComponent; kinds: EdgeKind[] }[];
  /** How many links in all. */
  links: number;
}

/** What the server adds around the objects the user confirmed (decision SC). */
export interface MetadataScope {
  objects: IndexedComponent[];
  /** Fields, rules and record types of the objects. */
  children: IndexedComponent[];
  members: ScopeMember[];
  /** Busiest first. */
  neighbours: ScopeNeighbour[];
  /** Permission sets and profiles that give access to the objects or their fields, counted by type (impact analysis looks closer). */
  grantedBy: Record<string, number>;
  /** Objects asked for that the index does not have. */
  unknown: string[];
}

/** Types whose links lead further in the second hop: automation and code. */
const AUTOMATION = new Set(["Flow", "ApexClass", "ApexTrigger"]);
/** Neighbours kept, and links kept for each. */
const MAX_NEIGHBOURS = 40;
const MAX_VIA = 5;

interface ComponentRow {
  id: number;
  type: string;
  name: string;
  parent: string | null;
  parent_type: string | null;
  label: string | null;
  file: string | null;
  present: number;
  attrs: string;
  text: string;
}

interface SnapshotRow {
  id: number;
  source: string;
  kind: "repo" | "org";
  revision: string | null;
  status: "building" | "ready" | "failed";
  started_at: string;
  finished_at: string | null;
  stats: string;
}

const toComponent = (r: ComponentRow): IndexedComponent => ({
  id: r.id,
  type: r.type as ComponentType,
  name: r.name,
  ...(r.parent ? { parent: r.parent, parentType: (r.parent_type ?? "CustomObject") as ComponentType } : {}),
  ...(r.label ? { label: r.label } : {}),
  ...(r.file ? { file: r.file } : {}),
  missing: r.present === 0,
  attrs: JSON.parse(r.attrs) as Record<string, unknown>,
  text: r.text,
});

const toSnapshot = (r: SnapshotRow): SnapshotInfo => ({
  id: r.id,
  source: r.source,
  kind: r.kind,
  ...(r.revision ? { revision: r.revision } : {}),
  status: r.status,
  startedAt: r.started_at,
  ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
  stats: JSON.parse(r.stats) as SnapshotStats,
});

const COLUMNS = "c.id, c.type, c.name, c.parent, c.parent_type, c.label, c.file, c.present, c.attrs, c.text";

/** What a run holds while it reads: renewing it keeps another run of the source from starting. */
export interface BuildLease {
  /** Says the run is alive; call it between long steps (each part of an org retrieval). */
  renew(): void;
  /** Records the revision read, when it is only known once the run has fetched it (a remote repository). */
  setRevision(revision: string): void;
}

/** The metadata index in the workspace database: snapshots, components, edges, search. */
export class MetadataIndex {
  constructor(private readonly database: Database) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Indexes a source: records a building snapshot, reads it with `read`, stores what it
   * found in one transaction, and marks it ready. Older snapshots of the same source are
   * then removed. If reading fails, the snapshot is marked failed and the error rethrown;
   * the previous ready snapshot stays in use. While another run of the same source is under
   * way (started, or renewed its lease, less than an hour ago), this refuses, unless `force`
   * is set.
   */
  async build(
    source: SnapshotSource,
    read: (lease: BuildLease, cache: ParseCache) => Promise<ParsedMetadata>,
    options: { force?: boolean; full?: boolean } = {},
  ): Promise<SnapshotInfo> {
    const id = this.database.write(() => {
      const since = new Date(Date.now() - BUILD_LEASE_MS).toISOString();
      const running = this.db
        .prepare("SELECT started_at FROM metadata_snapshot WHERE source = ? AND status = 'building' AND coalesce(heartbeat_at, started_at) > ? ORDER BY id DESC LIMIT 1")
        .get(source.source, since) as { started_at: string } | undefined;
      if (running && !options.force) throw new Error(`${source.source} is already being indexed (since ${running.started_at}).`);
      const r = this.db
        .prepare("INSERT INTO metadata_snapshot (source, kind, revision, status, started_at) VALUES (?, ?, ?, 'building', ?) RETURNING id")
        .get(source.source, source.kind, source.revision ?? null, new Date().toISOString()) as { id: number };
      return r.id;
    });
    this.building.add(id);
    const lease: BuildLease = {
      renew: () => {
        if (this.building.has(id)) this.database.write(() => this.db.prepare("UPDATE metadata_snapshot SET heartbeat_at = ? WHERE id = ? AND status = 'building'").run(new Date().toISOString(), id));
      },
      setRevision: (revision) => {
        if (this.building.has(id)) this.database.write(() => this.db.prepare("UPDATE metadata_snapshot SET revision = ? WHERE id = ? AND status = 'building'").run(revision, id));
      },
    };
    try {
      const cache = this.parseCache(source.source, options.full);
      const parsed = await read(lease, cache);
      return this.database.write(() => {
        this.store(id, source.source, parsed, cache.full);
        cache.save();
        return this.snapshotById(id)!;
      });
    } catch (err) {
      this.fail(id, (err as Error)?.message ?? String(err));
      throw err;
    } finally {
      this.building.delete(id);
    }
  }

  private readonly building = new Set<number>();

  /**
   * The parse cache of a source for one run. A file's components are reused when its hash
   * and the readers' version match, and it was parsed less than FULL_RUN_AFTER_MS ago, so
   * that every file is parsed again at least weekly; nothing is reused when `forceFull` is
   * set. Rows are looked up one file at a time, so the cache is never all in memory. `save`
   * writes only what this run parsed and removes the rows of files that are gone (and of
   * sources no longer indexed), in the transaction that stores the snapshot, so a failed run
   * keeps the old rows.
   */
  private parseCache(source: string, forceFull = false): ParseCache & { full: boolean; save(): void } {
    const reader = readerVersion();
    const since = new Date(Date.now() - FULL_RUN_AFTER_MS).toISOString();
    const lookup = this.db.prepare("SELECT hash, components FROM metadata_file WHERE source = ? AND file = ? AND reader = ? AND parsed_at > ?");
    const seen = new Set<string>();
    const parsed = new Map<string, { hash: string; components: string }>();
    return {
      full: forceFull,
      get: (file, hash) => {
        if (forceFull) return undefined;
        const r = lookup.get(source, file, reader, since) as { hash: string; components: string } | undefined;
        if (!r || r.hash !== hash) return undefined;
        seen.add(file);
        return JSON.parse(r.components) as ParsedComponent[];
      },
      put: (file, hash, components) => {
        if (seen.has(file) && !parsed.has(file)) return; // reused as it was
        seen.add(file);
        parsed.set(file, { hash, components: JSON.stringify(components) });
      },
      save: () => {
        const now = new Date().toISOString();
        const upsert = this.db.prepare("INSERT OR REPLACE INTO metadata_file (source, file, hash, reader, parsed_at, components) VALUES (?, ?, ?, ?, ?, ?)");
        for (const [file, r] of parsed) upsert.run(source, file, r.hash, reader, now, r.components);
        const remove = this.db.prepare("DELETE FROM metadata_file WHERE source = ? AND file = ?");
        const files = (this.db.prepare("SELECT file FROM metadata_file WHERE source = ?").all(source) as { file: string }[]).map((r) => r.file);
        for (const file of files) if (!seen.has(file)) remove.run(source, file);
        this.db.prepare("DELETE FROM metadata_file WHERE source NOT IN (SELECT source FROM metadata_snapshot)").run();
      },
    };
  }

  private fail(id: number, error: string): void {
    this.database.write(() => {
      this.db
        .prepare("UPDATE metadata_snapshot SET status = 'failed', finished_at = ?, stats = ? WHERE id = ? AND status = 'building'")
        .run(new Date().toISOString(), JSON.stringify({ error }), id);
    });
  }

  /**
   * Marks every run this index started and has not finished as failed: for a process that is
   * being stopped, so that its runs do not block the next one for an hour.
   */
  abandon(reason = "stopped"): void {
    for (const id of this.building) this.fail(id, reason);
    this.building.clear();
  }

  private store(id: number, source: string, parsed: ParsedMetadata, full: boolean): void {
    const insert = this.db.prepare(
      "INSERT INTO component (snapshot, type, name, parent, parent_type, label, file, present, attrs, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    );
    const ids = new Map<string, number>();
    const counts: Partial<Record<ComponentType, number>> = {};
    let referenced = 0;
    for (const c of parsed.components) {
      const row = insert.get(id, c.type, c.name, c.parent ?? null, c.parent ? (c.parentType ?? "CustomObject") : null, c.label ?? null, c.file ?? null, c.missing ? 0 : 1, JSON.stringify(c.attrs), c.text) as { id: number };
      ids.set(componentKey(c.type, c.name), row.id);
      if (c.missing) referenced++;
      else counts[c.type] = (counts[c.type] ?? 0) + 1;
    }
    const edge = this.db.prepare("INSERT OR IGNORE INTO edge (src, dst, kind) VALUES (?, ?, ?)");
    let edges = 0;
    for (const e of parsed.edges) {
      const src = ids.get(componentKey(e.from.type, e.from.name));
      const dst = ids.get(componentKey(e.to.type, e.to.name));
      if (src === undefined || dst === undefined || src === dst) continue;
      edges += Number(edge.run(src, dst, e.kind).changes);
    }
    const stats: SnapshotStats = {
      counts,
      referenced,
      edges,
      skipped: parsed.skipped,
      ...(parsed.skippedCount ? { skippedCount: parsed.skippedCount } : {}),
      full: full || !parsed.files?.reused,
      ...(parsed.files ? { files: parsed.files } : {}),
    };
    this.db.prepare("UPDATE metadata_snapshot SET status = 'ready', finished_at = ?, stats = ? WHERE id = ?").run(new Date().toISOString(), JSON.stringify(stats), id);
    // The run that finishes last holds the newest reading of the source, whichever started
    // first, so it replaces every other; a run still building elsewhere is left alone unless
    // its lease ran out (it died).
    const since = new Date(Date.now() - BUILD_LEASE_MS).toISOString();
    this.db.prepare("DELETE FROM metadata_snapshot WHERE source = ? AND id != ? AND (status != 'building' OR coalesce(heartbeat_at, started_at) <= ?)").run(source, id, since);
  }

  /** The newest ready snapshot of a source. */
  latest(source: string): SnapshotInfo | undefined {
    const r = this.db.prepare("SELECT * FROM metadata_snapshot WHERE source = ? AND status = 'ready' ORDER BY finished_at DESC, id DESC LIMIT 1").get(source) as SnapshotRow | undefined;
    return r && toSnapshot(r);
  }

  snapshotById(id: number): SnapshotInfo | undefined {
    const r = this.db.prepare("SELECT * FROM metadata_snapshot WHERE id = ?").get(id) as SnapshotRow | undefined;
    return r && toSnapshot(r);
  }

  /** Every snapshot, newest first. */
  snapshots(): SnapshotInfo[] {
    return (this.db.prepare("SELECT * FROM metadata_snapshot ORDER BY id DESC").all() as unknown as SnapshotRow[]).map(toSnapshot);
  }

  /** A component by type and API name; the case of the name does not matter (the column ignores it, as Salesforce does). */
  component(snapshot: number, type: ComponentType, name: string): IndexedComponent | undefined {
    const r = this.db
      .prepare(`SELECT ${COLUMNS} FROM component c WHERE c.snapshot = ? AND c.type = ? AND c.name = ?`)
      .get(snapshot, type, name) as ComponentRow | undefined;
    return r && toComponent(r);
  }

  /**
   * The children of a component: of an object (its fields, record types, rules, list views...)
   * by default, or of another type's (a bot's versions, a workflow's rules), by type and name.
   */
  children(snapshot: number, parent: string, parentType: ComponentType = "CustomObject"): IndexedComponent[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM component c WHERE c.snapshot = ? AND c.parent_type = ? AND c.parent = ? ORDER BY c.present DESC, c.type, c.name`)
        .all(snapshot, parentType, parent) as unknown as ComponentRow[]
    ).map(toComponent);
  }

  /**
   * The objects of a snapshot that the project holds, busiest first: how many fields and other
   * children each has, how much automation runs on its records (flows and triggers), and how
   * many components link to it.
   */
  objectSummary(snapshot: number, limit = 30): ObjectSummary[] {
    const rows = this.db
      .prepare(
        `SELECT o.name, o.label,
           (SELECT count(*) FROM component f WHERE f.snapshot = o.snapshot AND f.parent_type = 'CustomObject' AND f.parent = o.name AND f.type = 'CustomField' AND f.present = 1) AS fields,
           (SELECT count(*) FROM component f WHERE f.snapshot = o.snapshot AND f.parent_type = 'CustomObject' AND f.parent = o.name AND f.type = 'ValidationRule' AND f.present = 1) AS rules,
           (SELECT count(*) FROM edge e JOIN component s ON s.id = e.src WHERE e.dst = o.id AND e.kind = 'triggers_on' AND s.type = 'Flow') AS flows,
           (SELECT count(*) FROM edge e JOIN component s ON s.id = e.src WHERE e.dst = o.id AND e.kind = 'triggers_on' AND s.type = 'ApexTrigger') AS triggers,
           (SELECT count(DISTINCT e.src) FROM edge e WHERE e.dst = o.id AND e.kind != 'part_of') AS linked
         FROM component o WHERE o.snapshot = ? AND o.type = 'CustomObject' AND o.present = 1
         ORDER BY flows + triggers DESC, fields DESC, o.name LIMIT ?`,
      )
      .all(snapshot, Math.min(Math.max(limit, 1), 500)) as unknown as (Omit<ObjectSummary, "label"> & { label: string | null })[];
    return rows.map(({ label, ...r }) => ({ ...r, ...(label ? { label } : {}) }));
  }

  /**
   * Components whose name, label or text contain every word of the query, best first; an
   * exact name comes first. Words of three letters or more use the full-text index; shorter
   * ones (two Chinese characters, "Id") are matched by substring.
   */
  search(snapshot: number, query: string, options: { types?: readonly ComponentType[]; limit?: number } = {}): IndexedComponent[] {
    const words = query.split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return [];
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
    const long = words.filter((w) => [...w].length >= 3);
    const short = words.filter((w) => [...w].length < 3);
    const where = ["c.snapshot = ?"];
    const params: (string | number)[] = [snapshot];
    if (options.types?.length) {
      where.push(`c.type IN (${options.types.map(() => "?").join(", ")})`);
      params.push(...options.types);
    }
    for (const w of short) {
      where.push("(c.name LIKE ? ESCAPE '\\' OR c.label LIKE ? ESCAPE '\\' OR c.text LIKE ? ESCAPE '\\')");
      const like = `%${w.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      params.push(like, like, like);
    }
    const exact = query.trim();
    if (long.length) {
      const match = long.map((w) => `"${w.replace(/"/g, '""')}"`).join(" AND ");
      const sql = `SELECT ${COLUMNS} FROM component_fts f JOIN component c ON c.id = f.rowid
        WHERE component_fts MATCH ? AND ${where.join(" AND ")}
        ORDER BY (c.name = ? COLLATE NOCASE OR c.label = ? COLLATE NOCASE) DESC, c.present DESC, f.rank LIMIT ?`;
      return (this.db.prepare(sql).all(match, ...params, exact, exact, limit) as unknown as ComponentRow[]).map(toComponent);
    }
    const sql = `SELECT ${COLUMNS} FROM component c WHERE ${where.join(" AND ")}
      ORDER BY (c.name = ? COLLATE NOCASE OR c.label = ? COLLATE NOCASE) DESC, c.present DESC, length(c.name), c.name LIMIT ?`;
    return (this.db.prepare(sql).all(...params, exact, exact, limit) as unknown as ComponentRow[]).map(toComponent);
  }

  /**
   * Components linked to one, up to `depth` hops (1 to 3), each at its shortest distance:
   * what it depends on ("out") and what depends on it ("in"). Beyond one hop, `kinds` are
   * those of the last hop. The walk keeps each (component, kind, direction, depth) once, so a
   * dense graph stays bounded by its size.
   */
  related(componentId: number, options: { depth?: number; kinds?: readonly EdgeKind[] } = {}): Related[] {
    const depth = Math.min(Math.max(options.depth ?? 1, 1), 3);
    const kinds = options.kinds?.length ? options.kinds : null;
    const kindFilter = kinds ? `AND e.kind IN (${kinds.map(() => "?").join(", ")})` : "";
    const kindParams = kinds ?? [];
    const sql = `
      WITH RECURSIVE walk(id, kind, direction, depth) AS (
        SELECT e.dst, e.kind, 'out', 1 FROM edge e WHERE e.src = ? ${kindFilter}
        UNION
        SELECT e.src, e.kind, 'in', 1 FROM edge e WHERE e.dst = ? ${kindFilter}
        UNION
        SELECT e.dst, e.kind, w.direction, w.depth + 1 FROM walk w JOIN edge e ON e.src = w.id
          WHERE w.direction = 'out' AND w.depth < ? ${kindFilter}
        UNION
        SELECT e.src, e.kind, w.direction, w.depth + 1 FROM walk w JOIN edge e ON e.dst = w.id
          WHERE w.direction = 'in' AND w.depth < ? ${kindFilter}
      )
      SELECT ${COLUMNS}, group_concat(DISTINCT w.kind) AS edge_kinds, w.direction, w.depth
      FROM walk w JOIN component c ON c.id = w.id
      WHERE w.id != ?
      GROUP BY c.id, w.direction, w.depth
      ORDER BY w.depth, w.direction DESC, c.type, c.name`;
    const rows = this.db
      .prepare(sql)
      .all(componentId, ...kindParams, componentId, ...kindParams, depth, ...kindParams, depth, ...kindParams, componentId) as unknown as (ComponentRow & {
      edge_kinds: string;
      direction: "out" | "in";
      depth: number;
    })[];
    // Rows come shortest first: each component is kept at its shortest distance, with every
    // way it is linked there (a trigger that reads and writes a field).
    const seen = new Set<string>();
    const out: Related[] = [];
    for (const r of rows) {
      const key = `${r.id}:${r.direction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const kinds = (r.edge_kinds.split(",") as EdgeKind[]).sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
      out.push({ component: toComponent(r), kind: kinds[0]!, kinds, direction: r.direction, depth: r.depth });
    }
    return out;
  }

  /**
   * Components of these types in the source (not those only referenced), by type and name, at
   * most `limit` (default 500); with `attr`, only those whose attrs have it (Apex with
   * calloutHosts).
   */
  ofTypes(snapshot: number, types: readonly ComponentType[], options: { attr?: string; limit?: number } = {}): IndexedComponent[] {
    if (!types.length) return [];
    if (options.attr !== undefined && !/^[A-Za-z]\w*$/.test(options.attr)) throw new Error(`Not an attribute name: ${options.attr}`);
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 5_000);
    const attr = options.attr ? `AND json_extract(c.attrs, '$.${options.attr}') IS NOT NULL` : "";
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM component c WHERE c.snapshot = ? AND c.present = 1 AND c.type IN (${types.map(() => "?").join(", ")}) ${attr} ORDER BY c.type, c.name LIMIT ?`)
        .all(snapshot, ...types, limit) as unknown as ComponentRow[]
    ).map(toComponent);
  }

  /** Components that name this host (its `host`, or one of its `calloutHosts` or `callbackHosts`), by type and name. */
  withHost(snapshot: number, host: string, limit = 200): IndexedComponent[] {
    const h = host.trim().toLowerCase();
    if (!h) return [];
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM component c WHERE c.snapshot = ? AND c.present = 1 AND (json_extract(c.attrs, '$.host') = ?
             OR EXISTS (SELECT 1 FROM json_each(c.attrs, '$.calloutHosts') WHERE value = ?)
             OR EXISTS (SELECT 1 FROM json_each(c.attrs, '$.callbackHosts') WHERE value = ?))
           ORDER BY c.type, c.name LIMIT ?`,
        )
        .all(snapshot, h, h, h, Math.min(Math.max(limit, 1), 1_000)) as unknown as ComponentRow[]
    ).map(toComponent);
  }

  /**
   * Apex the index cannot follow (queries built from strings, classes named at run time,
   * describes: its `dynamic` attr) or could not read (too large), by name.
   */
  blindSpots(snapshot: number): IndexedComponent[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM component c WHERE c.snapshot = ? AND c.type IN ('ApexClass', 'ApexTrigger')
           AND (json_extract(c.attrs, '$.dynamic') IS NOT NULL OR json_extract(c.attrs, '$.tooLarge') = 1) ORDER BY c.type, c.name`,
        )
        .all(snapshot) as unknown as ComponentRow[]
    ).map(toComponent);
  }

  /** The components that write an object or any of its fields (whose saves a new rule or required field can break). */
  writersOf(snapshot: number, object: string): IndexedComponent[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT ${COLUMNS} FROM edge e JOIN component t ON t.id = e.dst JOIN component c ON c.id = e.src
           WHERE e.kind = 'writes' AND t.snapshot = ? AND ((t.type = 'CustomObject' AND t.name = ?) OR (t.parent_type = 'CustomObject' AND t.parent = ?))
           ORDER BY c.type, c.name`,
        )
        .all(snapshot, object, object) as unknown as ComponentRow[]
    ).map(toComponent);
  }

  /**
   * What depends on these components (a component, or an object and all its parts): what
   * links to them, then (depth 2) what reads, writes, calls or shows those. Grants and
   * permission set groups count only on the first link, and part_of never: an object's parts
   * are given with it, not as its dependents.
   */
  dependents(ids: readonly number[], depth: 1 | 2 = 2): Related[] {
    if (!ids.length) return [];
    const own = new Set(ids);
    const incoming = (targets: readonly number[], kinds: string) =>
      this.db
        .prepare(
          `SELECT e.src AS id, group_concat(DISTINCT e.kind) AS kinds FROM edge e
           WHERE e.dst IN (SELECT value FROM json_each(?)) AND e.kind IN (${kinds}) GROUP BY e.src`,
        )
        .all(JSON.stringify(targets)) as unknown as { id: number; kinds: string }[];
    const first = incoming(ids, "'references', 'reads', 'writes', 'triggers_on', 'calls', 'grants', 'includes', 'shows'").filter((r) => !own.has(r.id));
    const seen = new Set([...own, ...first.map((r) => r.id)]);
    const second = depth === 2 ? incoming(first.filter((r) => r.kinds.split(",").some((k) => k !== "grants" && k !== "includes")).map((r) => r.id), "'references', 'reads', 'writes', 'triggers_on', 'calls', 'shows'").filter((r) => !seen.has(r.id)) : [];
    const components = this.byIds([...first, ...second].map((r) => r.id));
    const out: Related[] = [];
    for (const [rows, d] of [[first, 1], [second, 2]] as const)
      for (const r of rows) {
        const component = components.get(r.id);
        if (!component) continue;
        const kinds = (r.kinds.split(",") as EdgeKind[]).sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
        out.push({ component, kind: kinds[0]!, kinds, direction: "in", depth: d });
      }
    return out.sort((a, b) => a.depth - b.depth || a.component.type.localeCompare(b.component.type) || a.component.name.localeCompare(b.component.name));
  }

  /** Components by id, in no particular order. */
  private byIds(ids: readonly number[]): Map<number, IndexedComponent> {
    if (!ids.length) return new Map();
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM component c WHERE c.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as unknown as ComponentRow[];
    return new Map(rows.map((r) => [r.id, toComponent(r)]));
  }

  /** The edges from or to any of these components, other than grants and part_of (which the scope reads apart). */
  private edgesAround(ids: readonly number[]): { src: number; dst: number; kind: EdgeKind }[] {
    if (!ids.length) return [];
    const list = JSON.stringify(ids);
    return this.db
      .prepare(
        `SELECT src, dst, kind FROM edge WHERE src IN (SELECT value FROM json_each(?)) AND kind NOT IN ('grants', 'includes', 'part_of')
         UNION SELECT src, dst, kind FROM edge WHERE dst IN (SELECT value FROM json_each(?)) AND kind NOT IN ('grants', 'includes', 'part_of')`,
      )
      .all(list, list) as unknown as { src: number; dst: number; kind: EdgeKind }[];
  }

  /** The permission sets and profiles that grant any of these components, counted by type. */
  private grantorsOf(ids: readonly number[]): Record<string, number> {
    if (!ids.length) return {};
    const rows = this.db
      .prepare(
        `SELECT c.type AS type, count(DISTINCT e.src) AS n FROM edge e JOIN component c ON c.id = e.src
         WHERE e.kind = 'grants' AND e.dst IN (SELECT value FROM json_each(?)) GROUP BY c.type ORDER BY c.type`,
      )
      .all(JSON.stringify(ids)) as unknown as { type: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.type, r.n]));
  }

  /**
   * The scope of a piece of work: the objects the user confirmed, their fields, rules and record
   * types, and what is linked to them (the flows, triggers and code that run on, read or write
   * them, the layouts that show them, lookups to them from other objects); with two hops, also
   * what that automation calls or is called by. Objects outside the scope that it touches are
   * neighbours: candidates to add. Grants are only counted, since a profile grants nearly
   * everything. `neighbours: false` skips what only neighbours and the second hop need.
   */
  scope(snapshot: number, objects: readonly string[], options: { hops?: 1 | 2; neighbours?: boolean } = {}): MetadataScope {
    const hops = options.hops ?? 2;
    const wantNeighbours = options.neighbours ?? true;
    const found: IndexedComponent[] = [];
    const unknown: string[] = [];
    for (const name of new Set(objects.map((o) => o.trim()).filter(Boolean))) {
      const c = this.component(snapshot, "CustomObject", name);
      if (c && !found.some((f) => f.id === c.id)) found.push(c);
      else if (!c) unknown.push(name);
    }
    const inScope = new Set(found.map((o) => o.name.toLowerCase()));
    // Standard fields only referenced are walked too (a formula or Apex reading Account.Industry),
    // but not listed as the object's own.
    const allChildren = found.flatMap((o) => this.children(snapshot, o.name));
    const local = new Map<number, IndexedComponent>([...found, ...allChildren].map((c) => [c.id, c]));
    const core = new Set(local.keys());

    const members = new Map<number, { hop: 1 | 2; kinds: Set<EdgeKind> }>();
    const note = (id: number, hop: 1 | 2, kind: EdgeKind) => {
      const m = members.get(id) ?? { hop, kinds: new Set<EdgeKind>() };
      m.kinds.add(kind);
      members.set(id, m);
    };
    // Neighbour object id -> the scope's component linked to it -> how.
    const touches = new Map<number, Map<number, Set<EdgeKind>>>();
    const objectIds = new Map<string, number | undefined>();
    const objectId = (name: string) => {
      const key = name.toLowerCase();
      if (!objectIds.has(key)) objectIds.set(key, this.component(snapshot, "CustomObject", name)?.id);
      return objectIds.get(key);
    };
    const touch = (object: number | undefined, via: number, kind: EdgeKind) => {
      if (object === undefined) return;
      const byScope = touches.get(object) ?? new Map<number, Set<EdgeKind>>();
      byScope.set(via, (byScope.get(via) ?? new Set<EdgeKind>()).add(kind));
      touches.set(object, byScope);
    };
    /** The object an outside component belongs to, when it is not in the scope. */
    const outsideObject = (c: IndexedComponent) => {
      if (c.type === "CustomObject") return inScope.has(c.name.toLowerCase()) ? undefined : c.id;
      if (!c.parent || (c.parentType !== undefined && c.parentType !== "CustomObject") || inScope.has(c.parent.toLowerCase())) return undefined;
      return objectId(c.parent);
    };

    // Hop 1: whatever links to the objects and their children.
    const first = this.edgesAround([...core]).filter((e) => !(core.has(e.src) && core.has(e.dst)));
    const reached1 = this.byIds([...new Set(first.map((e) => (core.has(e.src) ? e.dst : e.src)))]);
    for (const e of first) {
      const own = core.has(e.src) ? e.src : e.dst;
      const c = reached1.get(own === e.src ? e.dst : e.src);
      if (!c) continue;
      const object = outsideObject(c);
      if (c.type === "CustomObject") touch(object, own, e.kind);
      else if (object !== undefined && c.id === e.dst) {
        // An in-scope formula or lookup reads or points to another object's field: that object is a neighbour.
        touch(object, own, e.kind);
      } else {
        note(c.id, 1, e.kind);
        // A field of another object that uses the scope (a lookup to it): a member, and its object a neighbour.
        if (object !== undefined) touch(object, c.id, e.kind);
      }
    }
    for (const [id, c] of reached1) if (members.has(id)) local.set(id, c);

    // Automation of the first hop: the other objects it runs on, reads or writes are neighbours;
    // with two hops, what it calls and what calls it join the scope.
    const automation = [...members.keys()].filter((id) => AUTOMATION.has(local.get(id)!.type));
    if (wantNeighbours || hops === 2) {
      const auto = new Set(automation);
      const second = this.edgesAround(automation);
      const reached2 = this.byIds([...new Set(second.map((e) => (auto.has(e.src) ? e.dst : e.src)))]);
      for (const e of second) {
        const from = auto.has(e.src) ? e.src : e.dst;
        const other = from === e.src ? e.dst : e.src;
        const c = reached2.get(other);
        if (!c || core.has(other) || (members.has(other) && members.get(other)!.hop === 1)) continue;
        if (e.kind === "calls" || (e.kind === "references" && from === e.src && c.type !== "CustomObject")) {
          if (hops === 2) {
            note(other, 2, e.kind);
            local.set(other, c);
          }
        } else if (wantNeighbours && from === e.src && (e.kind === "reads" || e.kind === "writes" || e.kind === "triggers_on")) touch(outsideObject(c), from, e.kind);
      }
    }

    const objectsById = this.byIds([...touches.keys()]);
    const neighbours = [...touches]
      .flatMap(([id, byScope]) => {
        const object = objectsById.get(id);
        if (!object) return [];
        const via = [...byScope].flatMap(([from, kinds]) => {
          const component = local.get(from);
          return component ? [{ component, kinds: [...kinds].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b)) }] : [];
        });
        return [{ object, via: via.slice(0, MAX_VIA), links: via.length }];
      })
      .sort((a, b) => b.links - a.links || a.object.name.localeCompare(b.object.name))
      .slice(0, MAX_NEIGHBOURS);

    return {
      objects: found,
      children: allChildren.filter((c) => !c.missing),
      members: [...members]
        .map(([id, m]) => ({ component: local.get(id)!, hop: m.hop, kinds: [...m.kinds].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b)) }))
        .sort((a, b) => a.hop - b.hop || a.component.type.localeCompare(b.component.type) || a.component.name.localeCompare(b.component.name)),
      neighbours: wantNeighbours ? neighbours : [],
      grantedBy: this.grantorsOf([...core]),
      unknown,
    };
  }
}
