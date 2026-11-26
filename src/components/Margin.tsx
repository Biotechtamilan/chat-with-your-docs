"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import type { ChatUIMessage } from "@/lib/chat-types";
import { formatMs, sourcesOf, textOf, traceOf } from "@/lib/client";
import { analyzeCitations } from "@/lib/generation/citations";
import { whereLabel } from "@/lib/labels";
import type { AnswerOutcome, Note, SourceRef, TraceData } from "@/lib/types";
import { Guide } from "./Guide";
import { Notes } from "./Notes";
import { SourceView } from "./SourceView";
import type { GuideState } from "./Workspace";

export type PaneTab = "guide" | "evidence" | "trace" | "notes";

export interface OpenedSource {
  documentId: string;
  /** The passage to scroll to and highlight, when the source was opened from an evidence card. */
  chunkId: string | null;
}

interface Props {
  tabs: PaneTab[];
  tab: PaneTab;
  onTab: (tab: PaneTab) => void;

  message: ChatUIMessage | null;
  activeN: number | null;
  /** True while an answer is still being written. */
  writing: boolean;
  onSelect: (n: number) => void;

  guide: GuideState;
  /** Why there is no guide to show (no sources, none selected), or null. */
  guideHint: string | null;
  canAsk: boolean;
  onAsk: (question: string) => void;
  onRetryGuide: () => void;

  notes: Note[];
  noteError: string | null;
  /** Ids of the sources that still exist, to flag notes whose source is gone. */
  documentIds: ReadonlySet<string>;
  onRenameNote: (id: string, title: string) => void;
  onDeleteNote: (id: string) => void;
  savedKeys: ReadonlySet<string>;
  onSavePassage: (source: SourceRef) => void;

  opened: OpenedSource | null;
  onOpenSource: (documentId: string, chunkId: string | null) => void;
  onCloseSource: () => void;
  onAskOnly: (documentId: string) => void;

  /** On a phone the pane is a sheet over the page. These do nothing on a wide screen. */
  isSheet: boolean;
  sheetOpen: boolean;
  onCloseSheet: () => void;
}

const TAB_TEXT: Record<PaneTab, string> = {
  guide: "Guide",
  evidence: "Evidence",
  trace: "How it was built",
  notes: "Notes",
};

const OUTCOME_TEXT: Record<AnswerOutcome, string> = {
  answered: "Answered from the cited passages",
  no_context: "Nothing relevant found, so the model was not called",
  no_documents: "No sources to search",
  stopped: "Stopped before the answer finished",
  error: "The model request failed",
};

const STAGE_TEXT: Record<string, string> = {
  rewrite_query: "Rewrite follow-up",
  embed_query: "Embed question",
  search: "Search",
  generate: "Write answer",
};

function scores(source: SourceRef): string {
  const parts = [
    source.similarity !== null ? `similarity ${source.similarity.toFixed(2)}` : null,
    source.denseRank !== null ? `meaning rank ${source.denseRank}` : null,
    source.lexicalRank !== null ? `keyword rank ${source.lexicalRank}` : null,
  ];
  return parts.filter(Boolean).join(", ");
}

