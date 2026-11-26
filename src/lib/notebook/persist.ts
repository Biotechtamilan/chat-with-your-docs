import { z } from "zod";
import type { ChatUIMessage } from "../chat-types";

/**
 * Keeping the conversation across a reload. It lives in the browser's own
 * storage: it is one person's working state, and nothing about it needs the
 * server. What comes back out of storage is treated as untrusted input, since
 * an older version of the app, or anything else on this origin, may have
 * written it.
 */
export const CONVERSATION_STORAGE_KEY = "marginalia.conversation.v1";

/** Browsers allow about 5 MB per origin. Past this, the oldest turns are dropped first. */
const MAX_STORED_CHARS = 2_000_000;

const storedSchema = z.array(
  z.looseObject({
    id: z.string().min(1),
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.looseObject({ type: z.string() })),
  }),
);

/**
 * A reload in the middle of an answer leaves a question with no reply, or a
 * reply cut short. Only finished question and answer pairs are worth keeping.
 */
function completePairs(messages: ChatUIMessage[]): ChatUIMessage[] {
  const kept: ChatUIMessage[] = [];
  for (let index = 0; index + 1 < messages.length; index++) {
    const [question, answer] = [messages[index], messages[index + 1]];
    if (question.role === "user" && answer.role === "assistant") {
      kept.push(question, answer);
      index++;
    }
  }
  return kept;
}

export function serializeConversation(messages: ChatUIMessage[]): string {
  let kept = completePairs(messages);
  let text = JSON.stringify(kept);
  while (text.length > MAX_STORED_CHARS && kept.length > 2) {
    kept = kept.slice(2);
    text = JSON.stringify(kept);
  }
  return text.length > MAX_STORED_CHARS ? "[]" : text;
}

/** Returns an empty conversation for anything missing, damaged or of the wrong shape. */
export function restoreConversation(raw: string | null): ChatUIMessage[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = storedSchema.safeParse(value);
  return parsed.success ? completePairs(parsed.data as unknown as ChatUIMessage[]) : [];
}
