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
      -- Values the user said must be hidden (on the approval page): masked in every later
      -- input of the context, however short, where values the model found are left out.
      ALTER TABLE pseudonym ADD COLUMN declared INTEGER NOT NULL DEFAULT 0;

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
];
