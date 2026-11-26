/**
 * How a passage's position is written, in one place so the prompt, the
 * evidence pane, notes and the export all say it the same way. No imports:
 * the browser bundle uses this file too.
 */
/** Provider names as the settings panel lists them. Keyed by the ids in `PROVIDER_NAMES`. */
export const PROVIDER_CHOICES = {
  gateway: "Vercel AI Gateway",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "openai-compatible": "OpenAI-compatible or local server",
} as const;

interface Position {
  page: number | null;
  pageEnd: number | null;
  heading?: string | null;
}

/** "3" for a single page, "3-4" when the passage runs over a page break. */
export function pageLabel(source: Pick<Position, "page" | "pageEnd">): string {
  if (source.page === null) return "";
  const spans = source.pageEnd !== null && source.pageEnd !== source.page;
  return spans ? `${source.page}-${source.pageEnd}` : `${source.page}`;
}

/** "Page 3, Leave › Carry-over", or whichever half exists. Empty when neither does. */
export function whereLabel(source: Position): string {
  const spansPages = source.pageEnd !== null && source.pageEnd !== source.page;
  const page = source.page !== null ? `${spansPages ? "Pages" : "Page"} ${pageLabel(source)}` : null;
  return [page, source.heading ?? null].filter(Boolean).join(", ");
}
