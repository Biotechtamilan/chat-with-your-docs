import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfig, getConfig, resetConfigForTests, type AppConfig } from "../config";
import { log } from "../log";
import type { ConnectionView } from "../types";
import {
  candidateFrom,
  connectionView,
  diskFiles,
  fileStore,
  forgetConnection,
  handleForgetConnection,
  handleGetConnection,
  handleSaveConnection,
  isLocalHost,
  loadConnection,
  boundToLoopback,
  cameThroughProxy,
  isForbiddenIp,
  resolveAddress,
  type AddressLookup,
  CHANGE_REFUSED,
  changeAllowed,
  isForbiddenAddress,
  refusalFor,
  saveConnection,
  type ConnectionFiles,
  type Disk,
  type SavedConnection,
} from "./connection";
import { describeAiError, describeCheckFailure } from "./errors";
import { checkConnection, fetchWithoutRedirects, resolveChatModel, type ConnectionCheck } from "./provider";

/**
 * The saved connection, end to end, with no network and no disk: the provider
 * packages are replaced by fakes that record the settings they were given.
 */
const providers = vi.hoisted(() => ({
  calls: [] as Array<{ provider: string; settings: { apiKey?: string; baseURL?: string; fetch?: typeof fetch } | undefined }>,
  /** When set, the fake model fails with this message instead of answering. */
  failWith: null as string | null,
  /** When set, the fake model throws exactly this, for errors that carry a status and a body. */
  failure: null as unknown,
}));

vi.mock("@ai-sdk/openai", async () => ({ createOpenAI: await fakeFactory("openai") }));
vi.mock("@ai-sdk/anthropic", async () => ({ createAnthropic: await fakeFactory("anthropic") }));
vi.mock("@ai-sdk/google", async () => ({ createGoogleGenerativeAI: await fakeFactory("google") }));
vi.mock("@ai-sdk/openai-compatible", async () => ({ createOpenAICompatible: await fakeFactory("openai-compatible") }));
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), createGateway: await fakeFactory("gateway") }));

