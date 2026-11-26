import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatUIMessage } from "@/lib/chat-types";
import type { ConnectionView, DocumentSummary, HealthReport, Note, SourceGuide, SourceRef, TraceData } from "@/lib/types";
import { ConnectionSettings, type ConnectionStatus } from "./ConnectionSettings";
import { Conversation } from "./Conversation";
import { Guide } from "./Guide";
import { Library, type UploadState } from "./Library";
import { Margin } from "./Margin";
import { Notes } from "./Notes";

/**
 * Each pane rendered to HTML with fixed props. There is no browser here, so
 * these prove what a state shows (the wording of a prompt, which passages are
 * grouped where, that untrusted text is escaped), not how it behaves on a tap.
 */
const noop = () => {};

const doc = (id: string, name: string, extra: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id,
  name,
  mime: "text/markdown",
  bytes: 2048,
  pages: null,
  ocrPages: 0,
  chunkCount: 4,
  status: "ready",
  error: null,
  createdAt: "2026-11-20T09:30:00.000Z",
  ...extra,
});

const ref = (n: number, extra: Partial<SourceRef> = {}): SourceRef => ({
  n,
  chunkId: `d1:${n}`,
  documentId: "d1",
  documentName: "handbook.md",
  heading: "Leave",
  page: null,
  pageEnd: null,
  content: `Passage ${n} text.`,
  similarity: 0.81,
  denseRank: n,
  lexicalRank: null,
  fusedScore: 0.01,
  ...extra,
});

const trace: TraceData = {
  id: "t1",
  outcome: "answered",
  mode: "gateway",
  model: "m1",
  provider: "token-pass",
  question: "How much leave?",
  searchQuery: "How much leave?",
  stages: [{ name: "search", ms: 12 }],
  totalMs: 900,
  bestSimilarity: 0.81,
  retrievedCount: 3,
  usage: { inputTokens: 800, outputTokens: 40 },
  costUsd: 0.00014,
  citations: { cited: [2], invalid: [], grounded: true },
  complete: true,
};

const question: ChatUIMessage = { id: "q1", role: "user", parts: [{ type: "text", text: "How much leave?" }] };
const answer: ChatUIMessage = {
  id: "a1",
  role: "assistant",
  parts: [
    { type: "data-sources", id: "sources", data: { sources: [ref(1), ref(2), ref(3)] } },
    { type: "text", text: "Employees accrue 1.5 days per month [2]. See [9]." },
    { type: "data-trace", id: "trace", data: trace },
  ],
};

const health: HealthReport = {
  ok: true,
  mode: "gateway",
  chatModel: "m1",
  chatModels: [{ id: "m1", label: "Model One" }],
  provider: "openai-compatible",
  local: true,
  connectionSource: "env",
  warning: null,
  embeddingModel: "e",
  documents: 2,
  chunks: 8,
  limits: { maxDocuments: 50, maxUploadMb: 15 },
};

function library(uploads: UploadState[], documents: DocumentSummary[] = [doc("d1", "handbook.md"), doc("d2", "runbook.md")]) {
  return renderToStaticMarkup(
    <Library
      documents={documents}
      uploads={uploads}
      excluded={new Set(["d2"])}
      loaded
      selected={1}
      openedId={null}
      limits={{ maxDocuments: 50, maxUploadMb: 15 }}
      onDismissUpload={noop}
      onPassword={noop}
      onAllowScan={noop}
      onSkipScan={noop}
      onToggle={noop}
      onSelectAll={noop}
      onSelectNone={noop}
      onOpen={noop}
      onAdd={noop}
      onRemove={noop}
      onLoadSamples={noop}
    />,
  );
}

