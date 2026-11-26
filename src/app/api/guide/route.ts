import { handleGuide } from "@/lib/notebook/guide";

export const maxDuration = 60;

/** A POST because writing a guide can call the model; a stored guide is returned without one. */
export async function POST(request: Request) {
  return handleGuide(request);
}
