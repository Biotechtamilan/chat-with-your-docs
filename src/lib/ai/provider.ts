import { createGateway, generateText, type LanguageModel } from "ai";
import { getConfig, type AppConfig } from "../config";
import { CROSS_SITE_MESSAGE, isCrossSiteRequest, limiterFor, rateLimitKey } from "../guardrails";
import { describeCheckFailure } from "./errors";

/**
 * Turns a model id into something the AI SDK can call, for whichever provider
 * is connected.
 *
 * The gateway is the default and the path that is tested end to end. The
 * others exist so the app runs for someone who holds a different key. Each
 * provider package is imported only when used.
 *
 * Where the key comes from depends on the connection's source. From the
 * environment, each provider reads its own variable (OPENAI_API_KEY and so
 * on) and no key passes through this code. Saved in the app, the key is handed
 * to the provider explicitly and is never written into process.env, so
 * forgetting the connection leaves nothing behind.
 */
export async function resolveChatModel(config: AppConfig, modelId: string): Promise<LanguageModel> {
  const fromApp = config.connectionSource === "app";
  const appKey = fromApp ? (config.apiKey ?? undefined) : undefined;

  switch (config.provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey: appKey, baseURL: process.env.OPENAI_BASE_URL || undefined })(modelId);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey: appKey, baseURL: process.env.ANTHROPIC_BASE_URL || undefined })(modelId);
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey: appKey })(modelId);
    }
    case "openai-compatible": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({
        name: "openai-compatible",
        baseURL: config.llmBaseUrl ?? "",
        // A local server saved without a key gets none, not the one in the environment.
        apiKey: fromApp ? appKey : process.env.LLM_API_KEY || undefined,
        fetch: fetchWithoutRedirects,
      })(modelId);
    }
    case "gateway":
      // From the environment the gateway resolves plain ids itself.
      return fromApp ? createGateway({ apiKey: appKey })(modelId) : modelId;
    default:
      return modelId;
  }
}

/**
 * The fetch given to the OpenAI-compatible provider, whose address someone
 * typed. A redirect is treated as a failure: every request carries the key and
 * the passages, and the server at that address must not be able to bounce
 * them to another one, or to an address the app refuses to call directly.
 */
export const fetchWithoutRedirects: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" });

/** Call settings shared by every model request. */
export function callSettings(config: AppConfig): { reasoning?: "none" } {
  return config.reasoning === "none" ? { reasoning: "none" } : {};
}

export interface ConnectionCheck {
  ok: boolean;
  provider: string | null;
  model: string;
  ms: number;
  message: string;
}

/**
 * One tiny real request, so a wrong key or model id is found from a button in
 * the interface and not from the first question failing.
 */
export async function handleConnectionCheck(
  request: Request,
  deps: { check?: typeof checkConnection } = {},
): Promise<Response> {
  if (isCrossSiteRequest(request.headers)) return Response.json({ error: CROSS_SITE_MESSAGE }, { status: 403 });
  const config = getConfig();
  // Each check is a real model request, so it has its own small allowance.
  const limiter = limiterFor("health-check", config.healthCheckRateLimitPerMinute);
  if (!limiter.allow(rateLimitKey(request.headers, config.trustProxy))) {
    return Response.json({ error: "Too many connection checks in one minute. Wait a moment and try again." }, { status: 429 });
  }
  const body = (await request.json().catch(() => null)) as { model?: unknown } | null;
  const requested = typeof body?.model === "string" ? body.model : config.chatModel;
  const model = config.allowedChatModels.includes(requested) ? requested : config.chatModel;
  return Response.json(await (deps.check ?? checkConnection)(config, model));
}

/** A server that never answers must not leave the settings panel waiting forever. */
const CHECK_TIMEOUT_MS = 30_000;

/**
 * `config` need not be the active one: "Test and save" passes the settings it
 * is about to save, so a connection is tried before anything is written.
 */
export async function checkConnection(config: AppConfig, modelId = config.chatModel): Promise<ConnectionCheck> {
  const started = performance.now();
  const done = (ok: boolean, message: string): ConnectionCheck => ({
    ok,
    provider: config.provider,
    model: modelId,
    ms: Math.round(performance.now() - started),
    message,
  });

  if (!config.provider) {
    return done(false, config.warning ?? "No model is connected. Connect one under Settings, Connection, or add a key to .env.local.");
  }
  try {
    const result = await generateText({
      model: await resolveChatModel(config, modelId),
      prompt: "Reply with the single word: ready",
      maxOutputTokens: 200,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      ...callSettings(config),
    });
    return result.text.trim()
      ? done(true, "The model answered.")
      : done(false, "The model returned no text. Try another model, or set REASONING=default.");
  } catch (error) {
    return done(false, describeCheckFailure(error));
  }
}
