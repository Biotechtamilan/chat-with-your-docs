import { handleUpload } from "@/lib/ingest/upload";
import { listDocuments } from "@/lib/retrieval/store";

// Embedding a large file takes a while; allow it on platforms that enforce a limit.
export const maxDuration = 300;

export async function GET() {
  return Response.json({ documents: await listDocuments() });
}

export async function POST(request: Request) {
  return handleUpload(request);
}
