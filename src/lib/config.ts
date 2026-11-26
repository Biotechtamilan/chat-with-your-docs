import { z } from "zod";
import { boundToLoopback, connectionVersion, loadConnection, type SavedConnection } from "./ai/connection";
import { isLocalModel } from "./ai/local";
import { DEFAULT_CHAT_MODEL, FEATURED_MODELS } from "./ai/models";
import { hideInLogs } from "./log";
import type { ConnectionSource, ProviderName } from "./types";

export type { ProviderName } from "./types";

/**
 * Every tunable lives here, read once from the environment and validated.
 * A bad value fails at startup with a readable message instead of surfacing
 * later as a confusing retrieval or database error.
 *
 * The one thing that is not an environment variable is the model connection
 * saved from the settings panel: it is merged over the environment below.
 */
/** Short enough to type, long enough that guessing it is not an attack. */
const SETTINGS_TOKEN_MIN_CHARS = 24;
/** This machine only, which is all a localhost server needs. */
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** "localhost:3000, Docs.Example" becomes ["localhost", "docs.example"]; an empty list falls back to the default. */
export function parseAllowedHosts(value: string): string[] {
  const names = value
    .split(",")
    .map((name) => name.trim().toLowerCase().replace(/:\d{1,5}$/, ""))
    .filter(Boolean);
  return names.length > 0 ? names : DEFAULT_ALLOWED_HOSTS;
}

const schema = z.object({
  // One of these credentials connects a chat model. See detectProvider below.
  AI_GATEWAY_API_KEY: z.string().trim().optional(),
  VERCEL_OIDC_TOKEN: z.string().trim().optional(),
  OPENAI_API_KEY: z.string().trim().optional(),
  ANTHROPIC_API_KEY: z.string().trim().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().trim().optional(),
  /** Any server that speaks the OpenAI chat API: OpenRouter, Groq, Together, Ollama and others. */
  LLM_BASE_URL: z.string().trim().optional(),
  LLM_API_KEY: z.string().trim().optional(),
  /** Forces a provider when several keys are set. */
  LLM_PROVIDER: z.enum(["gateway", "openai", "anthropic", "google", "openai-compatible"]).optional(),

  /** "mock" replaces both the embedder and the model with deterministic fakes (tests, CI). */
  AI_MODE: z.enum(["live", "mock"]).default("live"),

  /** Required for every provider except the gateway, which has a default. */
  CHAT_MODEL: z.string().trim().optional(),
  /** Comma-separated model ids the browser is allowed to pick. */
  CHAT_MODELS: z.string().trim().optional(),
  /**
   * "none" switches the model's reasoning phase off. Reporting what six passages
   * say needs none, and with it on the default model sometimes spent its whole
   * output budget thinking and returned no text. "default" leaves the provider's
   * own behaviour, for models that reject the setting.
   */
  REASONING: z.enum(["none", "default"]).optional(),

  /** A Hugging Face model id run locally through ONNX. No API call, no cost. */
  EMBEDDING_MODEL: z.string().default("Xenova/bge-small-en-v1.5"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(8).max(4096).default(384),
  /** bge models expect this instruction in front of search queries (not documents). */
  EMBEDDING_QUERY_PREFIX: z.string().default("Represent this sentence for searching relevant passages: "),

  /** Folder for the embedded database and model cache. ":memory:" keeps the database in RAM (tests). */
  DATA_DIR: z.string().default(".data"),

  // The embedding model reads at most 512 word pieces, so chunks stay well under that.
  CHUNK_TARGET_TOKENS: z.coerce.number().int().min(50).default(280),
  CHUNK_MAX_TOKENS: z.coerce.number().int().min(80).default(400),
  CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).default(50),

  /** How many candidates each search leg contributes before fusion. */
  CANDIDATES_PER_LEG: z.coerce.number().int().min(1).default(20),
  /** How many fused chunks are shown to the model. */
  TOP_K: z.coerce.number().int().min(1).max(20).default(6),
  /** Below this best cosine similarity, and with no keyword hit, the app refuses instead of answering. */
  MIN_SIMILARITY: z.coerce.number().min(-1).max(1).default(0.5),

  HISTORY_TURNS: z.coerce.number().int().min(0).default(6),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).default(1200),
  MAX_QUESTION_CHARS: z.coerce.number().int().min(10).default(2000),
  MAX_UPLOAD_MB: z.coerce.number().min(1).default(15),
  MAX_DOCUMENTS: z.coerce.number().int().min(1).default(50),
  /** Scanned pages are read by the model one at a time, which costs tokens, so they are capped per file. */
  OCR_MAX_PAGES: z.coerce.number().int().min(0).default(20),
  /** Scanned pages are rendered to an image first. Larger pages are rendered at a lower scale to stay under this. */
  OCR_MAX_PAGE_PIXELS: z.coerce.number().int().min(250_000).default(16_000_000),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  /** Uploads have their own budget: indexing is CPU work and a scan costs model calls. */
  INGEST_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  /** "Check connection" sends a real model request each time, so it gets a small budget. */
  HEALTH_CHECK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(6),
  /** Saving a connection from the settings panel can test it with a real model request. */
  CONNECTION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(6),
  /**
   * The app has no login. When the server accepts connections from other
   * machines (Docker, --hostname 0.0.0.0), the connection can only be changed by
   * a request that carries this token. Empty means not set.
   */
  SETTINGS_TOKEN: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined)
    .pipe(z.string().min(SETTINGS_TOKEN_MIN_CHARS, `must be at least ${SETTINGS_TOKEN_MIN_CHARS} characters`).optional()),
  /** How much text from the opening passages of the selected sources the source guide may read. */
  GUIDE_INPUT_CHARS: z.coerce.number().int().min(500).max(60_000).default(12_000),
  MAX_NOTES: z.coerce.number().int().min(1).default(500),
  /** Set to "true" only when the app sits behind a proxy you control that appends X-Forwarded-For. */
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  /**
   * Host names the API answers to, comma separated, any port. A web page that
   * points its own domain at this machine (DNS rebinding) is same-origin to the
   * browser, so only the Host header gives it away. "*" turns the check off,
   * for a deployment behind your own proxy and login.
   */
  ALLOWED_HOSTS: z.string().trim().default(DEFAULT_ALLOWED_HOSTS.join(",")),
});

