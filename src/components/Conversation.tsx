"use client";

import type { ChatStatus } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatUIMessage } from "@/lib/chat-types";
import {
  checkModelConnection,
  formatMs,
  linkCitations,
  scopeLine,
  sourcesOf,
  textOf,
  traceOf,
  type ConnectionResult,
} from "@/lib/client";
import type { HealthReport, TraceData } from "@/lib/types";
import { ConnectionDialog } from "./ConnectionSettings";
import type { Focus } from "./Workspace";

interface Props {
  messages: ChatUIMessage[];
  status: ChatStatus;
  error: Error | null;
  health: HealthReport | null;
  model: string;
  /** Why asking is unavailable right now, or null when it is. */
  hint: string | null;
  /** Ticked sources, and all ready sources. */
  selected: number;
  total: number;
  shownMessageId: string | null;
  activeCitation: Focus | null;
  /** Answers and passages already saved as notes in this session. */
  savedKeys: ReadonlySet<string>;
  exportStatus: string | null;
  canExport: boolean;
  onModel: (model: string) => void;
  onAsk: (text: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onDismissError: () => void;
  onClear: () => void;
  onFocus: (focus: Focus) => void;
  onSaveAnswer: (messageId: string) => void;
  onCopyExport: () => void;
  onDownloadExport: () => void;
  /** A connection was saved or forgotten in the settings panel. */
  onConnectionChanged: () => void;
  /** Phones only: opens the evidence and notes sheet. */
  onOpenSheet: () => void;
}

function Answer(props: { text: string; sourceCount: number; activeN: number | null; onCite: (n: number) => void }) {
  const { text, sourceCount, activeN, onCite } = props;
  const linked = useMemo(() => linkCitations(text, sourceCount), [text, sourceCount]);

  return (
    <div className="answer">
      <Markdown
        remarkPlugins={[remarkGfm]}
        // Images are dropped for the same reason: the browser would fetch them unprompted.
        disallowedElements={["img"]}
        components={{
          a({ href, children }) {
            const match = /^#cite-(\d+)$/.exec(href ?? "");
            // Any other link is shown as text. A document could instruct the model to
            // emit a link that carries conversation data to another site.
            if (!match) return <span>{children}</span>;
            const n = Number(match[1]);
            const active = n === activeN;
            return (
              <button
                type="button"
                className={active ? "cite active" : "cite"}
                onClick={() => onCite(n)}
                aria-pressed={active}
                aria-label={`Show passage ${n}`}
              >
                {n}
              </button>
            );
          },
        }}
      >
        {linked}
      </Markdown>
    </div>
  );
}

/** One line under each answer: what produced it and whether its citations hold up. */
function AnswerFoot({ trace, modelName }: { trace: TraceData; modelName: string }) {
  if (!trace.complete) return null;
  const citations = trace.citations;
  const written = trace.outcome === "answered" && trace.mode === "gateway";

  return (
    <p className="answer-foot">
      {written && <span>{modelName}</span>}
      <span>{formatMs(trace.totalMs)}</span>
      {trace.outcome === "answered" && citations?.grounded && (
        <span>
          Cites {citations.cited.length} of {trace.retrievedCount} passages
        </span>
      )}
      {written && citations && !citations.grounded && (
        <span className="warn">No passage is cited. Check this answer against the evidence.</span>
      )}
      {citations && citations.invalid.length > 0 && (
        <span className="warn">Refers to a passage number that does not exist.</span>
      )}
    </p>
  );
}

export function Conversation(props: Props) {
  const { messages, status, error, health, model, hint, shownMessageId, activeCitation, savedKeys } = props;
  const [draft, setDraft] = useState("");
  const [connection, setConnection] = useState<ConnectionResult | "checking" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  // In component state only: gone when the page is closed, never written to storage.
  const [settingsToken, setSettingsToken] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const busy = status === "submitted" || status === "streaming";
  const last = messages.at(-1);
  const waiting = busy && (last?.role === "user" || (last ? textOf(last) === "" : true));
  const offline = health?.mode === "offline";
  const labels = useMemo(() => new Map(health?.chatModels.map((entry) => [entry.id, entry.label])), [health]);

  useEffect(() => {
    // "nearest" keeps a phone from jumping when the thread is already in view.
    if (messages.length > 0) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, waiting]);

  const selectedModel = model || health?.chatModel || "";
  const runCheck = async () => {
    setConnection("checking");
    setConnection(await checkModelConnection(selectedModel).catch(() => null));
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || busy || hint) return;
    props.onAsk(text);
    setDraft("");
  };

