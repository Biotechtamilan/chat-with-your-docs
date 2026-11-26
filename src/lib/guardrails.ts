import type { AppConfig } from "./config";
import { extensionOf, SUPPORTED_EXTENSIONS } from "./ingest/parse";

/**
 * Input-side guardrails. Each check returns a message written for the person
 * using the app, or null when the input is fine.
 */

export function checkQuestion(question: string, config: AppConfig): string | null {
  const trimmed = question.trim();
  if (!trimmed) return "Type a question first.";
  if (trimmed.length > config.maxQuestionChars) {
    return `Questions are limited to ${config.maxQuestionChars} characters. Yours has ${trimmed.length}.`;
  }
  return null;
}

export function checkUpload(file: { name: string; size: number }, config: AppConfig): string | null {
  if (!SUPPORTED_EXTENSIONS.includes(extensionOf(file.name))) {
    return `"${file.name}" is not a supported type. Use ${SUPPORTED_EXTENSIONS.join(", ")}.`;
  }
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > config.maxUploadBytes) {
    const limitMb = Math.round(config.maxUploadBytes / (1024 * 1024));
    return `"${file.name}" is larger than the ${limitMb} MB limit.`;
  }
  return null;
}

/**
 * Document text is untrusted: a file can contain "ignore previous instructions".
 * Sources are wrapped in <source> tags and the system prompt says to treat them
 * as data. This escaping stops a document from closing its own tag early and
 * smuggling text outside the wrapper.
 */
export function escapeForSourceBlock(text: string): string {
  return text.replace(/<(\/?)(source|sources)\b/gi, "&lt;$1$2");
}

/**
 * True when a browser sent this request from a different site.
 *
 * The app has no login, so the risk is a web page in another tab quietly
 * posting to it: uploads and chat messages are "simple" requests that browsers
 * send without asking. Browsers label every request with Sec-Fetch-Site (or
 * Origin on older ones), and a page cannot forge either. Requests without both
 * headers come from non-browser clients such as curl and are allowed.
 */
export function isCrossSiteRequest(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== headers.get("host");
  } catch {
    return true;
  }
}

export const CROSS_SITE_MESSAGE = "This request came from another site and was refused.";

/**
 * True when the request is addressed to a name this app answers to.
 *
 * The cross-site check above cannot see DNS rebinding. A page on evil.example
 * points its own name at 127.0.0.1, and its requests to this app are then
 * same-origin as far as the browser knows, so it could read the documents.
 * Those requests still carry evil.example as the Host header, which this
 * refuses. Ports are ignored. "*" allows any name.
 */
export function isAllowedHost(host: string | null, allowed: readonly string[]): boolean {
  if (allowed.includes("*")) return true;
  if (!host) return false;
  return allowed.includes(host.trim().toLowerCase().replace(/:\d{1,5}$/, ""));
}

export const WRONG_HOST_MESSAGE =
  "This app only answers requests addressed to localhost. To open it under another name, add that name to ALLOWED_HOSTS and restart.";

/**
 * Which bucket a request counts against.
 *
 * The leftmost value of X-Forwarded-For is whatever the caller typed, so
 * keying on it would let anyone mint a fresh allowance per request. By default
 * every request shares one bucket, which fits a single container and still
 * caps spend. Behind your own proxy (TRUST_PROXY=true) the last hop is the one
 * that proxy appended, and it identifies the real client.
 */
export function rateLimitKey(headers: Headers, trustProxy: boolean): string {
  if (!trustProxy) return "all";
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.at(-1) ?? "all";
}

/**
 * Fixed-window limiter held in memory. It protects the API key's budget from a
 * runaway client. It is per process, so behind several instances this belongs
 * in a shared store such as Redis; see the README's production section.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Returns true when the caller is still within its allowance. */
  allow(key: string, now = Date.now()): boolean {
    // Expired windows are dropped once the map grows, so memory stays bounded.
    if (this.windows.size > 10_000) {
      for (const [stale, window] of this.windows) {
        if (now - window.start >= this.windowMs) this.windows.delete(stale);
      }
    }
    const current = this.windows.get(key);
    if (!current || now - current.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}

const limiters = globalThis as typeof globalThis & { __docsLimiters?: Map<string, RateLimiter> };

/**
 * One limiter per kind of work ("chat", "ingest", "health-check", "guide"), so
 * a burst of uploads cannot use up the allowance for questions, and the other
 * way round. Held on globalThis because Next re-evaluates modules in development.
 */
export function limiterFor(bucket: string, limit: number): RateLimiter {
  limiters.__docsLimiters ??= new Map();
  let limiter = limiters.__docsLimiters.get(bucket);
  if (!limiter) {
    limiter = new RateLimiter(limit);
    limiters.__docsLimiters.set(bucket, limiter);
  }
  return limiter;
}
