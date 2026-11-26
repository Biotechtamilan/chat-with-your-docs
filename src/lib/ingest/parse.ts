import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import type { Block } from "./chunk";
import type { PageReader } from "./ocr";

/**
 * Turns an uploaded file into ordered text blocks that keep the structure the
 * chunker needs: heading path for Markdown and Word files, page number for PDFs.
 */

export class UnsupportedFileError extends Error {}
export class EmptyDocumentError extends Error {}

/** The PDF is encrypted. `wrong` is true when a password was supplied and did not open it. */
export class PasswordRequiredError extends Error {
  constructor(readonly wrong: boolean) {
    super(wrong ? "That password did not open this PDF." : "This PDF is password-protected.");
  }
}

/**
 * The file has pages that only the model can read, and the person has not yet
 * agreed to send them. Thrown before any model call and before anything is stored.
 */
export class ScanPermissionRequiredError extends Error {
  constructor(
    /** Pages that would be sent to the model as images. */
    readonly pages: number,
    /** Pages that have a text layer and need no model. */
    readonly textPages: number,
  ) {
    super("Reading this file needs permission to send page images to the model.");
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  // Pictures of text. They are read by the chat model, so they need one connected.
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
/** A page with less text than this is treated as a scan. Stray page numbers do not count as content. */
const SCANNED_PAGE_CHARS = 16;
const NEEDS_MODEL = "Reading text from a scan or an image needs a connected model. Connect one under Settings, Connection, or add a key to .env.local.";

export const SUPPORTED_EXTENSIONS = Object.keys(MIME_BY_EXTENSION);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export interface ParsedDocument {
  blocks: Block[];
  pages: number | null;
  mime: string;
  /** How many pages were read from an image by the model, not extracted as text. */
  ocrPages: number;
}

/** How scans get read. Left out (offline mode, most tests), scans are refused with a clear message. */
export interface OcrOptions {
  /** Whether the person agreed to send page images to the model. Without it, no page is read. */
  allowed: boolean;
  readPage: PageReader;
  renderPage: (bytes: Uint8Array, pageNumber: number) => Promise<Uint8Array>;
  maxPages: number;
  onPage?: (done: number, total: number) => void;
}

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const path: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = (kind?: "code") => {
    const body = buffer.join("\n").trim();
    if (body) blocks.push({ text: body, heading: [...path], kind });
    buffer = [];
  };

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (inFence) {
        buffer.push(line);
        flush("code");
      } else {
        flush();
        buffer.push(line);
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      buffer.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      // A level-3 heading replaces any deeper path and sits under the current level 1-2.
      path.splice(Math.min(heading[1].length - 1, path.length));
      path.push(heading[2]);
      continue;
    }
    if (line.trim() === "") flush();
    else buffer.push(line);
  }
  flush(inFence ? "code" : undefined);
  return blocks;
}

export function parsePlainText(text: string): Block[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({ text: paragraph, heading: [] }));
}

