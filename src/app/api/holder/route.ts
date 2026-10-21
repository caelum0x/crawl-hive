// Тариф вошедшего кошелька (раньше: только статус держателя). Поле holder оставлено для старых клиентов.
import type { NextRequest } from "next/server";
import { sessionWallet } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";
import { tierAtLeast, tierOf } from "@/lib/server/tiers";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const w = sessionWallet(req);
    const t = await tierOf(w);
    return { wallet: w, balance: t.balance, min: t.need.holder, holder: tierAtLeast(t.tier, "holder"), tier: t.tier, proUntil: t.proUntil };
  });
}
