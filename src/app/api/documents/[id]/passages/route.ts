import { handleSourcePassages } from "@/lib/notebook/notes";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleSourcePassages((await params).id);
}