/** PDF text arrives as visual lines. Rejoin them into flowing paragraphs. */
export function cleanPdfText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2") // "infor-\nmation" -> "information"
    .replace(/([^\n])\n(?!\n)/g, "$1 ") // single line break -> space
    .replace(/[ \t]+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Mammoth gives clean semantic HTML; this keeps headings, lists and table rows as Markdown-like text. */
export function htmlToMarkdown(html: string): string {
  return html
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${inner}\n\n`)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(p|ul|ol|table)>|<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\n{3,}/g, "\n\n");
}

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  if (text.includes("\u0000")) throw new UnsupportedFileError("This file looks binary, not text.");
  return text;
}

export interface ParseLimits {
  maxPdfPages: number;
  maxTextChars: number;
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = { maxPdfPages: 300, maxTextChars: 1_500_000 };

/** pdf.js reports both "a password is needed" (code 1) and "that password is wrong" (code 2) this way. */
function passwordProblem(error: unknown): { wrong: boolean } | null {
  if (!(error instanceof Error) || error.name !== "PasswordException") return null;
  return { wrong: (error as Error & { code?: number }).code === 2 };
}

/**
 * A Word file saved with a password is no longer a zip archive: Word wraps the
 * encrypted content in the old OLE container, which starts with these bytes.
 * (A legacy .doc renamed to .docx starts the same way.)
 */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0];

export function isOleContainer(bytes: Uint8Array): boolean {
  return OLE_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * `password` opens an encrypted PDF. It is used for that and nothing else: it
 * is never stored, logged, or included in an error message.
 */
export async function parseDocument(
  name: string,
  bytes: Uint8Array,
  limits: ParseLimits = DEFAULT_PARSE_LIMITS,
  ocr?: OcrOptions,
  password?: string,
): Promise<ParsedDocument> {
  const extension = extensionOf(name);
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) {
    throw new UnsupportedFileError(
      `"${extension || name}" files are not supported. Use ${SUPPORTED_EXTENSIONS.join(", ")}.`,
    );
  }

  let blocks: Block[];
  let pages: number | null = null;
  let ocrPages = 0;

  if (IMAGE_EXTENSIONS.has(extension)) {
    if (!ocr) throw new UnsupportedFileError(NEEDS_MODEL);
    if (!ocr.allowed) throw new ScanPermissionRequiredError(1, 0);
    ocr.onPage?.(0, 1);
    blocks = parsePlainText(await ocr.readPage(bytes, mime));
    ocrPages = 1;
  } else if (extension === ".pdf") {
    // pdf.js takes ownership of the buffer it is given, so hand it a copy.
    const pdf = await getDocumentProxy(new Uint8Array(bytes), password ? { password } : undefined).catch(
      (error: unknown) => {
        const problem = passwordProblem(error);
        // A password that was sent and still did not open the file is a wrong one, whatever code came back.
        if (problem) throw new PasswordRequiredError(problem.wrong || Boolean(password));
        throw error;
      },
    );
    if (pdf.numPages > limits.maxPdfPages) {
      throw new UnsupportedFileError(
        `This PDF has ${pdf.numPages} pages. The limit is ${limits.maxPdfPages}.`,
      );
    }
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    pages = totalPages;
    const pageTexts = text.map(cleanPdfText);

    // Pages without a text layer are scans: render each one and have the model read it.
    const scanned = pageTexts.flatMap((pageText, index) => (pageText.length < SCANNED_PAGE_CHARS ? [index] : []));
    if (scanned.length > 0 && ocr) {
      if (scanned.length > ocr.maxPages) {
        throw new UnsupportedFileError(
          `This PDF has ${scanned.length} scanned pages. Up to ${ocr.maxPages} can be read per file.`,
        );
      }
      // Asked only after the limits, so nobody is asked to approve a file that would be refused anyway.
      if (!ocr.allowed) throw new ScanPermissionRequiredError(scanned.length, totalPages - scanned.length);
      for (const [done, index] of scanned.entries()) {
        ocr.onPage?.(done, scanned.length);
        pageTexts[index] = await ocr.readPage(await ocr.renderPage(bytes, index + 1), "image/png");
      }
      ocrPages = scanned.length;
    } else if (scanned.length === totalPages) {
      throw new EmptyDocumentError(`This PDF is a scan with no text layer. ${NEEDS_MODEL}`);
    }

    blocks = pageTexts.flatMap((pageText, index) =>
      parsePlainText(pageText).map((block) => ({ ...block, page: index + 1 })),
    );
  } else if (extension === ".docx") {
    if (isOleContainer(bytes)) {
      throw new UnsupportedFileError(
        "This Word file is password-protected, or saved in the old .doc format. Open it in Word, remove the password, save it as .docx, and add it again.",
      );
    }
    const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    blocks = parseMarkdown(htmlToMarkdown(value));
  } else if (extension === ".txt") {
    blocks = parsePlainText(decodeText(bytes));
  } else {
    blocks = parseMarkdown(decodeText(bytes));
  }

  // A small compressed file can expand into a very large amount of text.
  const textChars = blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (textChars > limits.maxTextChars) {
    throw new UnsupportedFileError(
      `This file contains too much text to index (${textChars.toLocaleString()} characters; the limit is ${limits.maxTextChars.toLocaleString()}).`,
    );
  }

  if (blocks.length === 0) {
    throw new EmptyDocumentError(
      ocrPages > 0 ? "No readable text was found in this file." : "The file contains no text.",
    );
  }
  return { blocks, pages, mime, ocrPages };
}
