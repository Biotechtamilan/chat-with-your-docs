import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { z } from "zod";
import { getEmbedder } from "../ai/embedder";
import { describeAiError } from "../ai/errors";
import { estimateCostUsd } from "../ai/models";
import { callSettings, resolveChatModel } from "../ai/provider";
import type { ChatUIMessage } from "../chat-types";
import { getConfig, type AppConfig } from "../config";
import { checkQuestion, CROSS_SITE_MESSAGE, isCrossSiteRequest, limiterFor, rateLimitKey } from "../guardrails";
import { errorMessage, log } from "../log";
import { isAnswerable, retrieve } from "../retrieval/retrieve";
import { countIndex, saveTrace } from "../retrieval/store";
import { TraceRecorder } from "../trace";
import type { SourceRef, TraceData } from "../types";
import { analyzeCitations } from "./citations";
import {
  buildCondenseInput,
  buildUserMessage,
  CONDENSE_SYSTEM_PROMPT,
  NO_CONTEXT_ANSWER,
  NO_DOCUMENTS_ANSWER,
  SYSTEM_PROMPT,
  type Turn,
} from "./prompts";

/** Earlier turns are context, not evidence, so each one is capped. */
const HISTORY_TEXT_LIMIT = 2000;

const requestSchema = z.object({
  messages: z
    .array(z.looseObject({ role: z.enum(["user", "assistant", "system"]), parts: z.array(z.looseObject({ type: z.string() })) }))
    .min(1)
    .max(200),
  documentIds: z.array(z.string().min(1)).max(200).optional(),
  model: z.string().min(1).max(120).optional(),
});

export interface ChatDeps {
  /** Tests inject a scripted model here; production resolves the id through the gateway. */
  languageModel?: LanguageModel;
}

/** Chat errors are plain text so the browser can show the body as the message. */
const fail = (status: number, message: string) =>
  new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

function toTurns(messages: z.infer<typeof requestSchema>["messages"]): Turn[] {
  return messages.flatMap((message) => {
    if (message.role === "system") return [];
    const text = message.parts
      .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
    return text ? [{ role: message.role, text }] : [];
  });
}

/**
 * Follow-ups like "and for contractors?" are useless as search queries.
 * One short model call rewrites them into a standalone query. The rewrite is
 * used for search only; the model still sees the real conversation. Any
 * failure falls back to the question as typed.
 */
