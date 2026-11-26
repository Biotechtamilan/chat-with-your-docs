"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_CHAT_MODEL, FEATURED_MODELS } from "@/lib/ai/models";
import { fetchConnection, forgetConnectionSettings, saveConnectionSettings } from "@/lib/client";
import { PROVIDER_CHOICES } from "@/lib/labels";
import { PROVIDER_NAMES, type ConnectionInput, type ConnectionView, type ProviderName } from "@/lib/types";

const LOCAL_SERVERS = [
  { name: "Ollama", address: "http://localhost:11434/v1" },
  { name: "LM Studio", address: "http://localhost:1234/v1" },
];

const SOURCE_TEXT: Record<ConnectionView["source"], string> = {
  app: "Set in this app",
  env: "From the settings file",
  none: "No model connected",
};

export type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "saved"; message: string }
  | { kind: "failed"; message: string };

interface Props {
  view: ConnectionView;
  status: ConnectionStatus;
  /** The settings token as typed. Asked for only when the server requires one. */
  token: string;
  onToken: (token: string) => void;
  onSave: (input: ConnectionInput) => void;
  onForget: () => void;
  onClose: () => void;
}

const sameAddress = (a: string, b: string | null) => a.trim().replace(/\/+$/, "") === (b ?? "");

/**
 * The form for connecting a model. It never holds a saved key: the server
 * sends only whether one exists and its last four characters, and the key
 * field starts empty every time.
 */
export function ConnectionSettings({ view, status, token, onToken, onSave, onForget, onClose }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [provider, setProvider] = useState<ProviderName>(view.provider ?? "gateway");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(view.baseUrl ?? "");
  const fromGateway = view.provider === "gateway";
  const [gatewayModel, setGatewayModel] = useState(
    fromGateway && FEATURED_MODELS.some((model) => model.id === view.model) ? view.model : DEFAULT_CHAT_MODEL,
  );
  const [modelId, setModelId] = useState(view.provider && !fromGateway ? view.model : "");
  const [moreModels, setMoreModels] = useState(
    view.provider && !fromGateway ? view.models.filter((id) => id !== view.model).join(", ") : "",
  );

  const gateway = provider === "gateway";
  const compatible = provider === "openai-compatible";
  const working = status.kind === "working";
  const locked = view.changeAllowed === "no";
  // The server keeps a saved key only for the same provider and address, so the hint promises no more than that.
  const keyKept =
    view.source === "app" && view.keySet && view.provider === provider && (!compatible || sameAddress(baseUrl, view.baseUrl));

  const submit = (test: boolean) => {
    if (!formRef.current?.reportValidity()) return;
    onSave({
      provider,
      apiKey: apiKey.trim() || undefined,
      baseUrl: compatible ? baseUrl.trim() : undefined,
      model: gateway ? gatewayModel : modelId.trim(),
      models: gateway
        ? undefined
        : moreModels
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
      test,
    });
  };

  return (
    <form
      ref={formRef}
      className="connection-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit(true);
      }}
    >
      <p className="connection-now">
        {view.provider && (
          <strong>
            {PROVIDER_CHOICES[view.provider]}, {view.model}.
          </strong>
        )}{" "}
        {SOURCE_TEXT[view.source]}.
        {view.local && <span className="badge">Local model, nothing leaves this machine</span>}
      </p>

      {locked && (
        <p className="connection-locked" role="status">
          The connection cannot be changed from here. That needs either the app started on localhost (
          <code>npm run dev</code> and <code>npm start</code> do), opened at <code>http://localhost</code> with no proxy
          in front, or <code>SETTINGS_TOKEN</code> set on the server. It can also be set in <code>.env.local</code>.
        </p>
      )}

      {view.changeAllowed === "token" && (
        <div className="field">
          <label htmlFor="connection-token">Settings token</label>
          <input
            id="connection-token"
            type="password"
            required
            maxLength={400}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="connection-token-hint"
            value={token}
            onChange={(event) => onToken(event.target.value)}
            disabled={working}
          />
          <p className="field-hint" id="connection-token-hint">
            The <code>SETTINGS_TOKEN</code> value this server was started with. It is needed to change the connection,
            is kept only until this page is closed, and is never stored.
          </p>
        </div>
      )}

      <div className="field">
        <label htmlFor="connection-provider">Provider</label>
        <select
          id="connection-provider"
          value={provider}
          onChange={(event) => setProvider(event.target.value as ProviderName)}
          disabled={working}
        >
          {PROVIDER_NAMES.map((name) => (
            <option key={name} value={name}>
              {PROVIDER_CHOICES[name]}
            </option>
          ))}
        </select>
      </div>

      {compatible && (
        <div className="field">
          <label htmlFor="connection-address">Server address</label>
          <input
            id="connection-address"
            type="url"
            inputMode="url"
            required
            maxLength={500}
            autoComplete="off"
            spellCheck={false}
            placeholder="http://localhost:11434/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            disabled={working}
          />
          <p className="field-fills">
            {LOCAL_SERVERS.map((server) => (
              <button
                key={server.name}
                type="button"
                className="button small quiet"
                onClick={() => setBaseUrl(server.address)}
                disabled={working}
              >
                Use {server.name}
              </button>
            ))}
          </p>
        </div>
      )}

      <div className="field">
        <label htmlFor="connection-key">{compatible ? "API key, if your server asks for one" : "API key"}</label>
        <input
          id="connection-key"
          type="password"
          maxLength={400}
          autoComplete="off"
          spellCheck={false}
          required={!compatible && !keyKept}
          aria-describedby="connection-key-hint"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          disabled={working}
        />
        <p className="field-hint" id="connection-key-hint">
          {keyKept
            ? `${view.keyLast4 ? `A key ending in ${view.keyLast4} is saved.` : "A key is saved."} Leave this empty to keep it.`
            : compatible
              ? "Not needed for a local server. The key is stored on this machine and is never shown again."
              : "The key is stored on this machine and is never shown again."}
        </p>
      </div>

      {gateway ? (
        <div className="field">
          <label htmlFor="connection-model">Model</label>
          <select
            id="connection-model"
            value={gatewayModel}
            onChange={(event) => setGatewayModel(event.target.value)}
            disabled={working}
          >
            {FEATURED_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="connection-model">Model id</label>
            <input
              id="connection-model"
              type="text"
              required
              maxLength={120}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={compatible ? "llama3.2" : "The id your provider uses"}
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              disabled={working}
            />
          </div>
          <div className="field">
            <label htmlFor="connection-more">More model ids for the picker (optional)</label>
            <input
              id="connection-more"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby="connection-more-hint"
              value={moreModels}
              onChange={(event) => setMoreModels(event.target.value)}
              disabled={working}
            />
            <p className="field-hint" id="connection-more-hint">
              Separate ids with commas.
            </p>
          </div>
        </>
      )}

      {status.kind !== "idle" && (
        <p
          className={status.kind === "failed" ? "settings-status failed" : status.kind === "saved" ? "settings-status ok" : "settings-status"}
          role={status.kind === "failed" ? "alert" : "status"}
        >
          {status.message}
        </p>
      )}

      <div className="connection-actions">
        <button type="submit" className="button" disabled={working || locked}>
          Test and save
        </button>
        <button type="button" className="button quiet" onClick={() => submit(false)} disabled={working || locked}>
          Save without testing
        </button>
        <button
          type="button"
          className="button quiet"
          onClick={() => {
            // Forgetting needs the token too, and nothing else from the form.
            if (view.changeAllowed === "token" && !token.trim()) formRef.current?.reportValidity();
            else onForget();
          }}
          disabled={working || locked || view.source !== "app"}
        >
          Forget this connection
        </button>
        <button type="button" className="button quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="field-hint">
        Test and save sends one short request and saves only if the model answers. Forgetting returns to whatever{" "}
        <code>.env.local</code> provides.
      </p>
    </form>
  );
}

