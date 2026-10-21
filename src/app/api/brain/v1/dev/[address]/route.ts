// GET /api/brain/v1/dev/<адрес> — CrawlHive Brain: репутация дева: запуски, которые видел рой, и история pump.fun (только Solana).
// Новый скан не запускается. Лимиты и оплата — в brain.ts.
import type { NextRequest } from "next/server";
import { BRAIN_CORS, brainRoute, devReport } from "@/lib/server/brain";
import "@/lib/server/store";

export async function GET(req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  return brainRoute(req, "lookup", () => devReport(address));
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: BRAIN_CORS });
}
