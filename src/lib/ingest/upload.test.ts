import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getEmbedder } from "../ai/embedder";
import { isLocalAddress, isLocalModel } from "../ai/local";
import { handleConnectionCheck } from "../ai/provider";
import { getConfig } from "../config";
import { closeDbForTests } from "../db";
import { listDocuments } from "../retrieval/store";
import type { IngestEvent } from "../types";
import { fitRenderScale, PageTooLargeError, renderPdfPage } from "./ocr";
import { isOleContainer, parseDocument } from "./parse";
import { IngestLimitError, ingestDocument } from "./pipeline";
import { handleUpload } from "./upload";

/**
 * The upload endpoint as a black box, plus the pure helpers behind its
 * guardrails. The model is a fake page reader that records its calls, so each
 * test can prove a page image was or was not sent.
 */
const config = getConfig();
const PASSWORD = "open-sesame-42";
const fixture = async (name: string) => new Uint8Array(await readFile(path.join(__dirname, "__fixtures__", name)));

let client = 0;
function upload(name: string, bytes: Uint8Array, fields: Record<string, string> = {}, address?: string): Request {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request("http://test/api/documents", {
    method: "POST",
    headers: { "x-forwarded-for": address ?? `10.1.0.${++client}` },
    body: form,
  });
}

async function events(response: Response): Promise<IngestEvent[]> {
  return (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as IngestEvent);
}

function fakeReader() {
  const calls: string[] = [];
  const readPage = async (_image: Uint8Array, mediaType: string) => {
    calls.push(mediaType);
    return "Delivery note 8812\n\nTwelve crates were received at the Harbour Road depot.";
  };
  return { readPage, calls };
}

afterAll(closeDbForTests);

describe("password-protected PDFs", () => {
  afterEach(() => {
    delete process.env.LOG_IN_TESTS;
    vi.restoreAllMocks();
  });

  it("asks for a password and stores nothing", async () => {
    const before = (await listDocuments()).length;
    const result = await events(await handleUpload(upload("memo.pdf", await fixture("protected.pdf"))));
    expect(result.at(-1)).toEqual({ type: "needs_password", wrong: false });
    expect((await listDocuments()).length).toBe(before);
  });

  it("says so when the password is wrong, and still stores nothing", async () => {
    const before = (await listDocuments()).length;
    const request = upload("memo.pdf", await fixture("protected.pdf"), { password: "not-the-password" });
    const result = await events(await handleUpload(request));
    expect(result.at(-1)).toEqual({ type: "needs_password", wrong: true });
    expect(JSON.stringify(result)).not.toContain("not-the-password");
    expect((await listDocuments()).length).toBe(before);
  });

  it("indexes the file with the right password and never logs or echoes it", async () => {
    process.env.LOG_IN_TESTS = "1";
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));

    const request = upload("memo.pdf", await fixture("protected.pdf"), { password: PASSWORD });
    const result = await events(await handleUpload(request));
    const done = result.at(-1);
    expect(done).toMatchObject({ type: "done", document: { name: "memo.pdf", status: "ready", pages: 1 } });

    const ingested = lines.filter((line) => line.includes('"document_ingested"'));
    expect(ingested).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(await listDocuments())).not.toContain(PASSWORD);
  });

  it("refuses an overlong password field", async () => {
    const request = upload("memo.pdf", await fixture("protected.pdf"), { password: "x".repeat(501) });
    expect((await handleUpload(request)).status).toBe(400);
  });

  it("recognises a password-protected Word file by its container and says what to do", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(isOleContainer(ole)).toBe(true);
    expect(isOleContainer(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
    await expect(parseDocument("contract.docx", ole)).rejects.toThrow(/password-protected.*remove the password/i);
    const result = await events(await handleUpload(upload("contract.docx", ole)));
    expect(result.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/remove the password/) });
  });
});

describe("permission before a scan is read", () => {
  it("asks first for an image: no model call, nothing stored", async () => {
    const { readPage, calls } = fakeReader();
    const before = (await listDocuments()).length;
    const result = await events(await handleUpload(upload("note.png", new Uint8Array([1, 2, 3])), { readPage }));
    expect(result.at(-1)).toEqual({
      type: "needs_scan_permission",
      pages: 1,
      textPages: 0,
      provider: "the connected model",
      local: false,
    });
    expect(calls).toEqual([]);
    expect((await listDocuments()).length).toBe(before);
  });

  it("reads the image once permission comes with the request", async () => {
    const { readPage, calls } = fakeReader();
    const request = upload("note.png", new Uint8Array([1, 2, 3]), { allowScan: "true" });
    const result = await events(await handleUpload(request, { readPage }));
    expect(calls).toEqual(["image/png"]);
    expect(result.at(-1)).toMatchObject({ type: "done", document: { name: "note.png", ocrPages: 1, status: "ready" } });
  });

  it("does not index the text half of a mixed PDF while permission is missing", async () => {
    const { readPage, calls } = fakeReader();
    const before = (await listDocuments()).length;
    const result = await events(await handleUpload(upload("visit.pdf", await fixture("mixed-scan.pdf")), { readPage }));
    expect(result.at(-1)).toMatchObject({ type: "needs_scan_permission", pages: 1, textPages: 1 });
    expect(calls).toEqual([]);
    expect((await listDocuments()).length).toBe(before);
  });

  it("offline, a scan is still refused with the reason", async () => {
    const result = await events(await handleUpload(upload("note.jpg", new Uint8Array([4, 5, 6]), { allowScan: "true" })));
    expect(result.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/needs a connected model/) });
  });

  it("a full library refuses a scan before the page reader is called", async () => {
    const { readPage, calls } = fakeReader();
    const full = { ...config, maxDocuments: (await listDocuments()).length };
    await expect(
      ingestDocument(
        { name: "late.png", bytes: new Uint8Array([7, 7, 7]) },
        { embedder: getEmbedder(config), config: full, readPage, allowScan: true },
      ),
    ).rejects.toBeInstanceOf(IngestLimitError);
    expect(calls).toEqual([]);
  });
});

