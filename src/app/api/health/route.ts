import { modelLabel } from "@/lib/ai/models";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/log";
import { countIndex } from "@/lib/retrieval/store";
import type { HealthReport } from "@/lib/types";

/** Liveness plus the facts the UI needs on load: mode, models, and index size. */
export async function GET() {
  try {
    const config = getConfig();
    const index = await countIndex();
    const report: HealthReport = {
      ok: true,
      mode: config.chatMode,
      chatModel: config.chatModel,
      provider: config.provider,
      local: config.local,
      connectionSource: config.connectionSource,
      warning: config.warning,
      chatModels: config.allowedChatModels.map((id) => ({ id, label: modelLabel(id) })),
      embeddingModel: config.embeddingModel,
      documents: index.documents,
      chunks: index.chunks,
      limits: {
        maxDocuments: config.maxDocuments,
        maxUploadMb: Math.round(config.maxUploadBytes / (1024 * 1024)),
      },
    };
    return Response.json(report);
  } catch (error) {
    return Response.json({ ok: false, error: errorMessage(error) }, { status: 503 });
  }
}
