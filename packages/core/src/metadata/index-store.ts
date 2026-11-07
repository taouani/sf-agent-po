import type { Database } from "../store/db.js";
import type { ComponentType, EdgeKind, ParsedMetadata } from "./model.js";
import { componentKey } from "./objects.js";

/**
 * How long a run that has not finished keeps others from indexing the same source. A run
 * that died (the host closed) holds it no longer than this, and is then cleared away.
 */
export const BUILD_LEASE_MS = 60 * 60 * 1000;

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
   * way (started less than an hour ago), this refuses, unless `force` is set.
   */
  async build(source: SnapshotSource, read: () => Promise<ParsedMetadata>, options: { force?: boolean } = {}): Promise<SnapshotInfo> {
    const id = this.database.write(() => {
      const since = new Date(Date.now() - BUILD_LEASE_MS).toISOString();
      const running = this.db
        .prepare("SELECT started_at FROM metadata_snapshot WHERE source = ? AND status = 'building' AND started_at > ? ORDER BY id DESC LIMIT 1")
        .get(source.source, since) as { started_at: string } | undefined;
      if (running && !options.force) throw new Error(`${source.source} is already being indexed (since ${running.started_at}).`);
      const r = this.db
        .prepare("INSERT INTO metadata_snapshot (source, kind, revision, status, started_at) VALUES (?, ?, ?, 'building', ?) RETURNING id")
        .get(source.source, source.kind, source.revision ?? null, new Date().toISOString()) as { id: number };
      return r.id;
    });
    try {
      const parsed = await read();
      return this.database.write(() => {
        this.store(id, source.source, parsed);
        return this.snapshotById(id)!;
      });
    } catch (err) {
      this.database.write(() => {
        this.db
          .prepare("UPDATE metadata_snapshot SET status = 'failed', finished_at = ?, stats = ? WHERE id = ?")
          .run(new Date().toISOString(), JSON.stringify({ error: (err as Error).message }), id);
      });
      throw err;
    }
  }

  private store(id: number, source: string, parsed: ParsedMetadata): void {
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
    const stats: SnapshotStats = { counts, referenced, edges, skipped: parsed.skipped, ...(parsed.skippedCount ? { skippedCount: parsed.skippedCount } : {}) };
    this.db.prepare("UPDATE metadata_snapshot SET status = 'ready', finished_at = ?, stats = ? WHERE id = ?").run(new Date().toISOString(), JSON.stringify(stats), id);
    // The run that finishes last holds the newest reading of the source, whichever started
    // first, so it replaces every other; a run still building elsewhere is left alone unless
    // its lease ran out (it died).
    const since = new Date(Date.now() - BUILD_LEASE_MS).toISOString();
    this.db.prepare("DELETE FROM metadata_snapshot WHERE source = ? AND id != ? AND (status != 'building' OR started_at <= ?)").run(source, id, since);
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
        .prepare(`SELECT ${COLUMNS} FROM component c WHERE c.snapshot = ? AND c.parent_type = ? AND c.parent = ? ORDER BY c.type, c.name`)
        .all(snapshot, parentType, parent) as unknown as ComponentRow[]
    ).map(toComponent);
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
   * what it depends on ("out") and what depends on it ("in").
   */
  related(componentId: number, options: { depth?: number; kinds?: readonly EdgeKind[] } = {}): Related[] {
    const depth = Math.min(Math.max(options.depth ?? 1, 1), 3);
    const kinds = options.kinds?.length ? options.kinds : null;
    const kindFilter = kinds ? `AND e.kind IN (${kinds.map(() => "?").join(", ")})` : "";
    const kindParams = kinds ?? [];
    const sql = `
      WITH RECURSIVE walk(id, kind, direction, depth) AS (
        SELECT e.dst, e.kind, 'out', 1 FROM edge e WHERE e.src = ? ${kindFilter}
        UNION ALL
        SELECT e.src, e.kind, 'in', 1 FROM edge e WHERE e.dst = ? ${kindFilter}
        UNION ALL
        SELECT e.dst, e.kind, w.direction, w.depth + 1 FROM walk w JOIN edge e ON e.src = w.id
          WHERE w.direction = 'out' AND w.depth < ? ${kindFilter}
        UNION ALL
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
}
