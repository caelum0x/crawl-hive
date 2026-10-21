"use client";
// Баннер тарифов и watchlist на главной: три тарифа с живыми суммами токенов из /api/tier и кнопки на /pricing
// и /watchlist. Числа те же, что на странице тарифов (tiers.ts).
import Link from "next/link";
import { ArrowRight, Eye } from "lucide-react";
import { useApi } from "@/lib/client/use-api";
import { fmt, cn } from "@/lib/utils";
import { TOKEN } from "@/lib/token";
import type { TierApi } from "./pricing-client";

export function PricingBanner({ className }: { className?: string }) {
  const { data } = useApi<TierApi>("/api/tier", 300_000);
  const need = data?.need;
  const tok = (n: number | null | undefined, d: string) => (n ? `${fmt(n)} $${TOKEN.symbol}` : d);
  const tiers = [
    { name: "Holder", icon: "🟢", how: `Hold ${tok(need?.holder, "$10 of $" + TOKEN.symbol)}`, perks: "Live radar · 60 bot scans a day · 3 watched wallets", ring: "border-lime/50", text: "text-lime" },
    { name: "Pro", icon: "🔥", how: `Burn ${tok(need?.pro, "about $10")} a month`, perks: "Unlimited bot · 50 watched wallets · personal Brain key", ring: "border-pink/60", text: "text-pink" },
    { name: "Whale", icon: "🐋", how: `Hold ${tok(need?.whale, "$100 of $" + TOKEN.symbol)}`, perks: "Everything · 500 watched wallets · watch whole operators (25) · max Brain limits", ring: "border-sky/50", text: "text-sky" },
  ];
  return (
    <div className={cn("relative overflow-hidden rounded-2xl border-2 border-honey/40 bg-[#07080b] p-5 shadow-[0_0_50px_rgba(255,176,32,0.14)] lg:p-7", className)}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_10%_15%,rgba(255,159,28,0.25),transparent_45%),radial-gradient(circle_at_92%_90%,rgba(163,230,53,0.16),transparent_45%)]" />
      <div className="relative">
        <span className="rounded-full border border-honey/50 bg-honey/10 px-3 py-1 text-xs font-bold tracking-wider text-honey uppercase">New · Pricing &amp; watchlist</span>
        <div className="mt-4 grid items-center gap-6 lg:grid-cols-[1fr_1.25fr]">
          <div>
            <h2 className="text-3xl leading-tight font-black tracking-tight lg:text-5xl">
              Scanning stays free.
              <br />
              <span className="bg-gradient-to-r from-honey via-coral to-pink bg-clip-text text-transparent">Hold or burn for more.</span>
            </h2>
            <p className="mt-3 max-w-lg text-fg/80">
              Know the moment a rugger is back: watch any wallet and get a Telegram ping when it shows up in a new coin as sniper, bundler or dev, with its full history and risk score. Pro is paid by burning ${TOKEN.symbol} from your own wallet, every burn is public.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link href="/pricing" className="inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-honey via-coral to-pink px-5 text-base font-black text-black transition-transform hover:scale-[1.03]">
                See tiers <ArrowRight className="size-4" />
              </Link>
              <Link href="/watchlist" className="inline-flex h-11 items-center gap-2 rounded-xl border border-lime/50 bg-lime/10 px-4 text-sm font-bold text-lime transition-colors hover:bg-lime/20">
                <Eye className="size-4" /> Open watchlist
              </Link>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {tiers.map((t) => (
              <Link key={t.name} href="/pricing" className={cn("rounded-2xl border-2 bg-panel/80 p-4 transition-transform hover:-translate-y-0.5", t.ring)}>
                <div className="text-2xl">{t.icon}</div>
                <div className={cn("mt-1 text-xl font-black", t.text)}>{t.name}</div>
                <div className="mt-1 text-sm font-bold text-fg">{t.how}</div>
                <div className="mt-2 text-xs leading-relaxed text-muted">{t.perks}</div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
