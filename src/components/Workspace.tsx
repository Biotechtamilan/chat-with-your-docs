"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatUIMessage } from "@/lib/chat-types";
import {
  fetchDocuments,
  fetchGuide,
  fetchHealth,
  fetchNotes,
  noteSource,
  removeDocument,
  removeNote,
  renameNote,
  saveNote,
  sourcesOf,
  textOf,
  titleFrom,
  uploadDocument,
  type NoteDraft,
  type UploadOptions,
} from "@/lib/client";
import { analyzeCitations } from "@/lib/generation/citations";
import { whereLabel } from "@/lib/labels";
import { buildMarkdownExport, type ExportTurn } from "@/lib/notebook/export";
import { CONVERSATION_STORAGE_KEY, restoreConversation, serializeConversation } from "@/lib/notebook/persist";
import type { DocumentSummary, HealthReport, Note, SourceGuide, SourceRef } from "@/lib/types";
import { Conversation } from "./Conversation";
import { Library, type UploadState } from "./Library";
import { Margin, type OpenedSource, type PaneTab } from "./Margin";

const transport = new DefaultChatTransport<ChatUIMessage>({ api: "/api/chat" });

/** The last one is a scan, so loading the samples also shows the permission prompt once. */
const SAMPLE_FILES = [
  "employee-handbook.md",
  "support-runbook.md",
  "returns-and-warranty.pdf",
  "vendor-note.txt",
  "field-service-report-scan.pdf",
];

/** Remembered for the browser session only: closing the tab forgets it. */
const ALWAYS_SCAN_KEY = "marginalia.alwaysReadScans";

/** Storage can be unavailable (private windows, blocked site data). The app must work without it. */
function readStorage(storage: "localStorage" | "sessionStorage", key: string): string | null {
  try {
    return window[storage].getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: "localStorage" | "sessionStorage", key: string, value: string): void {
  try {
    window[storage].setItem(key, value);
  } catch {
    // Nothing to do: the conversation simply will not survive a reload.
  }
}

async function loadServerState() {
  const [documents, health, notes] = await Promise.all([
    fetchDocuments().catch(() => []),
    fetchHealth().catch(() => null),
    fetchNotes().catch(() => []),
  ]);
  return { documents, health, notes };
}

export interface Focus {
  messageId: string;
  /** The citation number to highlight, or null to show all passages for that answer. */
  n: number | null;
}

export type GuideState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; guide: SourceGuide }
  | { status: "error"; key: string; message: string };

