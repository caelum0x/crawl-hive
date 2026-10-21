// GET /api/brain/v1/track — CrawlHive Brain: как часто каждый наш вердикт оказывался прав через 24 часа. Бесплатно.
import type { NextRequest } from "next/server";
import { BRAIN_CORS, brainRoute, trackReport } from "@/lib/server/brain";
import "@/lib/server/store";

export async function GET(req: NextRequest) {
  return brainRoute(req, "track", trackReport);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: BRAIN_CORS });
}
