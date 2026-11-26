import { afterEach, describe, expect, it } from "vitest";
import { checkConnection } from "@/lib/ai/provider";
import { getConfig, resetConfigForTests } from "@/lib/config";

/**
 * Exercises the non-gateway provider adapters against a real server.
 *
 * The only credential available when this was written was a Vercel AI Gateway
 * key. The gateway also speaks the OpenAI and Anthropic wire formats, so
 * pointing those adapters at it proves the adapter code path (request shape,
 * auth header, response parsing) with a live call. It does not prove anything
 * about OpenAI's or Anthropic's own servers, and the Google adapter has no
 * such stand-in, so it is not covered here.
 */
const gatewayKey = process.env.AI_GATEWAY_API_KEY;
const model = "deepseek/deepseek-v4.1-flash-1017";
const saved = { ...process.env };

function useEnvironment(extra: Record<string, string>) {
  process.env = { ...saved, AI_MODE: "live", CHAT_MODEL: model, REASONING: "none", ...extra };
  delete process.env.AI_GATEWAY_API_KEY;
  resetConfigForTests();
  return getConfig();
}

afterEach(() => {
  process.env = { ...saved };
  resetConfigForTests();
});

describe.skipIf(!gatewayKey)("provider adapters against a live endpoint", () => {
  it("OpenAI-compatible adapter", async () => {
    const config = useEnvironment({ LLM_BASE_URL: "https://ai-gateway.vercel.sh/v1", LLM_API_KEY: gatewayKey! });
    expect(config.provider).toBe("openai-compatible");
    const result = await checkConnection(config);
    console.log("openai-compatible:", JSON.stringify(result));
    expect(result.ok, result.message).toBe(true);
  });

  it("OpenAI adapter", async () => {
    const config = useEnvironment({ OPENAI_API_KEY: gatewayKey!, OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1" });
    expect(config.provider).toBe("openai");
    const result = await checkConnection(config);
    console.log("openai:", JSON.stringify(result));
    expect(result.ok, result.message).toBe(true);
  });

  it("Anthropic adapter", async () => {
    const config = useEnvironment({ ANTHROPIC_API_KEY: gatewayKey!, ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/v1" });
    expect(config.provider).toBe("anthropic");
    const result = await checkConnection(config);
    console.log("anthropic:", JSON.stringify(result));
    expect(result.ok, result.message).toBe(true);
  });

  it("a wrong key is reported as a rejected key, not a crash", async () => {
    const config = useEnvironment({ LLM_BASE_URL: "https://ai-gateway.vercel.sh/v1", LLM_API_KEY: "not-a-real-key" });
    const result = await checkConnection(config);
    console.log("bad key:", JSON.stringify(result));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/key|rejected|invalid/i);
  });
});
