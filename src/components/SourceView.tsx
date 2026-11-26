"use client";

import { useEffect, useRef, useState } from "react";
import { fetchPassages } from "@/lib/client";
import { whereLabel } from "@/lib/labels";
import type { DocumentSummary, Passage } from "@/lib/types";
import type { OpenedSource } from "./Margin";

interface Props {
  opened: OpenedSource;
  onBack: () => void;
  onAskOnly: () => void;
}

type Loaded =
  | { status: "loading" }
  | { status: "ready"; document: DocumentSummary; passages: Passage[] }
  | { status: "error"; message: string };

/**
 * One source, read passage by passage in order: the text exactly as it was
 * extracted and indexed, which is what answers are written from. Opened from
 * an evidence card, it scrolls to that passage and marks it.
 */
export function SourceView({ opened, onBack, onAskOnly }: Props) {
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const targetRef = useRef<HTMLLIElement>(null);

  // The parent re-keys this component per source, so this runs once for each one opened.
  useEffect(() => {
    let cancelled = false;
    fetchPassages(opened.documentId)
      .then((result) => {
        if (!cancelled) setState({ status: "ready", ...result });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setState({ status: "error", message: reason instanceof Error ? reason.message : "That source could not be opened." });
      });
    return () => {
      cancelled = true;
    };
  }, [opened.documentId]);

  useEffect(() => {
    if (state.status !== "ready" || !opened.chunkId) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    targetRef.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, [state.status, opened.chunkId]);

  const name = state.status === "ready" ? state.document.name : "Source";

  return (
    <>
      <header className="source-head">
        <h2 title={name}>{name}</h2>
        <p>
          {state.status === "ready"
            ? `${state.passages.length} ${state.passages.length === 1 ? "passage" : "passages"}, as extracted from the file.`
            : "The text as extracted from the file."}
        </p>
        <div className="source-actions">
          <button type="button" className="button small quiet" onClick={onBack}>
            Back
          </button>
          <button type="button" className="button small quiet" onClick={onAskOnly} disabled={state.status !== "ready"}>
            Ask only this source
          </button>
        </div>
      </header>

      <div className="pane-body">
        {state.status === "loading" && (
          <p className="pane-note thinking" role="status">
            Opening the source
          </p>
        )}
        {state.status === "error" && (
          <p className="pane-note failed" role="alert">
            {state.message}
          </p>
        )}
        {state.status === "ready" && (
          <ol className="passage-list">
            {state.passages.map((passage) => {
              const target = passage.id === opened.chunkId;
              return (
                <li key={passage.id} ref={target ? targetRef : undefined} className={target ? "passage target" : "passage"}>
                  <p className="passage-where">{whereLabel(passage) || `Passage ${passage.ord + 1}`}</p>
                  <p className="passage-text">{passage.content}</p>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </>
  );
}