type Env = z.infer<typeof schema>;

/** "gateway" here means "a chat model is connected"; "offline" means answers are quoted passages. */
export type ChatMode = "gateway" | "offline";

export interface AppConfig {
  chatMode: ChatMode;
  /** Which service answers. Null in offline and mock modes. */
  provider: ProviderName | null;
  /** The provider's name as shown to people, e.g. "Vercel AI Gateway". Null when no model is connected. */
  providerLabel: string | null;
  /** True when the model runs on this machine or private network, so nothing sent to it leaves. */
  local: boolean;
  /** Where the connection came from: the settings panel, the environment, or nowhere. */
  connectionSource: ConnectionSource;
  /**
   * The key saved in the app, handed to the provider explicitly. Null when the
   * connection comes from the environment, where each provider reads its own
   * variable. Never log this object or send it to the browser.
   */
  apiKey: string | null;
  /** True when the active connection has a key, wherever it came from. */
  keySet: boolean;
  /** A setup problem worth showing in the interface, such as a key without a model. */
  warning: string | null;
  /** True when both the embedder and the model are deterministic fakes. */
  mock: boolean;
  chatModel: string;
  allowedChatModels: string[];
  reasoning: "none" | "default";
  /** Base address for the generic OpenAI-compatible provider. */
  llmBaseUrl: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingQueryPrefix: string;
  dataDir: string;
  chunk: { targetTokens: number; maxTokens: number; overlapTokens: number };
  retrieval: { candidatesPerLeg: number; topK: number; minSimilarity: number };
  historyTurns: number;
  maxOutputTokens: number;
  maxQuestionChars: number;
  maxUploadBytes: number;
  maxDocuments: number;
  ocrMaxPages: number;
  ocrMaxPagePixels: number;
  rateLimitPerMinute: number;
  ingestRateLimitPerMinute: number;
  healthCheckRateLimitPerMinute: number;
  connectionRateLimitPerMinute: number;
  /**
   * True when the server listens on 127.0.0.1 only, so every request comes from
   * a program on this machine. Decided from how the server was started, never
   * from a request.
   */
  loopbackOnly: boolean;
  /** Lets a request change the connection when the server is not loopback-only. Never log or return it. */
  settingsToken: string | null;
  guideInputChars: number;
  maxNotes: number;
  trustProxy: boolean;
  /** Host names the API answers to, without ports. "*" allows any. */
  allowedHosts: string[];
}

