import { getDb } from "../db";
import type { Chunk } from "../ingest/chunk";
import type { DocumentStatus, DocumentSummary, Note, NoteSource, Passage, SourceGuide, TraceData } from "../types";

/** All SQL lives in this file: the rest of the app never writes a query. */

interface DocumentRow {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  pages: number | null;
  ocr_pages: number;
  chunk_count: number;
  status: DocumentStatus;
  error: string | null;
  created_at: Date | string;
}

const DOCUMENT_COLUMNS = "id, name, mime, bytes, pages, ocr_pages, chunk_count, status, error, created_at";

function toSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    bytes: row.bytes,
    pages: row.pages,
    ocrPages: row.ocr_pages,
    chunkCount: row.chunk_count,
    status: row.status,
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** pgvector accepts a vector as the text literal "[1,2,3]". */
const toVector = (values: number[]): string => `[${values.join(",")}]`;

// ---------------------------------------------------------------- documents

export async function createDocument(input: {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO documents (id, name, mime, bytes, sha256, status) VALUES ($1, $2, $3, $4, $5, 'processing')`,
    [input.id, input.name, input.mime, input.bytes, input.sha256],
  );
}

export async function findReadyDocumentByHash(sha256: string): Promise<DocumentSummary | null> {
  const db = await getDb();
  const result = await db.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE sha256 = $1 AND status = 'ready' LIMIT 1`,
    [sha256],
  );
  return result.rows[0] ? toSummary(result.rows[0]) : null;
}

export async function completeDocument(
  id: string,
  pages: number | null,
  chunkCount: number,
  ocrPages = 0,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE documents SET status = 'ready', pages = $2, chunk_count = $3, ocr_pages = $4, error = NULL WHERE id = $1`,
    [id, pages, chunkCount, ocrPages],
  );
}

export async function failDocument(id: string, error: string): Promise<void> {
  const db = await getDb();
  // Drop any partial chunks so a failed upload can never be retrieved from.
  await db.transaction(async (tx) => {
    await tx.query(`DELETE FROM chunks WHERE document_id = $1`, [id]);
    await tx.query(`UPDATE documents SET status = 'failed', error = $2, chunk_count = 0 WHERE id = $1`, [
      id,
      error.slice(0, 500),
    ]);
  });
}

export async function getDocument(id: string): Promise<DocumentSummary | null> {
  const db = await getDb();
  const result = await db.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1`, [id]);
  return result.rows[0] ? toSummary(result.rows[0]) : null;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const db = await getDb();
  const result = await db.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents ORDER BY created_at DESC, id`,
  );
  return result.rows.map(toSummary);
}

export async function deleteDocument(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.query<{ id: string }>(`DELETE FROM documents WHERE id = $1 RETURNING id`, [id]);
  return result.rows.length > 0; // chunks go with it via ON DELETE CASCADE
}

export async function countIndex(): Promise<{ documents: number; chunks: number }> {
  const db = await getDb();
  const result = await db.query<{ documents: number; chunks: number }>(
    `SELECT (SELECT count(*)::int FROM documents WHERE status = 'ready') AS documents,
            (SELECT count(*)::int FROM chunks) AS chunks`,
  );
  return result.rows[0];
}

// ------------------------------------------------------------------- chunks

const INSERT_BATCH = 40;

export async function insertChunks(documentId: string, chunks: Chunk[], embeddings: number[][]): Promise<void> {
  if (chunks.length !== embeddings.length) {
    throw new Error(`Got ${embeddings.length} embeddings for ${chunks.length} chunks`);
  }
  const db = await getDb();
  await db.transaction(async (tx) => {
    for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
      const batch = chunks.slice(start, start + INSERT_BATCH);
      const params: unknown[] = [];
      const rows = batch.map((chunk, i) => {
        const base = i * 9;
        params.push(
          `${documentId}:${chunk.ord}`,
          documentId,
          chunk.ord,
          chunk.content,
          chunk.heading,
          chunk.page,
          chunk.pageEnd,
          chunk.tokens,
          toVector(embeddings[start + i]),
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::vector)`;
      });
      await tx.query(
        `INSERT INTO chunks (id, document_id, ord, content, heading, page, page_end, tokens, embedding) VALUES ${rows.join(", ")}`,
        params,
      );
    }
  });
}

export interface ChunkHit {
  id: string;
  documentId: string;
  documentName: string;
  ord: number;
  content: string;
  heading: string | null;
  page: number | null;
  pageEnd: number | null;
  /** Cosine similarity for the dense leg, ts_rank_cd for the lexical leg. */
  score: number;
}

interface HitRow {
  id: string;
  document_id: string;
  document_name: string;
  ord: number;
  content: string;
  heading: string | null;
  page: number | null;
  page_end: number | null;
  score: number | string;
}

const toHit = (row: HitRow): ChunkHit => ({
  id: row.id,
  documentId: row.document_id,
  documentName: row.document_name,
  ord: row.ord,
  content: row.content,
  heading: row.heading,
  page: row.page,
  pageEnd: row.page_end,
  score: Number(row.score),
});

const HIT_COLUMNS = "c.id, c.document_id, d.name AS document_name, c.ord, c.content, c.heading, c.page, c.page_end";
/** Only search finished documents, optionally narrowed to the ones the user selected. */
const SCOPE = "d.status = 'ready' AND ($3::text[] IS NULL OR c.document_id = ANY($3::text[]))";
/** No list means "search everything". An empty list means "nothing is selected" and must match nothing. */
const scopeParam = (documentIds?: string[]) => documentIds ?? null;