function Trace({ trace, writing }: { trace: TraceData | null; writing: boolean }) {
  if (!trace) return <p className="pane-note">The steps behind an answer appear here once you ask a question.</p>;
  const longest = Math.max(1, ...trace.stages.map((stage) => stage.ms));
  return (
    <div className="trace">
      <p className="pane-note">What the app did to produce the selected answer, and what it cost.</p>
      <dl>
        <dt>Result</dt>
        <dd>{trace.complete ? OUTCOME_TEXT[trace.outcome] : writing ? "Writing" : OUTCOME_TEXT.stopped}</dd>
        {trace.searchQuery !== trace.question && (
          <>
            <dt>Searched for</dt>
            <dd>{trace.searchQuery}</dd>
          </>
        )}
        {trace.bestSimilarity !== null && (
          <>
            <dt>Best match</dt>
            <dd>similarity {trace.bestSimilarity.toFixed(2)}</dd>
          </>
        )}
        {trace.mode === "gateway" && (
          <>
            <dt>Model</dt>
            <dd>{trace.model}</dd>
          </>
        )}
        {trace.provider && (
          <>
            <dt>Served by</dt>
            <dd>{trace.provider}</dd>
          </>
        )}
        {trace.usage && (
          <>
            <dt>Tokens</dt>
            <dd>
              {trace.usage.inputTokens.toLocaleString()} in, {trace.usage.outputTokens.toLocaleString()} out
            </dd>
          </>
        )}
        {trace.costUsd !== null && (
          <>
            <dt>Estimated cost</dt>
            <dd>${trace.costUsd.toFixed(5)}</dd>
          </>
        )}
        <dt>Total time</dt>
        <dd>{formatMs(trace.totalMs)}</dd>
      </dl>
      {trace.stages.length > 0 && (
        <ul className="stages" aria-label="Time per stage">
          {trace.stages.map((stage, index) => (
            <li key={`${stage.name}-${index}`}>
              <span>{STAGE_TEXT[stage.name] ?? stage.name}</span>
              <span className="bar">
                <span style={{ width: `${Math.max(2, (stage.ms / longest) * 100)}%` }} />
              </span>
              <span className="ms">{formatMs(stage.ms)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface EvidenceProps {
  message: ChatUIMessage | null;
  activeN: number | null;
  savedKeys: ReadonlySet<string>;
  onSelect: (n: number) => void;
  onOpenSource: (documentId: string, chunkId: string | null) => void;
  onSavePassage: (source: SourceRef) => void;
}

function Evidence({ message, activeN, savedKeys, onSelect, onOpenSource, onSavePassage }: EvidenceProps) {
  const sources = message ? sourcesOf(message) : [];
  // Worked out from the answer text itself, so the split is right while the answer is still being written.
  const citedNumbers = new Set(message ? analyzeCitations(textOf(message), sources.length).cited : []);
  const cited = sources.filter((source) => citedNumbers.has(source.n));
  const rest = sources.filter((source) => !citedNumbers.has(source.n));
  const activeRef = useRef<HTMLLIElement>(null);
  const activeInRest = rest.some((source) => source.n === activeN);

  useEffect(() => {
    if (activeN === null) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [activeN, message?.id]);

  if (sources.length === 0) {
    return (
      <p className="pane-note">
        {message ? "No passages were used for this answer." : "Passages appear here when you ask a question."}
      </p>
    );
  }

  const card = (source: SourceRef, unused: boolean) => {
    const active = source.n === activeN;
    const where = whereLabel(source);
    const saved = savedKeys.has(`passage:${source.chunkId}`);
    const classes = ["note", active ? "active" : "", unused ? "unused" : ""].filter(Boolean).join(" ");
    return (
      <li key={source.chunkId} ref={active ? activeRef : undefined} className={classes}>
        <button
          type="button"
          className="note-head"
          onClick={() => onSelect(source.n)}
          aria-expanded={active}
          aria-label={`Passage ${source.n} from ${source.documentName}`}
        >
          <span className="note-n">{source.n}</span>
          <span>
            <span className="note-title">{source.documentName}</span>
            {where && <span className="note-where">{where}</span>}
          </span>
        </button>
        <p className="note-text">{source.content}</p>
        {active && <p className="note-scores">{scores(source)}</p>}
        <p className="note-actions">
          <button type="button" className="link" onClick={() => onOpenSource(source.documentId, source.chunkId)}>
            Open in source
          </button>
          <button type="button" className="link" onClick={() => onSavePassage(source)} disabled={saved}>
            {saved ? "Saved to notes" : "Save as note"}
          </button>
        </p>
      </li>
    );
  };

  return (
    <>
      <p className="pane-note">
        The passages the model was given, numbered as the answer cites them. Select a number in the answer or a
        passage here to read it in full.
      </p>
      {cited.length > 0 && (
        <section aria-label="Cited passages">
          <h3 className="group-title">Cited ({cited.length})</h3>
          <ol className="note-list">{cited.map((source) => card(source, false))}</ol>
        </section>
      )}
      {rest.length > 0 &&
        (cited.length === 0 ? (
          <section aria-label="Retrieved passages">
            <h3 className="group-title">Retrieved ({rest.length})</h3>
            <ol className="note-list">{rest.map((source) => card(source, false))}</ol>
          </section>
        ) : (
          // Re-keyed when a passage inside is selected, so the group opens to show it;
          // otherwise the person's own open or closed choice stands.
          <details className="group" key={activeInRest ? "open" : "closed"} open={activeInRest || undefined}>
            <summary className="group-title">Retrieved, not cited ({rest.length})</summary>
            <ol className="note-list">{rest.map((source) => card(source, true))}</ol>
          </details>
        ))}
    </>
  );
}

export function Margin(props: Props) {
  const { tabs, tab, message, opened } = props;
  const trace = message ? traceOf(message) : null;
  const closeRef = useRef<HTMLButtonElement>(null);

  // When the sheet opens on a phone, focus moves into it. On a wide screen the
  // button is not displayed, has no layout box, and focus stays where it was.
  useEffect(() => {
    const button = closeRef.current;
    if (props.sheetOpen && button && button.offsetParent !== null) button.focus({ preventScroll: true });
  }, [props.sheetOpen, opened]);

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
    props.onTab(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`#tab-${next}`)?.focus();
  };

  return (
    <aside
      className="pane margin"
      aria-label="Evidence, guide and notes"
      onKeyDown={(event) => {
        if (event.key === "Escape" && props.isSheet && props.sheetOpen) props.onCloseSheet();
      }}
    >
      <div className="sheet-bar">
        <button ref={closeRef} type="button" className="button small quiet" onClick={props.onCloseSheet}>
          Back to the conversation
        </button>
      </div>

      {opened ? (
        <SourceView
          key={opened.documentId}
          opened={opened}
          onBack={props.onCloseSource}
          onAskOnly={() => {
            props.onAskOnly(opened.documentId);
            props.onCloseSource();
          }}
        />
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label="Right pane" onKeyDown={onTabKey}>
            {tabs.map((name) => (
              <button
                key={name}
                id={`tab-${name}`}
                type="button"
                role="tab"
                aria-selected={name === tab}
                aria-controls="pane-panel"
                tabIndex={name === tab ? 0 : -1}
                className={name === tab ? "tab active" : "tab"}
                onClick={() => props.onTab(name)}
              >
                {TAB_TEXT[name]}
                {name === "notes" && props.notes.length > 0 ? ` (${props.notes.length})` : ""}
              </button>
            ))}
          </div>

          <div className="pane-body" id="pane-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
            {tab === "guide" && (
              <Guide
                state={props.guide}
                hint={props.guideHint}
                canAsk={props.canAsk}
                onAsk={props.onAsk}
                onRetry={props.onRetryGuide}
              />
            )}
            {tab === "evidence" && (
              <Evidence
                message={message}
                activeN={props.activeN}
                savedKeys={props.savedKeys}
                onSelect={props.onSelect}
                onOpenSource={props.onOpenSource}
                onSavePassage={props.onSavePassage}
              />
            )}
            {tab === "trace" && <Trace trace={trace} writing={props.writing} />}
            {tab === "notes" && (
              <Notes
                notes={props.notes}
                error={props.noteError}
                documentIds={props.documentIds}
                onRename={props.onRenameNote}
                onDelete={props.onDeleteNote}
              />
            )}
          </div>
        </>
      )}
    </aside>
  );
}
