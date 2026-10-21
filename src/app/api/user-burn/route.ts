// Оплата сжиганием: GET — публичный журнал; POST {action:"build", purpose:"pro"|"brain", calls?} — неподписанная
// транзакция сжигания из кошелька пользователя; POST {action:"confirm", quoteId, signature} — проверка в сети и зачёт.
import type { NextRequest } from "next/server";
import { body, handle, walletFrom } from "@/lib/server/http";
import { allowHit } from "@/lib/server/scan";
import { ApiError } from "@/lib/server/store";
import { buildUserBurn, confirmUserBurn, userBurnStats } from "@/lib/server/user-burns";

export async function GET() {
  return handle(() => userBurnStats());
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const w = walletFrom(req);
    const b = await body<{ action?: string; purpose?: string; calls?: number; quoteId?: string; signature?: string }>(req);
    if (!allowHit(`userburn:${b.action}:${w}`, 20, 10 * 60_000)) throw new ApiError("Too many requests, wait a moment", 429);
    if (b.action === "build") return buildUserBurn(w, b.purpose, b.calls);
    if (b.action === "confirm") return confirmUserBurn(w, b.quoteId, b.signature);
    throw new ApiError("Unknown action");
  });
}
