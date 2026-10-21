"use client";
import { TOKEN } from "@/lib/token";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Bug, LayoutGrid, Store, Trophy, Landmark, Wallet, LogOut, Plus, Radio, ShieldCheck, Radar, Target, Bot, Rocket, Sparkles, History, Puzzle, Brain } from "lucide-react";
import { cn, fmt, short } from "@/lib/utils";
import { Logo } from "./logo";
import { APP_URL, COMMUNITY_URL, TelegramIcon } from "./telegram-cta";
import { useWallet } from "./wallet-provider";
import { useApi } from "@/lib/client/use-api";
import { Button } from "./ui/button";

const LINKS = [
  { href: "/", label: "Swarm", icon: LayoutGrid, color: "text-honey" },
  { href: "/spawn", label: "Spawn", icon: Plus, color: "text-coral" },
  { href: "/my", label: "My Crawlers", icon: Bug, color: "text-lime" },
  { href: "/signals", label: "My Signals", icon: Radio, color: "text-teal" },
  { href: "/launch", label: "Clean Launch", icon: Rocket, color: "text-coral" },
  { href: "/radar", label: "Launch Radar", icon: Radar, color: "text-lime" },
  { href: "/narratives", label: "Narrative Radar", icon: Sparkles, color: "text-violet" },
  { href: "/track", label: "Track Record", icon: Target, color: "text-honey" },
  { href: "/replay", label: "Gem & Rug Replay", icon: History, color: "text-pink" },
  { href: "/extension", label: "Extension", icon: Puzzle, color: "text-lime" },
  { href: "/brain", label: "Brain API", icon: Brain, color: "text-pink" },
  { href: "/agents", label: "For Agents", icon: Bot, color: "text-teal" },
  { href: "/market", label: "Marketplace", icon: Store, color: "text-pink" },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy, color: "text-sky" },
  { href: "/governance", label: "Governance", icon: Landmark, color: "text-violet" },
];

// Бейдж держателя $CRAWLHIVE: видно, что бонусы (live-радар, лимиты бота) включены.
function HolderBadge() {
  const { data } = useApi<{ holder: boolean }>("/api/holder", 300_000);
  if (!data?.holder) return null;
  return (
    <span className="rounded bg-lime px-1 py-px text-[9px] font-black tracking-wide text-black" title={`You hold ${TOKEN.symbol}: holder perks are on`}>
      HOLDER
    </span>
  );
}

function WalletButton({ compact = false }: { compact?: boolean }) {
  const { address, info, mode, signedIn, connect, signIn, disconnect } = useWallet();
  if (!address)
    return (
      <div className="flex w-full flex-col gap-1.5">
        <Button onClick={() => connect()} size="sm" className="w-full">
          <Wallet className="size-4" /> Connect
        </Button>
        {/* Подсказка у кнопки: что на самом деле происходит при подключении. */}
        {!compact && (
          <Link href="/#wallet-safety" className="flex items-center justify-center gap-1 text-[11px] text-muted hover:text-lime">
            <ShieldCheck className="size-3" /> Is it safe? Read-only until you pay
          </Link>
        )}
      </div>
    );
  return (
    <div className={cn("flex items-center gap-2", !compact && "rounded-lg border border-line bg-panel-2 p-2.5")}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="num truncate text-xs">{short(address)}</span>
          {signedIn && <HolderBadge />}
        </div>
        {signedIn ? (
          <div className="num text-xs text-honey">{info ? fmt(info.balance) : "…"} credits</div>
        ) : (
          <button onClick={() => signIn().catch(() => {})} className="text-xs font-medium text-honey hover:underline">
            Sign in to continue
          </button>
        )}
        {!compact && <div className="text-[10px] text-muted">{mode === "phantom" ? "Phantom · Solana" : mode === "evm" ? "EVM wallet · Robinhood Chain" : "Demo wallet"}</div>}
      </div>
      <button onClick={disconnect} className="text-muted hover:text-fg" title="Disconnect">
        <LogOut className="size-4" />
      </button>
    </div>
  );
}