interface DialogProps {
  onClose: () => void;
  /** Called after a save or a forget, so the rest of the app reloads which model is connected. */
  onChanged: () => void;
  /** Held by the page, in memory, so it survives closing the panel but not the tab. */
  token: string;
  onToken: (token: string) => void;
}

const messageOf = (reason: unknown, fallback: string) => (reason instanceof Error ? reason.message : fallback);

/** The panel as a modal dialog: the browser keeps focus inside it and Escape closes it. */
export function ConnectionDialog({ onClose, onChanged, token, onToken }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<ConnectionView | null>(null);
  // Bumped whenever the server reports a new state, so the form starts again from it with an empty key field.
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "idle" });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchConnection()
      .then((loaded) => {
        if (!cancelled) setView(loaded);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setStatus({ kind: "failed", message: messageOf(reason, "The connection settings could not be loaded.") });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = (next: ConnectionView, message: string) => {
    setView(next);
    setRevision((current) => current + 1);
    setStatus({ kind: "saved", message });
    onChanged();
  };

  const save = async (input: ConnectionInput) => {
    setStatus({ kind: "working", message: input.test ? "Asking the model for one word" : "Saving" });
    try {
      const next = await saveConnectionSettings(input, token.trim());
      apply(next, input.test ? "The model answered. The connection is saved and in use." : "Saved without testing. It is in use from the next question.");
    } catch (reason) {
      setStatus({ kind: "failed", message: messageOf(reason, "The connection could not be saved.") });
    }
  };

  const forget = async () => {
    setStatus({ kind: "working", message: "Forgetting the saved connection" });
    try {
      const next = await forgetConnectionSettings(token.trim());
      apply(
        next,
        next.source === "env"
          ? "Forgotten. The connection from the settings file is in use again."
          : "Forgotten. No model is connected now.",
      );
    } catch (reason) {
      setStatus({ kind: "failed", message: messageOf(reason, "The saved connection could not be removed.") });
    }
  };

  const close = () => dialogRef.current?.close();

  return (
    <dialog ref={dialogRef} className="connection-dialog" aria-labelledby="connection-title" onClose={onClose}>
      <h2 id="connection-title">Connection</h2>
      {view ? (
        <ConnectionSettings
          key={revision}
          view={view}
          status={status}
          token={token}
          onToken={onToken}
          onSave={save}
          onForget={forget}
          onClose={close}
        />
      ) : (
        <>
          <p className={status.kind === "failed" ? "settings-status failed" : "settings-status"} role="status">
            {status.kind === "failed" ? status.message : "Loading the connection"}
          </p>
          <div className="connection-actions">
            <button type="button" className="button quiet" onClick={close}>
              Close
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
