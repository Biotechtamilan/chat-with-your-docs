"use client";

import { useId, useState } from "react";
import { formatBytes } from "@/lib/client";
import type { DocumentSummary } from "@/lib/types";

export interface UploadState {
  name: string;
  /**
   * working: in progress. failed: stopped with a message. password and scan:
   * waiting for the person. skipped: the person declined; the row says what that meant.
   */
  status: "working" | "failed" | "password" | "scan" | "skipped";
  stage: string;
  wrongPassword?: boolean;
  scan?: { pages: number; textPages: number; provider: string; local: boolean };
}

interface Props {
  documents: DocumentSummary[];
  uploads: UploadState[];
  excluded: ReadonlySet<string>;
  loaded: boolean;
  /** How many ready sources are ticked. */
  selected: number;
  /** The source open in the right pane, if any. */
  openedId: string | null;
  limits: { maxDocuments: number; maxUploadMb: number } | null;
  onDismissUpload: (name: string) => void;
  onPassword: (name: string, password: string) => void;
  onAllowScan: (name: string, always: boolean) => void;
  onSkipScan: (name: string) => void;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onOpen: (id: string) => void;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  onLoadSamples: () => void;
}

function describe(document: DocumentSummary): string {
  if (document.status === "failed") return document.error ?? "Could not be indexed.";
  if (document.status === "processing") return "Indexing";
  const pages = document.pages ? `${document.pages} ${document.pages === 1 ? "page" : "pages"}, ` : "";
  const scan = document.ocrPages > 0 ? ", read from a scan" : "";
  return `${pages}${document.chunkCount} ${document.chunkCount === 1 ? "passage" : "passages"}, ${formatBytes(document.bytes)}${scan}`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The password is held in this field only until it is sent with the file. */
function PasswordPrompt({ upload, onSubmit }: { upload: UploadState; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState("");
  const fieldId = useId();
  return (
    <form
      className="upload-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        if (password) onSubmit(password);
      }}
    >
      <p>
        {upload.wrongPassword
          ? "That password did not open this PDF. Check it and try again."
          : "This PDF is password-protected. Enter its password to read it."}
      </p>
      <label htmlFor={fieldId}>Password for {upload.name}</label>
      <div className="upload-prompt-row">
        <input
          id={fieldId}
          type="password"
          value={password}
          autoComplete="off"
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" className="button small" disabled={!password}>
          Open
        </button>
      </div>
      <p className="upload-prompt-foot">The password is used once to open the file and is not saved.</p>
    </form>
  );
}

function ScanPrompt(props: { upload: UploadState; onAllow: (always: boolean) => void; onSkip: () => void }) {
  const scan = props.upload.scan;
  if (!scan) return null;
  const what =
    scan.textPages === 0 && scan.pages === 1
      ? "This file is an image or a scanned page with no text layer."
      : scan.textPages === 0
        ? `All ${scan.pages} pages of this file are scans with no text layer.`
        : `${plural(scan.pages, "page")} of this file ${scan.pages === 1 ? "is a scan" : "are scans"} with no text layer.`;
  const one = scan.pages === 1;
  const whereTo = scan.local
    ? `${one ? "It is" : "They are"} read by the model on this machine. Nothing leaves it.`
    : `Reading ${one ? "it sends the page image" : "them sends the page images"} to ${scan.provider}.`;
  return (
    <div className="upload-prompt">
      <p>
        {what} {whereTo}
      </p>
      <div className="upload-prompt-actions">
        <button type="button" className="button small" onClick={() => props.onAllow(false)}>
          Read this file
        </button>
        <button type="button" className="button small quiet" onClick={() => props.onAllow(true)}>
          Always read scans this session
        </button>
        <button type="button" className="button small quiet" onClick={props.onSkip}>
          Skip this file
        </button>
      </div>
    </div>
  );
}

