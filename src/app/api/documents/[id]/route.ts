import { CROSS_SITE_MESSAGE, isCrossSiteRequest } from "@/lib/guardrails";
import { deleteDocument } from "@/lib/retrieval/store";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSiteRequest(request.headers)) return Response.json({ error: CROSS_SITE_MESSAGE }, { status: 403 });
  const { id } = await params;
  const removed = await deleteDocument(id);
  if (!removed) return Response.json({ error: "That document no longer exists." }, { status: 404 });
  return Response.json({ removed: true });
}
