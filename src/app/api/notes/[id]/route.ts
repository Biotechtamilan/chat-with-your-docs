import { handleDeleteNote, handleRenameNote } from "@/lib/notebook/notes";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  return handleRenameNote(request, (await params).id);
}

export async function DELETE(request: Request, { params }: Context) {
  return handleDeleteNote(request, (await params).id);
}
