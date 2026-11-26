import { handleChat } from "@/lib/generation/chat";

export const maxDuration = 60;

/** The route stays thin on purpose: the logic lives in a plain function that tests can call. */
export async function POST(request: Request) {
  return handleChat(request);
}
