// Spike 3: which SQLite driver should v1 use? Checks node:sqlite and better-sqlite3 on the
// current OS for FTS5 (including the trigram tokenizer for Chinese), JSON, WAL with several
// processes writing at once, and speed on a synthetic 10,000-component metadata index.

import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { configure, open, type Db, type DriverName } from './driver.ts';
import { OUT_DIR, platform, table, writeReport } from '../lib/report.ts';

const run = promisify(execFile);
const warnings: string[] = [];
process.on('warning', (w) => warnings.push(`${w.name}: ${w.message}`));

const COMPONENTS = Number(process.env.SQLITE_COMPONENTS ?? 10000);
const WRITERS = 4;
const WRITES_PER_WRITER = 250;

function schema(db: Db, tokenizer: string): void {
  db.exec(`
    CREATE TABLE component (id INTEGER PRIMARY KEY, type TEXT NOT NULL, api_name TEXT NOT NULL, label TEXT, body TEXT, meta TEXT, UNIQUE(type, api_name));
    CREATE TABLE edge (src INTEGER NOT NULL REFERENCES component(id), dst INTEGER NOT NULL REFERENCES component(id), kind TEXT NOT NULL, PRIMARY KEY (src, dst, kind)) WITHOUT ROWID;
    CREATE INDEX edge_dst ON edge(dst);
    CREATE VIRTUAL TABLE component_fts USING fts5(api_name, label, body, content='component', content_rowid='id', tokenize='${tokenizer}');
    CREATE TABLE feedback (id INTEGER PRIMARY KEY, writer TEXT, seq INTEGER, body TEXT);
  `);
}

/** Synthetic org: objects, then fields, classes, flows, layouts, with references between them. */
function populate(db: Db): { components: number; edges: number } {
  const types = [
    ['CustomObject', 0.04],
    ['CustomField', 0.6],
    ['ApexClass', 0.12],
    ['Flow', 0.08],
    ['Layout', 0.08],
    ['PermissionSet', 0.04],
    ['ValidationRule', 0.04],
  ] as const;
  const ins = db.prepare('INSERT INTO component (id, type, api_name, label, body, meta) VALUES (?, ?, ?, ?, ?, ?)');
  const insE = db.prepare('INSERT OR IGNORE INTO edge (src, dst, kind) VALUES (?, ?, ?)');
  let id = 0;
  let edges = 0;
  const objects: number[] = [];
  db.tx(() => {
    for (const [type, share] of types) {
      const n = Math.round(COMPONENTS * share);
      for (let i = 0; i < n; i++) {
        id++;
        const lang = i % 10 === 0 ? 'zh' : i % 3 === 0 ? 'fr' : 'en';
        const label = lang === 'zh' ? `客户偏好 ${i}` : lang === 'fr' ? `Préférence client ${i}` : `Client preference ${i}`;
        const body = `${type} ${label} used by clienteling and after-sales service; tier ${i % 5}`;
        ins.run(id, type, `${type}_${i}__c`, label, body, JSON.stringify({ lang, tier: i % 5, managed: i % 7 === 0 }));
        if (type === 'CustomObject') objects.push(id);
        else {
          // each non-object component references 1 object and up to 3 other components
          insE.run(id, objects[i % objects.length]!, 'references');
          edges++;
          for (let k = 1; k <= 3 && id - k * 17 > 0; k++) {
            insE.run(id, id - k * 17, 'uses');
            edges++;
          }
        }
      }
    }
    db.exec("INSERT INTO component_fts(component_fts) VALUES('rebuild')");
  });
  return { components: id, edges };
}

function time<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const r = fn();
  return [r, performance.now() - t0];
}