async function condenseQuestion(
  model: LanguageModel,
  history: Turn[],
  question: string,
  abortSignal: AbortSignal,
  config: AppConfig,
): Promise<string> {
  try {
    const { text } = await generateText({
      model,
      instructions: CONDENSE_SYSTEM_PROMPT,
      prompt: buildCondenseInput(history, question),
      maxOutputTokens: 400,
      temperature: 0,
      abortSignal,
      ...callSettings(config),
    });
    const query = text.trim().replace(/^["']|["']$/g, "");
    return query.length >= 3 && query.length <= 400 ? query : question;
  } catch (error) {
    // A cancelled request must stop here, not carry on into search.
    if (abortSignal.aborted) throw error;
    log.warn("query_rewrite_failed", { error: errorMessage(error) });
    return question;
  }
}

/** With no model connected, the honest answer is the evidence itself. */
export function extractiveAnswer(sources: SourceRef[]): string {
  const quotes = sources.slice(0, 3).map((source) => {
    const flat = source.content.replace(/\s+/g, " ").trim();
    const excerpt = flat.length > 360 ? `${flat.slice(0, 360).trimEnd()}…` : flat;
    return `> ${excerpt} [${source.n}]`;
  });
  return `No model is connected, so these are the closest passages, quoted as written rather than summarised.\n\n${quotes.join("\n\n")}`;
}

/** The gateway reports which upstream provider served the call, e.g. "token-pass". */
function resolvedProvider(providerMetadata: unknown): string | null {
  const routing = (providerMetadata as { gateway?: { routing?: { resolvedProvider?: unknown } } } | undefined)?.gateway
    ?.routing;
  return typeof routing?.resolvedProvider === "string" ? routing.resolvedProvider : null;
}

/**
 * One question, start to finish:
 * validate -> (rewrite follow-up) -> hybrid search -> relevance gate -> stream answer -> check citations -> save trace.
 *
 * The response is a single stream that carries the retrieved passages first,
 * then the answer text, then the final trace.
 */
export async function handleChat(request: Request, deps: ChatDeps = {}): Promise<Response> {
  if (isCrossSiteRequest(request.headers)) return fail(403, CROSS_SITE_MESSAGE);
  const config = getConfig();

  if (!limiterFor("chat", config.rateLimitPerMinute).allow(rateLimitKey(request.headers, config.trustProxy))) {
    return fail(429, "Too many questions in one minute. Wait a moment and try again.");
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(400, "That is not a valid chat request.");
  const body = parsed.data;
  // An empty list means every document was unticked. It must not fall back to "search everything".
  if (body.documentIds?.length === 0) return fail(400, "Select at least one document to search.");

  const turns = toTurns(body.messages);
  const last = turns.at(-1);
  if (!last || last.role !== "user") return fail(400, "Type a question first.");
  const question = last.text;
  const problem = checkQuestion(question, config);
  if (problem) return fail(400, problem);

  // The browser may only pick from the configured list: it cannot make the
  // server call an arbitrary (and arbitrarily expensive) model.
  const modelId = body.model ?? config.chatModel;
  if (!config.allowedChatModels.includes(modelId)) {
    return fail(400, `"${modelId}" is not one of the models this app offers.`);
  }

  const useModel = deps.languageModel !== undefined || config.chatMode === "gateway";
  const model: LanguageModel = deps.languageModel ?? (await resolveChatModel(config, modelId));
  const history = turns
    .slice(0, -1)
    .slice(-config.historyTurns * 2)
    .map((turn) => ({ ...turn, text: turn.text.slice(0, HISTORY_TEXT_LIMIT) }));

  const trace = new TraceRecorder();
  const base = {
    mode: useModel ? ("gateway" as const) : ("offline" as const),
    model: modelId,
    provider: null,
    question,
    searchQuery: question,
    bestSimilarity: null,
    retrievedCount: 0,
    usage: null,
    costUsd: null,
    citations: null,
  };

  const stream = createUIMessageStream<ChatUIMessage>({
    originalMessages: body.messages as unknown as ChatUIMessage[],
    onError: (error) => describeAiError(error, config.apiKey),
    execute: async ({ writer }) => {
      writer.write({ type: "start" });

      /** Sends the final trace to the browser, stores it, and logs one line. */
      const finish = async (fields: Partial<TraceData> & Pick<TraceData, "outcome">) => {
        const data = trace.snapshot({ ...base, ...fields, complete: true });
        try {
          writer.write({ type: "data-trace", id: "trace", data });
        } catch {
          // The browser has gone (stopped or closed). The trace is still stored and logged below.
        }
        await saveTrace(data).catch((error) => log.error("trace_save_failed", { error: errorMessage(error) }));
        log.info("answer", {
          traceId: data.id,
          outcome: data.outcome,
          model: data.model,
          provider: data.provider,
          totalMs: data.totalMs,
          stages: data.stages,
          retrieved: data.retrievedCount,
          bestSimilarity: data.bestSimilarity,
          usage: data.usage,
          costUsd: data.costUsd,
          grounded: data.citations?.grounded ?? null,
          invalidCitations: data.citations?.invalid.length ?? 0,
        });
      };

      const cannedAnswer = async (text: string, fields: Partial<TraceData> & Pick<TraceData, "outcome">) => {
        writer.write({ type: "text-start", id: "answer" });
        writer.write({ type: "text-delta", id: "answer", delta: text });
        writer.write({ type: "text-end", id: "answer" });
        await finish(fields);
        writer.write({ type: "finish" });
      };

      if ((await countIndex()).documents === 0) {
        await cannedAnswer(NO_DOCUMENTS_ANSWER, { outcome: "no_documents" });
        return;
      }

      const searchQuery =
        useModel && history.length > 0
          ? await trace.stage("rewrite_query", () => condenseQuestion(model, history, question, request.signal, config))
          : question;

      const retrieval = await retrieve(searchQuery, {
        embedder: getEmbedder(config),
        config,
        documentIds: body.documentIds,
        trace,
      });
      const found = {
        searchQuery,
        bestSimilarity: retrieval.bestSimilarity,
        retrievedCount: retrieval.sources.length,
      };

      if (!isAnswerable(retrieval, config)) {
        writer.write({ type: "data-sources", id: "sources", data: { sources: [] } });
        await cannedAnswer(NO_CONTEXT_ANSWER, { ...found, outcome: "no_context" });
        return;
      }

      const sources = retrieval.sources;
      writer.write({ type: "data-sources", id: "sources", data: { sources } });

      if (!useModel) {
        const text = extractiveAnswer(sources);
        await cannedAnswer(text, { ...found, outcome: "answered", citations: analyzeCitations(text, sources.length) });
        return;
      }

      // An interim trace, so retrieval details are visible while the model writes.
      writer.write({
        type: "data-trace",
        id: "trace",
        data: trace.snapshot({ ...base, ...found, outcome: "answered", complete: false }),
      });

      const messages: ModelMessage[] = [
        ...history.map((turn): ModelMessage => ({ role: turn.role, content: turn.text })),
        { role: "user", content: buildUserMessage(question, sources) },
      ];
      const generationStarted = performance.now();

      const result = streamText({
        model,
        instructions: SYSTEM_PROMPT,
        messages,
        maxOutputTokens: config.maxOutputTokens,
        temperature: 0.2, // low: the job is to report the sources, not to be inventive
        abortSignal: request.signal,
        ...callSettings(config),
        onEnd: async ({ text, usage, finalStep }) => {
          trace.record("generate", performance.now() - generationStarted);
          const tokens = { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 };
          await finish({
            ...found,
            outcome: "answered",
            provider: resolvedProvider(finalStep.providerMetadata) ?? config.provider,
            usage: tokens,
            costUsd: estimateCostUsd(modelId, tokens),
            citations: analyzeCitations(text, sources.length),
          });
        },
        // onEnd does not run when generation fails, so the trace is closed here too.
        // Neither onEnd nor onError runs when the person presses Stop.
        onAbort: async () => {
          trace.record("generate", performance.now() - generationStarted);
          await finish({ ...found, outcome: "stopped" });
        },
        onError: async ({ error }) => {
          trace.record("generate", performance.now() - generationStarted);
          log.error("generation_failed", { traceId: trace.id, model: modelId, error: errorMessage(error) });
          await finish({ ...found, outcome: "error" });
        },
      });

      writer.merge(toUIMessageStream({ stream: result.stream, sendStart: false, onError: (error) => describeAiError(error, config.apiKey) }));
    },
  });

  return createUIMessageStreamResponse({ stream });
}
