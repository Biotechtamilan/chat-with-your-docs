import { handleForgetConnection, handleGetConnection, handleSaveConnection } from "@/lib/ai/connection";

/**
 * The model connection set from the settings panel. Reading it never returns
 * the key. Changing it is refused for other sites, and allowed only when the
 * server listens on this machine alone or the request carries the settings
 * token. Saving is rate limited.
 */
export async function GET(request: Request) {
  return handleGetConnection(request);
}

export async function PUT(request: Request) {
  return handleSaveConnection(request);
}

export async function DELETE(request: Request) {
  return handleForgetConnection(request);
}
