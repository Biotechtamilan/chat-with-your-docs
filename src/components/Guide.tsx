"use client";

import type { GuideState } from "./Workspace";

interface Props {
  state: GuideState;
  /** Why there is nothing to guide (no sources, none selected), or null. */
  hint: string | null;
  canAsk: boolean;
  onAsk: (question: string) => void;
  onRetry: () => void;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * What the selected sources are about, and three questions to start with.
 * The overview and the questions are model output about untrusted documents,
 * so they are rendered as plain text: no Markdown, no links, no HTML.
 */
export function Guide({ state, hint, canAsk, onAsk, onRetry }: Props) {
  if (hint) return <p className="pane-note">{hint} A short guide to your sources appears here.</p>;

  if (state.status === "idle" || state.status === "loading") {
    return (
      <p className="pane-note thinking" role="status">
        Reading the opening of your sources
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="pane-note" role="alert">
        <p>The guide could not be written. {state.message}</p>
        <button type="button" className="button small quiet" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  const { guide } = state;

  if (guide.mode === "offline") {
    return (
      <div className="guide">
        <h3 className="group-title">Ready to search</h3>
        <p className="pane-note">
          No model is connected, so there is no written overview. These sources are indexed and can be searched:
        </p>
        <ul className="guide-sources">
          {guide.sources.map((source) => (
            <li key={source.id}>
              <span title={source.name}>{source.name}</span>
              <span>{plural(source.passages, "passage")}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="guide">
      <h3 className="group-title">About {guide.sources.length === 1 ? "this source" : `these ${guide.sources.length} sources`}</h3>
      <p className="guide-overview">{guide.overview}</p>

      <h3 className="group-title">Try asking</h3>
      <ul className="suggestions">
        {guide.questions.map((question) => (
          <li key={question}>
            <button type="button" onClick={() => onAsk(question)} disabled={!canAsk}>
              {question}
            </button>
          </li>
        ))}
      </ul>
      <p className="pane-note">
        Written by the model from the opening passages of the selected sources. Change the selection to get a guide
        to a different set.
      </p>
    </div>
  );
}
