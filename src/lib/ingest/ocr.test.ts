import { afterEach, describe, expect, it } from "vitest";
import { detectProvider, getConfig, resetConfigForTests } from "../config";
import { EmptyDocumentError, parseDocument, UnsupportedFileError, type OcrOptions } from "./parse";

/**
 * Scans and images, with the model and the page renderer replaced by fakes:
 * these tests prove the routing (which pages get read, what is refused), not
 * the quality of a transcription.
 */
const limits = { maxPdfPages: 300, maxTextChars: 1_500_000 };

function fakeOcr(overrides: Partial<OcrOptions> = {}) {
  const calls: Array<{ mediaType: string; bytes: number }> = [];
  const pages: Array<[number, number]> = [];
  const ocr: OcrOptions = {
    allowed: true,
    readPage: async (image, mediaType) => {
      calls.push({ mediaType, bytes: image.byteLength });
      return "Invoice 4471\n\nTotal due: 120 dollars by 31 March.";
    },
    renderPage: async () => new Uint8Array([1, 2, 3]),
    maxPages: 5,
    onPage: (done, total) => pages.push([done, total]),
    ...overrides,
  };
  return { ocr, calls, pages };
}

/** A minimal one-page PDF with an empty content stream: no text layer, like a scan. */
function blankPdf(pageCount = 1): Uint8Array {
  const kids = Array.from({ length: pageCount }, (_, i) => `${i + 3} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    ...Array.from({ length: pageCount }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"),
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}

describe("images", () => {
  it("reads an image through the model and counts it as one scanned page", async () => {
    const { ocr, calls } = fakeOcr();
    const parsed = await parseDocument("receipt.JPG", new Uint8Array([9, 9]), limits, ocr);
    expect(calls).toEqual([{ mediaType: "image/jpeg", bytes: 2 }]);
    expect(parsed.ocrPages).toBe(1);
    expect(parsed.mime).toBe("image/jpeg");
    expect(parsed.blocks.map((block) => block.text)).toEqual(["Invoice 4471", "Total due: 120 dollars by 31 March."]);
  });

  it("refuses an image when no model is connected", async () => {
    await expect(parseDocument("receipt.png", new Uint8Array([9]), limits)).rejects.toThrow(/needs a connected model/);
  });

  it("reports an image with no readable text", async () => {
    const { ocr } = fakeOcr({ readPage: async () => "" });
    await expect(parseDocument("blank.png", new Uint8Array([9]), limits, ocr)).rejects.toBeInstanceOf(EmptyDocumentError);
  });
});

describe("scanned PDFs", () => {
  it("renders and reads every page that has no text layer, keeping page numbers", async () => {
    const { ocr, calls, pages } = fakeOcr();
    const parsed = await parseDocument("scan.pdf", blankPdf(2), limits, ocr);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.mediaType === "image/png")).toBe(true);
    expect(parsed.ocrPages).toBe(2);
    expect(parsed.pages).toBe(2);
    expect(parsed.blocks.map((block) => block.page)).toEqual([1, 1, 2, 2]);
    expect(pages).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  it("refuses a scan when no model is connected, and says why", async () => {
    await expect(parseDocument("scan.pdf", blankPdf(), limits)).rejects.toThrow(/scan with no text layer.*connected model/);
  });

  it("without permission, asks before reading and says how many pages are scans", async () => {
    const { ocr, calls } = fakeOcr({ allowed: false });
    await expect(parseDocument("scan.pdf", blankPdf(2), limits, ocr)).rejects.toMatchObject({ pages: 2, textPages: 0 });
    await expect(parseDocument("photo.webp", new Uint8Array([9]), limits, ocr)).rejects.toMatchObject({ pages: 1 });
    expect(calls).toHaveLength(0);
  });

  it("refuses a file with more scanned pages than the limit before reading any", async () => {
    const { ocr, calls } = fakeOcr({ maxPages: 1 });
    await expect(parseDocument("scan.pdf", blankPdf(3), limits, ocr)).rejects.toBeInstanceOf(UnsupportedFileError);
    expect(calls).toHaveLength(0);
  });
});

describe("provider detection", () => {
  const base = {
    AI_MODE: "live",
    EMBEDDING_MODEL: "x",
    EMBEDDING_DIMENSIONS: 8,
    EMBEDDING_QUERY_PREFIX: "",
    DATA_DIR: ".data",
    CHUNK_TARGET_TOKENS: 280,
    CHUNK_MAX_TOKENS: 400,
    CHUNK_OVERLAP_TOKENS: 50,
    CANDIDATES_PER_LEG: 20,
    TOP_K: 6,
    MIN_SIMILARITY: 0.5,
    HISTORY_TURNS: 6,
    MAX_OUTPUT_TOKENS: 1200,
    MAX_QUESTION_CHARS: 2000,
    MAX_UPLOAD_MB: 15,
    MAX_DOCUMENTS: 50,
    OCR_MAX_PAGES: 20,
    OCR_MAX_PAGE_PIXELS: 16_000_000,
    RATE_LIMIT_PER_MINUTE: 30,
    INGEST_RATE_LIMIT_PER_MINUTE: 30,
    HEALTH_CHECK_RATE_LIMIT_PER_MINUTE: 6,
    CONNECTION_RATE_LIMIT_PER_MINUTE: 6,
    GUIDE_INPUT_CHARS: 12_000,
    MAX_NOTES: 500,
    TRUST_PROXY: "false",
  } as const;

  it("prefers the gateway, then falls through the other keys in order", () => {
    expect(detectProvider({ ...base, AI_GATEWAY_API_KEY: "k", OPENAI_API_KEY: "k" })).toBe("gateway");
    expect(detectProvider({ ...base, OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" })).toBe("openai");
    expect(detectProvider({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: "k" })).toBe("google");
    expect(detectProvider({ ...base, LLM_BASE_URL: "http://localhost:11434/v1" })).toBe("openai-compatible");
    expect(detectProvider(base)).toBeNull();
  });

  it("honours an explicit choice only when that provider has a key", () => {
    expect(detectProvider({ ...base, LLM_PROVIDER: "anthropic", AI_GATEWAY_API_KEY: "k", ANTHROPIC_API_KEY: "k" })).toBe("anthropic");
    expect(detectProvider({ ...base, LLM_PROVIDER: "openai", AI_GATEWAY_API_KEY: "k" })).toBeNull();
  });

  describe("from the environment", () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
      resetConfigForTests();
    });

    it("stays offline with a clear warning when a key has no model to go with it", () => {
      process.env = { ...saved, AI_MODE: "live", OPENAI_API_KEY: "k" };
      delete process.env.AI_GATEWAY_API_KEY;
      delete process.env.CHAT_MODEL;
      resetConfigForTests();
      const config = getConfig();
      expect(config.chatMode).toBe("offline");
      expect(config.warning).toMatch(/CHAT_MODEL is not/);
    });

    it("connects another provider once a model is named, and leaves its reasoning setting alone", () => {
      process.env = { ...saved, AI_MODE: "live", OPENAI_API_KEY: "k", CHAT_MODEL: "some-model" };
      delete process.env.AI_GATEWAY_API_KEY;
      resetConfigForTests();
      const config = getConfig();
      expect(config).toMatchObject({ provider: "openai", chatMode: "gateway", reasoning: "default" });
      expect(config.allowedChatModels).toEqual(["some-model"]);
    });
  });
});
