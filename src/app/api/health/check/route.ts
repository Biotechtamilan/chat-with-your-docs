import { handleConnectionCheck } from "@/lib/ai/provider";

/**
 * Sends one tiny request to the configured model and reports whether it
 * answered. It spends a few tokens, so it is a POST, refuses other sites, and
 * is rate limited.
 */
export async function POST(request: Request) {
  return handleConnectionCheck(request);
}
