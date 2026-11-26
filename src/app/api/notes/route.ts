import { handleCreateNote, handleListNotes } from "@/lib/notebook/notes";

export async function GET() {
  return handleListNotes();
}

export async function POST(request: Request) {
  return handleCreateNote(request);
}
