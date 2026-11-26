import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbedder } from "@/lib/ai/embedder";
import { callSettings, resolveChatModel } from "@/lib/ai/provider";
import { getConfig } from "@/lib/config";
import { closeDbForTests } from "@/lib/db";
import { handleChat } from "@/lib/generation/chat";
import { createPageReader, type PageReader } from "@/lib/ingest/ocr";
import { ScanPermissionRequiredError } from "@/lib/ingest/parse";
import { ingestDocument } from "@/lib/ingest/pipeline";
import { handleGuide } from "@/lib/notebook/guide";
import type { DocumentSummary, SourceGuide, SourceRef, TraceData } from "@/lib/types";

/**
 * Live checks for the two features that put a model call somewhere new:
 * reading a scan (after permission) and writing the source guide. Both spend
 * credit, so they run only when a model is connected.
 */
const config = getConfig();
const deps = { embedder: getEmbedder(config), config };
const SAMPLES = ["employee-handbook.md", "support-runbook.md", "returns-and-warranty.pdf", "vendor-note.txt"];
const sample = async (name: string) => new Uint8Array(await readFile(path.join("public", "samples", name)));

const documents: DocumentSummary[] = [];

beforeAll(async () => {
  for (const name of SAMPLES) documents.push((await ingestDocument({ name, bytes: await sample(name) }, deps)).document);
}, 600_000);

afterAll(closeDbForTests);

type Chunk = { type: string; delta?: string; data?: unknown };

async function ask(question: string, documentIds: string[]): Promise<Chunk[]> {
  const request = new Request("http://eval/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ id: "q", role: "user", parts: [{ type: "text", text: question }] }], documentIds }),
  });
  return (await (await handleChat(request)).text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)) as Chunk);
}

describe.skipIf(config.chatMode !== "gateway")("scanned sample (live model)", () => {
  it("is not read without permission, then is read and answers a question with a citation", async () => {
    const name = "field-service-report-scan.pdf";
    const bytes = await sample(name);
    let pagesSent = 0;
    const reader = createPageReader(await resolveChatModel(config, config.chatModel), callSettings(config));
    const readPage: PageReader = (image, mediaType) => {
      pagesSent += 1;
      return reader(image, mediaType);
    };

    await expect(ingestDocument({ name, bytes }, { ...deps, readPage })).rejects.toBeInstanceOf(ScanPermissionRequiredError);
    expect(pagesSent, "no page image leaves before permission").toBe(0);

    const { document } = await ingestDocument({ name, bytes }, { ...deps, readPage, allowScan: true });
    console.log(`scan: pages=${document.pages} ocrPages=${document.ocrPages} passages=${document.chunkCount} sent=${pagesSent}`);
    expect(document.status).toBe("ready");
    expect(document.ocrPages).toBeGreaterThan(0);
    expect(pagesSent).toBe(document.ocrPages);

    const chunks = await ask("Which part replaced the worn probe membrane on sensor TW-7740?", [document.id]);
    const answer = chunks
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => chunk.delta)
      .join("");
    const trace = chunks.filter((chunk) => chunk.type === "data-trace").at(-1)?.data as TraceData;
    const sources = (chunks.find((chunk) => chunk.type === "data-sources")?.data as { sources: SourceRef[] }).sources;
    console.log(`\nQ (scan): Which part replaced the worn probe membrane?\nA: ${answer}`);

    expect(answer).toMatch(/PM-?118/i);
    expect(trace.citations?.grounded, "the answer cites a passage").toBe(true);
    expect(trace.citations?.invalid).toEqual([]);
    const cited = sources.filter((source) => trace.citations?.cited.includes(source.n));
    expect(cited.every((source) => source.documentName === name)).toBe(true);
  });
});

describe.skipIf(config.chatMode !== "gateway")("source guide (live model)", () => {
  const request = () =>
    new Request("http://eval/api/guide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentIds: documents.map((document) => document.id) }),
    });

  it("writes an overview and three questions about what the sources really contain", async () => {
    const response = await handleGuide(request());
    expect(response.status, await response.clone().text()).toBe(200);
    const { guide, cached } = (await response.json()) as { guide: SourceGuide; cached: boolean };
    console.log(`\nGuide overview: ${guide.overview}\nGuide questions:\n- ${guide.questions.join("\n- ")}`);

    expect(cached).toBe(false);
    expect(guide.mode).toBe("model");
    expect(guide.overview!.length).toBeGreaterThan(80);
    expect(guide.questions).toHaveLength(3);
    for (const question of guide.questions) expect(question.trim().endsWith("?"), question).toBe(true);

    // "Real content": the guide names things that are in the sample documents.
    const topics = [/leave/i, /expens/i, /warrant/i, /return|refund/i, /E-\d{4}|error code/i, /incident|SEV/i, /sensor/i, /vendor|supplier/i];
    const text = `${guide.overview} ${guide.questions.join(" ")}`;
    const named = topics.filter((topic) => topic.test(text)).length;
    expect(named, `topics from the samples named in: ${text}`).toBeGreaterThanOrEqual(3);

    // The same selection is served from the stored copy, without another model call.
    const again = (await (await handleGuide(request())).json()) as { guide: SourceGuide; cached: boolean };
    expect(again.cached).toBe(true);
    expect(again.guide).toEqual(guide);
  });
});
