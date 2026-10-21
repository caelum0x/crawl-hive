// GET /api/brain/v1/token/<адрес> — CrawlHive Brain: последний вердикт токена, его снимки, что изменилось с прошлого скана и исход по Track Record.
// Новый скан не запускается. Лимиты и оплата — в brain.ts.
import type { NextRequest } from "next/server";
import { BRAIN_CORS, brainRoute, tokenReport } from "@/lib/server/brain";
import "@/lib/server/store";

export async function GET(req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  return brainRoute(req, "lookup", () => tokenReport(address));
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: BRAIN_CORS });
}
