import { listTraces } from "@/lib/retrieval/store";

/**
 * The most recent answer traces, newest first: a debugging aid.
 * Traces contain the questions people asked and the app has no login, so this
 * endpoint is off unless ENABLE_TRACE_API=true.
 */
export async function GET() {
  if (process.env.ENABLE_TRACE_API !== "true") return new Response("Not found", { status: 404 });
  return Response.json({ traces: await listTraces(50) });
}
