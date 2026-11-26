import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbedder } from "../ai/embedder";
import { getConfig } from "../config";
import { closeDbForTests } from "../db";
import { ingestDocument } from "../ingest/pipeline";
import { listTraces } from "../retrieval/store";
import type { SourceRef, TraceData } from "../types";
import { handleChat } from "./chat";

/** The chat endpoint exercised as a black box: a Request goes in, a stream of chunks comes out. */

type Chunk = { type: string; [key: string]: unknown };

async function readChunks(response: Response): Promise<Chunk[]> {
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)) as Chunk);
}

const textOf = (chunks: Chunk[]) => chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
const sourcesOf = (chunks: Chunk[]) =>
  (chunks.find((c) => c.type === "data-sources")?.data as { sources: SourceRef[] } | undefined)?.sources ?? [];
const finalTrace = (chunks: Chunk[]) => chunks.filter((c) => c.type === "data-trace").at(-1)?.data as TraceData;

let ip = 0;
function ask(question: string, extra: Record<string, unknown> = {}, history: Array<[string, string]> = []) {
  const message = (role: string, text: string, i: number) => ({ id: `m${i}`, role, parts: [{ type: "text", text }] });
  const messages = [...history.map(([role, text], i) => message(role, text, i)), message("user", question, 99)];
  return new Request("http://test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${++ip}` },
    body: JSON.stringify({ messages, ...extra }),
  });
}

/** A scripted model: streams the given text and reports fixed token usage. */
function scriptedModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: text },
          { type: "text-end", id: "t" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 40, text: 40, reasoning: undefined },
            },
          },
        ],
      }),
    }),
    doGenerate: async () => ({
      content: [{ type: "text", text: "annual leave accrual for contractors" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 6, text: 6, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

const config = getConfig();

describe("before any document exists", () => {
  it("says so without searching", async () => {
    const chunks = await readChunks(await handleChat(ask("What is the leave policy?")));
    expect(textOf(chunks)).toMatch(/no documents to search/i);
    expect(finalTrace(chunks)).toMatchObject({ outcome: "no_documents", complete: true });
  });
});

describe("with documents indexed", () => {
  beforeAll(async () => {
    const text =
      "# Handbook\n\n## Annual leave\n\nEmployees accrue 1.5 days of annual leave for each month of service.\n\n## Expenses\n\nSubmit expense claims within 30 days.";
    await ingestDocument(
      { name: "handbook.md", bytes: new TextEncoder().encode(text) },
      { embedder: getEmbedder(config), config },
    );
  });
  afterAll(closeDbForTests);

  it("offline: sends the passages first, then quotes them", async () => {
    const response = await handleChat(ask("How much annual leave do employees accrue?"));
    expect(response.status).toBe(200);
    const chunks = await readChunks(response);
    const types = chunks.map((c) => c.type);

    expect(types.indexOf("data-sources")).toBeLessThan(types.indexOf("text-delta"));
    expect(sourcesOf(chunks)[0].content).toContain("1.5 days");
    expect(textOf(chunks)).toContain("[1]");
    expect(finalTrace(chunks)).toMatchObject({ outcome: "answered", mode: "offline", usage: null });
    expect(finalTrace(chunks).citations?.grounded).toBe(true);
  });

  it("refuses an off-topic question without showing sources", async () => {
    const chunks = await readChunks(await handleChat(ask("zxqv wobblefrotz?")));
    expect(textOf(chunks)).toMatch(/couldn't find anything/i);
    expect(sourcesOf(chunks)).toEqual([]);
    expect(finalTrace(chunks).outcome).toBe("no_context");
  });

  it("with a model: streams its answer and records usage, cost and citations", async () => {
    const model = scriptedModel("Employees accrue 1.5 days per month [1]. See also [9].");
    const chunks = await readChunks(
      await handleChat(ask("How much annual leave do employees accrue?"), { languageModel: model }),
    );

    expect(textOf(chunks)).toBe("Employees accrue 1.5 days per month [1]. See also [9].");
    const trace = finalTrace(chunks);
    expect(trace).toMatchObject({ outcome: "answered", mode: "gateway", complete: true });
    expect(trace.usage).toEqual({ inputTokens: 900, outputTokens: 40 });
    expect(trace.costUsd).toBeGreaterThan(0);
    expect(trace.citations).toEqual({ cited: [1], invalid: [9], grounded: true });
    expect(trace.stages.map((s) => s.name)).toEqual(["embed_query", "search", "generate"]);

    // The model saw the rules as instructions and the passage inside a source block.
    const call = model.doStreamCalls[0];
    expect(JSON.stringify(call.prompt)).toContain('<source n=\\"1\\"');
    expect((await listTraces(1))[0].id).toBe(trace.id);
  });

  it("rewrites a follow-up into a standalone search query", async () => {
    const model = scriptedModel("Contractors accrue leave the same way [1].");
    const history: Array<[string, string]> = [
      ["user", "How much annual leave do employees accrue?"],
      ["assistant", "1.5 days per month [1]."],
    ];
    const chunks = await readChunks(await handleChat(ask("And for contractors?", {}, history), { languageModel: model }));
    const trace = finalTrace(chunks);
    expect(trace.question).toBe("And for contractors?");
    expect(trace.searchQuery).toBe("annual leave accrual for contractors");
    expect(trace.stages[0].name).toBe("rewrite_query");
    // Earlier turns reach the model as plain text, without their old sources.
    expect(JSON.stringify(model.doStreamCalls[0].prompt).match(/<sources>/g)).toHaveLength(1);
  });

  it("rejects bad input before doing any work", async () => {
    expect((await handleChat(ask("   "))).status).toBe(400);
    expect((await handleChat(ask("x".repeat(config.maxQuestionChars + 1)))).status).toBe(400);
    const notOffered = await handleChat(ask("Leave policy?", { model: "someone/expensive-model" }));
    expect(notOffered.status).toBe(400);
    expect(await notOffered.text()).toMatch(/not one of the models/);
    // Every document unticked must be refused, not treated as "search everything".
    const nothingSelected = await handleChat(ask("Leave policy?", { documentIds: [] }));
    expect(nothingSelected.status).toBe(400);
    expect(await nothingSelected.text()).toMatch(/Select at least one document/);
    const garbage = new Request("http://test/api/chat", { method: "POST", body: "not json" });
    expect((await handleChat(garbage)).status).toBe(400);
  });

  it("rate limits one client without affecting another", async () => {
    const from = (address: string) =>
      new Request("http://test/api/chat", { method: "POST", headers: { "x-forwarded-for": address }, body: "{}" });
    const statuses: number[] = [];
    for (let i = 0; i < config.rateLimitPerMinute + 1; i++) statuses.push((await handleChat(from("203.0.113.7"))).status);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((status) => status === 400)).toBe(true);
    expect((await handleChat(from("203.0.113.8"))).status).toBe(400);
  });
});
