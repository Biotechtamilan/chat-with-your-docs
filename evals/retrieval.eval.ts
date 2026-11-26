import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbedder } from "@/lib/ai/embedder";
import { getConfig } from "@/lib/config";
import { closeDbForTests } from "@/lib/db";
import { handleChat } from "@/lib/generation/chat";
import { ingestDocument } from "@/lib/ingest/pipeline";
import { retrieve } from "@/lib/retrieval/retrieve";
import type { TraceData } from "@/lib/types";
import golden from "./golden.json";

/**
 * Quality checks that need the real embedding model, so they are kept out of
 * the unit tests. Run with `npm run eval`.
 *
 * Part 1 scores retrieval on its own: for each golden question, where does the
 * passage containing the expected fact rank? It needs no API key.
 * Part 2 asks the live model a few questions and checks the answers. It runs
 * only when AI_GATEWAY_API_KEY is set, because it spends credit.
 */
const config = getConfig();
const deps = { embedder: getEmbedder(config), config };
const SAMPLES = ["employee-handbook.md", "support-runbook.md", "returns-and-warranty.pdf", "vendor-note.txt"];

beforeAll(async () => {
  for (const name of SAMPLES) {
    const bytes = new Uint8Array(await readFile(path.join("public", "samples", name)));
    await ingestDocument({ name, bytes }, deps);
  }
}, 600_000);

afterAll(closeDbForTests);

describe("retrieval quality", () => {
  it("ranks the passage with the expected fact near the top", async () => {
    const rows: Array<{ question: string; rank: number | null }> = [];

    for (const item of golden.retrieval) {
      const { sources } = await retrieve(item.question, deps);
      const hit = sources.find(
        (source) => source.documentName === item.document && source.content.includes(item.contains),
      );
      rows.push({ question: item.question, rank: hit?.n ?? null });
    }

    const total = rows.length;
    const hitAt = (k: number) => rows.filter((row) => row.rank !== null && row.rank <= k).length / total;
    const mrr = rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / total;

    console.table(rows.map((row) => ({ rank: row.rank ?? "miss", question: row.question })));
    console.log(
      `questions=${total}  hit@1=${hitAt(1).toFixed(2)}  hit@3=${hitAt(3).toFixed(2)}  hit@${config.retrieval.topK}=${hitAt(config.retrieval.topK).toFixed(2)}  MRR=${mrr.toFixed(3)}`,
    );

    // The bar: the right passage is almost always among the first three shown to the model.
    expect(hitAt(3)).toBeGreaterThanOrEqual(0.9);
    expect(hitAt(config.retrieval.topK)).toBe(1);
  });

  it("refuses off-topic questions without calling the model", async () => {
    for (const question of golden.offTopic) {
      const chunks = await ask(question);
      expect(traceOf(chunks).outcome, question).toBe("no_context");
    }
  });
});

describe.skipIf(config.chatMode !== "gateway")("answer quality (live model)", () => {
  for (const item of golden.answers) {
    it(item.question, async () => {
      const chunks = await ask(item.question);
      const answer = chunks
        .filter((chunk) => chunk.type === "text-delta")
        .map((chunk) => chunk.delta)
        .join("");
      const trace = traceOf(chunks);
      console.log(`\nQ: ${item.question}\nA: ${answer}\nprovider=${trace.provider} usage=${JSON.stringify(trace.usage)}`);

      for (const pattern of item.mustMatch) expect(answer).toMatch(new RegExp(pattern, "i"));
      for (const pattern of item.mustNotMatch) expect(answer).not.toMatch(new RegExp(pattern, "i"));
      // A correct "the documents do not say" reply cites nothing, so each case states what it expects.
      expect(trace.citations?.grounded, "citation expectation").toBe(item.cites);
      expect(trace.citations?.invalid, "no made-up citation numbers").toEqual([]);
    });
  }
});

type Chunk = { type: string; delta?: string; data?: unknown };

let caller = 0;
async function ask(question: string): Promise<Chunk[]> {
  const request = new Request("http://eval/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `eval-${++caller}` },
    body: JSON.stringify({ messages: [{ id: "q", role: "user", parts: [{ type: "text", text: question }] }] }),
  });
  const body = await (await handleChat(request)).text();
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)) as Chunk);
}

function traceOf(chunks: Chunk[]): TraceData {
  return chunks.filter((chunk) => chunk.type === "data-trace").at(-1)?.data as TraceData;
}
