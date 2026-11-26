/**
 * Structure-aware chunking.
 *
 * Goals, in priority order:
 *  1. A chunk never crosses a section boundary, so its heading describes all of it.
 *  2. A chunk ends on a sentence boundary whenever the text allows it.
 *  3. Chunks stay near a target size, small enough that one chunk is about one idea.
 *  4. Neighbouring chunks in a section share a sentence or two, so a fact that
 *     straddles a boundary is still retrievable from one of them.
 */

export interface Block {
  text: string;
  /** Heading path from the document root, e.g. ["Refunds", "Exceptions"]. */
  heading: string[];
  page?: number;
  /** Code is split by line rather than by sentence. */
  kind?: "code";
}

export interface Chunk {
  ord: number;
  content: string;
  heading: string | null;
  /** First and last page the chunk draws from (PDFs only). They differ when text runs over a page break. */
  page: number | null;
  pageEnd: number | null;
  tokens: number;
}

export interface ChunkOptions {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

/**
 * Roughly four characters per token for English prose. An estimate is enough
 * here: the limits it feeds have wide margins, and it avoids shipping a tokenizer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

export function splitSentences(text: string): string[] {
  return Array.from(sentenceSegmenter.segment(text), (s) => s.segment.trim()).filter(Boolean);
}

interface Unit {
  text: string;
  section: string;
  page: number | null;
  kind?: "code";
}

/** Last resort for a single "sentence" longer than a whole chunk (tables, minified text). */
function splitByWords(text: string, maxTokens: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current && estimateTokens(`${current} ${word}`) > maxTokens) {
      parts.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Greedily packs small pieces into groups no larger than `limit` tokens. */
function pack(pieces: string[], limit: number, joiner: string): string[] {
  const groups: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const candidate = current ? `${current}${joiner}${piece}` : piece;
    if (current && estimateTokens(candidate) > limit) {
      groups.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current) groups.push(current);
  return groups;
}

/** Breaks a block into pieces that each fit in one chunk. */
function toUnits(block: Block, options: ChunkOptions): Unit[] {
  const section = block.heading.join(" › ");
  const page = block.page ?? null;
  const text = block.text.trim();
  if (!text) return [];
  if (estimateTokens(text) <= options.maxTokens) {
    return [{ text, section, page, kind: block.kind }];
  }

  const pieces =
    block.kind === "code"
      ? pack(text.split("\n"), options.targetTokens, "\n")
      : pack(
          splitSentences(text).flatMap((sentence) =>
            estimateTokens(sentence) > options.maxTokens
              ? splitByWords(sentence, options.targetTokens)
              : [sentence],
          ),
          options.targetTokens,
          " ",
        );
  return pieces.map((piece) => ({ text: piece, section, page, kind: block.kind }));
}

/** The trailing sentences of a chunk, up to the overlap budget. */
function overlapTail(content: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return "";
  const sentences = splitSentences(content);
  const tail: string[] = [];
  let used = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const cost = estimateTokens(sentences[i]);
    if (used + cost > overlapTokens) break;
    tail.unshift(sentences[i]);
    used += cost;
  }
  return tail.join(" ");
}

export function chunkBlocks(blocks: Block[], options: ChunkOptions): Chunk[] {
  const units = blocks.flatMap((block) => toUnits(block, options));
  const chunks: Chunk[] = [];

  let parts: string[] = [];
  let section = "";
  let page: number | null = null;
  let pageEnd: number | null = null;

  const flush = (): string => {
    const content = parts.join("\n\n").trim();
    if (content) {
      chunks.push({
        ord: chunks.length,
        content,
        heading: section || null,
        page,
        pageEnd,
        tokens: estimateTokens(content),
      });
    }
    parts = [];
    return content;
  };

  for (const unit of units) {
    const sameSection = parts.length > 0 && unit.section === section;
    const wouldBe = estimateTokens([...parts, unit.text].join("\n\n"));

    if (parts.length > 0 && (!sameSection || wouldBe > options.targetTokens)) {
      const previous = flush();
      const previousPageEnd = pageEnd;
      // Carry context forward only inside a section, and never into code:
      // a prose sentence glued onto a code block helps neither.
      if (sameSection && unit.kind !== "code") {
        const tail = overlapTail(previous, options.overlapTokens);
        if (tail && tail !== previous) {
          parts.push(tail);
          // The carried sentences come from the end of the previous chunk,
          // so this chunk starts on the page where that one ended.
          page = previousPageEnd;
        }
      }
    }
    if (parts.length === 0) {
      section = unit.section;
      page = unit.page;
    }
    pageEnd = unit.page;
    parts.push(unit.text);
  }
  flush();
  return chunks;
}

/**
 * The text that gets embedded. Prefixing the document name and heading gives
 * the vector the context a reader would have ("Refund policy › Exceptions"),
 * which matters for short chunks full of pronouns. The stored content stays raw.
 */
export function embeddingText(documentName: string, chunk: Pick<Chunk, "content" | "heading">): string {
  const header = [documentName, chunk.heading].filter(Boolean).join(" › ");
  return `${header}\n\n${chunk.content}`;
}
