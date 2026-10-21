// Тарифы для клиента: пороги в токенах и долларах по текущей цене, лимиты и тариф вошедшего кошелька.
import type { NextRequest } from "next/server";
import { sessionWallet } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";
import { PRO_DAYS, TIER_LIMITS, TIER_USD, tierOf } from "@/lib/server/tiers";
import { BRAIN_PACKS, brainCredits, brainUsdPer1k } from "@/lib/server/user-burns";
import { brainKeyInfo } from "@/lib/server/brain-keys";
import { holderMin } from "@/lib/server/rewards";

// Infinity в JSON становится null: отдаём явное «unlimited».
const lim = Object.fromEntries(Object.entries(TIER_LIMITS).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, Number.isFinite(b) ? b : "unlimited"]))]));

export async function GET(req: NextRequest) {
  return handle(async () => {
    const w = sessionWallet(req);
    const t = await tierOf(w);
    return {
      wallet: w,
      tier: t.tier,
      balance: t.balance,
      proUntil: t.proUntil,
      need: t.need,
      // порог в монетах; действует меньший из него и долларового (tierTokens)
      coins: { holder: holderMin(), whale: holderMin() * 10 },
      usd: TIER_USD,
      proDays: PRO_DAYS,
      limits: lim,
      brain: { packs: BRAIN_PACKS, usdPer1k: brainUsdPer1k(), credits: w ? brainCredits(w) : 0, key: w ? brainKeyInfo(w) : null },
    };
  });
}