/** Name recorded for the fake embedder, so its vectors never share an index with real ones. */
export const MOCK_EMBEDDING_MODEL = "mock/hash-bow-v1";

const PROVIDER_LABEL: Record<ProviderName, string> = {
  gateway: "Vercel AI Gateway",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "openai-compatible": "the OpenAI-compatible endpoint",
};

/**
 * Picks the provider from whichever credential is present. The gateway comes
 * first because it is the tested default; LLM_PROVIDER overrides the order.
 */
export function detectProvider(env: Env): ProviderName | null {
  const available: Record<ProviderName, boolean> = {
    gateway: Boolean(env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN),
    openai: Boolean(env.OPENAI_API_KEY),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    google: Boolean(env.GOOGLE_GENERATIVE_AI_API_KEY),
    "openai-compatible": Boolean(env.LLM_BASE_URL),
  };
  if (env.LLM_PROVIDER) return available[env.LLM_PROVIDER] ? env.LLM_PROVIDER : null;
  const order: ProviderName[] = ["gateway", "openai", "anthropic", "google", "openai-compatible"];
  return order.find((name) => available[name]) ?? null;
}

/** The part of the configuration that says which model answers and how it is reached. */
interface Connection {
  provider: ProviderName | null;
  source: ConnectionSource;
  apiKey: string | null;
  keySet: boolean;
  baseUrl: string | null;
  chatModel: string;
  allowedChatModels: string[];
  warning: string | null;
}

const ENV_KEY: Record<ProviderName, (env: Env) => string | undefined> = {
  gateway: (env) => env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN,
  openai: (env) => env.OPENAI_API_KEY,
  anthropic: (env) => env.ANTHROPIC_API_KEY,
  google: (env) => env.GOOGLE_GENERATIVE_AI_API_KEY,
  "openai-compatible": (env) => env.LLM_API_KEY,
};

