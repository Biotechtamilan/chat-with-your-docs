import { createHash, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildConfig, getConfig, type AppConfig } from "../config";
import { CROSS_SITE_MESSAGE, isCrossSiteRequest, limiterFor, rateLimitKey } from "../guardrails";
import { PROVIDER_CHOICES } from "../labels";
import { errorMessage, hideInLogs, log, redactSecret } from "../log";
import { PROVIDER_NAMES, type ChangeAllowed, type ConnectionView, type ProviderName } from "../types";
import { UNREACHABLE_MESSAGE } from "./errors";
import { DEFAULT_CHAT_MODEL, modelInfo } from "./models";
import { checkConnection } from "./provider";

/**
 * The model connection saved from the settings panel.
 *
 * It lives in one file in the data folder and overrides the environment until
 * it is forgotten. The key in it is the one secret this app stores, so three
 * rules hold everywhere below: the key never goes back to the browser, it is
 * never logged, and only the machine the app runs on may change it.
 */

export interface SavedConnection {
  provider: ProviderName;
  /** Null for a local server that needs no key. */
  apiKey: string | null;
  /** Server address. Only the OpenAI-compatible choice has one. */
  baseUrl: string | null;
  model: string;
  /** More model ids to offer in the picker. */
  models: string[];
}

// Input bounds. Real keys are well under 300 characters and real model ids under 100.
const KEY_MAX_CHARS = 400;
const ADDRESS_MAX_CHARS = 500;
const MODEL_ID_MAX_CHARS = 120;
const MAX_EXTRA_MODELS = 20;
/** A key shorter than this would give too much of itself away in four characters. */
const MIN_KEY_CHARS_FOR_HINT = 12;

const FILE_NAME = "connection.json";

// ------------------------------------------------------------------ storage

/** The three file operations the store needs, so tests can run it without a disk. */
export interface ConnectionFiles {
  /** The file's text, or null when it does not exist. */
  read(file: string): string | null;
  /** Writes the file so that only its owner can read it, where the platform supports that. */
  write(file: string, text: string): void;
  remove(file: string): void;
}

const OWNER_ONLY = 0o600;

/** The calls made on the real disk, named so a test can stand in for them. */
export interface Disk {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, text: string, options: { mode: number }): void;
  chmodSync(file: string, mode: number): void;
  renameSync(from: string, to: string): void;
  mkdirSync(folder: string, options: { recursive: true }): unknown;
  rmSync(file: string, options: { force: true }): void;
}

const nodeDisk: Disk = { readFileSync, writeFileSync, chmodSync, renameSync, mkdirSync, rmSync };