async function check(driver: DriverName): Promise<Record<string, string | number>> {
  const dir = join(OUT_DIR, 'sqlite');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${driver.replace(':', '-')}.db`);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  const r: Record<string, string | number> = { driver };
  let db: Db;
  try {
    db = open(driver, file);
  } catch (e) {
    return { driver, error: (e as Error).message.slice(0, 200) };
  }
  configure(db);
  r.sqlite = db.prepare('select sqlite_version() v').get().v;
  r.journal = db.prepare('PRAGMA journal_mode').get().journal_mode;

  // FTS5 tokenizers: unicode61 for Latin text, trigram for Chinese (no word segmentation).
  for (const tok of ['unicode61 remove_diacritics 2', 'trigram']) {
    try {
      db.exec(`CREATE VIRTUAL TABLE t_${tok.split(' ')[0]} USING fts5(x, tokenize='${tok}')`);
      r[`fts5 ${tok.split(' ')[0]}`] = 'yes';
    } catch (e) {
      r[`fts5 ${tok.split(' ')[0]}`] = `no (${(e as Error).message})`;
    }
  }
  const trigram = r['fts5 trigram'] === 'yes';
  schema(db, trigram ? 'trigram' : 'unicode61 remove_diacritics 2');
  r.json = db.prepare(`select json_extract('{"a":{"b":2}}', '$.a.b') v`).get().v === 2 ? 'yes' : 'no';

  const [counts, insertMs] = time(() => populate(db));
  r.components = counts.components;
  r.edges = counts.edges;
  r['insert + FTS build'] = `${Math.round(insertMs)} ms`;

  // Two-hop expansion from five seed objects, as the scope step will do.
  const seeds = db.prepare("select id from component where type='CustomObject' limit 5").all().map((x) => x.id);
  const twoHop = db.prepare(`
    WITH RECURSIVE hop(id, depth) AS (
      SELECT value, 0 FROM json_each(?)
      UNION
      SELECT e.src, h.depth + 1 FROM edge e JOIN hop h ON e.dst = h.id WHERE h.depth < 2
      UNION
      SELECT e.dst, h.depth + 1 FROM edge e JOIN hop h ON e.src = h.id WHERE h.depth < 2
    ) SELECT count(DISTINCT id) n FROM hop`);
  const [hop, hopMs] = time(() => twoHop.get(JSON.stringify(seeds)));
  r['2-hop scope'] = `${hop.n} components in ${hopMs.toFixed(1)} ms`;

  const fts = db.prepare('select count(*) n from component_fts where component_fts match ?');
  const [en, enMs] = time(() => fts.get('"clienteling"').n);
  r['FTS english'] = `${en} hits, ${enMs.toFixed(1)} ms`;
  const [fr] = time(() => fts.get(trigram ? '"Préférence"' : 'Préférence').n);
  r['FTS accents'] = `${fr} hits`;
  const [zh] = time(() => fts.get(trigram ? '"客户偏好"' : '客户偏好').n);
  r['FTS chinese'] = `${zh} hits`;
  db.close();

  // Several processes writing at once (host processes + background indexer).
  const [writers, wMs] = await (async () => {
    const t0 = performance.now();
    const out = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        run(process.execPath, [join(import.meta.dirname, 'writer.ts'), driver, file, String(i), String(WRITES_PER_WRITER)]).then(
          (p) => JSON.parse(p.stdout) as { errors: number },
          (e) => ({ errors: WRITES_PER_WRITER, failure: String(e.stderr || e.message).slice(0, 200) }),
        ),
      ),
    );
    return [out, performance.now() - t0] as const;
  })();
  const check = open(driver, file);
  const rows = check.prepare('select count(*) n from feedback').get().n;
  check.close();
  const errors = writers.reduce((n, w) => n + w.errors, 0);
  r['multi-process writes'] = `${rows}/${WRITERS * WRITES_PER_WRITER} rows, ${errors} errors, ${Math.round(wMs)} ms`;
  const fail = writers.find((w) => 'failure' in w);
  if (fail) r['writer failure'] = (fail as any).failure;
  r['db size'] = `${(statSync(file).size / 1e6).toFixed(1)} MB`;
  return r;
}

const results = [await check('node:sqlite'), await check('better-sqlite3')];
const keys = [...new Set(results.flatMap((r) => Object.keys(r)))].filter((k) => k !== 'driver');
let md = `## Spike 3: SQLite drivers (${platform()})\n\n`;
md += table(['Check', ...results.map((r) => String(r.driver))], keys.map((k) => [k, ...results.map((r) => r[k] ?? '')]));
md += `\n\nProcess warnings: ${warnings.length ? [...new Set(warnings)].join('; ') : 'none'}\n`;
writeReport(`sqlite-${process.platform}`, md, results);
