/**
 * Shapes shared by the server and the browser. Keeping them in one file means
 * the API contract cannot drift between a route handler and the component that
 * renders its response.
 */

export type DocumentStatus = "processing" | "ready" | "failed";

export interface DocumentSummary {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  pages: number | null;
  /** Pages read from an image by the model. Their text may contain transcription mistakes. */
  ocrPages: number;
  chunkCount: number;
  status: DocumentStatus;
  error: string | null;
  createdAt: string;
}

/** One retrieved passage, numbered the way the model is asked to cite it. */
export interface SourceRef {
  /** 1-based citation number: the model writes [n]. */
  n: number;
  chunkId: string;
  documentId: string;
  documentName: string;
  heading: string | null;
  page: number | null;
  pageEnd: number | null;
  content: string;
  /** Cosine similarity from the vector leg, when that leg returned this chunk. */
  similarity: number | null;
  /** 1-based rank in each leg, when present. */
  denseRank: number | null;
  lexicalRank: number | null;
  fusedScore: number;
}

export type AnswerOutcome = "answered" | "no_context" | "no_documents" | "stopped" | "error";

export interface TraceStage {
  name: string;
  ms: number;
}

/** Everything needed to explain how one answer was produced. */
export interface TraceData {
  id: string;
  outcome: AnswerOutcome;
  /** "gateway": a model wrote the answer. "offline": no credential, passages were quoted. */
  mode: "gateway" | "offline";
  model: string;
  /** Which upstream provider served the request, e.g. "token-pass". Null when unknown. */
  provider: string | null;
  question: string;
  /** The query actually searched for (differs from the question on follow-ups). */
  searchQuery: string;
  stages: TraceStage[];
  totalMs: number;
  bestSimilarity: number | null;
  retrievedCount: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  costUsd: number | null;
  citations: { cited: number[]; invalid: number[]; grounded: boolean } | null;
  /** True once generation has finished and the numbers above are final. */
  complete: boolean;
}

export type IngestEvent =
  | { type: "progress"; stage: "parsing" | "reading" | "chunking" | "embedding" | "storing"; detail?: string }
  | { type: "done"; document: DocumentSummary; duplicate: boolean }
  /** The PDF is encrypted. Nothing was stored; send the file again with its password. */
  | { type: "needs_password"; wrong: boolean }
  /**
   * The file has pages only the model can read, and no permission came with the
   * request. Nothing was stored and no model was called. `provider` and `local`
   * say where the page images would go; `textPages` is how many pages need no model.
   */
  | { type: "needs_scan_permission"; pages: number; textPages: number; provider: string; local: boolean }
  | { type: "error"; message: string };

/** One stored passage of a document, as shown when a source is opened. */
export interface Passage {
  id: string;
  ord: number;
  content: string;
  heading: string | null;
  page: number | null;
  pageEnd: number | null;
}

/**
 * A short introduction to the selected sources. In offline mode there is no
 * overview and no questions, only the list of sources.
 */
export interface SourceGuide {
  mode: "model" | "offline";
  /** Model output about untrusted documents: always rendered as plain text. */
  overview: string | null;
  questions: string[];
  sources: Array<{ id: string; name: string; passages: number }>;
  model: string | null;
}

/** Where a note's text came from. Kept on the note so it still reads after the source is removed. */
export interface NoteSource {
  /** The citation number the answer used for this passage, or null for a passage note. */
  n: number | null;
  chunkId: string;
  documentId: string;
  documentName: string;
  heading: string | null;
  page: number | null;
  pageEnd: number | null;
}

export interface Note {
  id: string;
  kind: "answer" | "passage";
  title: string;
  body: string;
  /** The question an answer note replies to. */
  question: string | null;
  sources: NoteSource[];
  createdAt: string;
}

export interface HealthReport {
  ok: boolean;
  mode: "gateway" | "offline";
  chatModel: string;
  chatModels: Array<{ id: string; label: string }>;
  /** Which service answers, or null when no model is connected. */
  provider: string | null;
  /** True when the model runs on this machine or private network (its address points there). */
  local: boolean;
  /** Where the connection came from: saved in the app, the environment, or nowhere. */
  connectionSource: ConnectionSource;
  /** A setup problem to show, such as a key without a model. */
  warning: string | null;
  embeddingModel: string;
  documents: number;
  chunks: number;
  /** Shown in the library so the limits are known before an upload fails. */
  limits: { maxDocuments: number; maxUploadMb: number };
}

export type ProviderName = "gateway" | "openai" | "anthropic" | "google" | "openai-compatible";

/** In the order the settings panel offers them. */
export const PROVIDER_NAMES = ["gateway", "openai", "anthropic", "google", "openai-compatible"] as const satisfies readonly ProviderName[];

/** "app": saved from the settings panel. "env": from .env.local or the environment. */
export type ConnectionSource = "app" | "env" | "none";

/**
 * What the browser may know about the model connection. The key itself is
 * never part of it: only whether one is set and, for a key saved in the app,
 * its last four characters.
 */
export interface ConnectionView {
  source: ConnectionSource;
  provider: ProviderName | null;
  keySet: boolean;
  keyLast4: string | null;
  /** The server address, for the OpenAI-compatible or local choice. */
  baseUrl: string | null;
  model: string;
  models: string[];
  local: boolean;
  changeAllowed: ChangeAllowed;
}

/**
 * Whether this browser may change the connection. "local": the server only
 * accepts connections from this machine. "token": the settings token must be
 * sent with the change. "no": neither applies, so it cannot be changed here.
 */
export type ChangeAllowed = "local" | "token" | "no";

/** What the settings panel sends. An empty key keeps the one already saved for the same provider and address. */
export interface ConnectionInput {
  provider: ProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** More model ids to offer in the picker. */
  models?: string[];
  /** Send one tiny request first and save only if the model answers. */
  test: boolean;
}