describe("library", () => {
  it("says what is selected, what the boxes do, and keeps the limit in view", () => {
    const html = library([]);
    expect(html).toContain("2 sources, 1 selected");
    expect(html).toContain("2 of 50 allowed");
    expect(html).toContain("Ticked sources are searched when you ask.");
    expect(html).toContain("Select all");
    expect(html).toContain("Clear");
    expect(html).toContain("Sources (2)");
    // A long name is cut by CSS; the full name stays available as a tooltip.
    expect(html).toContain('title="handbook.md"');
  });

  it("asks for a password in the file's own row, and says when it was wrong", () => {
    const first = library([{ name: "memo.pdf", status: "password", stage: "", wrongPassword: false }]);
    expect(first).toContain("This PDF is password-protected. Enter its password to read it.");
    expect(first).toContain('type="password"');
    const wrong = library([{ name: "memo.pdf", status: "password", stage: "", wrongPassword: true }]);
    expect(wrong).toContain("That password did not open this PDF.");
  });

  it("asks before a scan is read and says where the page images would go", () => {
    const remote = library([
      { name: "scan.pdf", status: "scan", stage: "", scan: { pages: 3, textPages: 2, provider: "Vercel AI Gateway", local: false } },
    ]);
    expect(remote).toContain("3 pages of this file are scans with no text layer.");
    expect(remote).toContain("Reading them sends the page images to Vercel AI Gateway.");
    for (const action of ["Read this file", "Always read scans this session", "Skip this file"]) expect(remote).toContain(action);

    const local = library([
      { name: "scan.pdf", status: "scan", stage: "", scan: { pages: 2, textPages: 0, provider: "x", local: true } },
    ]);
    expect(local).toContain("They are read by the model on this machine. Nothing leaves it.");
    expect(local).not.toContain("sends the page");
  });

  it("offers the samples when empty, and warns that one is a scan", () => {
    const html = library([], []);
    expect(html).toContain("Load five sample documents");
    expect(html).toContain("you will be asked before it is read");
  });
});

function conversation(messages: ChatUIMessage[], extra: Partial<Parameters<typeof Conversation>[0]> = {}) {
  return renderToStaticMarkup(
    <Conversation
      messages={messages}
      status="ready"
      error={null}
      health={health}
      model=""
      hint={null}
      selected={2}
      total={5}
      shownMessageId="a1"
      activeCitation={{ messageId: "a1", n: 2 }}
      savedKeys={new Set()}
      exportStatus={null}
      canExport
      onModel={noop}
      onAsk={noop}
      onStop={noop}
      onRetry={noop}
      onDismissError={noop}
      onClear={noop}
      onFocus={noop}
      onSaveAnswer={noop}
      onCopyExport={noop}
      onDownloadExport={noop}
      onConnectionChanged={noop}
      onOpenSheet={noop}
      {...extra}
    />,
  );
}

