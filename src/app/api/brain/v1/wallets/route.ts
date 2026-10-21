// POST /api/brain/v1/wallets {"wallets": [...]} — CrawlHive Brain: пакетная проверка до 100 кошельков по памяти роя.
// Тело читаем до оплаты и лимита: за кривой запрос не платят и попытку не тратят.
import type { NextRequest } from "next/server";
import { connection } from "next/server";
import { BRAIN_CORS, brainRoute, parseWallets, walletsReport } from "@/lib/server/brain";
import { body } from "@/lib/server/http";
import { ApiError } from "@/lib/server/store";

export async function POST(req: NextRequest) {
  await connection();
  let wallets: string[];
  try {
    wallets = parseWallets(await body<unknown>(req));
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError("Bad request");
    return Response.json({ error: err.message }, { status: err.status, headers: { ...BRAIN_CORS, "Cache-Control": "no-store" } });
  }
  return brainRoute(req, "batch", () => walletsReport(wallets));
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: BRAIN_CORS });
}
