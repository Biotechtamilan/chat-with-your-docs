/**
 * One JSON object per line on stdout. That is the format every log collector
 * (CloudWatch, Cloud Logging, Datadog) parses without configuration, and it
 * keeps a request id attached to each event so one question can be followed
 * across stages.
 */
type Level = "info" | "warn" | "error";

/** On globalThis because Next can load this module more than once and every copy must hide the same keys. */
const holder = globalThis as typeof globalThis & { __docsLogSecrets?: string[] };
const MAX_HIDDEN = 32;

/**
 * Registers a key so that no log line can contain it. Callers never put a key
 * in a log field; this covers the case they cannot control, a provider quoting
 * the key back in an error message that then gets logged.
 */
export function hideInLogs(secret: string | null | undefined): void {
  if (!secret) return;
  const hidden = (holder.__docsLogSecrets ??= []);
  if (hidden.includes(secret)) return;
  hidden.push(secret);
  if (hidden.length > MAX_HIDDEN) hidden.shift();
}

/** Removes a key from text that is about to be shown, stored or logged. */
export function redactSecret(text: string, secret: string | null | undefined): string {
  return secret ? text.split(secret).join("[key hidden]") : text;
}

function write(level: Level, event: string, fields: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "test" && !process.env.LOG_IN_TESTS) return;
  let line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  for (const secret of holder.__docsLogSecrets ?? []) line = redactSecret(line, secret);
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: Record<string, unknown> = {}) => write("info", event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => write("warn", event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => write("error", event, fields),
};

/** Reduces any thrown value to a short string that is safe to log or show. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}
