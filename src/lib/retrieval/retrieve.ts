import type { AppConfig } from "../config";
import type { Embedder } from "../ai/embedder";
import type { TraceRecorder } from "../trace";
import type { SourceRef } from "../types";
import { reciprocalRankFusion } from "./fusion";
import { toTsQuery } from "./lexical";
import { denseSearch, lexicalSearch, type ChunkHit } from "./store";

export interface RetrievalResult {
  /** Fused, numbered passages in the order shown to the model. */
  sources: SourceRef[];
  /** Highest cosine similarity from the vector leg, or null if it returned nothing. */
  bestSimilarity: number | null;
  /** How many chunks the keyword leg matched. */
  lexicalHits: number;
}

/**
 * Hybrid retrieval: a vector search and a keyword search run side by side and
 * their rankings are fused.
 *
 * Embeddings find passages that mean the same thing in different words.
 * Keyword search finds exact strings (an error code, a surname, a clause
 * number) that embeddings tend to blur. Each covers the other's blind spot.
 */
export async function retrieve(
  query: string,
  options: { embedder: Embedder; config: AppConfig; documentIds?: string[]; trace?: TraceRecorder },
): Promise<RetrievalResult> {
  const { embedder, config, documentIds, trace } = options;
  const { candidatesPerLeg, topK } = config.retrieval;
  const timed = <T>(name: string, run: () => Promise<T>) => (trace ? trace.stage(name, run) : run());

  const queryEmbedding = await timed("embed_query", () => embedder.embedQuery(query));

  const tsQuery = toTsQuery(query);
  const [dense, lexical] = await timed("search", () =>
    Promise.all([
      denseSearch(queryEmbedding, candidatesPerLeg, documentIds),
      tsQuery ? lexicalSearch(tsQuery, candidatesPerLeg, documentIds) : Promise.resolve([] as ChunkHit[]),
    ]),
  );

  const fused = reciprocalRankFusion({
    dense: dense.map((hit) => hit.id),
    lexical: lexical.map((hit) => hit.id),
  });

  const byId = new Map<string, ChunkHit>();
  for (const hit of [...lexical, ...dense]) byId.set(hit.id, hit); // dense last: keep its row
  const similarity = new Map(dense.map((hit) => [hit.id, hit.score]));

  const sources: SourceRef[] = fused.slice(0, topK).map((result, index) => {
    const hit = byId.get(result.id)!;
    return {
      n: index + 1,
      chunkId: hit.id,
      documentId: hit.documentId,
      documentName: hit.documentName,
      heading: hit.heading,
      page: hit.page,
      pageEnd: hit.pageEnd,
      content: hit.content,
      similarity: similarity.get(hit.id) ?? null,
      denseRank: result.ranks.dense ?? null,
      lexicalRank: result.ranks.lexical ?? null,
      fusedScore: Number(result.score.toFixed(5)),
    };
  });

  return {
    sources,
    bestSimilarity: dense.length > 0 ? Number(dense[0].score.toFixed(4)) : null,
    lexicalHits: lexical.length,
  };
}

/**
 * The relevance gate: should the model be called at all?
 *
 * It refuses only when both legs come up empty-handed: the best vector match
 * is below the threshold and no keyword matched. That makes it a cheap filter
 * for clearly off-topic questions, not a correctness check. It deliberately
 * leans towards answering, because a wrong refusal ("not in your documents"
 * when it is) is worse for the user than a model call that then says so itself.
 */
export function isAnswerable(result: RetrievalResult, config: AppConfig): boolean {
  if (result.sources.length === 0) return false;
  const similarEnough = result.bestSimilarity !== null && result.bestSimilarity >= config.retrieval.minSimilarity;
  return similarEnough || result.lexicalHits > 0;
}
