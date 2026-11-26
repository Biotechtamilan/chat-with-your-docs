/**
 * Turns a natural-language question into a Postgres `to_tsquery` string.
 *
 * Two things matter here:
 *  - Terms are OR-ed. Postgres' convenience parsers AND every term, so a full
 *    sentence would match almost nothing. With OR, ranking decides the order.
 *  - Only letters and digits survive, so user text can never inject tsquery
 *    operators (`&`, `!`, `:*`, parentheses).
 */
const MAX_TERMS = 24;

export function toTsQuery(text: string): string | null {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const unique = [...new Set(terms)].slice(0, MAX_TERMS);
  return unique.length > 0 ? unique.join(" | ") : null;
}
