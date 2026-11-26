import { CITATION_PATTERN } from "../generation/citations";
import { whereLabel } from "../labels";
import type { Note } from "../types";

/**
 * Builds the Markdown export of a conversation and its notes.
 *
 * In the app, citation numbers restart with every answer: [1] in one answer
 * and [1] in the next are different passages. A document cannot work that way,
 * so the export gives every cited passage one number for the whole file,
 * rewrites the markers to match, and ends with a single numbered source list.
 *
 * Pure and free of server imports: the browser runs it for "Copy" and "Download".
 */

/** The part of a source the export needs. Both an answer's passages and a note's sources fit it. */
export interface ExportSource {
  n: number | null;
  chunkId: string;
  documentName: string;
  heading: string | null;
  page: number | null;
  pageEnd: number | null;
}

export interface ExportTurn {
  question: string;
  answer: string;
  sources: ExportSource[];
}

export interface ExportInput {
  turns: ExportTurn[];
  notes: Note[];
  /** ISO timestamp, passed in so the function stays deterministic. */
  exportedAt: string;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const day = (iso: string) => iso.slice(0, 10);

class SourceList {
  private readonly numbers = new Map<string, number>();
  readonly lines: string[] = [];

  /** The export-wide number for a passage, assigned the first time it is cited. */
  numberFor(source: ExportSource): number {
    const known = this.numbers.get(source.chunkId);
    if (known) return known;
    const number = this.lines.length + 1;
    this.numbers.set(source.chunkId, number);
    const where = whereLabel(source);
    this.lines.push(`${number}. ${oneLine(source.documentName)}${where ? `, ${oneLine(where)}` : ""}`);
    return number;
  }
}

/** Rewrites "[1, 3]" from an answer's own numbering to the export's. A number with no passage becomes "[?]". */
function renumber(text: string, sources: ExportSource[], list: SourceList): string {
  const byNumber = new Map(sources.flatMap((source) => (source.n === null ? [] : [[source.n, source] as const])));
  return text.replace(CITATION_PATTERN, (_whole, group: string) => {
    const mapped = group.split(",").map((part) => {
      const source = byNumber.get(Number(part.trim()));
      return source ? String(list.numberFor(source)) : "?";
    });
    return `[${[...new Set(mapped)].join(", ")}]`;
  });
}

export function buildMarkdownExport(input: ExportInput): string {
  const list = new SourceList();
  const out: string[] = ["# Marginalia notebook", "", `Exported ${day(input.exportedAt)}.`];

  if (input.turns.length > 0) {
    out.push("", "## Conversation");
    input.turns.forEach((turn, index) => {
      out.push("", `### ${index + 1}. ${oneLine(turn.question)}`, "", renumber(turn.answer.trim(), turn.sources, list));
    });
  }

  if (input.notes.length > 0) {
    out.push("", "## Notes");
    for (const note of input.notes) {
      out.push("", `### ${oneLine(note.title)}`, "");
      if (note.kind === "answer") {
        if (note.question) out.push(`Saved ${day(note.createdAt)}, in reply to: ${oneLine(note.question)}`, "");
        else out.push(`Saved ${day(note.createdAt)}.`, "");
        out.push(renumber(note.body.trim(), note.sources, list));
      } else {
        const numbers = note.sources.map((source) => list.numberFor(source));
        out.push(`Saved ${day(note.createdAt)}. A passage quoted as written.`, "");
        out.push(...note.body.trim().split("\n").map((line) => `> ${line}`));
        if (numbers.length > 0) out.push("", `Source: [${numbers.join(", ")}]`);
      }
    }
  }

  if (input.turns.length === 0 && input.notes.length === 0) out.push("", "Nothing to export yet.");

  if (list.lines.length > 0) out.push("", "## Sources", "", ...list.lines);
  return `${out.join("\n")}\n`;
}
