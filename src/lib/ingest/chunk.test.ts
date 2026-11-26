import { describe, expect, it } from "vitest";
import { chunkBlocks, embeddingText, estimateTokens, splitSentences, type Block } from "./chunk";

const options = { targetTokens: 60, maxTokens: 90, overlapTokens: 20 };
const sentence = (n: number) => `Sentence number ${n} explains one small fact about the policy.`;
const paragraph = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => sentence(from + i)).join(" ");

describe("chunkBlocks", () => {
  it("keeps a short document as a single chunk", () => {
    const chunks = chunkBlocks([{ text: "Refunds take 14 days.", heading: ["Refunds"] }], options);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ ord: 0, content: "Refunds take 14 days.", heading: "Refunds" });
  });

  it("never exceeds the maximum size", () => {
    const blocks: Block[] = [{ text: paragraph(1, 40), heading: ["Policy"] }];
    const chunks = chunkBlocks(blocks, options);
    expect(chunks.length).toBeGreaterThan(3);
    // Overlap is added on top of a packed chunk, so the bound is target + overlap.
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(options.maxTokens + options.overlapTokens);
  });

  it("ends chunks on sentence boundaries", () => {
    const chunks = chunkBlocks([{ text: paragraph(1, 30), heading: [] }], options);
    for (const chunk of chunks) expect(chunk.content.trimEnd()).toMatch(/\.$/);
  });

  it("does not let a chunk cross a heading", () => {
    const blocks: Block[] = [
      { text: "Alpha fact.", heading: ["Alpha"] },
      { text: "Beta fact.", heading: ["Beta"] },
    ];
    const chunks = chunkBlocks(blocks, options);
    expect(chunks.map((c) => c.heading)).toEqual(["Alpha", "Beta"]);
    expect(chunks[1].content).not.toContain("Alpha");
  });

  it("repeats the tail of one chunk at the start of the next within a section", () => {
    const chunks = chunkBlocks(
      [
        { text: paragraph(1, 4), heading: ["Leave"] },
        { text: paragraph(5, 4), heading: ["Leave"] },
      ],
      options,
    );
    expect(chunks.length).toBeGreaterThan(1);
    const lastSentenceOfFirst = splitSentences(chunks[0].content).at(-1)!;
    expect(chunks[1].content.startsWith(lastSentenceOfFirst)).toBe(true);
  });

  it("joins nested headings into a readable path and keeps the page", () => {
    const chunks = chunkBlocks([{ text: "Detail.", heading: ["Handbook", "Leave", "Carry-over"], page: 7 }], options);
    expect(chunks[0].heading).toBe("Handbook › Leave › Carry-over");
    expect(chunks[0]).toMatchObject({ page: 7, pageEnd: 7 });
  });

  it("records the page range when a chunk runs over a page break", () => {
    const chunks = chunkBlocks(
      [
        { text: "End of page three.", heading: [], page: 3 },
        { text: "Start of page four.", heading: [], page: 4 },
      ],
      options,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ page: 3, pageEnd: 4 });
  });

  it("advances the start page of later chunks instead of repeating the first page", () => {
    const blocks: Block[] = [1, 2, 3, 4].map((page) => ({ text: paragraph(page * 10, 6), heading: [], page }));
    const chunks = chunkBlocks(blocks, options);
    const last = chunks.at(-1)!;
    expect(chunks.length).toBeGreaterThan(3);
    // With overlap a chunk may start on the previous chunk's last page, never back on page 1.
    expect(last.page).toBeGreaterThanOrEqual(3);
    expect(last.pageEnd).toBe(4);
    for (const chunk of chunks) expect(chunk.page).toBeLessThanOrEqual(chunk.pageEnd!);
  });

  it("splits oversized code by line, not by sentence", () => {
    const code = Array.from({ length: 60 }, (_, i) => `const value${i} = compute(${i});`).join("\n");
    const chunks = chunkBlocks([{ text: code, heading: ["Example"], kind: "code" }], options);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      for (const line of chunk.content.split("\n")) expect(line).toMatch(/^const value\d+ = compute\(\d+\);$/);
    }
  });

  it("hard-splits a single sentence that is longer than a chunk", () => {
    const endless = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkBlocks([{ text: endless, heading: [] }], options);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.content).join(" ")).toContain("word399");
  });

  it("is deterministic and numbers chunks in order", () => {
    const blocks: Block[] = [{ text: paragraph(1, 25), heading: ["A"] }];
    const first = chunkBlocks(blocks, options);
    expect(chunkBlocks(blocks, options)).toEqual(first);
    expect(first.map((c) => c.ord)).toEqual(first.map((_, i) => i));
  });

  it("ignores empty blocks", () => {
    expect(chunkBlocks([{ text: "   ", heading: [] }], options)).toEqual([]);
  });
});

describe("helpers", () => {
  it("estimates about four characters per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("prefixes the document name and heading for embedding only", () => {
    expect(embeddingText("handbook.pdf", { content: "Body.", heading: "Leave" })).toBe("handbook.pdf › Leave\n\nBody.");
    expect(embeddingText("notes.txt", { content: "Body.", heading: null })).toBe("notes.txt\n\nBody.");
  });
});
