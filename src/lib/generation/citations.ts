/**
 * The model is asked to cite sources as [1], [2] or [1, 3]. Nothing forces it
 * to behave, so every answer is checked after generation:
 *  - numbers that point at no source are reported as invalid (and the UI does
 *    not render them as links), and
 *  - an answer with no valid citation is flagged as ungrounded.
 */
export interface CitationReport {
  /** Valid source numbers the answer cites, ascending, without duplicates. */
  cited: number[];
  /** Numbers the answer cites that do not correspond to any source. */
  invalid: number[];
  grounded: boolean;
}

/** Matches [3] and [1, 2, 5]. Up to three digits keeps years like [2024] out. */
export const CITATION_PATTERN = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;

export function analyzeCitations(answer: string, sourceCount: number): CitationReport {
  const cited = new Set<number>();
  const invalid = new Set<number>();

  for (const match of answer.matchAll(CITATION_PATTERN)) {
    for (const part of match[1].split(",")) {
      const n = Number(part.trim());
      if (n >= 1 && n <= sourceCount) cited.add(n);
      else invalid.add(n);
    }
  }

  const ascending = (a: number, b: number) => a - b;
  return {
    cited: [...cited].sort(ascending),
    invalid: [...invalid].sort(ascending),
    grounded: cited.size > 0,
  };
}
