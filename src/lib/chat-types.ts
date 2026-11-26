import type { UIMessage } from "ai";
import type { SourceRef, TraceData } from "./types";

/**
 * Besides the answer text, each assistant message carries two typed data parts:
 * the passages it was shown, and the trace of how it was produced. Both travel
 * on the same stream as the text, so the evidence appears before the answer.
 */
export type ChatDataParts = {
  sources: { sources: SourceRef[] };
  trace: TraceData;
};

export type ChatUIMessage = UIMessage<unknown, ChatDataParts>;
