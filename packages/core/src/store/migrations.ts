/**
 * Schema migrations. Append only: never edit a migration that has shipped,
 * add a new one instead. Each runs once per database, in a transaction.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "contexts and documents",
    sql: `
      CREATE TABLE context (
        name        TEXT PRIMARY KEY,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        settings    TEXT NOT NULL DEFAULT '{}'   -- JSON, e.g. the output language (FE3)
      );

      CREATE TABLE document (
        context     TEXT NOT NULL REFERENCES context(name) ON DELETE CASCADE,
        id          TEXT NOT NULL,
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        source      TEXT NOT NULL,
        content     TEXT NOT NULL,
        metadata    TEXT NOT NULL DEFAULT '{}',  -- JSON
        -- 0 until the masking layer (phase 2) has processed the content. Imported
        -- contexts start at 0 so they are masked before any model sees them.
        masked      INTEGER NOT NULL DEFAULT 0,
        added_at    TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (context, id),
        UNIQUE (context, source)
      );
    `,
  },
  {
    version: 2,
    name: "document order",
    sql: `
      -- Documents keep the order they were added in. Ties on added_at (one batch,
      -- or a whole 0.x import) used to fall back to the id hash.
      ALTER TABLE document ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
      UPDATE document SET seq = rowid;
    `,
  },
  {
    version: 3,
    name: "pseudonym vault",
    sql: `
      -- One row per masked value and context (AR1, DE2). The original is encrypted
      -- (AES-256-GCM); lookup is a keyed hash of the normalised value, so the same
      -- value gets the same pseudonym without being stored in clear.
      CREATE TABLE pseudonym (
        context     TEXT NOT NULL REFERENCES context(name) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        n           INTEGER NOT NULL,
        lookup      BLOB NOT NULL,
        original    BLOB NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (context, type, n),
        UNIQUE (context, lookup)
      );

      -- Proof that the key in the keychain is the one this vault was written with.
      CREATE TABLE vault (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        key_check   BLOB NOT NULL,
        created_at  TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: "vault generation",
    sql: `
      -- A random id the vault gives a context the first time it looks, so a context that is
      -- deleted and created again (a new row) is never taken for the old one.
      ALTER TABLE context ADD COLUMN vault_generation TEXT;
    `,
  },
  {
    version: 5,
    name: "confirmed images and declared values",
    sql: `
      -- Values the user said must be hidden (on the approval page), as they wrote them:
      -- masked in every later input of the context, however short. Each stands for a
      -- pseudonym (type, n), which may have been seen first in another spelling. The value
      -- is encrypted like a pseudonym's original; lookup is a keyed hash of it, exactly.
      CREATE TABLE declared (
        context     TEXT NOT NULL REFERENCES context(name) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        n           INTEGER NOT NULL,
        lookup      BLOB NOT NULL,
        value       BLOB NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (context, lookup),
        FOREIGN KEY (context, type, n) REFERENCES pseudonym(context, type, n) ON DELETE CASCADE
      );

      -- A redacted image the user confirmed (FE4), next to the document holding its masked
      -- text. Replacing the document removes the image; a new one is stored only after the
      -- user confirmed it again. digest is the approval page's requestDigest of what they saw.
      CREATE TABLE image (
        context       TEXT NOT NULL,
        document      TEXT NOT NULL,
        png           BLOB NOT NULL,
        width         INTEGER NOT NULL,
        height        INTEGER NOT NULL,
        digest        TEXT NOT NULL,
        confirmed_at  TEXT NOT NULL,
        PRIMARY KEY (context, document),
        FOREIGN KEY (context, document) REFERENCES document(context, id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 6,
    name: "metadata index",
    sql: `
      -- One indexing run of a metadata source (decision B, DE2): a project folder or
      -- repository at a revision, or an org at a retrieve time. Readers use the newest
      -- ready snapshot of a source; a run that died stays 'building' and is ignored.
      CREATE TABLE metadata_snapshot (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        source       TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('repo', 'org')),
        revision     TEXT,
        status       TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
        started_at   TEXT NOT NULL,
        finished_at  TEXT,
        stats        TEXT NOT NULL DEFAULT '{}'   -- JSON: counts per type, files read, skipped
      );
      CREATE INDEX metadata_snapshot_source ON metadata_snapshot (source, status, id);

      -- A component: an object, field, record type, validation rule, flow, class... name is
      -- the full name ("Account.Industry__c"), parent the object it belongs to. present is 0
      -- for a component only referenced (a standard object outside the project). text holds
      -- the free text (descriptions, help text, picklist values, messages): it is stored as
      -- the project holds it and masked when a tool returns it, never sent as is. API names
      -- are case-insensitive in Salesforce, so name and parent compare without case.
      CREATE TABLE component (
        id        INTEGER PRIMARY KEY,
        snapshot  INTEGER NOT NULL REFERENCES metadata_snapshot(id) ON DELETE CASCADE,
        type      TEXT NOT NULL,
        name      TEXT NOT NULL COLLATE NOCASE,
        parent    TEXT COLLATE NOCASE,
        label     TEXT,
        file      TEXT,
        present   INTEGER NOT NULL DEFAULT 1,
        attrs     TEXT NOT NULL DEFAULT '{}',    -- JSON
        text      TEXT NOT NULL DEFAULT '',
        UNIQUE (snapshot, type, name)
      );
      CREATE INDEX component_parent ON component (snapshot, parent);

      -- The dependency graph, walked with recursive queries (ST2).
      CREATE TABLE edge (
        src   INTEGER NOT NULL REFERENCES component(id) ON DELETE CASCADE,
        dst   INTEGER NOT NULL REFERENCES component(id) ON DELETE CASCADE,
        kind  TEXT NOT NULL,
        PRIMARY KEY (src, dst, kind)
      ) WITHOUT ROWID;
      CREATE INDEX edge_dst ON edge (dst, kind);

      -- Full-text search over names, labels and text; trigram so that part of an API name
      -- matches, and accents fold (spike 5).
      CREATE VIRTUAL TABLE component_fts USING fts5 (
        name, label, text,
        content = 'component', content_rowid = 'id',
        tokenize = 'trigram remove_diacritics 1'
      );
      CREATE TRIGGER component_ai AFTER INSERT ON component BEGIN
        INSERT INTO component_fts (rowid, name, label, text) VALUES (new.id, new.name, coalesce(new.label, ''), new.text);
      END;
      CREATE TRIGGER component_ad AFTER DELETE ON component BEGIN
        INSERT INTO component_fts (component_fts, rowid, name, label, text) VALUES ('delete', old.id, old.name, coalesce(old.label, ''), old.text);
      END;
      CREATE TRIGGER component_au AFTER UPDATE ON component BEGIN
        INSERT INTO component_fts (component_fts, rowid, name, label, text) VALUES ('delete', old.id, old.name, coalesce(old.label, ''), old.text);
        INSERT INTO component_fts (rowid, name, label, text) VALUES (new.id, new.name, coalesce(new.label, ''), new.text);
      END;
    `,
  },
  {
    version: 7,
    name: "metadata parent types",
    sql: `
      -- A child's parent is not always an object (a bot version's bot, a workflow rule's
      -- workflow, which shares its object's name): the parent's type tells them apart.
      ALTER TABLE component ADD COLUMN parent_type TEXT;
      UPDATE component SET parent_type = 'CustomObject' WHERE parent IS NOT NULL;
      DROP INDEX component_parent;
      CREATE INDEX component_parent ON component (snapshot, parent_type, parent);
    `,
  },
];
