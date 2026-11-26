import path from "node:path";
import { getConfig, type AppConfig } from "../config";

/**
 * Embeddings run locally (ONNX on CPU) instead of through an API.
 *
 * Why: Token Pass credit covers chat models only, and a Token Pass-scoped key
 * is rejected by every other endpoint. Embedding locally means the gateway key
 * is used for one thing, documents are never sent anywhere at indexing time,
 * and indexing costs nothing. The price is CPU time during upload.
 */
export interface Embedder {
  readonly model: string;
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]>;
}

type Extractor = (
  texts: string[],
  options: { pooling: "cls" | "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

const holder = globalThis as typeof globalThis & { __docsExtractor?: Promise<Extractor> };

/** Small batches keep memory flat and give the progress bar something to report. */
const BATCH_SIZE = 8;

class LocalEmbedder implements Embedder {
  readonly model: string;

  constructor(private readonly config: AppConfig) {
    this.model = config.embeddingModel;
  }

  /** The model is loaded once per process, on first use (about 35 MB, cached on disk). */
  private extractor(): Promise<Extractor> {
    if (!holder.__docsExtractor) {
      holder.__docsExtractor = (async () => {
        // Imported lazily so tests and `next build` never load the ONNX runtime.
        const { pipeline, env } = await import("@huggingface/transformers");
        const root = this.config.dataDir === ":memory:" ? ".data" : this.config.dataDir;
        env.cacheDir = path.resolve(root, "models");
        const extractor = await pipeline("feature-extraction", this.model, { dtype: "q8" });
        return extractor as unknown as Extractor;
      })().catch((error) => {
        holder.__docsExtractor = undefined;
        throw new Error(`Could not load the embedding model "${this.model}": ${String(error?.message ?? error)}`);
      });
    }
    return holder.__docsExtractor;
  }

  private async run(texts: string[]): Promise<number[][]> {
    const extractor = await this.extractor();
    // bge models are trained with CLS pooling; vectors are normalised so cosine = dot product.
    const output = await extractor(texts, { pooling: "cls", normalize: true });
    return output.tolist();
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.run([`${this.config.embeddingQueryPrefix}${text}`]);
    return embedding;
  }

  async embedDocuments(texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      embeddings.push(...(await this.run(texts.slice(start, start + BATCH_SIZE))));
      onProgress?.(embeddings.length, texts.length);
    }
    return embeddings;
  }
}

const MOCK_STOP_WORDS = new Set(["the", "and", "for", "are", "was", "with", "that", "this", "what", "how", "does", "can"]);

/** FNV-1a: a tiny, stable string hash. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic stand-in for tests and CI: a hashed bag of words. Texts that
 * share words get similar vectors, which is enough to exercise the whole
 * pipeline without downloading a model. It has no notion of meaning.
 */
export class MockEmbedder implements Embedder {
  readonly model = "mock/hash-bow-v1";

  constructor(private readonly dimensions: number) {}

  private embed(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    for (const word of words) {
      if (MOCK_STOP_WORDS.has(word)) continue;
      const stem = word.replace(/(ing|ed|es|s)$/, ""); // crude, but "refunds" should meet "refund"
      const h = hash(stem);
      vector[h % this.dimensions] += h & 0x100 ? 1 : -1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  async embedDocuments(texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]> {
    const embeddings = texts.map((text) => this.embed(text));
    onProgress?.(texts.length, texts.length);
    return embeddings;
  }
}

export function getEmbedder(config: AppConfig = getConfig()): Embedder {
  return config.mock ? new MockEmbedder(config.embeddingDimensions) : new LocalEmbedder(config);
}