export function diskFiles(disk: Disk = nodeDisk): ConnectionFiles {
  return {
    read(file) {
      try {
        return disk.readFileSync(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    write(file, text) {
      disk.mkdirSync(path.dirname(file), { recursive: true });
      // Written beside the target and renamed, so a crash cannot leave half a file.
      const temporary = `${file}.tmp`;
      disk.writeFileSync(temporary, text, { mode: OWNER_ONLY });
      // The mode above applies only when the file is created. Windows ignores both.
      disk.chmodSync(temporary, OWNER_ONLY);
      disk.renameSync(temporary, file);
    },
    remove(file) {
      disk.rmSync(file, { force: true });
    },
  };
}

const savedSchema = z.object({
  provider: z.enum(PROVIDER_NAMES),
  apiKey: z.string().min(1).max(KEY_MAX_CHARS).nullable(),
  baseUrl: z.string().min(1).max(ADDRESS_MAX_CHARS).nullable(),
  model: z.string().min(1).max(MODEL_ID_MAX_CHARS),
  models: z.array(z.string().min(1).max(MODEL_ID_MAX_CHARS)).max(MAX_EXTRA_MODELS),
});

export interface ConnectionStore {
  read(): SavedConnection | null;
  write(connection: SavedConnection): void;
  clear(): void;
}

export function fileStore(file: string, files: ConnectionFiles = diskFiles()): ConnectionStore {
  return {
    read() {
      let text: string | null;
      try {
        text = files.read(file);
      } catch (error) {
        log.warn("connection_file_unreadable", { error: errorMessage(error) });
        return null;
      }
      if (text === null) return null;
      try {
        return savedSchema.parse(JSON.parse(text));
      } catch {
        // The contents are not logged: a damaged file can still hold a key.
        log.warn("connection_file_invalid", { file: FILE_NAME });
        return null;
      }
    },
    write(connection) {
      files.write(file, `${JSON.stringify(connection, null, 2)}\n`);
    },
    clear() {
      files.remove(file);
    },
  };
}

export function memoryStore(): ConnectionStore {
  let held: SavedConnection | null = null;
  return {
    read: () => held,
    write: (connection) => {
      held = connection;
    },
    clear: () => {
      held = null;
    },
  };
}

// On globalThis because Next can load this module once per route: every copy
// must see the same in-memory connection and the same version counter.
const shared = globalThis as typeof globalThis & {
  __docsConnectionMemory?: ConnectionStore;
  __docsConnectionVersion?: number;
};

/** The store for a data folder. ":memory:" (tests) keeps the connection in RAM and writes nothing. */
export function storeFor(dataDir: string): ConnectionStore {
  if (dataDir === ":memory:") return (shared.__docsConnectionMemory ??= memoryStore());
  return fileStore(path.join(path.resolve(dataDir), FILE_NAME));
}

/** Changes whenever a connection is saved or forgotten. getConfig() rebuilds when it does. */
export function connectionVersion(): number {
  return shared.__docsConnectionVersion ?? 0;
}

function changed(): void {
  shared.__docsConnectionVersion = connectionVersion() + 1;
}

export function loadConnection(dataDir: string): SavedConnection | null {
  const saved = storeFor(dataDir).read();
  hideInLogs(saved?.apiKey);
  return saved;
}

export function saveConnection(dataDir: string, connection: SavedConnection): void {
  hideInLogs(connection.apiKey);
  storeFor(dataDir).write(connection);
  changed();
}

/** Removes the saved connection, so the environment decides again. */
export function forgetConnection(dataDir: string): void {
  storeFor(dataDir).clear();
  changed();
}

// --------------------------------------------------------------- public view

/**
 * An address is shown in the panel, so the parts of it that can carry a secret
 * are left out: a login, a query string (some services take the key there) and
 * a fragment. An address that cannot be parsed is not shown at all.
 */
function displayAddress(address: string | null): string | null {
  if (!address) return null;
  try {
    const url = new URL(address);
    // Only a web address has a login, query and fragment where this looks for them.
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.username && !url.password && !url.search && !url.hash) return address;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Everything the browser may know about the connection. The key is never in
 * it. `detailed` is whether this caller could also change the connection: only
 * then does the view carry the server address and the key's last four
 * characters, so a server reachable from other machines does not hand either
 * to any visitor. The rest is what the page needs to draw the model picker,
 * and is on /api/health already.
 */
export function connectionView(config: AppConfig, mayChange: ChangeAllowed, detailed: boolean): ConnectionView {
  const key = config.apiKey;
  return {
    source: config.connectionSource,
    provider: config.provider,
    keySet: config.keySet,
    keyLast4: detailed && key && key.length >= MIN_KEY_CHARS_FOR_HINT ? key.slice(-4) : null,
    baseUrl: detailed ? displayAddress(config.llmBaseUrl) : null,
    model: config.chatModel,
    models: config.allowedChatModels,
    local: config.local,
    changeAllowed: mayChange,
  };
}

// ------------------------------------------------- who may change the connection

/**
 * The app has no login, so changing the key is allowed in exactly two cases:
 * the server only accepts connections from this machine, or the request
 * carries the settings token. Nothing a client sends decides the first case:
 * a Host header says "localhost" as easily as anything else.
 */

/** The value of `--hostname` / `-H` on a Next command line, or undefined when it is not there. */
function hostnameArgument(argv: readonly string[]): string | undefined {
  let found: string | undefined;
  argv.forEach((argument, index) => {
    if (argument === "--hostname" || argument === "-H") found = argv[index + 1] ?? "";
    else if (argument.startsWith("--hostname=")) found = argument.slice("--hostname=".length);
    else if (/^-H./.test(argument)) found = argument.slice(2);
  });
  return found;
}

/**
 * True only when this server is known to listen on 127.0.0.1 and nowhere else.
 *
 * The signal is `__NEXT_PRIVATE_ORIGIN`, which Next sets in the serving process
 * from the address it actually bound. It was observed under `next dev` and
 * `next start` (16.4.6): `--hostname 127.0.0.1` gives `http://127.0.0.1:<port>`;
 * `--hostname 0.0.0.0` and no hostname both give `http://localhost:<port>`;
 * `--hostname ::` (every interface) gives `http://[::1]:<port>`. So only the
 * literal 127.0.0.1 proves a loopback bind: "localhost" and "[::1]" are also
 * what an all-interfaces server reports, and are refused. The command line is
 * a second opinion where it exists (`next start` keeps it; the `next dev`
 * worker does not): a hostname flag that is anything else means not loopback.
 * The HOSTNAME variable is not used: Next does not set it, and on Linux and in
 * containers it is the machine's name.
 *
 * Anything unexpected, including a future Next that drops the variable, gives
 * false, and the settings token is then required.
 */
export function boundToLoopback(argv: readonly string[], env: Record<string, string | undefined>): boolean {
  const flag = hostnameArgument(argv);
  if (flag !== undefined && flag !== "127.0.0.1") return false;
  const origin = env.__NEXT_PRIVATE_ORIGIN;
  if (!origin) return false;
  try {
    return new URL(origin).hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * True when a Host header names this machine: localhost, 127.0.0.1 or [::1],
 * on any port. This is not authorization, because the client writes the
 * header. Its one job is on a loopback-only server, where the remaining risk
 * is a web page in this machine's browser that points its own domain at
 * 127.0.0.1 (DNS rebinding): the browser then sends that domain as Host.
 */
export function isLocalHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.trim().toLowerCase().replace(/:\d{1,5}$/, "");
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

/** What Next writes into X-Forwarded-For itself on a loopback server: the socket's own address. */
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * True when the request shows any sign of having passed through a proxy. Behind
 * a proxy every visitor arrives from the proxy's address, so a loopback bind
 * says nothing about who sent the request.
 *
 * `Forwarded`, `X-Real-IP` and `Via` are only ever written by a proxy, so their
 * presence is enough. The three X-Forwarded-* headers need more care, because
 * Next fills them in on every request that lacks them (base-server.js: host
 * from the Host header, proto from its own listener, for from the socket's
 * address). They therefore count as a proxy's only when they differ from what
 * Next would have written for a direct request to a loopback server.
 */
export function cameThroughProxy(headers: Headers): boolean {
  if (headers.has("forwarded") || headers.has("x-real-ip") || headers.has("via")) return true;
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor !== null && !LOOPBACK_PEERS.has(forwardedFor.trim().toLowerCase())) return true;
  const forwardedHost = headers.get("x-forwarded-host");
  if (forwardedHost !== null && forwardedHost !== headers.get("host")) return true;
  const forwardedProto = headers.get("x-forwarded-proto");
  return forwardedProto !== null && forwardedProto !== "http";
}

/** Compared through digests, so the buffers are always the same length and the time taken says nothing. */
function sameToken(supplied: string, expected: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

export const SETTINGS_TOKEN_HEADER = "x-settings-token";

export interface ChangePolicy {
  loopbackOnly: boolean;
  settingsToken: string | null;
}

/**
 * What the panel should show for this request: free to change, token needed,
 * or not possible. A configured token is always required: "local" exists only
 * when no token is set, the server is loopback-only, no proxy is in sight and
 * the browser used a local name.
 */
export function changeAllowed(headers: Headers, policy: ChangePolicy): ChangeAllowed {
  if (policy.settingsToken) return "token";
  const local = policy.loopbackOnly && !cameThroughProxy(headers) && isLocalHost(headers.get("host"));
  return local ? "local" : "no";
}

export const CHANGE_REFUSED = {
  no:
    "The connection cannot be changed here: this server accepts connections from other machines and no settings token is set. " +
    "Start the app on localhost (npm run dev and npm start do), or set SETTINGS_TOKEN and restart. The connection can also be set in .env.local.",
  rebinding:
    "The connection can only be changed with the app opened at http://localhost or http://127.0.0.1. Open it there, or set the connection in .env.local.",
  proxy:
    "The connection cannot be changed here: a proxy is in front of the app, so a request cannot be shown to come from this machine. " +
    "Set SETTINGS_TOKEN on the server and restart, then enter it in the panel.",
  tokenMissing: "Enter the settings token to change the connection. It is the SETTINGS_TOKEN value the server was started with.",
  tokenWrong: "That settings token is not right. It is the SETTINGS_TOKEN value the server was started with.",
} as const;

/** Null when the request may change the connection, otherwise the sentence to refuse it with. */
export function refusalFor(headers: Headers, policy: ChangePolicy): string | null {
  const mode = changeAllowed(headers, policy);
  if (mode === "local") return null;
  if (mode === "no") {
    if (!policy.loopbackOnly) return CHANGE_REFUSED.no;
    return cameThroughProxy(headers) ? CHANGE_REFUSED.proxy : CHANGE_REFUSED.rebinding;
  }
  const supplied = headers.get(SETTINGS_TOKEN_HEADER);
  if (!supplied) return CHANGE_REFUSED.tokenMissing;
  return policy.settingsToken && sameToken(supplied, policy.settingsToken) ? null : CHANGE_REFUSED.tokenWrong;
}

// ------------------------------------------------------- addresses never called

/** Names cloud platforms give their metadata service. */
const METADATA_NAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.azure.com",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** Metadata services outside the link-local range (Alibaba Cloud, AWS over IPv6), and the "any" addresses. */
const FORBIDDEN_IPV4 = new Set(["100.100.100.200", "0.0.0.0"]);
const FORBIDDEN_IPV6 = new Set(["fd00:ec2::254", "::"]);

/** The IPv4 address inside an IPv4-mapped IPv6 one (::ffff:a.b.c.d or ::ffff:hhhh:hhhh), or null. */
function mappedIpv4(ip: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (!hex) return null;
  const [high, low] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * True for an IP address the server must never be sent to: the link-local
 * ranges (169.254.0.0/16, where cloud machines serve their credentials, and
 * fe80::/10), the metadata addresses outside them, and the "any" addresses.
 * Loopback and private ranges stay allowed, because that is where a local
 * model server lives. Used both for an address as typed and for every address
 * a name resolves to.
 */
export function isForbiddenIp(address: string): boolean {
  // A resolver can return a zone ("fe80::1%eth0"); the URL parser gives the canonical spelling of the rest.
  let ip = address.trim().toLowerCase().replace(/%.*$/, "");
  if (isIP(ip) === 6) {
    try {
      ip = new URL(`http://[${ip}]`).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return true;
    }
    const inner = mappedIpv4(ip);
    if (inner === null) return FORBIDDEN_IPV6.has(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
    ip = inner;
  }
  return FORBIDDEN_IPV4.has(ip) || /^169\.254\.\d{1,3}\.\d{1,3}$/.test(ip);
}

/** The host of an address, lower-cased, without brackets or a trailing dot. Null when it is not a URL. */
function hostOf(address: string): string | null {
  try {
    return new URL(address).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * True when an address as written must be refused: a metadata name or a
 * forbidden IP. The URL parser has already turned decimal and hex spellings of
 * an IPv4 address into dotted form.
 */
export function isForbiddenAddress(address: string): boolean {
  const host = hostOf(address);
  return host === null || METADATA_NAMES.has(host) || isForbiddenIp(host);
}

/** `dns.promises.lookup(host, { all: true })`, passed in so tests need no network. */
export type AddressLookup = (host: string) => Promise<Array<{ address: string }>>;

const systemLookup: AddressLookup = (host) => lookup(host, { all: true });

/**
 * Where a server address actually leads. A harmless-looking public name can
 * resolve to the metadata address, so every address the name resolves to is
 * checked, and one forbidden answer among several is enough to refuse. A
 * literal IP was already checked as written and is not looked up.
 */
export async function resolveAddress(address: string, find: AddressLookup = systemLookup): Promise<"ok" | "forbidden" | "unresolved"> {
  const host = hostOf(address);
  if (host === null || isForbiddenAddress(address)) return "forbidden";
  if (isIP(host) !== 0) return "ok";
  let answers: Array<{ address: string }>;
  try {
    answers = await find(host);
  } catch {
    return "unresolved";
  }
  if (answers.length === 0) return "unresolved";
  return answers.some((answer) => isForbiddenIp(answer.address)) ? "forbidden" : "ok";
}

// ---------------------------------------------------------------- validation

const inputSchema = z.object({
  provider: z.enum(PROVIDER_NAMES),
  apiKey: z.string().trim().max(KEY_MAX_CHARS).optional(),
  baseUrl: z.string().trim().max(ADDRESS_MAX_CHARS).optional(),
  model: z.string().trim().max(MODEL_ID_MAX_CHARS).optional(),
  models: z.array(z.string().trim().min(1).max(MODEL_ID_MAX_CHARS)).max(MAX_EXTRA_MODELS).optional(),
  test: z.boolean().default(true),
});

export type ConnectionRequest = z.infer<typeof inputSchema>;

const FIELD_PROBLEM: Record<string, string> = {
  provider: "Choose a provider from the list.",
  apiKey: `An API key can be at most ${KEY_MAX_CHARS} characters.`,
  baseUrl: `A server address can be at most ${ADDRESS_MAX_CHARS} characters.`,
  model: `A model id can be at most ${MODEL_ID_MAX_CHARS} characters.`,
  models: `List at most ${MAX_EXTRA_MODELS} more model ids, each up to ${MODEL_ID_MAX_CHARS} characters.`,
};

/** The address as typed, minus trailing slashes, or null when it is not a plain http(s) URL. */
function parseAddress(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // The address is shown back in the panel, so it must not be a place to keep a password.
  if (url.username || url.password) return null;
  return text.replace(/\/+$/, "");
}

const FORBIDDEN_ADDRESS_MESSAGE =
  "That address cannot be used. Link-local addresses (169.254.x.x, fe80::), cloud metadata addresses and names that lead to them are refused.";

function addressProblem(text: string): string | null {
  if (!parseAddress(text)) {
    return "Enter the server address as a full http or https URL, for example http://localhost:11434/v1.";
  }
  return isForbiddenAddress(text) ? FORBIDDEN_ADDRESS_MESSAGE : null;
}

export type Candidate = { ok: true; connection: SavedConnection } | { ok: false; error: string };

/**
 * Turns what the panel sent into the connection that would be saved, or says
 * what is wrong with it. An empty key keeps the saved one, but only for the
 * same provider and address: a kept key is never sent somewhere new.
 */
export function candidateFrom(input: ConnectionRequest, existing: SavedConnection | null): Candidate {
  const fail = (error: string): Candidate => ({ ok: false, error });
  const { provider } = input;
  const compatible = provider === "openai-compatible";

  let baseUrl: string | null = null;
  if (compatible) {
    const problem = addressProblem(input.baseUrl ?? "");
    if (problem) return fail(problem);
    baseUrl = parseAddress(input.baseUrl ?? "");
  }

  const typed = input.apiKey ?? "";
  // A key travels in a request header, which cannot carry spaces or non-ASCII text.
  if (typed && !/^[\x21-\x7e]+$/.test(typed)) {
    return fail("That key contains a space or a character a key cannot have. Paste it again.");
  }
  const sameTarget = existing !== null && existing.provider === provider && existing.baseUrl === baseUrl;
  const apiKey = typed || (sameTarget ? existing.apiKey : null);
  if (!apiKey && !compatible) return fail(`Enter an API key for ${PROVIDER_CHOICES[provider]}.`);

  if (provider === "gateway") {
    const model = input.model || DEFAULT_CHAT_MODEL;
    // Application code only ever calls gateway models from the app's own list.
    if (!modelInfo(model)) return fail("Choose one of the listed gateway models.");
    return { ok: true, connection: { provider, apiKey, baseUrl, model, models: [] } };
  }

  const model = input.model ?? "";
  if (!model) return fail("Enter the model id to use, as your provider or local server names it.");
  const models = [...new Set(input.models ?? [])].filter((id) => id !== model);
  return { ok: true, connection: { provider, apiKey, baseUrl, model, models } };
}

// ------------------------------------------------------------------ handlers

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (status: number, error: string) => Response.json({ error }, { status, headers: NO_STORE });
/** The answer to a save or forget. Those are reached only once the change was authorized, so the details are included. */
const reply = (config: AppConfig, request: Request, extra: Record<string, unknown> = {}) =>
  Response.json({ connection: connectionView(config, changeAllowed(request.headers, config), true), ...extra }, { headers: NO_STORE });

/**
 * Not rate limited, because the page loads it, so it must not answer anything
 * a guess could learn from. The details go only to a local caller on a
 * loopback server, which the change rule already lets through with no secret.
 * A settings token is ignored here: honouring it would let anyone test guesses
 * at it without limit. A token holder sees the details in the reply to a save
 * or forget, which is rate limited.
 */
export function handleGetConnection(request: Request): Response {
  const config = getConfig();
  const mode = changeAllowed(request.headers, config);
  return Response.json({ connection: connectionView(config, mode, mode === "local") }, { headers: NO_STORE });
}

export interface ConnectionDeps {
  /** Tests inject the check; production sends one tiny request to the model. */
  check?: typeof checkConnection;
  /** Tests inject the name lookup; production asks the system resolver. */
  lookup?: AddressLookup;
}

/**
 * The checks every change passes, in this order: other sites, then the rate
 * limit, then who is asking. The limit comes before authorization on purpose,
 * so a refused attempt uses up allowance and a token cannot be guessed at
 * speed. Returns the refusal, or null to carry on.
 */
function gate(request: Request, config: AppConfig): Response | null {
  if (isCrossSiteRequest(request.headers)) return refuse(403, CROSS_SITE_MESSAGE);
  const limiter = limiterFor("connection", config.connectionRateLimitPerMinute);
  if (!limiter.allow(rateLimitKey(request.headers, config.trustProxy))) {
    return refuse(429, "Too many connection changes in one minute. Wait a moment and try again.");
  }
  const refusal = refusalFor(request.headers, config);
  return refusal ? refuse(403, refusal) : null;
}

/**
 * Saves a connection, after testing it unless asked not to. A connection that
 * fails its test is not saved, so the app never swaps a working model for a
 * broken one.
 */
export async function handleSaveConnection(request: Request, deps: ConnectionDeps = {}): Promise<Response> {
  const config = getConfig();
  const refused = gate(request, config);
  if (refused) return refused;
  if (config.mock) return refuse(409, "The app is running with AI_MODE=mock, which replaces the model with a fake. No connection can be used.");

  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    return refuse(400, FIELD_PROBLEM[field] ?? "That is not a valid connection.");
  }
  const candidate = candidateFrom(parsed.data, loadConnection(config.dataDir));
  if (!candidate.ok) return refuse(400, candidate.error);
  const { connection } = candidate;
  // Before the test runs, so a failure that quotes the key cannot reach a log line.
  hideInLogs(connection.apiKey);
  const facts = { provider: connection.provider, model: connection.model, hasKey: connection.apiKey !== null };

  if (connection.baseUrl) {
    const leadsTo = await resolveAddress(connection.baseUrl, deps.lookup);
    if (leadsTo === "forbidden") return refuse(400, FORBIDDEN_ADDRESS_MESSAGE);
    // A name that does not resolve cannot be tested. Saved untested it is allowed: a local server may simply be off.
    if (leadsTo === "unresolved" && parsed.data.test) {
      log.info("connection_test_failed", { ...facts, ms: 0 });
      return refuse(422, `Nothing was saved. ${UNREACHABLE_MESSAGE}`);
    }
  }

  if (parsed.data.test) {
    const trial = buildConfig(process.env, () => connection);
    const result = await (deps.check ?? checkConnection)(trial);
    if (!result.ok) {
      log.info("connection_test_failed", { ...facts, ms: result.ms });
      return refuse(422, `Nothing was saved. ${redactSecret(result.message, connection.apiKey)}`);
    }
  }

  try {
    saveConnection(config.dataDir, connection);
  } catch (error) {
    log.error("connection_save_failed", { ...facts, error: errorMessage(error) });
    return refuse(500, "The connection could not be written to the data folder. Check that the folder is writable.");
  }
  log.info("connection_saved", { ...facts, tested: parsed.data.test });
  return reply(getConfig(), request, { tested: parsed.data.test });
}

/** Forgets the saved connection. Whatever the environment provides applies again. */
export function handleForgetConnection(request: Request): Response {
  const config = getConfig();
  const refused = gate(request, config);
  if (refused) return refused;
  try {
    forgetConnection(config.dataDir);
  } catch (error) {
    log.error("connection_forget_failed", { error: errorMessage(error) });
    return refuse(500, "The saved connection could not be removed from the data folder.");
  }
  log.info("connection_forgotten");
  return reply(getConfig(), request);
}
