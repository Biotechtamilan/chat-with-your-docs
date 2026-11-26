"use client";

import { whereLabel } from "@/lib/labels";
import type { Note } from "@/lib/types";

interface Props {
  notes: Note[];
  error: string | null;
  /** Ids of the sources that still exist. */
  documentIds: ReadonlySet<string>;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

function savedOn(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Saved answers and passages. A note's body is shown as plain text: it may be
 * model output or document text, and neither is trusted to carry markup.
 */
export function Notes({ notes, error, documentIds, onRename, onDelete }: Props) {
  return (
    <div className="notes">
      {error && (
        <p className="pane-note failed" role="alert">
          {error}
        </p>
      )}
      {notes.length === 0 ? (
        <p className="pane-note">
          Nothing saved yet. Use Save as note under an answer or on a passage to keep it here. Notes stay after a
          reload, and after their source is removed.
        </p>
      ) : (
        <ul className="saved-list">
          {notes.map((note) => (
            <li key={note.id} className="saved">
              <label className="visually-hidden" htmlFor={`note-title-${note.id}`}>
                Title of this note
              </label>
              <input
                // Re-keyed on the stored title, so a rejected edit falls back to what was saved.
                key={note.title}
                id={`note-title-${note.id}`}
                className="saved-title"
                defaultValue={note.title}
                maxLength={200}
                onBlur={(event) => {
                  const title = event.target.value.trim();
                  if (!title) event.target.value = note.title;
                  else if (title !== note.title) onRename(note.id, title);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <p className="saved-meta">
                {note.kind === "answer" ? "Answer" : "Passage"}, saved {savedOn(note.createdAt)}
              </p>
              {note.question && <p className="saved-question">In reply to: {note.question}</p>}
              <p className="saved-body">{note.body}</p>
              {note.sources.length > 0 && (
                <ul className="saved-sources" aria-label="Sources of this note">
                  {note.sources.map((source) => {
                    const where = whereLabel(source);
                    return (
                      <li key={`${source.chunkId}-${source.n}`}>
                        {source.n !== null && <span className="note-n">{source.n}</span>}
                        <span>
                          {source.documentName}
                          {where ? `, ${where}` : ""}
                          {!documentIds.has(source.documentId) && (
                            <em className="gone"> This source has been removed.</em>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <button type="button" className="link danger" onClick={() => onDelete(note.id)} aria-label={`Delete note: ${note.title}`}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
