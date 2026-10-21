// GET /api/brain/v1/operator/<op_id> — CrawlHive Brain: оператор, то есть кошельки, которые рой видел связанными
// на 2+ разных токенах: сколько их, на каких монетах, в каких ролях и чем монеты кончились. Лимиты и оплата — в brain.ts.
import type { NextRequest } from "next/server";
import { BRAIN_CORS, brainRoute, operatorReport } from "@/lib/server/brain";
import "@/lib/server/store";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return brainRoute(req, "lookup", () => operatorReport(id));
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: BRAIN_CORS });
}
