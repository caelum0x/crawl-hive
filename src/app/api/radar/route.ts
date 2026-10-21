// Launch Radar: свежие запуски, которые платформа просканировала сама. Free видит с задержкой
// (TIER_LIMITS.free.radarDelayMin), Holder и выше сразу.
import type { NextRequest } from "next/server";
import { sessionWallet } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";
import { radarFeed } from "@/lib/server/radar";
import { TIER_LIMITS, tierAtLeast, tierOf, tierTokens } from "@/lib/server/tiers";
import "@/lib/server/store";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const [t, need] = await Promise.all([tierOf(sessionWallet(req)), tierTokens()]);
    return { ...radarFeed({ live: tierAtLeast(t.tier, "holder"), delayMin: TIER_LIMITS.free.radarDelayMin }), holderMin: need.holder, tier: t.tier };
  });
}
