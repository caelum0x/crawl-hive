// GET /api/brain/v1/wallet/<адрес> — CrawlHive Brain: что рой помнит о кошельке: на каких токенах он был снайпером, бандлом, девом, спонсором, и чем они кончились.
// Новый скан не запускается. Лимиты и оплата — в brain.ts.
import type { NextRequest } from "next/server";
import { BRAIN_CORS, brainRoute, walletReport } from "@/lib/server/brain";
import "@/lib/server/store";

export async function GET(req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  return brainRoute(req, "lookup", () => walletReport(address));
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: BRAIN_CORS });
}