describe("upload guardrails", () => {
  it("refuses requests from another site", async () => {
    const request = upload("a.txt", new TextEncoder().encode("hello"));
    request.headers.set("sec-fetch-site", "cross-site");
    expect((await handleUpload(request)).status).toBe(403);
  });

  it("rate limits uploads per client, in a bucket of their own", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < config.ingestRateLimitPerMinute + 1; i++) {
      const request = new Request("http://test/api/documents", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.20" },
        body: "not a form",
      });
      statuses.push((await handleUpload(request)).status);
    }
    expect(statuses.slice(0, -1).every((status) => status === 400)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another client is unaffected.
    const other = await handleUpload(upload("b.txt", new TextEncoder().encode("A note about parking."), {}, "203.0.113.21"));
    expect(other.status).toBe(200);
  });
});

describe("connection check", () => {
  const check = (address: string, headers: Record<string, string> = {}) =>
    new Request("http://test/api/health/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": address, ...headers },
      body: "{}",
    });

  it("refuses other sites and limits how often the model is pinged", async () => {
    let pings = 0;
    const deps = {
      check: async () => {
        pings += 1;
        return { ok: true, provider: null, model: "m", ms: 1, message: "The model answered." };
      },
    };
    expect((await handleConnectionCheck(check("203.0.113.30", { "sec-fetch-site": "cross-site" }), deps)).status).toBe(403);

    const statuses: number[] = [];
    for (let i = 0; i < config.healthCheckRateLimitPerMinute + 2; i++) {
      statuses.push((await handleConnectionCheck(check("203.0.113.30"), deps)).status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(config.healthCheckRateLimitPerMinute);
    expect(statuses.at(-1)).toBe(429);
    expect(pings).toBe(config.healthCheckRateLimitPerMinute);
  });
});

describe("renderPdfPage", () => {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

  it("renders a page to PNG, and opens an encrypted file with its password", async () => {
    const plain = await renderPdfPage(await fixture("mixed-scan.pdf"), 2, { maxPixels: 16_000_000 });
    expect([...plain.slice(0, 4)]).toEqual(PNG_SIGNATURE);
    const locked = await renderPdfPage(await fixture("protected.pdf"), 1, { maxPixels: 16_000_000, password: PASSWORD });
    expect([...locked.slice(0, 4)]).toEqual(PNG_SIGNATURE);
  });

  it("refuses a page that cannot fit the pixel budget", async () => {
    await expect(renderPdfPage(await fixture("mixed-scan.pdf"), 2, { maxPixels: 1000 })).rejects.toBeInstanceOf(
      PageTooLargeError,
    );
  });
});

describe("fitRenderScale", () => {
  const budget = 16_000_000;

  it("keeps the preferred scale for an ordinary page", () => {
    expect(fitRenderScale(595, 842, budget)).toBe(2); // A4
  });

  it("lowers the scale so a large page stays within the budget", () => {
    const scale = fitRenderScale(2384, 3370, budget)!; // A0
    expect(scale).toBeLessThan(2);
    expect(scale).toBeGreaterThanOrEqual(1);
    expect(2384 * 3370 * scale * scale).toBeLessThanOrEqual(budget + 1);
  });

  it("refuses a page that would not fit even at its own size", () => {
    expect(fitRenderScale(14_400, 14_400, budget)).toBeNull();
  });

  it("refuses a page with no area or a nonsense size", () => {
    expect(fitRenderScale(0, 842, budget)).toBeNull();
    expect(fitRenderScale(Number.NaN, 842, budget)).toBeNull();
  });
});

describe("isLocalAddress", () => {
  it("accepts this machine and private networks", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:1234/v1",
      "http://[::1]:8000/v1",
      "http://10.0.0.5:8000/v1",
      "http://172.16.4.2/v1",
      "http://172.31.255.1/v1",
      "http://192.168.1.20:8080/v1",
      "http://[fd12:3456:789a::1]/v1",
    ]) {
      expect(isLocalAddress(url), url).toBe(true);
    }
  });

  it("rejects public hosts, look-alikes and garbage", () => {
    for (const url of [
      "https://ai-gateway.vercel.sh/v1",
      "https://openrouter.ai/api/v1",
      "http://172.32.0.1/v1",
      "http://192.169.1.1/v1",
      "http://11.0.0.1/v1",
      "http://localhost.example.com/v1",
      "http://10.example.com/v1",
      "not a url",
      "",
    ]) {
      expect(isLocalAddress(url), url).toBe(false);
    }
  });

  it("only the OpenAI-compatible provider can be local", () => {
    expect(isLocalModel("openai-compatible", "http://localhost:11434/v1")).toBe(true);
    expect(isLocalModel("openai-compatible", "https://api.groq.com/openai/v1")).toBe(false);
    expect(isLocalModel("gateway", "http://localhost:11434/v1")).toBe(false);
    expect(isLocalModel(null, null)).toBe(false);
  });
});