describe("conversation", () => {
  it("marks the selected citation, leaves a made-up number as text, and offers to save the answer", () => {
    const html = conversation([question, answer]);
    expect(html).toMatch(/<button[^>]*class="cite active"[^>]*aria-pressed="true"[^>]*>2<\/button>/);
    expect(html).toContain("See [9].");
    expect(html).toContain("Save as note");
    expect(html).toContain("Answering from 2 of 5 sources");
  });

  it("groups the session controls and shows when the model is local", () => {
    const html = conversation([]);
    for (const control of ["Check connection", "Connection</button>", "Start a new conversation", "Copy as Markdown", "Download", "Local model"]) {
      expect(html).toContain(control);
    }
    expect(html).toContain("Ask a question, then read the passage it came from.");
  });

  it("drops an image and unlinks a link the model was talked into writing", () => {
    const hostile: ChatUIMessage = {
      id: "a2",
      role: "assistant",
      parts: [{ type: "text", text: "![x](https://evil.example/p.png) and [click](https://evil.example/?q=secret)" }],
    };
    const html = conversation([question, hostile]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
    expect(html).toContain("<span>click</span>");
  });
});

function margin(extra: Partial<Parameters<typeof Margin>[0]>) {
  return renderToStaticMarkup(
    <Margin
      tabs={["evidence", "trace", "notes"]}
      tab="evidence"
      onTab={noop}
      message={answer}
      activeN={2}
      writing={false}
      onSelect={noop}
      guide={{ status: "idle" }}
      guideHint={null}
      canAsk
      onAsk={noop}
      onRetryGuide={noop}
      notes={[]}
      noteError={null}
      documentIds={new Set(["d1"])}
      onRenameNote={noop}
      onDeleteNote={noop}
      savedKeys={new Set(["passage:d1:3"])}
      onSavePassage={noop}
      opened={null}
      onOpenSource={noop}
      onCloseSource={noop}
      onAskOnly={noop}
      isSheet
      sheetOpen={false}
      onCloseSheet={noop}
      {...extra}
    />,
  );
}

describe("right pane", () => {
  it("lists cited passages first and folds the rest away", () => {
    const html = margin({});
    expect(html).toContain("Cited (1)");
    expect(html).toContain("Retrieved, not cited (2)");
    expect(html.indexOf("Cited (1)")).toBeLessThan(html.indexOf("Retrieved, not cited (2)"));
    // The selected passage carries the same selected state as its marker in the answer.
    expect(html).toMatch(/<li class="note active">/);
    expect(html).toContain("Open in source");
    expect(html).toContain("Saved to notes");
    expect(html).not.toMatch(/<details[^>]*open/);
  });

  it("opens the folded group when the selected passage is inside it", () => {
    expect(margin({ activeN: 3 })).toMatch(/<details[^>]*open/);
  });

  it("gives the trace its own tab", () => {
    const html = margin({ tab: "trace" });
    expect(html).toContain("How it was built");
    expect(html).toContain("Answered from the cited passages");
    expect(html).toContain("800 in, 40 out");
    expect(html).not.toContain("Cited (1)");
  });
});

describe("guide", () => {
  const guide: SourceGuide = {
    mode: "model",
    overview: "A handbook and a runbook. <b>Not markup</b>.",
    questions: ["How much leave?", "What is E-4012?", "Who is on call?"],
    sources: [
      { id: "d1", name: "handbook.md", passages: 11 },
      { id: "d2", name: "runbook.md", passages: 1 },
    ],
    model: "m1",
  };
  const render = (state: Parameters<typeof Guide>[0]["state"], hint: string | null = null) =>
    renderToStaticMarkup(<Guide state={state} hint={hint} canAsk onAsk={noop} onRetry={noop} />);

  it("shows the overview as plain text and the questions as suggestions", () => {
    const html = render({ status: "ready", key: "k", guide });
    expect(html).toContain("About these 2 sources");
    expect(html).toContain("Try asking");
    expect(html).toContain("&lt;b&gt;Not markup&lt;/b&gt;");
    expect(html.match(/<button/g)).toHaveLength(3);
  });

  it("offline, lists names and passage counts and promises no overview", () => {
    const html = render({ status: "ready", key: "k", guide: { ...guide, mode: "offline", overview: null, questions: [] } });
    expect(html).toContain("No model is connected");
    expect(html).toContain("11 passages");
    expect(html).toContain("1 passage<");
    expect(html).not.toContain("Try asking");
  });

  it("covers waiting, failure and nothing to guide", () => {
    expect(render({ status: "loading", key: "k" })).toContain("Reading the opening of your sources");
    expect(render({ status: "error", key: "k", message: "The provider is rate limiting requests." })).toContain("Try again");
    expect(render({ status: "idle" }, "Add a source to start asking questions.")).toContain("Add a source");
  });
});

describe("connection settings", () => {
  const view = (extra: Partial<ConnectionView> = {}): ConnectionView => ({
    source: "none",
    provider: null,
    keySet: false,
    keyLast4: null,
    baseUrl: null,
    model: "deepseek/deepseek-v4.1-flash-1017",
    models: [],
    local: false,
    changeAllowed: "local",
    ...extra,
  });
  const render = (extra: Partial<ConnectionView> = {}, status: ConnectionStatus = { kind: "idle" }, token = "") =>
    renderToStaticMarkup(
      <ConnectionSettings view={view(extra)} status={status} token={token} onToken={noop} onSave={noop} onForget={noop} onClose={noop} />,
    );

  it("asks for the settings token only when the server requires one", () => {
    expect(render()).not.toContain("Settings token");
    const html = render({ changeAllowed: "token", source: "app", provider: "openai", model: "gpt-x" }, { kind: "idle" }, "typed-token");
    expect(html).toContain('<label for="connection-token">Settings token</label>');
    expect(html).toMatch(/<input[^>]*id="connection-token"[^>]*type="password"[^>]*required=""/);
    expect(html).toContain("is never stored");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Test and save/);
  });

  it("when the connection cannot be changed here, says what to do and locks the actions", () => {
    const html = render({ changeAllowed: "no", source: "app", provider: "openai", model: "gpt-x" });
    expect(html).toContain("The connection cannot be changed from here.");
    expect(html).toContain("<code>SETTINGS_TOKEN</code>");
    expect(html).toContain("<code>npm run dev</code>");
    for (const action of ["Test and save", "Save without testing", "Forget this connection"]) {
      expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${action}</button>`));
    }
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Close<\/button>/);
    expect(html).not.toContain("Settings token");
  });

  it("with nothing connected, offers every provider, the gateway list and the three actions", () => {
    const html = render();
    expect(html).toContain("No model connected.");
    for (const name of ["Vercel AI Gateway", "OpenAI", "Anthropic", "Google", "OpenAI-compatible or local server"]) {
      expect(html).toContain(`>${name}</option>`);
    }
    expect(html).toContain(">DeepSeek V4.1 Flash (1017)</option>");
    for (const action of ["Test and save", "Save without testing", "Forget this connection", "Close"]) expect(html).toContain(action);
    // Nothing is saved in the app, so there is nothing to forget and a key is required.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Forget this connection<\/button>/);
    expect(html).toMatch(/<input[^>]*id="connection-key"[^>]*type="password"[^>]*required=""/);
    expect(html).not.toContain("Server address");
  });

  it("labels every field", () => {
    const html = render({ source: "app", provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3.2" });
    const ids = [...html.matchAll(/<(?:input|select)[^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(["connection-provider", "connection-address", "connection-key", "connection-model", "connection-more"]);
    for (const id of ids) expect(html).toContain(`<label for="${id}">`);
  });

  it("for a saved key, shows its last four characters and an empty field", () => {
    const html = render({ source: "app", provider: "openai", keySet: true, keyLast4: "ab12", model: "gpt-x", models: ["gpt-x", "gpt-y"] });
    expect(html).toContain("A key ending in ab12 is saved. Leave this empty to keep it.");
    expect(html).toContain("<strong>OpenAI, gpt-x.</strong> Set in this app.");
    expect(html).toMatch(/<input[^>]*id="connection-key"[^>]*value=""/);
    expect(html).not.toMatch(/<input[^>]*id="connection-key"[^>]*required/);
    expect(html).toMatch(/<input[^>]*id="connection-model"[^>]*value="gpt-x"/);
    expect(html).toMatch(/<input[^>]*id="connection-more"[^>]*value="gpt-y"/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Forget this connection/);
  });

  it("for a local server, asks for the address, offers the two fills and makes the promise", () => {
    const html = render({ source: "app", provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3.2", local: true });
    expect(html).toContain("Local model, nothing leaves this machine");
    expect(html).toMatch(/<input[^>]*id="connection-address"[^>]*value="http:\/\/localhost:11434\/v1"/);
    expect(html).toContain("Use Ollama");
    expect(html).toContain("Use LM Studio");
    expect(html).toContain("Not needed for a local server.");
    expect(html).not.toMatch(/<input[^>]*id="connection-key"[^>]*required/);
  });

  it("says when the connection comes from the settings file", () => {
    const html = render({ source: "env", provider: "gateway", keySet: true });
    expect(html).toContain("From the settings file.");
    expect(html).not.toContain("is saved. Leave this empty");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Forget this connection<\/button>/);
  });

  it("shows a refusal as an alert, a success as a status, and locks the form while working", () => {
    const refused = render({}, { kind: "failed", message: "The connection can only be changed from the machine the app runs on." });
    expect(refused).toMatch(/<p class="settings-status failed" role="alert">The connection can only be changed/);
    const saved = render({}, { kind: "saved", message: "The model answered. The connection is saved and in use." });
    expect(saved).toMatch(/<p class="settings-status ok" role="status">The model answered\./);
    const working = render({}, { kind: "working", message: "Asking the model for one word" });
    expect(working).toMatch(/<button[^>]*disabled=""[^>]*>Test and save<\/button>/);
    expect(working).not.toMatch(/<button[^>]*disabled=""[^>]*>Close<\/button>/);
  });
});

describe("notes", () => {
  const note: Note = {
    id: "n1",
    kind: "answer",
    title: "Leave accrual",
    body: "1.5 days per month [1]. <script>alert(1)</script>",
    question: "How much leave?",
    sources: [
      { n: 1, chunkId: "d1:1", documentId: "d1", documentName: "handbook.md", heading: "Leave", page: null, pageEnd: null },
      { n: 2, chunkId: "gone:4", documentId: "gone", documentName: "old-policy.pdf", heading: null, page: 3, pageEnd: 3 },
    ],
    createdAt: "2026-11-20T09:30:00.000Z",
  };
  const render = (notes: Note[]) =>
    renderToStaticMarkup(<Notes notes={notes} error={null} documentIds={new Set(["d1"])} onRename={noop} onDelete={noop} />);

  it("shows the note with an editable title, its sources, and which source is gone", () => {
    const html = render([note]);
    expect(html).toMatch(/<input[^>]*value="Leave accrual"/);
    expect(html).toContain("In reply to: How much leave?");
    expect(html).toContain("handbook.md, Leave");
    expect(html).toContain("old-policy.pdf, Page 3");
    expect(html.match(/This source has been removed\./g)).toHaveLength(1);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Delete");
  });

  it("explains itself when empty", () => {
    expect(render([])).toContain("Nothing saved yet.");
  });
});
