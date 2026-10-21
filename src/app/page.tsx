"use client";
// Главная: живая карта роя, метрики сети и поток сигналов.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Activity, ArrowRight, Bug, Flame, Plus, Radar, ScrollText, Send, Target, Users, Zap } from "lucide-react";
import { useTreasury } from "@/components/treasury-card";
import { TokenSection } from "@/components/token-panel";
import { TemplateCard } from "@/components/template-card";
import { TEMPLATES } from "@/lib/templates";
import { cn } from "@/lib/utils";
import { SwarmMap } from "@/components/swarm/swarm-map";
import { SignalFeed } from "@/components/signal-feed";
import { Card, CardHeader, Stat } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InstantCrawl } from "@/components/instant-crawl";
import { WalletSafety } from "@/components/wallet-safety";
import { Shipped } from "@/components/shipped";
import { TelegramCta } from "@/components/telegram-cta";
import { XBotBanner } from "@/components/x-bot-banner";
import { BrainBanner } from "@/components/brain-banner";
import { WhatsNew } from "@/components/whats-new";
import { useStream } from "@/lib/client/use-stream";
import { fmt, timeLeft } from "@/lib/utils";
import type { NetworkStats, Signal } from "@/lib/types";

const HOW = [
  { icon: ScrollText, tone: "bg-honey/15 text-honey", title: "Spawn & instruct", text: "Pick a source and write in plain words what your crawler should hunt for." },
  { icon: Radar, tone: "bg-teal/15 text-teal", title: "It crawls for you", text: "X via Grok search, Telegram channels, new on-chain pairs and project docs, on a schedule." },
  { icon: Send, tone: "bg-violet/15 text-violet", title: "Private signals", text: "Only you see what it finds, in My Signals or Telegram. Each call is scored against the price." },
];

const FEATURED = ["fresh-pairs", "pump-buzz", "kol-calls", "ai-agents"];

function FeaturedTemplates() {
  const treasury = useTreasury();
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {TEMPLATES.filter((t) => FEATURED.includes(t.id)).map((t) => (
        <TemplateCard key={t.id} t={t} compact running={treasury?.templates[t.id] ?? 0} />
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<NetworkStats | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [, force] = useState(0);

  // Таймер эпохи тикает каждую секунду.
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const onSignals = useCallback((s: Signal[]) => setSignals((prev) => (prev.length ? prev : s)), []);

  useStream((e) => {
    if (e.type === "signal") setSignals((prev) => [e.signal, ...prev.filter((x) => x.id !== e.signal.id)].slice(0, 60));
  });

  return (
    <>
      <InstantCrawl />

      <XBotBanner className="mb-6" />
      <BrainBanner className="mb-6" />
      <TelegramCta className="mb-6" />

      <WhatsNew />

      {/* Токен проекта, байбек и награды; сюда же ведёт бейдж фонда байбека из Instant Crawl (#treasury). */}
      <TokenSection />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat tone="honey" icon={<Bug className="size-3.5" />} label="Active crawlers" value={stats ? `${stats.activeCrawlers}` : "-"} hint={stats ? `of ${stats.totalCrawlers} spawned` : ""} />
        <Stat tone="violet" icon={<Users className="size-3.5" />} label="Wallets" value={stats ? stats.wallets : "-"} />
        <Stat tone="teal" icon={<Activity className="size-3.5" />} label="Items / min" value={stats ? fmt(stats.itemsPerMin) : "-"} />
        <Stat tone="sky" icon={<Zap className="size-3.5" />} label="Signals 24h" value={stats ? fmt(stats.signals24h) : "-"} />
        {stats && !stats.demo ? (
          <>
            <Stat tone="pink" icon={<Target className="size-3.5" />} label="Signals scored" value={fmt(stats.scored)} hint="checked against price" />
            <Stat
              tone="lime"
              icon={<Flame className="size-3.5" />}
              label="Hit rate"
              value={stats.scored ? `${Math.round((stats.hits / stats.scored) * 100)}%` : "-"}
              hint={stats.scored ? `${fmt(stats.hits)} hits` : "no scored signals yet"}
            />
          </>
        ) : (
          <>
            <Stat tone="pink" label="Credits burned" value={stats ? fmt(stats.totalBurned) : "-"} />
            <Stat tone="lime" label="Epoch reward" value={stats ? fmt(stats.epochReward) : "-"} hint={stats ? timeLeft(stats.epochEndsAt) : ""} />
          </>
        )}
      </div>

      <div className="mb-5 grid gap-3 md:grid-cols-3">
        {HOW.map(({ icon: Icon, title, text, tone }, i) => (
          <Card key={title} className="flex gap-3 p-4">
            <div className={cn("grid size-9 shrink-0 place-items-center rounded-lg", tone)}>
              <Icon className="size-4" />
            </div>
            <div>
              <div className="text-sm font-semibold">
                <span className="num text-muted">{i + 1}.</span> {title}
              </div>
              <div className="text-xs text-muted">{text}</div>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="relative min-w-0">
          <SwarmMap onStats={setStats} onSignals={onSignals} />
          {stats && stats.totalCrawlers === 0 && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center">
              <div className="pointer-events-auto rounded-xl border border-line bg-panel/90 p-6 backdrop-blur">
                <div className="mb-1 font-semibold">The swarm is waiting for its first crawler</div>
                <p className="mb-4 max-w-xs text-sm text-muted">Spawn one, write what it should look for, and it shows up here as the first dot.</p>
                <Link href="/spawn">
                  <Button>
                    <Flame className="size-4" /> Spawn the first crawler
                  </Button>
                </Link>
              </div>
            </div>
          )}
        </div>
        <Card className="flex max-h-[680px] flex-col">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <span className="size-2 animate-pulse rounded-full bg-lime" /> Live signals
              </span>
            }
            sub="Streamed from crawlers as they fire"
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SignalFeed signals={signals} />
          </div>
        </Card>
      </div>

      <div className="mt-8 mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            Ready-made <span className="text-gradient">crawlers</span>
          </h2>
          <p className="text-sm text-muted">Tested sources and specifications. Buy one and it starts crawling in seconds.</p>
        </div>
        <Link href="/market" className="inline-flex items-center gap-1 text-sm text-honey hover:underline">
          All {TEMPLATES.length} in the marketplace <ArrowRight className="size-4" />
        </Link>
      </div>
      <FeaturedTemplates />

      <Card className="mt-5 flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div>
          <div className="font-semibold">Got an edge nobody is crawling?</div>
          <div className="text-sm text-muted">Spawn a crawler on your own targets and write its rules yourself. Good signals raise its reputation.</div>
        </div>
        <Link href="/spawn">
          <Button variant="outline">
            <Plus className="size-4" /> Spawn your own
          </Button>
        </Link>
      </Card>

      <div className="mt-8 grid gap-5">
        <WalletSafety />
      </div>

      <Shipped />
    </>
  );
}
