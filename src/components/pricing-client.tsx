"use client";
// Тарифы: живые пороги в токенах по текущей цене, тариф вошедшего кошелька, покупка Pro сжиганием.
import Link from "next/link";
import { useApi } from "@/lib/client/use-api";
import { fmt } from "@/lib/utils";
import { TOKEN } from "@/lib/token";
import { useBurnPay } from "./burn-pay";
import { useWallet } from "./wallet-provider";
import { Card } from "./ui/card";
import { Button } from "./ui/button";

export type TierName = "free" | "holder" | "pro" | "whale";
export type TierApi = {
  wallet: string | null;
  tier: TierName;
  balance: number | null;
  proUntil: number | null;
  need: { holder: number; whale: number; pro: number | null; priceUsd: number | null };
  coins: { holder: number; whale: number };
  usd: { holder: number; whale: number; pro: number };
  proDays: number;
  brain: { packs: number[]; usdPer1k: number; credits: number; key: { tail: string; createdAt: number } | null };
};

export const TIER_LABEL: Record<TierName, string> = { free: "Free", holder: "Holder", pro: "Pro", whale: "Whale" };
const TIER_CLS: Record<TierName, string> = { free: "border-line", holder: "border-lime/60", pro: "border-pink/70 shadow-[0_0_40px_rgba(244,114,182,0.18)]", whale: "border-sky/60" };

// Строки таблицы: что даёт каждый тариф по всем частям продукта.
const ROWS: [string, string, string, string, string][] = [
  ["Site scans", "Unlimited, full report", "+ scan history, since last scan", "+ export and compare two coins (soon)", "Everything"],
  ["Telegram bot", "20 scans a day", "60 scans a day, live alerts", "Unlimited scans", "Unlimited, priority queue"],
  ["X bot", "Answers when tagged", "Answers when tagged", "Answers when tagged", "Answers when tagged"],
  ["Extension", "Compact panel", "+ More: bubble map, seen wallets", "+ watchlist alerts in the panel (soon)", "Everything"],
  ["Launch Radar", "Live feed delayed 5 min", "Live feed", "Live feed + filters and TG alerts (soon)", "Live feed, early access (soon)"],
  ["Narrative Radar", "Top narratives", "+ new narrative alerts", "+ coins inside each narrative", "Everything"],
  ["Wallet watchlist", "None", "3 wallets", "50 wallets, alert when a known rugger enters a new coin", "500 wallets + watch whole operators (25)"],
  ["Auto-scan your positions", "None", "None", "20 positions (soon)", "100 positions (soon)"],
  ["Crawlers", "1 free crawler", "Spawn discount (soon)", "3 crawlers included (soon)", "Private crawlers (soon)"],
  ["Brain API", "30 lookups / 10 min", "10x", "20x + personal key", "50x"],
  ["Community", "Open chat", "HOLDER badge", "PRO badge, Pro chat (soon)", "Vote on next features (soon)"],
];

const usd = (n: number) => `$${n % 1 ? n.toFixed(2) : n}`;

export function PricingClient() {
  const { data, reload } = useApi<TierApi>("/api/tier", 120_000);
  const { signedIn } = useWallet();
  const { pay, busy } = useBurnPay(() => reload());
  const need = data?.need;
  const amount = (n: number | null | undefined) => (n ? `${fmt(n)} $${TOKEN.symbol}` : "…");
  // Порог показываем одним числом в токенах (столько и проверяется на кошельке), доллары только для ориентира.
  const approx = (n: number | null | undefined) => (n && need?.priceUsd ? ` (about $${(n * need.priceUsd).toFixed(n * need.priceUsd < 10 ? 2 : 0)} now)` : "");

  return (
    <div className="space-y-6">
      {/* твой тариф */}
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        <div className="flex-1">
          <div className="text-sm text-muted">Your tier</div>
          <div className="text-3xl font-black">{data ? TIER_LABEL[data.tier] : "…"}</div>
          <div className="mt-1 text-sm text-muted">
            {!signedIn
              ? "Connect and sign in with your wallet to see your tier."
              : data?.proUntil
                ? `Pro active until ${new Date(data.proUntil).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                : `You hold ${fmt(Math.round(data?.balance ?? 0))} $${TOKEN.symbol}`}
          </div>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <Button onClick={() => pay("pro")} disabled={!!busy || !need?.pro} className="bg-pink text-black hover:bg-pink/90">
            🔥 {data?.proUntil ? "Extend Pro" : "Go Pro"}: burn {amount(need?.pro)}
          </Button>
          <div className="text-xs text-muted">{busy ?? `About ${usd(data?.usd.pro ?? 10)} for ${data?.proDays ?? 30} days, signed in Phantom`}</div>
        </div>
      </Card>

      {/* карточки тарифов */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {(["free", "holder", "pro", "whale"] as TierName[]).map((t) => (
          <Card key={t} className={`border-2 p-5 ${TIER_CLS[t]} ${data?.tier === t ? "ring-2 ring-honey/60" : ""}`}>
            <div className="flex items-center justify-between">
              <div className="text-xl font-black">{TIER_LABEL[t]}</div>
              {data?.tier === t && <span className="rounded bg-honey px-1.5 text-[10px] font-black text-black">YOU</span>}
            </div>
            <div className="mt-2 text-sm text-fg/85">
              {t === "free" && "Everything you need to check a coin. No wallet."}
              {t === "holder" && (
                <>
                  Hold <b>{amount(need?.holder)}</b><span className="text-muted">{approx(need?.holder)}</span>
                </>
              )}
              {t === "pro" && (
                <>
                  Burn <b>{amount(need?.pro)}</b> <span className="text-muted">(about {usd(data?.usd.pro ?? 10)}) per {data?.proDays ?? 30} days</span>
                </>
              )}
              {t === "whale" && (
                <>
                  Hold <b>{amount(need?.whale)}</b><span className="text-muted">{approx(need?.whale)}</span>
                </>
              )}
            </div>
          </Card>
        ))}
      </div>

      {/* таблица */}
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="p-3 text-muted">Feature</th>
              {(["free", "holder", "pro", "whale"] as TierName[]).map((t) => (
                <th key={t} className={`p-3 font-black ${t === "pro" ? "text-pink" : ""}`}>
                  {TIER_LABEL[t]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([f, ...cells]) => (
              <tr key={f} className="border-b border-line/60 align-top">
                <td className="p-3 font-semibold">{f}</td>
                {cells.map((c, i) => (
                  <td key={i} className="p-3 text-fg/85">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="p-5 text-sm text-fg/85">
        <div className="text-lg font-bold text-fg">How it works</div>
        <ul className="mt-2 space-y-1.5">
          <li>• Holder and Whale: keep the tokens in the wallet you sign in with. The amount follows the price: Holder is about $10 of tokens and Whale about $100, recalculated every few minutes.</li>
          <li>• Pro: you burn the tokens yourself from your wallet, signed in Phantom. Nobody receives them, they leave the supply for good, and the burn shows publicly below.</li>
          <li>• Brain API calls can be bought the same way on the <Link href="/brain" className="text-honey hover:underline">Brain page</Link>.</li>
          <li>• Tiers give access to features. They are not an investment and we make no promises about the token price.</li>
        </ul>
      </Card>
    </div>
  );
}