function connectionFromEnv(env: Env, mock: boolean): Connection {
  let provider = mock ? null : detectProvider(env);
  let warning: string | null = null;

  if (!mock && env.LLM_PROVIDER && !provider) {
    warning = `LLM_PROVIDER is set to "${env.LLM_PROVIDER}" but its key or address is missing. Running without a model.`;
  }
  // Only the gateway has a tested default model. Guessing one for another
  // provider would fail on the first question with a confusing error.
  if (provider && provider !== "gateway" && !env.CHAT_MODEL) {
    warning = `A key for ${PROVIDER_LABEL[provider]} is set, but CHAT_MODEL is not. Set CHAT_MODEL to a model your key can use, then restart.`;
    provider = null;
  }

  const chatModel = env.CHAT_MODEL || DEFAULT_CHAT_MODEL;
  const listed = (env.CHAT_MODELS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const defaults = provider === "gateway" || !provider ? FEATURED_MODELS.map((model) => model.id) : [];
  const allowed = listed.length > 0 ? listed : defaults;

  return {
    provider,
    source: provider ? "env" : "none",
    apiKey: null,
    keySet: provider ? Boolean(ENV_KEY[provider](env)) : false,
    baseUrl: env.LLM_BASE_URL || null,
    chatModel,
    // The default is always selectable, even if someone trims the list.
    allowedChatModels: allowed.includes(chatModel) ? allowed : [chatModel, ...allowed],
    warning,
  };
}

/** A connection saved in the app replaces the environment's whole connection, not single fields of it. */
function connectionFromApp(saved: SavedConnection): Connection {
  const gateway = saved.provider === "gateway";
  const offered = gateway ? FEATURED_MODELS.map((model) => model.id) : saved.models;
  return {
    provider: saved.provider,
    source: "app",
    apiKey: saved.apiKey,
    keySet: saved.apiKey !== null,
    baseUrl: saved.provider === "openai-compatible" ? saved.baseUrl : null,
    chatModel: saved.model,
    allowedChatModels: [...new Set([saved.model, ...offered])],
    warning: null,
  };
}

/**
 * Builds the configuration from an environment and, when there is one, the
 * connection saved in the app. Pure, so precedence is tested without a disk.
 */
export function buildConfig(
  rawEnv: Record<string, string | undefined>,
  loadSaved: (dataDir: string) => SavedConnection | null = () => null,
  argv: readonly string[] = [],
): AppConfig {
  const parsed = schema.safeParse(rawEnv);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  const env = parsed.data;
  if (env.CHUNK_MAX_TOKENS < env.CHUNK_TARGET_TOKENS) {
    throw new Error("CHUNK_MAX_TOKENS must be greater than or equal to CHUNK_TARGET_TOKENS");
  }

  const mock = env.AI_MODE === "mock";
  // Mock mode fakes the model, so no connection applies, saved or not.
  const saved = mock ? null : loadSaved(env.DATA_DIR);
  const connection = saved ? connectionFromApp(saved) : connectionFromEnv(env, mock);
  const { provider, chatModel } = connection;

  return {
    chatMode: provider ? "gateway" : "offline",
    provider,
    providerLabel: provider ? PROVIDER_LABEL[provider] : null,
    local: isLocalModel(provider, connection.baseUrl),
    connectionSource: connection.source,
    apiKey: connection.apiKey,
    keySet: connection.keySet,
    warning: connection.warning,
    mock,
    chatModel,
    allowedChatModels: connection.allowedChatModels,
    reasoning: env.REASONING ?? (provider === "gateway" || !provider ? "none" : "default"),
    llmBaseUrl: connection.baseUrl,
    embeddingModel: mock ? MOCK_EMBEDDING_MODEL : env.EMBEDDING_MODEL,
    embeddingDimensions: env.EMBEDDING_DIMENSIONS,
    embeddingQueryPrefix: env.EMBEDDING_QUERY_PREFIX,
    dataDir: env.DATA_DIR,
    chunk: {
      targetTokens: env.CHUNK_TARGET_TOKENS,
      maxTokens: env.CHUNK_MAX_TOKENS,
      overlapTokens: env.CHUNK_OVERLAP_TOKENS,
    },
    retrieval: {
      candidatesPerLeg: env.CANDIDATES_PER_LEG,
      topK: env.TOP_K,
      minSimilarity: env.MIN_SIMILARITY,
    },
    historyTurns: env.HISTORY_TURNS,
    maxOutputTokens: env.MAX_OUTPUT_TOKENS,
    maxQuestionChars: env.MAX_QUESTION_CHARS,
    maxUploadBytes: Math.floor(env.MAX_UPLOAD_MB * 1024 * 1024),
    maxDocuments: env.MAX_DOCUMENTS,
    ocrMaxPages: env.OCR_MAX_PAGES,
    ocrMaxPagePixels: env.OCR_MAX_PAGE_PIXELS,
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    ingestRateLimitPerMinute: env.INGEST_RATE_LIMIT_PER_MINUTE,
    healthCheckRateLimitPerMinute: env.HEALTH_CHECK_RATE_LIMIT_PER_MINUTE,
    connectionRateLimitPerMinute: env.CONNECTION_RATE_LIMIT_PER_MINUTE,
    loopbackOnly: boundToLoopback(argv, rawEnv),
    settingsToken: env.SETTINGS_TOKEN ?? null,
    guideInputChars: env.GUIDE_INPUT_CHARS,
    maxNotes: env.MAX_NOTES,
    trustProxy: env.TRUST_PROXY === "true",
    allowedHosts: parseAllowedHosts(env.ALLOWED_HOSTS),
  };
}

let cached: { config: AppConfig; version: number } | undefined;

/**
 * The configuration for this process. It is rebuilt when a connection is saved
 * or forgotten: the version lives on globalThis, so every copy of this module
 * that Next loads sees the change on its next request, with no restart.
 */
export function getConfig(): AppConfig {
  const version = connectionVersion();
  if (cached?.version === version) return cached.config;
  cached = { config: buildConfig(process.env, loadConnection, process.argv), version };
  hideInLogs(cached.config.settingsToken);
  return cached.config;
}

/** Tests change the environment between cases; this drops the cached copy. */
export function resetConfigForTests(): void {
  cached = undefined;
}