export function Library(props: Props) {
  const { documents, uploads, excluded, loaded, selected, limits, onToggle, onAdd, onRemove, onLoadSamples } = props;
  const [over, setOver] = useState(false);
  // On a phone the list sits behind a "Sources (n)" control so the question box is on the first screen.
  // Until the person chooses, it stays open while there is something here that needs them.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? (documents.length === 0 || uploads.length > 0);
  const busy = uploads.some((upload) => upload.status === "working");
  const ready = documents.filter((document) => document.status === "ready").length;

  return (
    <aside className={open ? "pane library open" : "pane library"} aria-label="Sources">
      <header className="pane-head library-head">
        <div>
          <h1>Marginalia</h1>
          <p>Ask your documents. Check the passage behind every answer.</p>
        </div>
        <button
          type="button"
          className="button small quiet sources-toggle"
          aria-expanded={open}
          aria-controls="library-body"
          onClick={() => setChosen(!open)}
        >
          Sources ({documents.length})
        </button>
      </header>

      <div className="pane-body library-body" id="library-body">
        <label
          className={over ? "dropzone over" : "dropzone"}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            onAdd([...event.dataTransfer.files]);
          }}
        >
          <strong>Add sources</strong>
          Drop files here or choose them. PDF, Word, Markdown, text or an image of text
          {limits ? `, up to ${limits.maxUploadMb} MB each.` : "."}
          <input
            className="visually-hidden"
            type="file"
            multiple
            accept=".pdf,.docx,.md,.markdown,.txt,.png,.jpg,.jpeg,.webp"
            onChange={(event) => {
              onAdd([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
        </label>

        {uploads.length > 0 && (
          <ul className="upload-list" aria-label="Uploads">
            {uploads.map((upload) => (
              <li key={upload.name} className={`upload-row ${upload.status}`}>
                <p className="upload-line" role="status">
                  <strong title={upload.name}>{upload.name}</strong>
                  {upload.stage && <span>{upload.stage}</span>}
                  {(upload.status === "failed" || upload.status === "skipped" || upload.status === "password") && (
                    <button type="button" className="link" onClick={() => props.onDismissUpload(upload.name)}>
                      {upload.status === "password" ? "Skip this file" : "Dismiss"}
                    </button>
                  )}
                </p>
                {upload.status === "password" && (
                  // The key resets the field after a wrong password.
                  <PasswordPrompt
                    key={String(upload.wrongPassword)}
                    upload={upload}
                    onSubmit={(password) => props.onPassword(upload.name, password)}
                  />
                )}
                {upload.status === "scan" && (
                  <ScanPrompt
                    upload={upload}
                    onAllow={(always) => props.onAllowScan(upload.name, always)}
                    onSkip={() => props.onSkipScan(upload.name)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {loaded && documents.length === 0 && uploads.length === 0 && (
          <p className="empty-note">
            Nothing here yet.{" "}
            <button type="button" className="link" onClick={onLoadSamples} disabled={busy}>
              Load five sample documents
            </button>{" "}
            to try it straight away. One is a scan, so you will be asked before it is read.
          </p>
        )}

        {documents.length > 0 && (
          <>
            <div className="library-summary">
              <p>
                <strong>
                  {plural(ready, "source")}, {selected} selected
                </strong>
                {limits && (
                  <span>
                    {documents.length} of {limits.maxDocuments} allowed
                  </span>
                )}
              </p>
              <p>Ticked sources are searched when you ask. Select a name to read the source.</p>
              <div className="library-actions">
                <button type="button" className="button small quiet" onClick={props.onSelectAll} disabled={selected === ready}>
                  Select all
                </button>
                <button type="button" className="button small quiet" onClick={props.onSelectNone} disabled={selected === 0}>
                  Clear
                </button>
              </div>
            </div>

            <ul className="doc-list">
              {documents.map((document) => {
                const usable = document.status === "ready";
                return (
                  <li key={document.id} className={document.id === props.openedId ? "doc opened" : "doc"}>
                    <input
                      type="checkbox"
                      checked={usable && !excluded.has(document.id)}
                      disabled={!usable}
                      onChange={() => onToggle(document.id)}
                      aria-label={`Search in ${document.name}`}
                    />
                    <div className="doc-text">
                      {usable ? (
                        <button
                          type="button"
                          className="doc-name"
                          title={document.name}
                          onClick={() => props.onOpen(document.id)}
                          aria-label={`Read ${document.name}`}
                        >
                          {document.name}
                        </button>
                      ) : (
                        <span className="doc-name" title={document.name}>
                          {document.name}
                        </span>
                      )}
                      <span className={document.status === "failed" ? "doc-meta failed" : "doc-meta"}>
                        {describe(document)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="doc-remove"
                      onClick={() => onRemove(document.id)}
                      aria-label={`Remove ${document.name}`}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
