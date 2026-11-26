import type { ChatUIMessage } from "./chat-types";
import type {
  ConnectionInput,
  ConnectionView,
  DocumentSummary,
  HealthReport,
  IngestEvent,
  Note,
  NoteSource,
  Passage,
  SourceGuide,
  SourceRef,
  TraceData,
} from "./types";

/** Browser-side helpers: API calls and small readers for message parts. */

export async function fetchDocuments(): Promise<DocumentSummary[]> {
  const response = await fetch("/api/documents", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load the document list.");
  return ((await response.json()) as { documents: DocumentSummary[] }).documents;
}

export async function fetchHealth(): Promise<HealthReport | null> {
  const response = await fetch("/api/health", { cache: "no-store" });
  return response.ok ? ((await response.json()) as HealthReport) : null;
}

export interface ConnectionResult {
  ok: boolean;
  provider: string | null;
  model: string;
  ms: number;
  message: string;
}

/** Asks the server to send one tiny request to the model and report what happened. */
export async function checkModelConnection(model: string): Promise<ConnectionResult> {
  const response = await fetch("/api/health/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, provider: null, model, ms: 0, message: body?.error ?? "The check could not be run." };
  }
  return (await response.json()) as ConnectionResult;
}

/** The connection as the settings panel may see it: never the key itself. */
export async function fetchConnection(): Promise<ConnectionView> {
  const response = await fetch("/api/connection", { cache: "no-store" });
  if (!response.ok) throw await failure(response, "The connection settings could not be loaded.");
  return ((await response.json()) as { connection: ConnectionView }).connection;
}

/** Saves a connection. With `test` on, the server saves only if the model answers; a refusal arrives as the error. */
export async function saveConnectionSettings(input: ConnectionInput, token = ""): Promise<ConnectionView> {
  const response = await fetch("/api/connection", {
    method: "PUT",
    headers: { ...JSON_HEADERS, ...tokenHeader(token) },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await failure(response, "The connection could not be saved.");
  return ((await response.json()) as { connection: ConnectionView }).connection;
}

/** The settings token travels in a header, only on the two requests that change the connection. */
function tokenHeader(token: string): Record<string, string> {
  return token ? { "x-settings-token": token } : {};
}

export async function forgetConnectionSettings(token = ""): Promise<ConnectionView> {
  const response = await fetch("/api/connection", { method: "DELETE", headers: tokenHeader(token) });
  if (!response.ok) throw await failure(response, "The saved connection could not be removed.");
  return ((await response.json()) as { connection: ConnectionView }).connection;
}

export async function removeDocument(id: string): Promise<void> {
  const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error("Could not remove the document.");
}

export interface UploadOptions {
  /** Opens an encrypted PDF. Sent once with the file and kept nowhere. */
  password?: string;
  /** The person agreed to send scanned pages to the model. */
  allowScan?: boolean;
}

/**
 * Uploads one file and reports each server-side stage as it happens.
 * The server answers with one JSON object per line.
 */
export async function uploadDocument(
  file: File,
  onEvent: (event: IngestEvent) => void,
  options: UploadOptions = {},
): Promise<void> {
  const form = new FormData();
  form.append("file", file);
  if (options.password) form.append("password", options.password);
  if (options.allowScan) form.append("allowScan", "true");
  const response = await fetch("/api/documents", { method: "POST", body: form });

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    onEvent({ type: "error", message: body?.error ?? `Upload failed (${response.status}).` });
    return;
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as IngestEvent);
    }
  }
}

/** Reads `{ error }` from a failed response, falling back to a plain sentence. */
async function failure(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? fallback);
}

const JSON_HEADERS = { "content-type": "application/json" };

/** The guide for a selection of sources. The server returns a stored one when it has it. */
export async function fetchGuide(documentIds: string[], model: string | undefined, signal?: AbortSignal): Promise<SourceGuide> {
  const response = await fetch("/api/guide", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ documentIds, model }),
    signal,
  });
  if (!response.ok) throw await failure(response, "The source guide could not be written.");
  return ((await response.json()) as { guide: SourceGuide }).guide;
}

export async function fetchPassages(documentId: string): Promise<{ document: DocumentSummary; passages: Passage[] }> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/passages`, { cache: "no-store" });
  if (!response.ok) throw await failure(response, "That source could not be opened.");
  return (await response.json()) as { document: DocumentSummary; passages: Passage[] };
}

export async function fetchNotes(): Promise<Note[]> {
  const response = await fetch("/api/notes", { cache: "no-store" });
  if (!response.ok) throw await failure(response, "Could not load the notes.");
  return ((await response.json()) as { notes: Note[] }).notes;
}

export type NoteDraft = Pick<Note, "kind" | "title" | "body" | "question" | "sources">;

export async function saveNote(draft: NoteDraft): Promise<Note> {
  const response = await fetch("/api/notes", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(draft) });
  if (!response.ok) throw await failure(response, "The note could not be saved.");
  return ((await response.json()) as { note: Note }).note;
}

export async function renameNote(id: string, title: string): Promise<Note> {
  const response = await fetch(`/api/notes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw await failure(response, "The title could not be changed.");
  return ((await response.json()) as { note: Note }).note;
}

export async function removeNote(id: string): Promise<void> {
  const response = await fetch(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw await failure(response, "The note could not be deleted.");
}

/** "Answering from 5 sources", or "from 2 of 5 sources" when the selection is narrower than the library. */
export function scopeLine(selected: number, total: number): string {
  if (total === 0) return "No sources yet";
  if (selected === 0) return "No source is selected";
  const noun = total === 1 ? "source" : "sources";
  return selected === total ? `Answering from ${total} ${noun}` : `Answering from ${selected} of ${total} ${noun}`;
}

/** Shortens text to a title, cutting at a word where it can. */
export function titleFrom(text: string, limit = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat || "Untitled note";
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function noteSource(source: SourceRef, n: number | null = source.n): NoteSource {
  return {
    n,
    chunkId: source.chunkId,
    documentId: source.documentId,
    documentName: source.documentName,
    heading: source.heading,
    page: source.page,
    pageEnd: source.pageEnd,
  };
}

export function textOf(message: ChatUIMessage): string {
  let text = "";
  for (const part of message.parts) if (part.type === "text") text += part.text;
  return text;
}

export function sourcesOf(message: ChatUIMessage): SourceRef[] {
  for (const part of message.parts) if (part.type === "data-sources") return part.data.sources;
  return [];
}

export function traceOf(message: ChatUIMessage): TraceData | null {
  for (const part of message.parts) if (part.type === "data-trace") return part.data;
  return null;
}

/**
 * Rewrites citation markers into Markdown links the renderer turns into
 * buttons: "[1, 3]" becomes two links. Numbers that match no source are left
 * as plain text, so a made-up citation is never clickable.
 */
export function linkCitations(text: string, sourceCount: number): string {
  return text.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g, (whole, list: string) => {
    const numbers = list.split(",").map((part) => Number(part.trim()));
    if (!numbers.every((n) => n >= 1 && n <= sourceCount)) return whole;
    return numbers.map((n) => `[${n}](#cite-${n})`).join("");
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
