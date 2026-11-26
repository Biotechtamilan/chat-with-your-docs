import {
  GatewayAuthenticationError,
  GatewayError,
  GatewayModelNotFoundError,
  GatewayRateLimitError,
} from "@ai-sdk/gateway";
import { APICallError, RetryError } from "ai";
import { errorMessage, redactSecret } from "../log";

/**
 * Turns a failed model call into one sentence that tells the person what to do.
 * By default the SDK sends the browser "An error occurred."; this replaces it
 * with something actionable, without ever echoing a key or a raw stack.
 * `secret` is the key saved in the app, if any: a provider can quote the key
 * it was sent, so it is removed from whatever text comes back.
 */
export function describeAiError(error: unknown, secret: string | null = null): string {
  return redactSecret(describe(error), secret);
}

/**
 * Why a connection test failed, as one of a fixed set of sentences.
 *
 * A test sends a request to an address someone typed, so whatever comes back is
 * not ours to repeat: echoing the body would turn the test into a way to read
 * a server the browser cannot reach. Only the status code, a number, is passed on.
 */
export const UNREACHABLE_MESSAGE =
  "The server could not be reached, or did not answer like a model API. Check the address and that the server is running.";

export function describeCheckFailure(error: unknown): string {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const message = errorMessage(cause);
  const name = cause instanceof Error ? cause.name : "";
  const rawStatus = GatewayError.isInstance(cause) || APICallError.isInstance(cause) ? cause.statusCode : undefined;
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) ? rawStatus : undefined;

  if (name === "TimeoutError" || name === "AbortError") return "The server did not answer in time.";
  // The gateway's Token Pass refusals are told apart by their wording; the sentences returned are ours.
  if (/Token Pass credits are used up/i.test(message)) return "The Token Pass credit for this key is used up.";
  if (/scoped to Vercel Token Pass/i.test(message)) return "This key is restricted to Token Pass models.";
  if (/requires an active Vercel Token Pass/i.test(message)) return "This key's team has no active Token Pass.";
  if (
    status === 401 ||
    status === 403 ||
    name === "GatewayAuthenticationError" ||
    GatewayAuthenticationError.isInstance(cause) ||
    message.includes("Unauthenticated request to AI Gateway") ||
    message.startsWith("Unauthenticated.")
  ) {
    return "The provider rejected the API key.";
  }
  if (status === 404 || GatewayModelNotFoundError.isInstance(cause)) return "The provider does not know that model id.";
  if (status === 429 || GatewayRateLimitError.isInstance(cause)) {
    return "The provider is rate limiting requests. Wait a moment and try again.";
  }
  if (status !== undefined) return `The request failed with status ${status}.`;
  // No status means no usable HTTP answer: refused, unresolved, or not a model API.
  return UNREACHABLE_MESSAGE;
}

function describe(error: unknown): string {
  // Retryable failures arrive wrapped once the retries are used up.
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const message = errorMessage(cause);

  // Token Pass problems all come back as HTTP 403; the message says which one.
  if (/Token Pass credits are used up/i.test(message)) {
    return "Your Token Pass credit is used up until the next billing cycle. Switch to a standard AI Gateway key, or wait for the reset.";
  }
  if (/scoped to Vercel Token Pass/i.test(message)) {
    return "This key is restricted to Token Pass models. Pick one of the featured models, or use a standard AI Gateway key.";
  }
  if (/requires an active Vercel Token Pass/i.test(message)) {
    return "This key's team has no active Token Pass. Subscribe, or use a key from the team that has it.";
  }

  // generateText and streamText replace the gateway's authentication error with
  // their own (a plain Error in development, a generic one in production), so
  // the class check alone misses a wrong key. The name and wording catch both.
  const unauthenticated =
    (cause instanceof Error && cause.name === "GatewayAuthenticationError") || /Unauthenticated/.test(message);
  if (GatewayAuthenticationError.isInstance(cause) || unauthenticated) {
    return "The AI Gateway key is missing or invalid. Check the key under Settings, Connection, or AI_GATEWAY_API_KEY in .env.local.";
  }
  if (GatewayRateLimitError.isInstance(cause)) {
    return "The model provider is rate limiting requests. Wait a few seconds and try again.";
  }
  if (GatewayModelNotFoundError.isInstance(cause)) {
    return "That model is not available on the gateway. Pick another model.";
  }
  if (GatewayError.isInstance(cause)) {
    return `The model request failed (${cause.statusCode}). ${message.slice(0, 200)}`;
  }
  // Providers other than the gateway report failures as plain HTTP errors.
  if (APICallError.isInstance(cause)) {
    if (cause.statusCode === 401 || cause.statusCode === 403) {
      return "The provider rejected the API key. Check the key under Settings, Connection, or in .env.local.";
    }
    if (cause.statusCode === 404) {
      return "The provider does not know that model. Check the model id under Settings, Connection, or CHAT_MODEL in .env.local.";
    }
    if (cause.statusCode === 429) return "The provider is rate limiting requests. Wait a few seconds and try again.";
    return `The model request failed (${cause.statusCode ?? "no status"}). ${message.slice(0, 200)}`;
  }
  if (cause instanceof Error && cause.name === "AbortError") return "The request was cancelled.";
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return "The model did not answer in time. Check the address and that the server is running.";
  }
  return `Something went wrong while answering: ${message.slice(0, 200)}`;
}
