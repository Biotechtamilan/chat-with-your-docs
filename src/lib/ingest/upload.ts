import { getEmbedder } from "../ai/embedder";
import { callSettings, resolveChatModel } from "../ai/provider";
import { getConfig } from "../config";
import { checkUpload, CROSS_SITE_MESSAGE, isCrossSiteRequest, limiterFor, rateLimitKey } from "../guardrails";
import { errorMessage, redactSecret } from "../log";
import type { IngestEvent } from "../types";
import { createPageReader, type PageReader } from "./ocr";
import { PasswordRequiredError, ScanPermissionRequiredError } from "./parse";
import { ingestDocument } from "./pipeline";

export interface UploadDeps {
  /** Tests inject a fake page reader; production builds one from the connected model. */
  readPage?: PageReader;
}

/** Longer than any real PDF password, short enough that the field cannot carry a payload. */
const MAX_PASSWORD_CHARS = 500;

const refuse = (status: number, error: string) => Response.json({ error }, { status });

/**
 * Uploads one file and streams progress as newline-delimited JSON, one
 * IngestEvent per line, so the browser can show which stage is running.
 *
 * Two events end the stream with nothing stored, and the browser answers each
 * by sending the same file again with one more form field:
 *  - `needs_password`: an encrypted PDF. Re-send with `password`.
 *  - `needs_scan_permission`: pages only the model can read. Re-send with `allowScan=true`.
 */
export async function handleUpload(request: Request, deps: UploadDeps = {}): Promise<Response> {
  if (isCrossSiteRequest(request.headers)) return refuse(403, CROSS_SITE_MESSAGE);
  const config = getConfig();

  if (!limiterFor("ingest", config.ingestRateLimitPerMinute).allow(rateLimitKey(request.headers, config.trustProxy))) {
    return refuse(429, "Too many uploads in one minute. Wait a moment and try again.");
  }

  // Refuse an oversized body before reading it. The multipart envelope adds a little to the file size.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > config.maxUploadBytes + 64 * 1024) {
    const limitMb = Math.round(config.maxUploadBytes / (1024 * 1024));
    return refuse(413, `That upload is larger than the ${limitMb} MB limit.`);
  }

  let file: File | null = null;
  let password: string | undefined;
  let allowScan = false;
  try {
    const form = await request.formData();
    const value = form.get("file");
    if (value instanceof File) file = value;
    const secret = form.get("password");
    if (typeof secret === "string" && secret.length > 0) password = secret;
    allowScan = form.get("allowScan") === "true";
  } catch {
    // fall through to the 400 below
  }
  if (!file) return refuse(400, 'Attach a file in the "file" field.');
  if (password && password.length > MAX_PASSWORD_CHARS) return refuse(400, "That password is too long.");

  const problem = checkUpload({ name: file.name, size: file.size }, config);
  if (problem) return refuse(400, problem);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: IngestEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        // Scans and images are read by the chat model, so a reader exists only when one is connected.
        // Building it calls nothing: the model is reached only if the parser decides a page needs reading.
        const readPage =
          deps.readPage ??
          (config.chatMode === "gateway"
            ? createPageReader(await resolveChatModel(config, config.chatModel), callSettings(config), request.signal)
            : undefined);
        const result = await ingestDocument(
          { name, bytes },
          { embedder: getEmbedder(config), config, readPage, allowScan, password },
          send,
        );
        send({ type: "done", document: result.document, duplicate: result.duplicate });
      } catch (error) {
        if (error instanceof PasswordRequiredError) {
          send({ type: "needs_password", wrong: error.wrong });
        } else if (error instanceof ScanPermissionRequiredError) {
          send({
            type: "needs_scan_permission",
            pages: error.pages,
            textPages: error.textPages,
            provider: config.providerLabel ?? "the connected model",
            local: config.local,
          });
        } else {
          send({ type: "error", message: redactSecret(errorMessage(error), config.apiKey) });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
