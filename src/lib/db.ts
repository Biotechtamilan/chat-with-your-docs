import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { getConfig } from "./config";

/**
 * The whole app uses one embedded Postgres (PGlite) with the pgvector extension.
 * Vectors, keyword search, document records and answer traces share one store,
 * and every statement here is plain Postgres SQL, so moving to a managed
 * Postgres later changes the driver, not the queries.
 */
export type Db = PGlite;

const holder = globalThis as typeof globalThis & { __docsDb?: Promise<PGlite> };

function schemaSql(dimensions: number): string {
  return `
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS documents (
      id          text PRIMARY KEY,
      name        text NOT NULL,
      mime        text NOT NULL,
      bytes       integer NOT NULL,
      sha256      text NOT NULL,
      pages       integer,
      ocr_pages   integer NOT NULL DEFAULT 0,
      chunk_count integer NOT NULL DEFAULT 0,
      status      text NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
      error       text,
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id          text PRIMARY KEY,
      document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      ord         integer NOT NULL,
      content     text NOT NULL,
      heading     text,
      page        integer,
      page_end    integer,
      tokens      integer NOT NULL,
      embedding   vector(${dimensions}) NOT NULL,
      -- Maintained by Postgres, so the keyword index can never drift from the text.
      -- Punctuation becomes spaces first: left alone, the parser reads "E-5100" as
      -- the letter E and the signed number -5100, and a search for 5100 misses it.
      tsv         tsvector GENERATED ALWAYS AS (
                    to_tsvector(
                      'english',
                      regexp_replace(coalesce(heading, '') || ' ' || content, '[^[:alnum:]]+', ' ', 'g')
                    )
                  ) STORED
    );
    CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);
    CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id, ord);
    -- No ANN index on purpose: an exact scan is faster and more accurate than
    -- HNSW until the table reaches tens of thousands of rows.

    CREATE TABLE IF NOT EXISTS traces (
      id         text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      data       jsonb NOT NULL
    );

    -- A source guide is model output, so it is kept: the same selection and
    -- model never pay for it twice. The key is a hash of the sorted document
    -- ids plus the model id.
    CREATE TABLE IF NOT EXISTS guides (
      key        text PRIMARY KEY,
      model      text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      data       jsonb NOT NULL
    );

    -- Notes deliberately have no foreign key to documents: a note outlives the
    -- source it was taken from, and carries the source's name with it.
    CREATE TABLE IF NOT EXISTS notes (
      id         text PRIMARY KEY,
      kind       text NOT NULL CHECK (kind IN ('answer', 'passage')),
      title      text NOT NULL,
      body       text NOT NULL,
      question   text,
      sources    jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `;
}

async function open(): Promise<PGlite> {
  const config = getConfig();
  let db: PGlite;

  if (config.dataDir === ":memory:") {
    db = new PGlite({ extensions: { vector } });
  } else {
    // One database per embedding model + size. Vectors from different models are
    // not comparable, so switching model (or to mock mode) gets a clean index
    // instead of silently mixing them.
    const identity = `${config.embeddingModel}-${config.embeddingDimensions}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    const root = path.resolve(config.dataDir);
    mkdirSync(root, { recursive: true });
    db = new PGlite(path.join(root, identity), { extensions: { vector } });
  }

  await ensureSchema(db, config.embeddingDimensions);
  return db;
}

/** Bump when a table definition changes. There are no migrations: the index is rebuildable. */
const SCHEMA_VERSION = "4";

/**
 * `CREATE TABLE IF NOT EXISTS` silently keeps an old table shape, which would
 * surface later as a confusing "column does not exist". Recording a version
 * turns that into one clear instruction at startup.
 */
async function ensureSchema(db: PGlite, dimensions: number): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS meta (key text PRIMARY KEY, value text NOT NULL)`);
  const existing = await db.query<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`);
  const found = existing.rows[0]?.value;
  if (found && found !== SCHEMA_VERSION) {
    throw new Error(
      `The local index was created by an older version of this app (schema ${found}, expected ${SCHEMA_VERSION}). ` +
        `Stop the server, delete the "${getConfig().dataDir}" folder, and start again.`,
    );
  }
  await db.exec(schemaSql(dimensions));
  if (!found) await db.query(`INSERT INTO meta (key, value) VALUES ('schema_version', $1)`, [SCHEMA_VERSION]);
}

/**
 * Returns the single database handle for this process.
 *
 * PGlite is single-connection: two instances on one folder would corrupt it.
 * The handle lives on globalThis because Next re-evaluates modules during
 * development, which would otherwise open a second instance. It is created on
 * first use, never at import time, so `next build` does not touch the disk.
 */
export function getDb(): Promise<PGlite> {
  if (!holder.__docsDb) {
    holder.__docsDb = open().catch((error) => {
      holder.__docsDb = undefined; // allow a retry after a failed start
      throw error;
    });
  }
  return holder.__docsDb;
}

export async function closeDbForTests(): Promise<void> {
  const pending = holder.__docsDb;
  holder.__docsDb = undefined;
  if (pending) await (await pending).close();
}
