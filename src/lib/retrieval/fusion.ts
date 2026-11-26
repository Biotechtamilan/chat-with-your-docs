/**
 * Reciprocal Rank Fusion.
 *
 * Vector similarity and keyword rank scores live on unrelated scales, so adding
 * them would need per-corpus calibration. RRF sidesteps that by using only each
 * result's position: score = sum over legs of 1 / (k + rank). A chunk that both
 * legs like rises to the top; a chunk only one leg found still gets a say.
 * k = 60 is the value from the original paper and is rarely worth tuning.
 */
export interface FusedResult {
  id: string;
  score: number;
  /** 1-based rank per leg name, absent when that leg did not return the id. */
  ranks: Record<string, number>;
}

export function reciprocalRankFusion(legs: Record<string, string[]>, k = 60): FusedResult[] {
  const byId = new Map<string, FusedResult>();

  for (const [leg, ids] of Object.entries(legs)) {
    ids.forEach((id, index) => {
      const rank = index + 1;
      const entry = byId.get(id) ?? { id, score: 0, ranks: {} };
      // A duplicate id inside one leg keeps its best (first) rank.
      if (entry.ranks[leg] === undefined) {
        entry.ranks[leg] = rank;
        entry.score += 1 / (k + rank);
      }
      byId.set(id, entry);
    });
  }

  // Ties break on id so the order is deterministic across runs.
  return [...byId.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
