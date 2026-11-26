import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { isAllowedHost, WRONG_HOST_MESSAGE } from "@/lib/guardrails";

/**
 * Runs before every API route. The routes hold the documents, the notes and
 * the model connection, so a request addressed to a name this app does not
 * answer to is refused before any of them sees it. The page itself carries no
 * data and is left alone.
 */
export function proxy(request: NextRequest): NextResponse {
  if (isAllowedHost(request.headers.get("host"), getConfig().allowedHosts)) return NextResponse.next();
  return NextResponse.json({ error: WRONG_HOST_MESSAGE }, { status: 403, headers: { "Cache-Control": "no-store" } });
}

export const config = {
  matcher: "/api/:path*",
};
