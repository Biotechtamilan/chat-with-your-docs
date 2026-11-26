import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbedder } from "./ai/embedder";
import { getConfig } from "./config";
import { closeDbForTests } from "./db";
import { ingestDocument } from "./ingest/pipeline";
import { EmptyDocumentError } from "./ingest/parse";
import { isAnswerable, retrieve } from "./retrieval/retrieve";
import { countIndex, deleteDocument, lexicalSearch, listDocuments } from "./retrieval/store";
import type { DocumentSummary, IngestEvent } from "./types";

/**
 * End-to-end over the real SQL: an in-memory Postgres with pgvector, the real
 * chunker and fusion, and a deterministic fake embedder. Nothing here touches
 * the network.
 */
const config = getConfig();
const deps = { embedder: getEmbedder(config), config };
const file = (name: string, text: string) => ({ name, bytes: new TextEncoder().encode(text) });

const HANDBOOK = `# Employee handbook

## Annual leave

Employees accrue 1.5 days of annual leave for each month of service. Up to five unused days carry over into the next calendar year with manager approval.

## Expenses

Submit expense claims within 30 days. Claims above 500 dollars need a receipt and director sign-off. The finance code for travel is TRV-4471.
`;

const RETURNS = `# Returns policy

## Refund window

Customers can return unused products within 14 days of delivery for a full refund. Refunds are paid to the original payment method within five working days.

## Exceptions

Custom engraved items and opened software cannot be returned.
`;

let handbook: DocumentSummary;
let returns: DocumentSummary;

beforeAll(async () => {
  handbook = (await ingestDocument(file("handbook.md", HANDBOOK), deps)).document;
  returns = (await ingestDocument(file("returns.md", RETURNS), deps)).document;
});

afterAll(closeDbForTests);

describe("ingestion", () => {
  it("indexes documents and marks them ready", async () => {
    expect(handbook).toMatchObject({ name: "handbook.md", status: "ready", mime: "text/markdown" });
    expect(handbook.chunkCount).toBeGreaterThanOrEqual(2);
    const index = await countIndex();
    expect(index.documents).toBe(2);
    expect(index.chunks).toBe(handbook.chunkCount + returns.chunkCount);
  });

  it("reports progress stages in order", async () => {
    const events: IngestEvent[] = [];
    await ingestDocument(file("progress.txt", "A short note about parking permits."), deps, (e) => events.push(e));
    const stages = events.flatMap((e) => (e.type === "progress" ? [e.stage] : []));
    expect([...new Set(stages)]).toEqual(["parsing", "chunking", "embedding", "storing"]);
  });

  it("treats a re-upload of the same bytes as a no-op", async () => {
    const again = await ingestDocument(file("renamed-copy.md", HANDBOOK), deps);
    expect(again.duplicate).toBe(true);
    expect(again.document.id).toBe(handbook.id);
  });

  it("rejects a file with no text without leaving a document behind", async () => {
    const before = (await listDocuments()).length;
    await expect(ingestDocument(file("blank.txt", "   \n\n  "), deps)).rejects.toBeInstanceOf(EmptyDocumentError);
    expect((await listDocuments()).length).toBe(before);
  });
});

describe("retrieval", () => {
  it("puts the passage that answers the question first", async () => {
    const result = await retrieve("How many days of annual leave do employees accrue?", deps);
    expect(result.sources[0]).toMatchObject({ n: 1, documentName: "handbook.md", heading: "Employee handbook › Annual leave" });
    expect(result.sources[0].content).toContain("1.5 days");
    expect(isAnswerable(result, config)).toBe(true);
  });

  it("finds an exact identifier through the keyword leg", async () => {
    const result = await retrieve("TRV-4471", deps);
    expect(result.lexicalHits).toBeGreaterThan(0);
    expect(result.sources[0].content).toContain("TRV-4471");
    expect(result.sources[0].lexicalRank).toBe(1);
    // The digits alone must match too: Postgres would otherwise index "-4471" as a signed number.
    expect(await lexicalSearch("4471", 5)).toHaveLength(1);
  });

  it("only searches the selected documents", async () => {
    const result = await retrieve("refund for unused products", { ...deps, documentIds: [handbook.id] });
    expect(result.sources.every((s) => s.documentId === handbook.id)).toBe(true);
  });

  it("finds nothing when the selection is empty", async () => {
    const result = await retrieve("annual leave", { ...deps, documentIds: [] });
    expect(result.sources).toEqual([]);
    expect(isAnswerable(result, config)).toBe(false);
  });

  it("refuses a question that matches nothing", async () => {
    const result = await retrieve("zxqv wobblefrotz", deps);
    expect(result.lexicalHits).toBe(0);
    expect(isAnswerable(result, config)).toBe(false);
  });

  it("survives punctuation-only and stop-word-only questions", async () => {
    await expect(retrieve("?!", deps)).resolves.toBeDefined();
    await expect(lexicalSearch("what | is | the", 5)).resolves.toEqual([]);
  });

  it("numbers sources 1..n without gaps", async () => {
    const result = await retrieve("refund window and exceptions", deps);
    expect(result.sources.map((s) => s.n)).toEqual(result.sources.map((_, i) => i + 1));
  });
});

describe("deletion", () => {
  it("removes a document together with its chunks", async () => {
    const before = await countIndex();
    expect(await deleteDocument(returns.id)).toBe(true);
    const after = await countIndex();
    expect(after.documents).toBe(before.documents - 1);
    expect(after.chunks).toBe(before.chunks - returns.chunkCount);
    expect(await deleteDocument(returns.id)).toBe(false);
  });
});