export function Workspace() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [model, setModel] = useState("");
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<PaneTab>("guide");
  const [opened, setOpened] = useState<OpenedSource | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [guide, setGuide] = useState<GuideState>({ status: "idle" });
  const [guideAttempt, setGuideAttempt] = useState(0);
  const [savedKeys, setSavedKeys] = useState<ReadonlySet<string>>(new Set());
  const [noteError, setNoteError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  // Files waiting for a password or for permission, kept so they can be sent again.
  // A password stays here only until its file is indexed or dismissed.
  const pending = useRef(new Map<string, { file: File; password?: string }>());
  const alwaysScan = useRef(false);

  const { messages, sendMessage, status, stop, error, clearError, regenerate, setMessages } = useChat<ChatUIMessage>({
    transport,
  });

  const refresh = useCallback(async () => {
    const [fresh, report] = await Promise.all([fetchDocuments().catch(() => null), fetchHealth().catch(() => null)]);
    if (fresh) setDocuments(fresh);
    if (report) setHealth(report);
  }, []);

  // A new connection brings its own model list, so a model picked under the old one no longer applies.
  const connectionChanged = useCallback(() => {
    setModel("");
    void refresh();
  }, [refresh]);

  // Initial load. The flag stops a late response from updating an unmounted component.
  useEffect(() => {
    let cancelled = false;
    void loadServerState().then((state) => {
      if (cancelled) return;
      setDocuments(state.documents);
      setHealth(state.health);
      setNotes(state.notes);
      alwaysScan.current = readStorage("sessionStorage", ALWAYS_SCAN_KEY) === "true";
      const stored = restoreConversation(readStorage("localStorage", CONVERSATION_STORAGE_KEY));
      if (stored.length > 0) {
        setMessages(stored);
        setTab("evidence");
      }
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [setMessages]);

  const busy = status === "submitted" || status === "streaming";

  // Saved only between answers, so a half-written reply is never what a reload brings back.
  useEffect(() => {
    if (!loaded || busy) return;
    writeStorage("localStorage", CONVERSATION_STORAGE_KEY, serializeConversation(messages));
  }, [loaded, busy, messages]);

  // ------------------------------------------------------------------ uploads

  const runUpload = useCallback(
    async (file: File, options: UploadOptions) => {
      const update = (patch: Partial<UploadState>) =>
        setUploads((current) => {
          const next: UploadState = { name: file.name, status: "working", stage: "Uploading", ...patch };
          return current.some((upload) => upload.name === file.name)
            ? current.map((upload) => (upload.name === file.name ? next : upload))
            : [...current, next];
        });
      update({});
      let finished = true;
      await uploadDocument(
        file,
        (event) => {
          if (event.type === "progress") {
            const label = event.stage.charAt(0).toUpperCase() + event.stage.slice(1);
            update({ stage: event.detail ? `${label} ${event.detail}` : label });
          } else if (event.type === "error") {
            finished = false;
            update({ status: "failed", stage: event.message });
          } else if (event.type === "needs_password") {
            finished = false;
            pending.current.set(file.name, { file });
            update({ status: "password", stage: "", wrongPassword: event.wrong });
          } else if (event.type === "needs_scan_permission") {
            finished = false;
            // The password already opened the file, so it is kept for the send that follows permission.
            pending.current.set(file.name, { file, password: options.password });
            update({
              status: "scan",
              stage: "",
              scan: { pages: event.pages, textPages: event.textPages, provider: event.provider, local: event.local },
            });
          }
        },
        options,
      ).catch(() => {
        finished = false;
        update({ status: "failed", stage: "The upload was interrupted." });
      });
      if (finished) {
        pending.current.delete(file.name);
        setUploads((current) => current.filter((upload) => upload.name !== file.name));
      }
      await refresh();
    },
    [refresh],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      // One at a time: embedding is CPU-bound, so parallel uploads would only compete.
      // A file that needs a password or permission leaves its question in the list and the rest carry on.
      for (const file of files) await runUpload(file, { allowScan: alwaysScan.current });
    },
    [runUpload],
  );

  const loadSamples = useCallback(async () => {
    const files = await Promise.all(
      SAMPLE_FILES.map(async (name) => {
        const response = await fetch(`/samples/${name}`);
        return new File([await response.blob()], name);
      }),
    );
    await addFiles(files);
  }, [addFiles]);

  const dismissUpload = useCallback((name: string) => {
    pending.current.delete(name);
    setUploads((current) => current.filter((upload) => upload.name !== name));
  }, []);

  const submitPassword = useCallback(
    (name: string, password: string) => {
      const entry = pending.current.get(name);
      if (entry) void runUpload(entry.file, { password, allowScan: alwaysScan.current });
    },
    [runUpload],
  );

  const allowScan = useCallback(
    (name: string, always: boolean) => {
      if (always) {
        alwaysScan.current = true;
        writeStorage("sessionStorage", ALWAYS_SCAN_KEY, "true");
      }
      const entry = pending.current.get(name);
      if (entry) void runUpload(entry.file, { password: entry.password, allowScan: true });
    },
    [runUpload],
  );

  const skipScan = useCallback((name: string) => {
    pending.current.delete(name);
    setUploads((current) =>
      current.map((upload) => {
        if (upload.name !== name) return upload;
        const mixed = (upload.scan?.textPages ?? 0) > 0;
        return {
          name,
          status: "skipped",
          stage: mixed
            ? "Skipped. This file mixes text pages and scanned pages, so none of it was indexed."
            : "Skipped. Nothing was sent and nothing was indexed.",
        };
      }),
    );
  }, []);

  // ---------------------------------------------------------------- selection

  const remove = useCallback(
    async (id: string) => {
      await removeDocument(id).catch(() => undefined);
      setExcluded((current) => new Set([...current].filter((value) => value !== id)));
      setOpened((current) => (current?.documentId === id ? null : current));
      await refresh();
    },
    [refresh],
  );

  const toggle = useCallback((id: string) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const ready = useMemo(() => documents.filter((document) => document.status === "ready"), [documents]);
  const scope = useMemo(
    () => ready.filter((document) => !excluded.has(document.id)).map((document) => document.id),
    [ready, excluded],
  );

  const selectAll = useCallback(() => setExcluded(new Set()), []);
  const selectNone = useCallback(() => setExcluded(new Set(ready.map((document) => document.id))), [ready]);
  const askOnly = useCallback(
    (id: string) => setExcluded(new Set(ready.filter((document) => document.id !== id).map((document) => document.id))),
    [ready],
  );

  // Sent with each question, so it always reflects the current selection.
  const requestBody = useMemo(
    () => ({ documentIds: scope.length === ready.length ? undefined : scope, model: model || undefined }),
    [scope, ready.length, model],
  );

  // ------------------------------------------------------------- conversation

  const ask = useCallback(
    (text: string) => {
      clearError();
      setFocus(null);
      setOpened(null);
      setTab("evidence");
      void sendMessage({ text }, { body: requestBody });
    },
    [clearError, sendMessage, requestBody],
  );

  const retry = useCallback(() => {
    clearError();
    void regenerate({ body: requestBody });
  }, [clearError, regenerate, requestBody]);

  const startOver = useCallback(() => {
    setMessages([]);
    setFocus(null);
    setSavedKeys(new Set());
    setExportStatus(null);
    setSheetOpen(false);
    setTab("guide");
  }, [setMessages]);

  /** Selecting a citation, or an answer, shows its evidence: in the pane, or in the sheet on a phone. */
  const showEvidence = useCallback((next: Focus) => {
    setFocus(next);
    setOpened(null);
    setTab("evidence");
    setSheetOpen(true);
  }, []);

  const openSource = useCallback((documentId: string, chunkId: string | null) => {
    setOpened({ documentId, chunkId });
    setSheetOpen(true);
  }, []);

  // -------------------------------------------------------------------- guide

  const hasThread = messages.length > 0;
  const uploading = uploads.some((upload) => upload.status === "working");
  const selectedModel = model || health?.chatModel || "";
  // The guide belongs to the first screen: once a question has been asked, the evidence takes its place.
  const guideKey =
    loaded && !hasThread && !uploading && scope.length > 0 ? `${guideAttempt}|${selectedModel}|${scope.join(",")}` : null;

  useEffect(() => {
    if (!guideKey) return;
    const [, modelId, ids] = guideKey.split("|");
    const controller = new AbortController();
    // A short wait, so ticking several boxes in a row asks for one guide and not one per click.
    const timer = setTimeout(() => {
      setGuide({ status: "loading", key: guideKey });
      fetchGuide(ids.split(","), modelId || undefined, controller.signal)
        .then((result) => setGuide({ status: "ready", key: guideKey, guide: result }))
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          const message = reason instanceof Error ? reason.message : "The source guide could not be written.";
          setGuide({ status: "error", key: guideKey, message });
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [guideKey]);

  // A guide for an earlier selection is not shown against the current one.
  const currentGuide: GuideState =
    guideKey === null
      ? { status: "idle" }
      : guide.status !== "idle" && guide.key === guideKey
        ? guide
        : { status: "loading", key: guideKey };

  // -------------------------------------------------------------------- notes

  const keep = useCallback(async (key: string, draft: NoteDraft) => {
    setNoteError(null);
    try {
      const note = await saveNote(draft);
      setNotes((current) => [note, ...current]);
      setSavedKeys((current) => new Set(current).add(key));
    } catch (reason) {
      setNoteError(reason instanceof Error ? reason.message : "The note could not be saved.");
      setTab("notes");
    }
  }, []);

  const saveAnswer = useCallback(
    (messageId: string) => {
      const index = messages.findIndex((message) => message.id === messageId);
      if (index === -1) return;
      const answer = messages[index];
      const question = messages[index - 1]?.role === "user" ? textOf(messages[index - 1]) : null;
      const text = textOf(answer);
      const sources = sourcesOf(answer);
      const cited = new Set(analyzeCitations(text, sources.length).cited);
      void keep(`answer:${messageId}`, {
        kind: "answer",
        title: titleFrom(question ?? text),
        body: text,
        question,
        sources: sources.filter((source) => cited.has(source.n)).map((source) => noteSource(source)),
      });
    },
    [messages, keep],
  );

  const savePassage = useCallback(
    (source: SourceRef) => {
      const where = whereLabel(source);
      void keep(`passage:${source.chunkId}`, {
        kind: "passage",
        title: titleFrom(where ? `${source.documentName}, ${where}` : source.documentName, 160),
        body: source.content,
        question: null,
        sources: [noteSource(source, null)],
      });
    },
    [keep],
  );

  const retitle = useCallback(async (id: string, title: string) => {
    setNoteError(null);
    try {
      const updated = await renameNote(id, title);
      setNotes((current) => current.map((note) => (note.id === id ? updated : note)));
    } catch (reason) {
      setNoteError(reason instanceof Error ? reason.message : "The title could not be changed.");
    }
  }, []);

  const discard = useCallback(async (id: string) => {
    setNoteError(null);
    try {
      await removeNote(id);
      setNotes((current) => current.filter((note) => note.id !== id));
    } catch (reason) {
      setNoteError(reason instanceof Error ? reason.message : "The note could not be deleted.");
    }
  }, []);

  // ------------------------------------------------------------------- export

  const exportMarkdown = useCallback((): string => {
    const turns: ExportTurn[] = [];
    messages.forEach((message, index) => {
      const answer = textOf(message);
      if (message.role !== "assistant" || !answer) return;
      const previous = messages[index - 1];
      turns.push({
        question: previous?.role === "user" ? textOf(previous) : "Question",
        answer,
        sources: sourcesOf(message),
      });
    });
    return buildMarkdownExport({ turns, notes, exportedAt: new Date().toISOString() });
  }, [messages, notes]);

  const copyExport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(exportMarkdown());
      setExportStatus("Copied the conversation and notes as Markdown.");
    } catch {
      setExportStatus("The browser did not allow copying. Use Download.");
    }
  }, [exportMarkdown]);

  const downloadExport = useCallback(() => {
    const url = URL.createObjectURL(new Blob([exportMarkdown()], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `marginalia-notebook-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    URL.revokeObjectURL(url);
    setExportStatus("Downloaded the conversation and notes.");
  }, [exportMarkdown]);

  // ------------------------------------------------------------------- render

  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant") ?? null;
  const shown = (focus && messages.find((message) => message.id === focus.messageId)) || lastAssistant;

  let hint: string | null = null;
  if (loaded && ready.length === 0) hint = "Add a source to start asking questions.";
  else if (loaded && scope.length === 0) hint = "Select at least one source to search.";

  // Guide before the first question; evidence and the trace after it. Notes are always there.
  const tabs: PaneTab[] = hasThread ? ["evidence", "trace", "notes"] : ["guide", "notes"];
  const activeTab = tabs.includes(tab) ? tab : tabs[0];
  // On a phone the right pane is a sheet over the page whenever it shows something tied to a tap.
  const sheet = hasThread || opened !== null;
  const deskClass = ["desk", sheet ? "has-sheet" : "", sheet && sheetOpen ? "sheet-open" : ""].filter(Boolean).join(" ");

  return (
    <main className={deskClass}>
      <Library
        documents={documents}
        uploads={uploads}
        excluded={excluded}
        loaded={loaded}
        selected={scope.length}
        openedId={opened?.documentId ?? null}
        limits={health?.limits ?? null}
        onDismissUpload={dismissUpload}
        onPassword={submitPassword}
        onAllowScan={allowScan}
        onSkipScan={skipScan}
        onToggle={toggle}
        onSelectAll={selectAll}
        onSelectNone={selectNone}
        onOpen={(id) => openSource(id, null)}
        onAdd={addFiles}
        onRemove={remove}
        onLoadSamples={loadSamples}
      />
      <Conversation
        messages={messages}
        status={status}
        error={error ?? null}
        health={health}
        model={model}
        hint={hint}
        selected={scope.length}
        total={ready.length}
        shownMessageId={shown?.id ?? null}
        activeCitation={focus}
        savedKeys={savedKeys}
        exportStatus={exportStatus}
        canExport={hasThread || notes.length > 0}
        onModel={setModel}
        onAsk={ask}
        onStop={stop}
        onRetry={retry}
        onDismissError={clearError}
        onClear={startOver}
        onFocus={showEvidence}
        onSaveAnswer={saveAnswer}
        onCopyExport={copyExport}
        onDownloadExport={downloadExport}
        onConnectionChanged={connectionChanged}
        onOpenSheet={() => setSheetOpen(true)}
      />
      {sheet && sheetOpen && (
        <button type="button" className="sheet-backdrop" aria-label="Back to the conversation" onClick={() => setSheetOpen(false)} />
      )}
      <Margin
        tabs={tabs}
        tab={activeTab}
        onTab={setTab}
        writing={busy}
        message={shown}
        activeN={focus && shown && focus.messageId === shown.id ? focus.n : null}
        onSelect={(n) => shown && setFocus({ messageId: shown.id, n })}
        guide={currentGuide}
        guideHint={hint}
        canAsk={!busy && !hint}
        onAsk={ask}
        onRetryGuide={() => setGuideAttempt((attempt) => attempt + 1)}
        notes={notes}
        noteError={noteError}
        documentIds={new Set(documents.map((document) => document.id))}
        onRenameNote={retitle}
        onDeleteNote={discard}
        savedKeys={savedKeys}
        onSavePassage={savePassage}
        opened={opened}
        onOpenSource={openSource}
        onCloseSource={() => setOpened(null)}
        onAskOnly={askOnly}
        isSheet={sheet}
        sheetOpen={sheetOpen}
        onCloseSheet={() => setSheetOpen(false)}
      />
    </main>
  );
}