/** Semantic leg: nearest neighbours by cosine distance (`<=>`). */
export async function denseSearch(embedding: number[], limit: number, documentIds?: string[]): Promise<ChunkHit[]> {
  const db = await getDb();
  const result = await db.query<HitRow>(
    `SELECT ${HIT_COLUMNS}, 1 - (c.embedding <=> $1::vector) AS score
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE ${SCOPE}
      ORDER BY c.embedding <=> $1::vector, c.id
      LIMIT $2`,
    [toVector(embedding), limit, scopeParam(documentIds)],
  );
  return result.rows.map(toHit);
}

/** Keyword leg: Postgres full-text search. Catches exact terms, codes and names that embeddings blur. */
export async function lexicalSearch(tsQuery: string, limit: number, documentIds?: string[]): Promise<ChunkHit[]> {
  const db = await getDb();
  const result = await db.query<HitRow>(
    `SELECT ${HIT_COLUMNS}, ts_rank_cd(c.tsv, q) AS score
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      CROSS JOIN to_tsquery('english', $1) AS q
      WHERE c.tsv @@ q AND ${SCOPE}
      ORDER BY score DESC, c.id
      LIMIT $2`,
    [tsQuery, limit, scopeParam(documentIds)],
  );
  return result.rows.map(toHit);
}

interface PassageRow {
  id: string;
  ord: number;
  content: string;
  heading: string | null;
  page: number | null;
  page_end: number | null;
}

/** Every passage of one document in reading order, for the "open a source" view. */
export async function listPassages(documentId: string): Promise<Passage[]> {
  const db = await getDb();
  const result = await db.query<PassageRow>(
    `SELECT id, ord, content, heading, page, page_end FROM chunks WHERE document_id = $1 ORDER BY ord`,
    [documentId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    ord: row.ord,
    content: row.content,
    heading: row.heading,
    page: row.page,
    pageEnd: row.page_end,
  }));
}

/** The first few passages of each given document, in document then reading order. */
export async function openingPassages(
  documentIds: string[],
  perDocument: number,
): Promise<Array<{ documentId: string; content: string }>> {
  const db = await getDb();
  const result = await db.query<{ document_id: string; content: string }>(
    `SELECT c.document_id, c.content
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready' AND c.document_id = ANY($1::text[]) AND c.ord < $2
      ORDER BY c.document_id, c.ord`,
    [documentIds, perDocument],
  );
  return result.rows.map((row) => ({ documentId: row.document_id, content: row.content }));
}

// ------------------------------------------------------------------- guides

export async function getGuide(key: string): Promise<SourceGuide | null> {
  const db = await getDb();
  const result = await db.query<{ data: SourceGuide }>(`SELECT data FROM guides WHERE key = $1`, [key]);
  return result.rows[0]?.data ?? null;
}

export async function saveGuide(key: string, model: string, guide: SourceGuide): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO guides (key, model, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, model = EXCLUDED.model, created_at = now()`,
    [key, model, JSON.stringify(guide)],
  );
}

// -------------------------------------------------------------------- notes

interface NoteRow {
  id: string;
  kind: Note["kind"];
  title: string;
  body: string;
  question: string | null;
  sources: NoteSource[];
  created_at: Date | string;
}

const NOTE_COLUMNS = "id, kind, title, body, question, sources, created_at";

const toNote = (row: NoteRow): Note => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  question: row.question,
  sources: row.sources,
  createdAt: new Date(row.created_at).toISOString(),
});

export async function createNote(input: Omit<Note, "createdAt">): Promise<Note> {
  const db = await getDb();
  const result = await db.query<NoteRow>(
    `INSERT INTO notes (id, kind, title, body, question, sources) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING ${NOTE_COLUMNS}`,
    [input.id, input.kind, input.title, input.body, input.question, JSON.stringify(input.sources)],
  );
  return toNote(result.rows[0]);
}

export async function listNotes(): Promise<Note[]> {
  const db = await getDb();
  const result = await db.query<NoteRow>(`SELECT ${NOTE_COLUMNS} FROM notes ORDER BY created_at DESC, id`);
  return result.rows.map(toNote);
}

export async function countNotes(): Promise<number> {
  const db = await getDb();
  const result = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM notes`);
  return result.rows[0].count;
}

export async function renameNote(id: string, title: string): Promise<Note | null> {
  const db = await getDb();
  const result = await db.query<NoteRow>(`UPDATE notes SET title = $2 WHERE id = $1 RETURNING ${NOTE_COLUMNS}`, [
    id,
    title,
  ]);
  return result.rows[0] ? toNote(result.rows[0]) : null;
}

export async function deleteNote(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.query<{ id: string }>(`DELETE FROM notes WHERE id = $1 RETURNING id`, [id]);
  return result.rows.length > 0;
}

// ------------------------------------------------------------------- traces

export async function saveTrace(trace: TraceData): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO traces (id, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [trace.id, JSON.stringify(trace)],
  );
}

export async function listTraces(limit = 50): Promise<TraceData[]> {
  const db = await getDb();
  const result = await db.query<{ data: TraceData }>(
    `SELECT data FROM traces ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => row.data);
}
