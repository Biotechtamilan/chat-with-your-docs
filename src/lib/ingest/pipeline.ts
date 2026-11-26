import { createHash, randomUUID } from "node:crypto";
import type { Embedder } from "../ai/embedder";
import type { AppConfig } from "../config";
import { errorMessage, log, redactSecret } from "../log";
import {
  completeDocument,
  createDocument,
  failDocument,
  findReadyDocumentByHash,
  getDocument,
  insertChunks,
  listDocuments,
} from "../retrieval/store";
import type { DocumentSummary, IngestEvent } from "../types";
import { chunkBlocks, embeddingText } from "./chunk";
import { renderPdfPage, type PageReader } from "./ocr";
import { DEFAULT_PARSE_LIMITS, parseDocument } from "./parse";

export class IngestLimitError extends Error {}

/** Browsers may send a path; keep only a short, printable file name. */
function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200) || "untitled";
}

/**
 * Upload -> parse -> chunk -> embed -> store.
 *
 * A document row is created as "processing" and only flips to "ready" after
 * every chunk is stored, and search ignores anything that is not "ready".
 * A crash midway therefore leaves a visible failed document, never a
 * half-indexed one that quietly returns partial answers.
 */
export interface IngestDeps {
  embedder: Embedder;
  config: AppConfig;
  /** Reads a page image with the model. Left out when no model is connected. */
  readPage?: PageReader;
  /** The person agreed to send page images to the model. Without it a scan is not read. */
  allowScan?: boolean;
  /** Opens an encrypted PDF. Passed straight to the parser: never stored and never logged. */
  password?: string;
}

export async function ingestDocument(
  file: { name: string; bytes: Uint8Array },
  deps: IngestDeps,
  onEvent: (event: IngestEvent) => void = () => {},
): Promise<{ document: DocumentSummary; duplicate: boolean }> {
  const { embedder, config } = deps;
  const name = cleanName(file.name);
  const started = performance.now();

  // Same bytes already indexed: re-uploading is a no-op, not a second copy.
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const existing = await findReadyDocumentByHash(sha256);
  if (existing) return { document: existing, duplicate: true };

  // Checked before parsing, so a full library refuses a scan without a single model call.
  if ((await listDocuments()).length >= config.maxDocuments) {
    throw new IngestLimitError(`The library is full (${config.maxDocuments} documents). Remove one to add another.`);
  }

  onEvent({ type: "progress", stage: "parsing" });
  // Throws before any row exists, so a rejected file leaves nothing behind.
  const parsed = await parseDocument(
    name,
    file.bytes,
    DEFAULT_PARSE_LIMITS,
    deps.readPage && {
      allowed: deps.allowScan === true,
      readPage: deps.readPage,
      renderPage: (bytes, pageNumber) =>
        renderPdfPage(bytes, pageNumber, { maxPixels: config.ocrMaxPagePixels, password: deps.password }),
      maxPages: config.ocrMaxPages,
      onPage: (done, total) =>
        onEvent({ type: "progress", stage: "reading", detail: `scanned page ${done + 1} of ${total}` }),
    },
    deps.password,
  );

  const id = randomUUID();
  await createDocument({ id, name, mime: parsed.mime, bytes: file.bytes.byteLength, sha256 });

  try {
    onEvent({ type: "progress", stage: "chunking" });
    const chunks = chunkBlocks(parsed.blocks, config.chunk);

    onEvent({ type: "progress", stage: "embedding", detail: `0 of ${chunks.length}` });
    const embeddings = await embedder.embedDocuments(
      chunks.map((chunk) => embeddingText(name, chunk)),
      (done, total) => onEvent({ type: "progress", stage: "embedding", detail: `${done} of ${total}` }),
    );

    onEvent({ type: "progress", stage: "storing" });
    await insertChunks(id, chunks, embeddings);
    await completeDocument(id, parsed.pages, chunks.length, parsed.ocrPages);

    log.info("document_ingested", {
      documentId: id,
      name,
      bytes: file.bytes.byteLength,
      chunks: chunks.length,
      ocrPages: parsed.ocrPages,
      ms: Math.round(performance.now() - started),
    });
  } catch (error) {
    // A scan is read by the model, so this can be a provider's error text.
    await failDocument(id, redactSecret(errorMessage(error), config.apiKey));
    log.error("document_ingest_failed", { documentId: id, name, error: errorMessage(error) });
    throw error;
  }

  const document = await getDocument(id);
  if (!document) throw new Error("Document disappeared during ingestion");
  return { document, duplicate: false };
}
