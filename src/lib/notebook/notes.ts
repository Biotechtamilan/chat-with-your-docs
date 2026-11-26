import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getConfig } from "../config";
import { CROSS_SITE_MESSAGE, isCrossSiteRequest } from "../guardrails";
import { countNotes, createNote, deleteNote, getDocument, listNotes, listPassages, renameNote } from "../retrieval/store";

/**
 * Notes: an answer or a passage the reader chose to keep. A note copies the
 * text and the name and position of each source it came from, so it still
 * makes sense after the conversation is cleared or the source is removed.
 */

const TITLE_MAX_CHARS = 200;
const BODY_MAX_CHARS = 20_000;

const title = z.string().trim().min(1).max(TITLE_MAX_CHARS);

const sourceSchema = z.object({
  n: z.number().int().min(1).max(999).nullable(),
  chunkId: z.string().min(1).max(200),
  documentId: z.string().min(1).max(200),
  documentName: z.string().min(1).max(200),
  heading: z.string().max(500).nullable(),
  page: z.number().int().min(1).nullable(),
  pageEnd: z.number().int().min(1).nullable(),
});

export const noteInputSchema = z.object({
  kind: z.enum(["answer", "passage"]),
  title,
  body: z.string().trim().min(1).max(BODY_MAX_CHARS),
  question: z.string().trim().min(1).max(2000).nullable(),
  sources: z.array(sourceSchema).max(20),
});

const refuse = (status: number, error: string) => Response.json({ error }, { status });

export async function handleListNotes(): Promise<Response> {
  return Response.json({ notes: await listNotes() });
}

export async function handleCreateNote(request: Request): Promise<Response> {
  if (isCrossSiteRequest(request.headers)) return refuse(403, CROSS_SITE_MESSAGE);
  const parsed = noteInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return refuse(400, "That note could not be saved: it is empty, too long, or not a note.");
  const limit = getConfig().maxNotes;
  if ((await countNotes()) >= limit) return refuse(409, `There are already ${limit} notes. Delete one to add another.`);
  const note = await createNote({ id: randomUUID(), ...parsed.data });
  return Response.json({ note }, { status: 201 });
}

export async function handleRenameNote(request: Request, id: string): Promise<Response> {
  if (isCrossSiteRequest(request.headers)) return refuse(403, CROSS_SITE_MESSAGE);
  const parsed = z.object({ title }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return refuse(400, `A note needs a title of 1 to ${TITLE_MAX_CHARS} characters.`);
  const note = await renameNote(id, parsed.data.title);
  return note ? Response.json({ note }) : refuse(404, "That note no longer exists.");
}

export async function handleDeleteNote(request: Request, id: string): Promise<Response> {
  if (isCrossSiteRequest(request.headers)) return refuse(403, CROSS_SITE_MESSAGE);
  return (await deleteNote(id)) ? Response.json({ removed: true }) : refuse(404, "That note no longer exists.");
}

/** A source's extracted text, passage by passage, for reading it in the right pane. */
export async function handleSourcePassages(id: string): Promise<Response> {
  const document = await getDocument(id);
  if (!document || document.status !== "ready") return refuse(404, "That source no longer exists.");
  return Response.json({ document, passages: await listPassages(id) });
}