async function fakeFactory(provider: string) {
  const { MockLanguageModelV4 } = await import("ai/test");
  return (settings?: { apiKey?: string; baseURL?: string; fetch?: typeof fetch }) => {
    providers.calls.push({ provider, settings });
    return () =>
      new MockLanguageModelV4({
        doGenerate: async () => {
          if (providers.failure) throw providers.failure;
          if (providers.failWith) throw new Error(providers.failWith);
          return {
            content: [{ type: "text", text: "ready" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          };
        },
      });
  };
}

const KEY = "sk-test-0123456789-SECRETab12";
const ENV_KEY = "vck-env-0123456789-ENVKEYcd34";
const KEY_VARIABLES = [
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_PROVIDER",
  "CHAT_MODEL",
  "CHAT_MODELS",
  "SETTINGS_TOKEN",
  "LOG_IN_TESTS",
];
const savedEnv = { ...process.env };
/** What Next reports for a server started with --hostname 127.0.0.1, and for one open to the network. */
const LOOPBACK = { __NEXT_PRIVATE_ORIGIN: "http://127.0.0.1:3000" };
const ALL_INTERFACES = { __NEXT_PRIVATE_ORIGIN: "http://localhost:3000" };
const TOKEN = "settings-token-0123456789";

/** A live (not mock) environment with no key in it, bound to loopback, plus whatever the test adds. */
function useEnvironment(extra: Record<string, string> = {}) {
  process.env = { ...savedEnv, AI_MODE: "live", DATA_DIR: ":memory:", TRUST_PROXY: "false", ...LOOPBACK };
  for (const name of KEY_VARIABLES) delete process.env[name];
  Object.assign(process.env, extra);
  resetConfigForTests();
}

const liveEnv = (extra: Record<string, string> = {}) => ({ AI_MODE: "live", DATA_DIR: ":memory:", ...extra });

beforeEach(() => {
  useEnvironment();
  forgetConnection(":memory:");
  providers.calls.length = 0;
  providers.failWith = null;
  providers.failure = null;
});

afterEach(() => {
  forgetConnection(":memory:");
  process.env = { ...savedEnv };
  resetConfigForTests();
  vi.restoreAllMocks();
});

const openai: SavedConnection = { provider: "openai", apiKey: KEY, baseUrl: null, model: "gpt-x", models: ["gpt-y"] };

/** Empties the allowance for connection changes, which every caller shares here (TRUST_PROXY is off). */
function freshAllowance() {
  (globalThis as { __docsLimiters?: Map<string, unknown> }).__docsLimiters?.delete("connection");
}

/**
 * A change request as a browser on this machine sends it: a local Host and no
 * forwarding header. Each one starts with a full allowance, except in the
 * tests that are about the limit, which pass `keepAllowance`.
 */
function call(method: "PUT" | "DELETE", body?: unknown, headers: Record<string, string> = {}, keepAllowance = false) {
  if (!keepAllowance) freshAllowance();
  return new Request("http://localhost:3000/api/connection", {
    method,
    headers: { host: "localhost:3000", "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Stand-ins for the system resolver. */
const resolvesTo =
  (...addresses: string[]): AddressLookup =>
  async () =>
    addresses.map((address) => ({ address }));
const unresolvable: AddressLookup = async () => {
  throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
};

const answered: ConnectionCheck = { ok: true, provider: "openai", model: "gpt-x", ms: 3, message: "The model answered." };
const passes = async () => answered;

async function view(response: Response): Promise<ConnectionView> {
  return ((await response.json()) as { connection: ConnectionView }).connection;
}

const read = (headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/connection", { headers: { host: "localhost:3000", ...headers } });
const current = () => view(handleGetConnection(read()));

describe("host check", () => {
  it("accepts only names for this machine, on any port", () => {
    for (const host of ["localhost", "localhost:3000", "LOCALHOST:8080", "127.0.0.1", "127.0.0.1:3101", "[::1]", "[::1]:3000"]) {
      expect(isLocalHost(host), host).toBe(true);
    }
    for (const host of [
      null,
      "",
      "example.com",
      "example.com:3000",
      "localhost.example.com",
      "evil-localhost",
      "127.0.0.1.example.com",
      "192.168.1.20:3000",
      "0.0.0.0:3000",
      "::1",
      "localhost:3000@example.com",
    ]) {
      expect(isLocalHost(host), String(host)).toBe(false);
    }
  });

});

describe("is the server bound to loopback", () => {
  const next = ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"];
  const worker = ["node", "node_modules/next/dist/server/lib/start-server.js"];

  it("is true only for the origin Next reports after binding 127.0.0.1", () => {
    // `next dev`: the worker's command line carries no hostname, so the origin decides alone.
    expect(boundToLoopback(worker, LOOPBACK)).toBe(true);
    expect(boundToLoopback([...next, "--hostname", "127.0.0.1"], LOOPBACK)).toBe(true);
    expect(boundToLoopback([...next, "--hostname=127.0.0.1"], LOOPBACK)).toBe(true);
    expect(boundToLoopback([...next, "-H", "127.0.0.1"], LOOPBACK)).toBe(true);
    expect(boundToLoopback([...next, "-H127.0.0.1"], LOOPBACK)).toBe(true);
    expect(boundToLoopback([], { __NEXT_PRIVATE_ORIGIN: "https://127.0.0.1:8443" })).toBe(true);
  });

  it("is false for every origin an all-interfaces server can report", () => {
    // Observed: 0.0.0.0 and no hostname both report localhost, and :: reports [::1].
    for (const origin of ["http://localhost:3000", "http://[::1]:3000", "http://0.0.0.0:3000", "http://192.168.1.20:3000", "http://[::]:3000"]) {
      expect(boundToLoopback(worker, { __NEXT_PRIVATE_ORIGIN: origin }), origin).toBe(false);
    }
    for (const origin of ["http://127.0.0.1.example.com:3000", "http://example.com/127.0.0.1", "not a url", ""]) {
      expect(boundToLoopback(worker, { __NEXT_PRIVATE_ORIGIN: origin }), origin).toBe(false);
    }
  });

  it("is false when nothing says how the server was started", () => {
    expect(boundToLoopback([], {})).toBe(false);
    expect(boundToLoopback(next, {})).toBe(false);
    // The command line alone is not enough: the address actually bound is what counts.
    expect(boundToLoopback([...next, "--hostname", "127.0.0.1"], {})).toBe(false);
  });

  it("does not trust the HOSTNAME variable, which is the machine's name on Linux and in containers", () => {
    for (const HOSTNAME of ["127.0.0.1", "localhost", "::1"]) {
      expect(boundToLoopback(next, { HOSTNAME }), HOSTNAME).toBe(false);
      expect(boundToLoopback(worker, { HOSTNAME, ...ALL_INTERFACES }), HOSTNAME).toBe(false);
    }
  });

  it("is false when the command line names anything but 127.0.0.1, whatever the origin says", () => {
    for (const flag of [
      ["--hostname", "0.0.0.0"],
      ["--hostname=0.0.0.0"],
      ["-H", "0.0.0.0"],
      ["-H0.0.0.0"],
      ["--hostname", "::"],
      ["--hostname", "localhost"],
      ["--hostname", "::1"],
      ["--hostname", "192.168.1.20"],
      ["--hostname"],
      // The last one wins, as it does for Next.
      ["--hostname", "127.0.0.1", "--hostname", "0.0.0.0"],
    ]) {
      expect(boundToLoopback([...next, ...flag], LOOPBACK), flag.join(" ")).toBe(false);
    }
  });

  it("reaches the configuration from the command line and environment, not from a request", () => {
    expect(buildConfig(liveEnv(LOOPBACK), undefined, worker).loopbackOnly).toBe(true);
    expect(buildConfig(liveEnv(ALL_INTERFACES), undefined, worker).loopbackOnly).toBe(false);
    expect(buildConfig(liveEnv(LOOPBACK), undefined, [...next, "--hostname", "0.0.0.0"]).loopbackOnly).toBe(false);
    expect(buildConfig(liveEnv()).loopbackOnly).toBe(false);
  });
});

describe("who may change the connection", () => {
  const local = { host: "localhost:3000" };
  const foreign = { host: "docs.example.com" };
  const withToken = (headers: Record<string, string>, token: string) => ({ ...headers, "x-settings-token": token });
  const decide = (headers: Record<string, string>, loopbackOnly: boolean, settingsToken: string | null = null) =>
    refusalFor(new Headers(headers), { loopbackOnly, settingsToken });
  const mode = (headers: Record<string, string>, loopbackOnly: boolean, settingsToken: string | null = null) =>
    changeAllowed(new Headers(headers), { loopbackOnly, settingsToken });

  it("on a loopback server, allows a local name and refuses a foreign one", () => {
    expect(decide(local, true)).toBeNull();
    expect(decide({ host: "127.0.0.1:3101" }, true)).toBeNull();
    expect(mode(local, true)).toBe("local");
    // A page that points its own domain at 127.0.0.1 arrives with that domain as Host.
    expect(decide(foreign, true)).toBe(CHANGE_REFUSED.rebinding);
    expect(decide({}, true)).toBe(CHANGE_REFUSED.rebinding);
    expect(mode(foreign, true)).toBe("no");
  });

  it("on a loopback server with no token, a request that came through a proxy is never local", () => {
    const proxied: Array<Record<string, string>> = [
      { "x-forwarded-for": "1.2.3.4" },
      { "x-forwarded-for": "127.0.0.1, 1.2.3.4" },
      { "x-forwarded-for": "1.2.3.4, 127.0.0.1" },
      { "x-forwarded-host": "docs.example.com" },
      { "x-forwarded-host": "127.0.0.1:3000" }, // a local name, but not the one in Host
      { "x-forwarded-proto": "https" },
      { forwarded: "for=1.2.3.4;proto=https" },
      { forwarded: "for=127.0.0.1" },
      { "x-real-ip": "1.2.3.4" },
      { "x-real-ip": "127.0.0.1" },
      { via: "1.1 proxy" },
    ];
    for (const extra of proxied) {
      const headers = { ...local, ...extra };
      expect(cameThroughProxy(new Headers(headers)), JSON.stringify(extra)).toBe(true);
      expect(decide(headers, true), JSON.stringify(extra)).toBe(CHANGE_REFUSED.proxy);
      expect(mode(headers, true), JSON.stringify(extra)).toBe("no");
    }
    expect(CHANGE_REFUSED.proxy).toMatch(/a proxy is in front/);
    expect(CHANGE_REFUSED.proxy).toMatch(/SETTINGS_TOKEN/);
  });

  it("does not mistake the headers Next adds to every direct request for a proxy", () => {
    // base-server.js fills these in when they are absent: host from Host, proto from its own listener, for from the socket.
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const direct = { ...local, "x-forwarded-host": local.host, "x-forwarded-proto": "http", "x-forwarded-port": "3000", "x-forwarded-for": peer };
      expect(cameThroughProxy(new Headers(direct)), peer).toBe(false);
      expect(decide(direct, true), peer).toBeNull();
    }
  });

  it("with a proxy in front and a token configured, the token decides", () => {
    const proxied = { ...foreign, "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "https" };
    expect(mode(proxied, true, TOKEN)).toBe("token");
    expect(decide(proxied, true, TOKEN)).toBe(CHANGE_REFUSED.tokenMissing);
    expect(decide(withToken(proxied, TOKEN), true, TOKEN)).toBeNull();
  });

  it("off loopback with no token, refuses everything, including a request that claims to be localhost", () => {
    for (const headers of [local, { host: "127.0.0.1:3000" }, { host: "[::1]:3000" }, foreign, withToken(local, TOKEN)]) {
      expect(decide(headers, false), JSON.stringify(headers)).toBe(CHANGE_REFUSED.no);
      expect(mode(headers, false)).toBe("no");
    }
    expect(CHANGE_REFUSED.no).toMatch(/npm run dev and npm start/);
    expect(CHANGE_REFUSED.no).toMatch(/SETTINGS_TOKEN/);
  });

  it("off loopback with a token, allows only a request that carries it", () => {
    expect(mode(local, false, TOKEN)).toBe("token");
    expect(decide(withToken(foreign, TOKEN), false, TOKEN)).toBeNull();
    expect(decide(withToken(local, TOKEN), false, TOKEN)).toBeNull();
    expect(decide(local, false, TOKEN)).toBe(CHANGE_REFUSED.tokenMissing);
    expect(decide(withToken(local, ""), false, TOKEN)).toBe(CHANGE_REFUSED.tokenMissing);
    for (const wrong of [TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase(), "short", "x".repeat(TOKEN.length)]) {
      expect(decide(withToken(local, wrong), false, TOKEN), wrong).toBe(CHANGE_REFUSED.tokenWrong);
    }
  });

  it("a configured token is always required, on a loopback server too", () => {
    expect(mode(local, true, TOKEN)).toBe("token");
    expect(decide(local, true, TOKEN)).toBe(CHANGE_REFUSED.tokenMissing);
    expect(decide(withToken(local, "not-the-token-0123456789-x"), true, TOKEN)).toBe(CHANGE_REFUSED.tokenWrong);
    expect(decide(withToken(local, TOKEN), true, TOKEN)).toBeNull();
    expect(decide(foreign, true, TOKEN)).toBe(CHANGE_REFUSED.tokenMissing);
    expect(decide(withToken(foreign, TOKEN), true, TOKEN)).toBeNull();
  });

  it("refuses to start with a token too short to be one, and treats an empty one as not set", () => {
    expect(() => buildConfig(liveEnv({ SETTINGS_TOKEN: "x".repeat(23) }))).toThrow(/SETTINGS_TOKEN: must be at least 24 characters/);
    expect(buildConfig(liveEnv({ SETTINGS_TOKEN: "x".repeat(24) })).settingsToken).toBe("x".repeat(24));
    expect(buildConfig(liveEnv({ SETTINGS_TOKEN: "" })).settingsToken).toBeNull();
    expect(buildConfig(liveEnv({ SETTINGS_TOKEN: "  " })).settingsToken).toBeNull();
    expect(buildConfig(liveEnv({ SETTINGS_TOKEN: TOKEN })).settingsToken).toBe(TOKEN);
  });
});

describe("addresses the server is never sent to", () => {
  it("refuses link-local addresses and the metadata names, however they are spelled", () => {
    for (const address of [
      "http://169.254.169.254/latest/meta-data",
      "http://169.254.0.1:8080/v1",
      "http://2852039166/v1", // 169.254.169.254 as one decimal number
      "http://0xa9.0xfe.0xa9.0xfe/v1",
      "http://[fe80::1]/v1",
      "http://[febf::1]:11434/v1",
      "http://[::ffff:169.254.169.254]/v1",
      "http://metadata.google.internal/computeMetadata/v1",
      "http://METADATA.google.internal./v1",
      "http://metadata/v1",
      "http://metadata.azure.com/metadata/instance",
      "http://instance-data/latest",
      "http://instance-data.ec2.internal/latest",
      "http://100.100.100.200/latest/meta-data",
      "http://[::ffff:100.100.100.200]/v1",
      "http://[fd00:ec2::254]/latest",
      "http://[fd00:ec2:0:0:0:0:0:254]/latest",
      "http://0.0.0.0:11434/v1",
      "http://0/v1",
      "http://[::]:11434/v1",
      "http://[::ffff:0.0.0.0]/v1",
      "not a url",
    ]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
  });

  it("applies the same ranges to an address a resolver returns", () => {
    for (const ip of [
      "169.254.169.254",
      "169.254.0.7",
      "fe80::1",
      "fe80::1%eth0",
      "FE80::1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "100.100.100.200",
      "fd00:ec2::254",
      "fd00:ec2:0:0:0:0:0:254",
      "0.0.0.0",
      "::",
    ]) {
      expect(isForbiddenIp(ip), ip).toBe(true);
    }
    for (const ip of ["127.0.0.1", "::1", "10.0.0.5", "192.168.1.20", "172.16.0.9", "fd00::1", "100.100.100.201", "93.184.216.34", "::ffff:10.0.0.5"]) {
      expect(isForbiddenIp(ip), ip).toBe(false);
    }
  });

  it("refuses a name when any address it resolves to is forbidden", async () => {
    const address = "https://models.example.com/v1";
    expect(await resolveAddress(address, resolvesTo("93.184.216.34"))).toBe("ok");
    expect(await resolveAddress(address, resolvesTo("169.254.169.254"))).toBe("forbidden");
    expect(await resolveAddress(address, resolvesTo("fe80::1%eth0"))).toBe("forbidden");
    // One public answer among them changes nothing.
    expect(await resolveAddress(address, resolvesTo("93.184.216.34", "169.254.169.254"))).toBe("forbidden");
    expect(await resolveAddress(address, resolvesTo("93.184.216.34", "::ffff:100.100.100.200"))).toBe("forbidden");
    expect(await resolveAddress(address, resolvesTo("10.0.0.5", "192.168.1.20"))).toBe("ok");
    expect(await resolveAddress(address, unresolvable)).toBe("unresolved");
    expect(await resolveAddress(address, resolvesTo())).toBe("unresolved");
  });

  it("does not look up a literal address, and allows loopback and private ones", async () => {
    const find = vi.fn(resolvesTo("169.254.169.254"));
    for (const address of ["http://127.0.0.1:11434/v1", "http://[::1]:8000/v1", "http://192.168.1.20:1234/v1", "http://10.0.0.5/v1"]) {
      expect(await resolveAddress(address, find), address).toBe("ok");
    }
    expect(await resolveAddress("http://169.254.169.254/v1", find)).toBe("forbidden");
    expect(await resolveAddress("http://metadata.google.internal/v1", find)).toBe("forbidden");
    expect(find).not.toHaveBeenCalled();
    // A name, even "localhost", is looked up.
    expect(await resolveAddress("http://localhost:11434/v1", resolvesTo("127.0.0.1", "::1"))).toBe("ok");
  });

  it("still allows loopback, private ranges and public hosts", () => {
    for (const address of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:1234/v1",
      "http://[::1]:8000/v1",
      "http://192.168.1.20:11434/v1",
      "http://10.0.0.5/v1",
      "http://[fd00::1]/v1",
      "http://[fec0::1]/v1",
      "https://ai-gateway.vercel.sh/v1",
      "https://metadata.example.com/v1",
      "http://169.253.1.1/v1",
    ]) {
      expect(isForbiddenAddress(address), address).toBe(false);
    }
  });
});

describe("merge and precedence", () => {
  it("uses the environment when nothing is saved, and reports no connection when there is neither", () => {
    const fromEnv = buildConfig(liveEnv({ AI_GATEWAY_API_KEY: ENV_KEY }));
    expect(fromEnv).toMatchObject({ provider: "gateway", connectionSource: "env", apiKey: null, keySet: true });
    const none = buildConfig(liveEnv());
    expect(none).toMatchObject({ provider: null, connectionSource: "none", chatMode: "offline", keySet: false });
  });

  it("puts a connection saved in the app over the environment, whole", () => {
    const config = buildConfig(liveEnv({ AI_GATEWAY_API_KEY: ENV_KEY, CHAT_MODELS: "a/b,c/d" }), () => openai);
    expect(config).toMatchObject({
      provider: "openai",
      connectionSource: "app",
      chatMode: "gateway",
      apiKey: KEY,
      chatModel: "gpt-x",
      allowedChatModels: ["gpt-x", "gpt-y"],
      llmBaseUrl: null,
      local: false,
    });
  });

  it("falls back to the environment when the saved connection is forgotten", () => {
    useEnvironment({ AI_GATEWAY_API_KEY: ENV_KEY });
    expect(getConfig().connectionSource).toBe("env");
    saveConnection(":memory:", openai);
    // No reset here: saving alone must drop the cached configuration.
    expect(getConfig()).toMatchObject({ provider: "openai", connectionSource: "app" });
    forgetConnection(":memory:");
    expect(getConfig()).toMatchObject({ provider: "gateway", connectionSource: "env", apiKey: null });
  });

  it("marks a saved local server as local and needs no key for it", () => {
    const ollama: SavedConnection = {
      provider: "openai-compatible",
      apiKey: null,
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.2",
      models: [],
    };
    const config = buildConfig(liveEnv({ LLM_API_KEY: ENV_KEY }), () => ollama);
    expect(config).toMatchObject({ local: true, keySet: false, apiKey: null, llmBaseUrl: "http://localhost:11434/v1" });
  });

  it("offers the app's own gateway list for a saved gateway connection", () => {
    const config = buildConfig(liveEnv(), () => ({
      provider: "gateway",
      apiKey: KEY,
      baseUrl: null,
      model: "zai/glm-5.3",
      models: [],
    }));
    expect(config.chatModel).toBe("zai/glm-5.3");
    expect(config.allowedChatModels).toContain("deepseek/deepseek-v4.1-flash-1017");
    expect(config.reasoning).toBe("none");
  });

  it("ignores a saved connection in mock mode, where the model is a fake", () => {
    const config = buildConfig({ AI_MODE: "mock", DATA_DIR: ":memory:" }, () => openai);
    expect(config).toMatchObject({ provider: null, connectionSource: "none", apiKey: null });
  });
});

describe("public view", () => {
  it("never contains the key, only its last four characters", () => {
    const shown = connectionView(buildConfig(liveEnv(), () => openai), "local", true);
    expect(shown).toEqual({
      source: "app",
      provider: "openai",
      keySet: true,
      keyLast4: "ab12",
      baseUrl: null,
      model: "gpt-x",
      models: ["gpt-x", "gpt-y"],
      local: false,
      changeAllowed: "local",
    });
    expect(JSON.stringify(shown)).not.toContain(KEY);
  });

  it("gives no hint for a short key or for a key from the environment", () => {
    const short = connectionView(buildConfig(liveEnv(), () => ({ ...openai, apiKey: "abcdefgh" })), "local", true);
    expect(short).toMatchObject({ keySet: true, keyLast4: null });
    const fromEnv = connectionView(buildConfig(liveEnv({ AI_GATEWAY_API_KEY: ENV_KEY })), "local", true);
    expect(fromEnv).toMatchObject({ source: "env", keySet: true, keyLast4: null });
    expect(JSON.stringify(fromEnv)).not.toContain(ENV_KEY.slice(-4));
  });

  it("leaves a login out of an address taken from the environment", () => {
    const config = buildConfig(liveEnv({ LLM_BASE_URL: "https://user:hunter2@llm.example/v1", CHAT_MODEL: "m" }));
    expect(JSON.stringify(connectionView(config, "local", true))).not.toContain("hunter2");
  });

  it("returns an address without its login, query string or fragment", () => {
    const config = buildConfig(liveEnv({ LLM_BASE_URL: "https://user:pass@llm.example/v1?x=1&key=hunter2#y", CHAT_MODEL: "m" }));
    expect(connectionView(config, "local", true).baseUrl).toBe("https://llm.example/v1");
    const plain = buildConfig(liveEnv({ LLM_BASE_URL: "http://localhost:11434/v1", CHAT_MODEL: "m" }));
    expect(connectionView(plain, "local", true).baseUrl).toBe("http://localhost:11434/v1");
    // Something that is not a URL cannot be cleaned, so it is not shown.
    const broken = buildConfig(liveEnv({ LLM_BASE_URL: "user:pass@not a url", CHAT_MODEL: "m" }));
    expect(connectionView(broken, "local", true).baseUrl).toBeNull();
  });

  it("without the right to change the connection, holds back the address and the key's last four", () => {
    const server: SavedConnection = { provider: "openai-compatible", apiKey: KEY, baseUrl: "https://llm.example/v1", model: "m", models: ["n"] };
    const config = buildConfig(liveEnv(), () => server);
    expect(connectionView(config, "no", false)).toEqual({
      source: "app",
      provider: "openai-compatible",
      keySet: true,
      keyLast4: null,
      baseUrl: null,
      model: "m",
      models: ["m", "n"],
      local: false,
      changeAllowed: "no",
    });
    expect(connectionView(config, "local", true)).toMatchObject({ keyLast4: "ab12", baseUrl: "https://llm.example/v1" });
  });

  describe("read through the endpoint", () => {
    const server: SavedConnection = { provider: "openai-compatible", apiKey: KEY, baseUrl: "https://llm.example/v1", model: "m", models: [] };
    const details = { keyLast4: "ab12", baseUrl: "https://llm.example/v1" };
    const held = { keyLast4: null, baseUrl: null };
    const rest = { source: "app", provider: "openai-compatible", keySet: true, model: "m", models: ["m"], local: false };
    const get = (headers: Record<string, string> = {}) => handleGetConnection(read(headers));

    it("a local request sees the details", async () => {
      saveConnection(":memory:", server);
      expect(await view(get())).toEqual({ ...rest, ...details, changeAllowed: "local" });
    });

    it("a local server reached by a foreign name or through a proxy does not", async () => {
      saveConnection(":memory:", server);
      expect(await view(get({ host: "docs.example.com" }))).toEqual({ ...rest, ...held, changeAllowed: "no" });
      expect(await view(get({ "x-forwarded-for": "1.2.3.4" }))).toEqual({ ...rest, ...held, changeAllowed: "no" });
    });

    it("in token mode, a read ignores the token: right, wrong and none get the same reply", async () => {
      useEnvironment({ SETTINGS_TOKEN: TOKEN });
      saveConnection(":memory:", server);
      const none = get();
      const wrong = get({ "x-settings-token": "not-the-token-0123456789-x" });
      const right = get({ "x-settings-token": TOKEN });
      expect([none.status, wrong.status, right.status]).toEqual([200, 200, 200]);
      const [noneText, wrongText, rightText] = [await none.text(), await wrong.text(), await right.text()];
      // Byte for byte the same reply. Reading is not rate limited, so a reply that changed for the right
      // token would let anyone test guesses at it without limit.
      expect(wrongText).toBe(noneText);
      expect(rightText).toBe(noneText);
      expect((JSON.parse(noneText) as { connection: ConnectionView }).connection).toEqual({ ...rest, ...held, changeAllowed: "token" });
    });

    it("an exposed server with a token behaves the same way, from any Host", async () => {
      useEnvironment({ ...ALL_INTERFACES, SETTINGS_TOKEN: TOKEN });
      saveConnection(":memory:", server);
      const remote = { host: "docs.example.com" };
      expect(await view(get(remote))).toEqual({ ...rest, ...held, changeAllowed: "token" });
      expect(await view(get({ ...remote, "x-settings-token": TOKEN }))).toEqual({ ...rest, ...held, changeAllowed: "token" });
    });

    it("a token holder sees the details in the reply to a save, which is rate limited", async () => {
      useEnvironment({ SETTINGS_TOKEN: TOKEN });
      freshAllowance();
      const saved = await handleSaveConnection(call("PUT", { ...server, test: false }, { "x-settings-token": TOKEN }, true));
      expect(saved.status).toBe(200);
      expect(await view(saved)).toMatchObject({ ...details, changeAllowed: "token" });
    });

    it("an exposed server with no token shows the details to nobody", async () => {
      useEnvironment(ALL_INTERFACES);
      saveConnection(":memory:", server);
      const callers: Array<Record<string, string>> = [{}, { host: "docs.example.com" }, { "x-settings-token": TOKEN }];
      for (const headers of callers) {
        expect(await view(get(headers))).toEqual({ ...rest, ...held, changeAllowed: "no" });
      }
    });

    it("reading is not rate limited and uses up none of the allowance for changes", async () => {
      useEnvironment({ SETTINGS_TOKEN: TOKEN });
      freshAllowance();
      const limit = getConfig().connectionRateLimitPerMinute;
      for (let i = 0; i < limit * 3; i++) expect(get({ "x-settings-token": `guess-${i}-0123456789-0123456789` }).status).toBe(200);
      const good = { provider: "openai", apiKey: KEY, model: "gpt-x" };
      expect((await handleSaveConnection(call("PUT", good, { "x-settings-token": TOKEN }, true), { check: passes })).status).toBe(200);
    });
  });

  it("carries neither the settings token nor the key, whatever the change mode", () => {
    const config = buildConfig(liveEnv({ SETTINGS_TOKEN: TOKEN }), () => openai);
    const shown = JSON.stringify(connectionView(config, "token", true));
    expect(shown).toContain('"changeAllowed":"token"');
    expect(shown).not.toContain(TOKEN);
    expect(shown).not.toContain(KEY);
  });
});

describe("storage", () => {
  function fakeFiles(initial: string | null = null): ConnectionFiles & { text: string | null } {
    const files = {
      text: initial,
      read: () => files.text,
      write: (_file: string, text: string) => {
        files.text = text;
      },
      remove: () => {
        files.text = null;
      },
    };
    return files;
  }

  it("writes, reads back and removes one file", () => {
    const files = fakeFiles();
    const store = fileStore("data/connection.json", files);
    expect(store.read()).toBeNull();
    store.write(openai);
    expect(store.read()).toEqual(openai);
    store.clear();
    expect(files.text).toBeNull();
  });

  it("treats a damaged or foreign file as no connection", () => {
    expect(fileStore("c.json", fakeFiles("{not json")).read()).toBeNull();
    expect(fileStore("c.json", fakeFiles(JSON.stringify({ provider: "someone-else", apiKey: KEY }))).read()).toBeNull();
  });

  it("writes the file for its owner only, through a rename", () => {
    const calls: string[] = [];
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const disk: Disk = {
      readFileSync: () => {
        throw missing;
      },
      writeFileSync: (file, _text, options) => void calls.push(`write ${file} ${options.mode.toString(8)}`),
      chmodSync: (file, mode) => void calls.push(`chmod ${file} ${mode.toString(8)}`),
      renameSync: (from, to) => void calls.push(`rename ${from} ${to}`),
      mkdirSync: (folder) => void calls.push(`mkdir ${folder}`),
      rmSync: (file) => void calls.push(`rm ${file}`),
    };
    const files = diskFiles(disk);
    expect(files.read("data/connection.json")).toBeNull();
    files.write("data/connection.json", "{}");
    files.remove("data/connection.json");
    expect(calls).toEqual([
      "mkdir data",
      "write data/connection.json.tmp 600",
      "chmod data/connection.json.tmp 600",
      "rename data/connection.json.tmp data/connection.json",
      "rm data/connection.json",
    ]);
  });
});

describe("what would be saved", () => {
  const request = (fields: Partial<Parameters<typeof candidateFrom>[0]>) => ({ provider: "openai" as const, test: true, ...fields });

  it("keeps the saved key only for the same provider and address", () => {
    const kept = candidateFrom(request({ model: "gpt-z" }), openai);
    expect(kept).toEqual({ ok: true, connection: { ...openai, model: "gpt-z", models: [] } });
    const moved = candidateFrom(request({ provider: "anthropic", model: "claude-x" }), openai);
    expect(moved).toMatchObject({ ok: false, error: "Enter an API key for Anthropic." });

    const server: SavedConnection = { provider: "openai-compatible", apiKey: KEY, baseUrl: "https://a.example/v1", model: "m", models: [] };
    const elsewhere = candidateFrom(request({ provider: "openai-compatible", baseUrl: "https://b.example/v1", model: "m" }), server);
    // Saved, but without the key: it is not sent to an address it was not entered for.
    expect(elsewhere).toMatchObject({ ok: true, connection: { apiKey: null, baseUrl: "https://b.example/v1" } });
    const same = candidateFrom(request({ provider: "openai-compatible", baseUrl: "https://a.example/v1/", model: "m2" }), server);
    expect(same).toMatchObject({ ok: true, connection: { apiKey: KEY, model: "m2" } });
  });

  it("tidies the extra model ids", () => {
    const result = candidateFrom(request({ apiKey: KEY, model: "a", models: ["b", "a", "b", "c"] }), null);
    expect(result).toMatchObject({ ok: true, connection: { model: "a", models: ["b", "c"] } });
  });
});

describe("saving and forgetting", () => {
  const good = { provider: "openai", apiKey: KEY, model: "gpt-x", models: ["gpt-y"] };

  it("starts with no connection and a view that holds no key", async () => {
    expect(await current()).toMatchObject({ source: "none", provider: null, keySet: false, keyLast4: null });
  });

  it("tests first and saves only when the model answers", async () => {
    const seen: Array<{ config: AppConfig; savedYet: boolean }> = [];
    const fails = async (config: AppConfig): Promise<ConnectionCheck> => {
      seen.push({ config, savedYet: loadConnection(":memory:") !== null });
      return { ...answered, ok: false, message: "The provider rejected the API key." };
    };
    const refused = await handleSaveConnection(call("PUT", good), { check: fails });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe("Nothing was saved. The provider rejected the API key.");
    // The check ran against the entered settings, before anything was written.
    expect(seen[0].config).toMatchObject({ provider: "openai", apiKey: KEY, chatModel: "gpt-x", connectionSource: "app" });
    expect(seen[0].savedYet).toBe(false);
    expect(await current()).toMatchObject({ source: "none" });

    const saved = await handleSaveConnection(call("PUT", good), { check: passes });
    expect(saved.status).toBe(200);
    expect(await view(saved)).toMatchObject({ source: "app", provider: "openai", keyLast4: "ab12", models: ["gpt-x", "gpt-y"] });
    // In use on the next request, with no restart.
    expect(getConfig()).toMatchObject({ provider: "openai", chatMode: "gateway", apiKey: KEY });
  });

  it("a failed test leaves the working connection in place", async () => {
    await handleSaveConnection(call("PUT", good), { check: passes });
    const worse = await handleSaveConnection(call("PUT", { ...good, apiKey: "sk-wrong-000000000000", model: "gpt-q" }), {
      check: async () => ({ ...answered, ok: false, message: "No." }),
    });
    expect(worse.status).toBe(422);
    expect(getConfig()).toMatchObject({ apiKey: KEY, chatModel: "gpt-x" });
  });

  it("saves without testing when asked, and sends no request", async () => {
    const check = vi.fn(passes);
    const response = await handleSaveConnection(call("PUT", { ...good, test: false }), { check });
    expect(response.status).toBe(200);
    expect(check).not.toHaveBeenCalled();
    expect(await current()).toMatchObject({ source: "app", provider: "openai" });
  });

  it("keeps the saved key when the field is left empty", async () => {
    await handleSaveConnection(call("PUT", good), { check: passes });
    const again = await handleSaveConnection(call("PUT", { provider: "openai", model: "gpt-z" }), { check: passes });
    expect(again.status).toBe(200);
    expect(getConfig()).toMatchObject({ apiKey: KEY, chatModel: "gpt-z" });
  });

  it("saves a local server with no key", async () => {
    const local = { provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3.2" };
    const response = await handleSaveConnection(call("PUT", local), { check: passes, lookup: resolvesTo("127.0.0.1", "::1") });
    expect(await view(response)).toMatchObject({ source: "app", local: true, keySet: false, baseUrl: "http://localhost:11434/v1" });
  });

  it("refuses a name that resolves to a forbidden address, tested or not, and sends nothing", async () => {
    const check = vi.fn(passes);
    const body = { provider: "openai-compatible", apiKey: KEY, baseUrl: "https://models.example.com/v1", model: "m" };
    for (const lookup of [resolvesTo("169.254.169.254"), resolvesTo("93.184.216.34", "fe80::1"), resolvesTo("100.100.100.200")]) {
      for (const test of [true, false]) {
        const response = await handleSaveConnection(call("PUT", { ...body, test }), { check, lookup });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toMatch(/cannot be used/);
      }
    }
    expect(check).not.toHaveBeenCalled();
    expect(await current()).toMatchObject({ source: "none" });
  });

  it("a name that does not resolve fails a test but may be saved without one", async () => {
    const check = vi.fn(passes);
    const body = { provider: "openai-compatible", baseUrl: "http://my-model-box:11434/v1", model: "llama3.2" };
    const tested = await handleSaveConnection(call("PUT", { ...body, test: true }), { check, lookup: unresolvable });
    expect(tested.status).toBe(422);
    expect(((await tested.json()) as { error: string }).error).toBe(
      "Nothing was saved. The server could not be reached, or did not answer like a model API. Check the address and that the server is running.",
    );
    expect(check).not.toHaveBeenCalled();
    expect(await current()).toMatchObject({ source: "none" });

    // The server may simply be switched off.
    const untested = await handleSaveConnection(call("PUT", { ...body, test: false }), { check, lookup: unresolvable });
    expect(untested.status).toBe(200);
    expect(await current()).toMatchObject({ source: "app", baseUrl: "http://my-model-box:11434/v1" });
  });

  it("refuses a request that came through a proxy when no token is set, and says to set one", async () => {
    const proxied: Array<Record<string, string>> = [{ "x-forwarded-for": "1.2.3.4" }, { forwarded: "for=1.2.3.4" }, { "x-real-ip": "1.2.3.4" }, { via: "1.1 proxy" }];
    for (const extra of proxied) {
      const put = await handleSaveConnection(call("PUT", good, extra), { check: passes });
      expect(put.status, JSON.stringify(extra)).toBe(403);
      expect(((await put.json()) as { error: string }).error).toBe(CHANGE_REFUSED.proxy);
      expect(await view(handleGetConnection(read(extra)))).toMatchObject({ changeAllowed: "no" });
    }
    expect(await current()).toMatchObject({ source: "none", changeAllowed: "local" });
  });

  it("on a loopback server with a token configured, the token is required", async () => {
    useEnvironment({ SETTINGS_TOKEN: TOKEN });
    expect(await current()).toMatchObject({ changeAllowed: "token" });
    const without = await handleSaveConnection(call("PUT", good), { check: passes });
    expect(without.status).toBe(403);
    expect(((await without.json()) as { error: string }).error).toBe(CHANGE_REFUSED.tokenMissing);
    expect(await current()).toMatchObject({ source: "none" });
    const allowed = await handleSaveConnection(call("PUT", good, { "x-settings-token": TOKEN }), { check: passes });
    expect(allowed.status).toBe(200);
    expect(handleForgetConnection(call("DELETE")).status).toBe(403);
    expect(handleForgetConnection(call("DELETE", undefined, { "x-settings-token": TOKEN })).status).toBe(200);
  });

  it("counts refused attempts against the allowance, so a token cannot be guessed at speed", async () => {
    useEnvironment({ SETTINGS_TOKEN: TOKEN });
    const check = vi.fn(passes);
    const limit = getConfig().connectionRateLimitPerMinute;
    freshAllowance();
    const statuses: number[] = [];
    for (let i = 0; i < limit + 3; i++) {
      const guess = { "x-settings-token": `wrong-guess-number-${i}-0123456789` };
      // Saves and forgets draw on the same allowance.
      const response = i % 2 === 0 ? await handleSaveConnection(call("PUT", good, guess, true), { check }) : handleForgetConnection(call("DELETE", undefined, guess, true));
      statuses.push(response.status);
    }
    expect(statuses).toEqual([...Array.from({ length: limit }, () => 403), 429, 429, 429]);
    // While limited, the right token is refused as well, without being looked at.
    expect((await handleSaveConnection(call("PUT", good, { "x-settings-token": TOKEN }, true), { check })).status).toBe(429);
    expect(handleForgetConnection(call("DELETE", undefined, { "x-settings-token": TOKEN }, true)).status).toBe(429);
    expect(check).not.toHaveBeenCalled();
    expect(await current()).toMatchObject({ source: "none" });
    // With allowance again, it works.
    expect((await handleSaveConnection(call("PUT", good, { "x-settings-token": TOKEN }), { check })).status).toBe(200);
  });

  it("checks other sites first, then the limit, then who is asking, then the input", async () => {
    const limit = getConfig().connectionRateLimitPerMinute;
    freshAllowance();
    // Cross-site refusals do not draw on the allowance.
    for (let i = 0; i < limit + 2; i++) {
      expect((await handleSaveConnection(call("PUT", good, { "sec-fetch-site": "cross-site" }, true))).status).toBe(403);
    }
    // Unauthorized ones do, even with a body that is not valid.
    const foreign = { host: "docs.example.com" };
    for (let i = 0; i < limit; i++) {
      expect((await handleSaveConnection(call("PUT", { provider: "nonsense" }, foreign, true))).status).toBe(403);
    }
    expect((await handleSaveConnection(call("PUT", { provider: "nonsense" }, foreign, true))).status).toBe(429);
    expect((await handleSaveConnection(call("PUT", { provider: "nonsense" }, {}, true))).status).toBe(429);
    expect((await handleSaveConnection(call("PUT", { provider: "nonsense" }))).status).toBe(400);
  });

  it("forgetting returns to the environment", async () => {
    useEnvironment({ AI_GATEWAY_API_KEY: ENV_KEY });
    await handleSaveConnection(call("PUT", good), { check: passes });
    expect(await current()).toMatchObject({ source: "app", provider: "openai" });
    const forgotten = handleForgetConnection(call("DELETE"));
    expect(forgotten.status).toBe(200);
    expect(await view(forgotten)).toMatchObject({ source: "env", provider: "gateway", keyLast4: null });
    expect(loadConnection(":memory:")).toBeNull();
  });

  it("on a loopback server, refuses a foreign Host and says where to open the app instead", async () => {
    const remote = { host: "docs.example.com" };
    const put = await handleSaveConnection(call("PUT", good, remote), { check: passes });
    expect(put.status).toBe(403);
    expect(((await put.json()) as { error: string }).error).toBe(CHANGE_REFUSED.rebinding);
    expect(await current()).toMatchObject({ source: "none", changeAllowed: "local" });
    expect(await view(handleGetConnection(read(remote)))).toMatchObject({ changeAllowed: "no" });

    saveConnection(":memory:", openai);
    expect(handleForgetConnection(call("DELETE", undefined, remote)).status).toBe(403);
    expect(await current()).toMatchObject({ source: "app" });
  });

  it("off loopback with no token, refuses a request that says Host: localhost, and says what to do", async () => {
    useEnvironment(ALL_INTERFACES);
    const check = vi.fn(passes);
    const put = await handleSaveConnection(call("PUT", good), { check });
    expect(put.status).toBe(403);
    expect(((await put.json()) as { error: string }).error).toBe(CHANGE_REFUSED.no);
    saveConnection(":memory:", openai);
    expect(handleForgetConnection(call("DELETE")).status).toBe(403);
    expect(check).not.toHaveBeenCalled();
    expect(await current()).toMatchObject({ source: "app", changeAllowed: "no" });
  });

  it("off loopback with a token, changes need the token and reading says so", async () => {
    useEnvironment({ ...ALL_INTERFACES, SETTINGS_TOKEN: TOKEN });
    const remote = { host: "docs.example.com" };
    expect(await view(handleGetConnection(read(remote)))).toMatchObject({ changeAllowed: "token" });

    const without = await handleSaveConnection(call("PUT", good, remote), { check: passes });
    expect(without.status).toBe(403);
    expect(((await without.json()) as { error: string }).error).toBe(CHANGE_REFUSED.tokenMissing);
    const wrong = await handleSaveConnection(call("PUT", good, { ...remote, "x-settings-token": "not-the-token-0123456789" }), { check: passes });
    expect(wrong.status).toBe(403);
    expect(await current()).toMatchObject({ source: "none" });

    const allowed = await handleSaveConnection(call("PUT", good, { ...remote, "x-settings-token": TOKEN }), { check: passes });
    expect(allowed.status).toBe(200);
    expect(handleForgetConnection(call("DELETE", undefined, remote)).status).toBe(403);
    expect(await current()).toMatchObject({ source: "app" });
    expect(handleForgetConnection(call("DELETE", undefined, { ...remote, "x-settings-token": TOKEN })).status).toBe(200);
    expect(await current()).toMatchObject({ source: "none" });
  });

  it("refuses to save a link-local or metadata address, tested or not", async () => {
    const check = vi.fn(passes);
    for (const baseUrl of ["http://169.254.169.254/v1", "http://metadata.google.internal/v1", "http://[fe80::1]/v1"]) {
      for (const test of [true, false]) {
        const response = await handleSaveConnection(call("PUT", { provider: "openai-compatible", baseUrl, model: "m", test }), { check });
        expect(response.status, baseUrl).toBe(400);
        expect(((await response.json()) as { error: string }).error).toMatch(/cannot be used/);
      }
    }
    expect(check).not.toHaveBeenCalled();
    expect(await current()).toMatchObject({ source: "none" });
  });

  it("a failed test answers with a fixed sentence and nothing from the upstream reply", async () => {
    const SECRET_BODY = "internal-admin-page: root password is hunter2";
    const upstream = (statusCode: number | undefined) =>
      new APICallError({
        message: `Upstream said: ${SECRET_BODY}`,
        url: "http://10.0.0.5/v1/chat/completions",
        requestBodyValues: {},
        statusCode,
        responseBody: SECRET_BODY,
        responseHeaders: { "x-internal": SECRET_BODY },
      });
    const local = { provider: "openai-compatible", baseUrl: "http://10.0.0.5/v1", model: "m" };
    const expected: Array<[unknown, string]> = [
      [upstream(401), "The provider rejected the API key."],
      [upstream(403), "The provider rejected the API key."],
      [upstream(404), "The provider does not know that model id."],
      [upstream(429), "The provider is rate limiting requests. Wait a moment and try again."],
      [upstream(500), "The request failed with status 500."],
      [upstream(200), "The request failed with status 200."],
      [upstream(undefined), "The server could not be reached, or did not answer like a model API. Check the address and that the server is running."],
      [new TypeError(`fetch failed: ${SECRET_BODY}`), "The server could not be reached, or did not answer like a model API. Check the address and that the server is running."],
      [Object.assign(new Error(SECRET_BODY), { name: "TimeoutError" }), "The server did not answer in time."],
    ];
    for (const [failure, sentence] of expected) {
      providers.failure = failure;
      const response = await handleSaveConnection(call("PUT", local));
      const text = await response.text();
      expect(response.status).toBe(422);
      expect(JSON.parse(text)).toEqual({ error: `Nothing was saved. ${sentence}` });
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("10.0.0.5");
    }
    expect(await current()).toMatchObject({ source: "none" });
  });

  it("refuses other sites before anything else", async () => {
    const crossSite = { "sec-fetch-site": "cross-site" };
    const check = vi.fn(passes);
    expect((await handleSaveConnection(call("PUT", good, crossSite), { check })).status).toBe(403);
    saveConnection(":memory:", openai);
    expect(handleForgetConnection(call("DELETE", undefined, crossSite)).status).toBe(403);
    expect(check).not.toHaveBeenCalled();
    expect(await current()).toMatchObject({ source: "app" });
  });

  it("rejects input outside the bounds and saves nothing", async () => {
    const check = vi.fn(passes);
    const bad: Array<[string, unknown]> = [
      ["no body", undefined],
      ["unknown provider", { ...good, provider: "someone-else" }],
      ["key too long", { ...good, apiKey: "k".repeat(401) }],
      ["key with a space", { ...good, apiKey: "sk-abc def-0123456789" }],
      ["no key", { provider: "anthropic", model: "claude-x" }],
      ["no model", { provider: "openai", apiKey: KEY }],
      ["model id too long", { ...good, model: "m".repeat(121) }],
      ["too many model ids", { ...good, models: Array.from({ length: 21 }, (_, i) => `m${i}`) }],
      ["a model outside the gateway list", { provider: "gateway", apiKey: KEY, model: "someone/unlisted" }],
      ["no address", { provider: "openai-compatible", model: "m" }],
      ["an address that is not a URL", { provider: "openai-compatible", baseUrl: "localhost:11434", model: "m" }],
      ["an address that is not http", { provider: "openai-compatible", baseUrl: "file:///etc/passwd", model: "m" }],
      ["an address carrying a login", { provider: "openai-compatible", baseUrl: "http://u:p@localhost:11434/v1", model: "m" }],
      ["a test flag that is not a boolean", { ...good, test: "yes" }],
    ];
    for (const [name, body] of bad) {
      const response = await handleSaveConnection(call("PUT", body), { check });
      expect(response.status, name).toBe(400);
      expect(((await response.json()) as { error: string }).error, name).toMatch(/\.$/);
    }
    expect(check).not.toHaveBeenCalled();
    expect(await current()).toMatchObject({ source: "none" });
  });

  it("limits how often a connection can be saved", async () => {
    const check = vi.fn(passes);
    const limit = getConfig().connectionRateLimitPerMinute;
    const statuses: number[] = [];
    for (let i = 0; i < limit + 2; i++) {
      statuses.push((await handleSaveConnection(call("PUT", good, {}, i > 0), { check })).status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(limit);
    expect(statuses.at(-1)).toBe(429);
    expect(check).toHaveBeenCalledTimes(limit);
  });

  it("refuses to save in mock mode, where no connection can be used", async () => {
    useEnvironment({ AI_MODE: "mock" });
    expect((await handleSaveConnection(call("PUT", good), { check: passes })).status).toBe(409);
  });
});

describe("the key stays out of logs and responses", () => {
  it("through a failed test, a save, a read, a logged provider error and a forget", async () => {
    useEnvironment({ LOG_IN_TESTS: "1" });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(String(line)));
    vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(String(line)));
    const body = { provider: "openai", apiKey: KEY, model: "gpt-x" };
    const bodies: string[] = [];
    const keep = async (response: Response) => bodies.push(`${response.status} ${await response.text()}`);

    // A provider that quotes the key back in its error.
    providers.failWith = `Incorrect API key provided: ${KEY}. Check your key.`;
    await keep(await handleSaveConnection(call("PUT", body)));
    providers.failWith = null;
    await keep(await handleSaveConnection(call("PUT", body)));
    await keep(handleGetConnection(read()));
    // Other code logs raw provider errors; the logger itself must hide a saved key.
    log.error("generation_failed", { error: `401 for bearer ${KEY}` });
    await keep(handleForgetConnection(call("DELETE")));

    expect(bodies.map((entry) => entry.slice(0, 3))).toEqual(["422", "200", "200", "200"]);
    expect(lines.some((line) => line.includes("connection_test_failed"))).toBe(true);
    expect(lines.some((line) => line.includes("connection_saved"))).toBe(true);
    expect(lines.some((line) => line.includes("generation_failed") && line.includes("[key hidden]"))).toBe(true);
    for (const text of [...lines, ...bodies]) expect(text).not.toContain(KEY);
    // Only the last four characters are ever shown.
    expect(bodies[1]).toContain('"keyLast4":"ab12"');
  });

  it("the settings token stays out of them too, whether it was right, wrong or missing", async () => {
    useEnvironment({ ...ALL_INTERFACES, SETTINGS_TOKEN: TOKEN, LOG_IN_TESTS: "1" });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(String(line)));
    vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(String(line)));
    const body = { provider: "openai", apiKey: KEY, model: "gpt-x" };
    const bodies: string[] = [];
    const keep = async (response: Response) => bodies.push(`${response.status} ${await response.text()}`);
    const WRONG = "wrong-token-0123456789";

    await keep(await handleSaveConnection(call("PUT", body)));
    await keep(await handleSaveConnection(call("PUT", body, { "x-settings-token": WRONG })));
    providers.failWith = `upstream echoes ${TOKEN}`;
    await keep(await handleSaveConnection(call("PUT", body, { "x-settings-token": TOKEN })));
    providers.failWith = null;
    await keep(await handleSaveConnection(call("PUT", body, { "x-settings-token": TOKEN })));
    await keep(handleGetConnection(read()));
    log.error("generation_failed", { error: `saw ${TOKEN}` });
    await keep(handleForgetConnection(call("DELETE", undefined, { "x-settings-token": TOKEN })));

    expect(bodies.map((entry) => entry.slice(0, 3))).toEqual(["403", "403", "422", "200", "200", "200"]);
    expect(lines.some((line) => line.includes("connection_saved"))).toBe(true);
    for (const text of [...lines, ...bodies]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(WRONG);
      expect(text).not.toContain(KEY);
    }
  });
});

describe("the model resolver", () => {
  const savedFor = (provider: SavedConnection["provider"]): SavedConnection => ({
    provider,
    apiKey: KEY,
    baseUrl: provider === "openai-compatible" ? "https://llm.example/v1" : null,
    model: provider === "gateway" ? "zai/glm-5.3" : "m1",
    models: [],
  });

  it("hands the saved key to each provider explicitly", async () => {
    for (const provider of ["gateway", "openai", "anthropic", "google", "openai-compatible"] as const) {
      const config = buildConfig(liveEnv(), () => savedFor(provider));
      await resolveChatModel(config, config.chatModel);
      expect(providers.calls.at(-1), provider).toMatchObject({ provider, settings: { apiKey: KEY } });
    }
    expect(providers.calls.at(-1)?.settings?.baseURL).toBe("https://llm.example/v1");
    // The one provider whose address someone typed is given a fetch that will not follow redirects.
    expect(providers.calls.at(-1)?.settings?.fetch).toBe(fetchWithoutRedirects);
  });

  it("the OpenAI-compatible provider's fetch refuses redirects, from the environment as well", async () => {
    const config = buildConfig(liveEnv({ LLM_BASE_URL: "http://localhost:11434/v1", CHAT_MODEL: "m1" }));
    await resolveChatModel(config, "m1");
    expect(providers.calls.at(-1)?.settings?.fetch).toBe(fetchWithoutRedirects);

    const sent = vi.fn<typeof fetch>(async () => new Response("{}"));
    vi.stubGlobal("fetch", sent);
    try {
      await fetchWithoutRedirects("http://localhost:11434/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer k" },
        redirect: "follow",
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveBeenCalledTimes(1);
    // Whatever the caller asked for, the request goes out refusing redirects, with the rest untouched.
    expect(sent.mock.calls[0][1]).toEqual({ method: "POST", headers: { authorization: "Bearer k" }, redirect: "error" });
    // The key is passed in, not planted in the environment for the SDKs to find.
    expect(Object.values(process.env)).not.toContain(KEY);
  });

  it("passes no key when the connection comes from the environment", async () => {
    const config = buildConfig(liveEnv({ OPENAI_API_KEY: ENV_KEY, CHAT_MODEL: "m1" }));
    await resolveChatModel(config, "m1");
    expect(providers.calls.at(-1)).toMatchObject({ provider: "openai" });
    expect(providers.calls.at(-1)?.settings?.apiKey).toBeUndefined();
    // The gateway from the environment stays a plain id, resolved by the SDK.
    const gateway = buildConfig(liveEnv({ AI_GATEWAY_API_KEY: ENV_KEY }));
    expect(await resolveChatModel(gateway, gateway.chatModel)).toBe(gateway.chatModel);
  });

  it("does not lend the environment's key to a local server saved without one", async () => {
    process.env.LLM_API_KEY = ENV_KEY;
    const config = buildConfig(liveEnv({ LLM_API_KEY: ENV_KEY }), () => ({ ...savedFor("openai-compatible"), apiKey: null }));
    await resolveChatModel(config, "m1");
    expect(providers.calls.at(-1)?.settings?.apiKey).toBeUndefined();
  });

  it("translates the SDK's own wording for a rejected gateway key", () => {
    // What generateText throws for a wrong gateway key, in development and in production.
    const development = Object.assign(new Error("\u001b[1mUnauthenticated request to AI Gateway.\u001b[0m\n\nTo authenticate, set"), {
      name: "GatewayAuthenticationError",
    });
    const production = new Error("Unauthenticated. Configure AI_GATEWAY_API_KEY or use a provider module.");
    for (const error of [development, production]) {
      expect(describeAiError(error)).toBe(
        "The AI Gateway key is missing or invalid. Check the key under Settings, Connection, or AI_GATEWAY_API_KEY in .env.local.",
      );
    }
  });

  it("checks candidate settings and repeats nothing a failing server said", async () => {
    const config = buildConfig(liveEnv(), () => savedFor("openai"));
    expect(await checkConnection(config)).toMatchObject({ ok: true, provider: "openai", model: "m1" });
    providers.failWith = `bad key ${KEY}`;
    const failed = await checkConnection(config);
    expect(failed.ok).toBe(false);
    expect(failed.message).toBe(
      "The server could not be reached, or did not answer like a model API. Check the address and that the server is running.",
    );
  });

  it("names a rejected gateway key from the SDK's own wording", () => {
    const development = Object.assign(new Error("\u001b[1mUnauthenticated request to AI Gateway.\u001b[0m"), {
      name: "GatewayAuthenticationError",
    });
    const production = new Error("Unauthenticated. Configure AI_GATEWAY_API_KEY or use a provider module.");
    for (const error of [development, production]) expect(describeCheckFailure(error)).toBe("The provider rejected the API key.");
  });
});