  return (
    <section className="pane conversation" aria-label="Conversation">
      {offline && (
        <p className="notice" role="status">
          {health?.warning ?? "No model is connected, so answers are quoted passages."}{" "}
          <button type="button" className="link" onClick={() => setConnectionOpen(true)}>
            Connect a model
          </button>{" "}
          for written answers, or add a key to <code>.env.local</code>.
        </p>
      )}

      <div className="thread">
        <div className="thread-inner">
          {messages.length === 0 && (
            <div className="welcome">
              <h2>Ask a question, then read the passage it came from.</h2>
              <p>
                Every answer is written only from your sources and cites the passages it used. The numbers in an
                answer open the matching passage.
              </p>
            </div>
          )}

          {messages.map((message) => {
            const text = textOf(message);
            if (message.role === "user") {
              return (
                <div key={message.id} className="turn user">
                  <p>{text}</p>
                </div>
              );
            }
            if (!text) return null;
            const trace = traceOf(message);
            const activeN = activeCitation?.messageId === message.id ? activeCitation.n : null;
            const finished = !busy || message.id !== last?.id;
            const saved = savedKeys.has(`answer:${message.id}`);
            return (
              <div
                key={message.id}
                className={message.id === shownMessageId ? "turn assistant selected" : "turn assistant"}
              >
                <Answer
                  text={text}
                  sourceCount={sourcesOf(message).length}
                  activeN={activeN}
                  onCite={(n) => props.onFocus({ messageId: message.id, n })}
                />
                {trace && <AnswerFoot trace={trace} modelName={labels.get(trace.model) ?? trace.model} />}
                {finished && (
                  <p className="answer-actions">
                    <button type="button" className="link" onClick={() => props.onSaveAnswer(message.id)} disabled={saved}>
                      {saved ? "Saved to notes" : "Save as note"}
                    </button>
                    <button
                      type="button"
                      className={message.id === shownMessageId ? "link sheet-only" : "link"}
                      onClick={() => props.onFocus({ messageId: message.id, n: null })}
                    >
                      Show the evidence for this answer
                    </button>
                  </p>
                )}
              </div>
            );
          })}

          {waiting && (
            <p className="thinking" role="status">
              Searching your sources
            </p>
          )}

          {error && (
            <div className="error-box" role="alert">
              {error.message || "The answer could not be completed."}
              <div>
                <button type="button" className="link" onClick={props.onRetry}>
                  Try again
                </button>
                <button type="button" className="link" onClick={props.onDismissError}>
                  Dismiss
                </button>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="composer">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="scope-row">
            <p className="scope-line">{scopeLine(props.selected, props.total)}</p>
            <div className="scope-tools">
              <button type="button" className="button small quiet sheet-only" onClick={props.onOpenSheet}>
                Evidence and notes
              </button>
              <button
                type="button"
                className="button small quiet settings-toggle"
                aria-expanded={settingsOpen}
                aria-controls="composer-settings"
                onClick={() => setSettingsOpen(!settingsOpen)}
              >
                Settings
              </button>
              <span className="enter-hint">Enter to send</span>
            </div>
          </div>

          <div className="ask-row">
            <label className="visually-hidden" htmlFor="question">
              Your question
            </label>
            <textarea
              id="question"
              rows={2}
              value={draft}
              placeholder={hint ?? "Ask about your sources"}
              disabled={Boolean(hint)}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            {busy ? (
              <button type="button" className="button ask quiet" onClick={props.onStop}>
                Stop
              </button>
            ) : (
              <button type="submit" className="button ask" disabled={!draft.trim() || Boolean(hint)}>
                Ask
              </button>
            )}
          </div>

          <div className={settingsOpen ? "settings open" : "settings"} id="composer-settings">
            <div className="settings-group">
              <label htmlFor="model">Model</label>
              <select
                id="model"
                value={selectedModel}
                onChange={(event) => {
                  props.onModel(event.target.value);
                  setConnection(null);
                }}
                disabled={offline || !health}
              >
                {health?.chatModels.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
              {health?.local && (
                <span className="badge" title="The model runs on this machine or network. Questions and passages do not leave it.">
                  Local model
                </span>
              )}
              {!offline && health && (
                <button type="button" className="button small quiet" onClick={runCheck} disabled={connection === "checking"}>
                  Check connection
                </button>
              )}
              <button
                type="button"
                className="button small quiet"
                aria-haspopup="dialog"
                onClick={() => setConnectionOpen(true)}
              >
                Connection
              </button>
            </div>
            <div className="settings-group">
              <button type="button" className="button small quiet" onClick={props.onClear} disabled={messages.length === 0 || busy}>
                Start a new conversation
              </button>
              <button type="button" className="button small quiet" onClick={props.onCopyExport} disabled={!props.canExport || busy}>
                Copy as Markdown
              </button>
              <button type="button" className="button small quiet" onClick={props.onDownloadExport} disabled={!props.canExport || busy}>
                Download
              </button>
            </div>
            {connection && (
              <p className={connection !== "checking" && !connection.ok ? "settings-status failed" : "settings-status ok"} role="status">
                {connection === "checking"
                  ? "Checking the model"
                  : connection.ok
                    ? `Connected to ${connection.provider} in ${formatMs(connection.ms)}.`
                    : connection.message}
              </p>
            )}
            {props.exportStatus && (
              <p className="settings-status" role="status">
                {props.exportStatus}
              </p>
            )}
          </div>
        </form>
      </div>

      {/* Outside the question form: a form cannot sit inside another form. */}
      {connectionOpen && (
        <ConnectionDialog
          token={settingsToken}
          onToken={setSettingsToken}
          onClose={() => setConnectionOpen(false)}
          onChanged={() => {
            setConnection(null);
            props.onConnectionChanged();
          }}
        />
      )}
    </section>
  );
}
