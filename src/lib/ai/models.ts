/**
 * The chat models this app offers, all reached through Vercel AI Gateway.
 *
 * These are the models featured by Vercel Token Pass. While a team has Token
 * Pass credit, the gateway serves them from the `token-pass` provider with zero
 * data retention and draws down that credit, whichever gateway key is used.
 * Prices are the published list prices in USD per million tokens and are used
 * only for the cost estimate shown next to each answer.
 *
 * Source: https://vercel.com/docs/ai-gateway/token-pass (read 2026-11-26).
 * The live catalogue is at https://ai-gateway.vercel.sh/v1/models.
 */
export interface ChatModelInfo {
  id: string;
  label: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

export const FEATURED_MODELS: ChatModelInfo[] = [
  // The pinned 10/17 snapshot: same weights the alias below resolves to today,
  // but it cannot change under a running evaluation.
  { id: "deepseek/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash (1017)", inputPerMillion: 0.15, outputPerMillion: 0.6 },
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", inputPerMillion: 0.15, outputPerMillion: 0.6 },
  { id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash", inputPerMillion: 0.15, outputPerMillion: 0.5 },
  { id: "zai/glm-5.3", label: "GLM 5.3", inputPerMillion: 1.4, outputPerMillion: 4.4 },
  { id: "moonshotai/kimi-k3.1-pro", label: "Kimi K3.1 Pro", inputPerMillion: 2, outputPerMillion: 10 },
  { id: "moonshotai/kimi-k3", label: "Kimi K3", inputPerMillion: 3, outputPerMillion: 15 },
];

export const DEFAULT_CHAT_MODEL = "deepseek/deepseek-v4.1-flash-1017";

export function modelInfo(id: string): ChatModelInfo | undefined {
  return FEATURED_MODELS.find((model) => model.id === id);
}

export function modelLabel(id: string): string {
  return modelInfo(id)?.label ?? id;
}

/** Null when the model is not in the price table: better no number than a wrong one. */
export function estimateCostUsd(modelId: string, usage: { inputTokens: number; outputTokens: number }): number | null {
  const info = modelInfo(modelId);
  if (!info) return null;
  const cost = (usage.inputTokens * info.inputPerMillion + usage.outputTokens * info.outputPerMillion) / 1_000_000;
  return Number(cost.toFixed(6));
}