// Путь — данные запроса: с cacheComponents его можно читать только внутри Suspense.
// Поэтому сама навигация рендерится один раз и без него, а активный пункт подсвечивает
// невидимый PathSync, который сообщает путь через эффект. Так HTML с сервера и первый
// клиентский рендер совпадают, и нет второй копии навигации в fallback.
function PathSync({ onPath }: { onPath: (p: string) => void }) {
  const path = usePathname();
  useEffect(() => onPath(path), [path, onPath]);
  return null;
}

export function Nav() {
  const [path, setPath] = useState("");
  return (
    <>
      <Suspense fallback={null}>
        <PathSync onPath={setPath} />
      </Suspense>
      <NavShell path={path} />
    </>
  );
}

export function NavShell({ path }: { path: string }) {
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <>
      {/* десктоп: боковая панель */}
      <aside data-chrome className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-panel/60 p-3 lg:flex">
        <Link href="/" className="mb-6 flex items-center gap-2 px-2 pt-1">
          <Logo size={34} />
          <span className="text-lg font-bold tracking-tight">
            Crawl<span className="text-honey">Hive</span>
          </span>
        </Link>
        <nav className="flex flex-col gap-0.5">
          {LINKS.map(({ href, label, icon: Icon, color }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                active(href) ? "bg-gradient-to-r from-honey/15 to-transparent text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
              )}
            >
              {active(href) && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-gradient-to-b from-honey to-pink" />}
              <Icon className={cn("size-4", color)} />
              {label}
            </Link>
          ))}
        </nav>
        <a
          href={APP_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-4 flex items-center gap-2.5 rounded-lg border border-[#229ED9]/50 bg-[#229ED9]/15 px-2.5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#229ED9]/25"
        >
          <TelegramIcon className="size-4 text-[#5bc4f5]" />
          Telegram app
        </a>
        <a
          href={COMMUNITY_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-2 flex items-center gap-2.5 rounded-lg border border-[#229ED9]/50 bg-[#229ED9]/15 px-2.5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#229ED9]/25"
        >
          <TelegramIcon className="size-4 text-[#5bc4f5]" />
          Community
        </a>
        <a
          href="https://x.com/crawlhivebot"
          target="_blank"
          rel="noreferrer"
          className="mt-2 flex items-center gap-2.5 rounded-lg border border-white/25 bg-white/[0.06] px-2.5 py-2 text-sm font-medium text-white transition-colors hover:bg-white/[0.12]"
        >
          <span className="grid size-4 place-items-center text-[13px] leading-none font-black">𝕏</span>
          X bot
          <span className="ml-auto rounded bg-white px-1.5 py-px text-[9px] font-bold tracking-wide text-black">NEW</span>
        </a>
        <Link
          href="/#treasury"
          className="mt-2 flex items-center gap-2.5 rounded-lg border border-honey/50 bg-honey/10 px-2.5 py-2 text-sm font-medium text-honey transition-colors hover:bg-honey/20"
        >
          <span className="text-base leading-none">🔥</span>${TOKEN.symbol}
          <span className="ml-auto rounded bg-honey px-1.5 py-px text-[9px] font-bold tracking-wide text-black">LIVE</span>
        </Link>
        <div className="mt-auto">
          <WalletButton />
        </div>
      </aside>

      {/* мобильный: верхняя полоса + горизонтальные вкладки */}
      <header data-chrome className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur lg:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <Link href="/" className="flex items-center gap-2">
            <Logo size={30} />
            <span className="font-bold">
              Crawl<span className="text-honey">Hive</span>
            </span>
          </Link>
          <Link href="/#treasury" className="ml-auto rounded-md border border-honey/50 bg-honey/10 px-2 py-1 text-[11px] font-bold text-honey">
            ${TOKEN.symbol}
          </Link>
          <div className="w-40">
            <WalletButton compact />
          </div>
        </div>
        <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 pb-2">
          {LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "shrink-0 rounded-lg px-3 py-1.5 text-xs",
                active(href) ? "bg-honey/10 text-honey" : "text-muted",
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>
    </>
  );
}
