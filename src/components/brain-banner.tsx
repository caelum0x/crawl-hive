// Баннер CrawlHive Brain на главной: память роя по API (brain.ts). Ведёт на страницу /brain с примерами
// и на репозиторий с документацией и OpenAPI.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrainNeurons } from "./brain-neurons";

const ASKS = ["🕵️ Has this wallet sniped before?", "🧑‍💻 What did this dev launch?", "📈 What changed since the last scan?"];

export function BrainBanner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border-2 border-pink/40 bg-[#05060a] p-5 shadow-[0_0_50px_rgba(244,114,182,0.15)] lg:p-7",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(244,114,182,0.22),transparent_45%),radial-gradient(circle_at_90%_90%,rgba(255,176,32,0.22),transparent_45%)]" />
      <div className="relative grid items-center gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <span className="rounded-full border border-pink/50 bg-pink/10 px-3 py-1 text-xs font-bold tracking-wider text-pink uppercase">New · API live</span>
          <h2 className="mt-4 text-3xl leading-tight font-black tracking-tight lg:text-5xl">
            <span className="text-pink">CrawlHive Brain</span>
            <br />
            The hive&apos;s memory, as an API.
          </h2>
          <p className="mt-3 max-w-lg text-fg/80">Every scan teaches the swarm which wallets snipe, bundle and rug. Now your bot, terminal or AI agent can ask that memory directly, instantly, without running a scan. Free tier, pay per call over x402 beyond it, 10x limits for $CRAWLHIVE holders.</p>
          <div className="mt-5 flex flex-wrap gap-2 text-sm font-semibold">
            {ASKS.map((s) => (
              <span key={s} className="rounded-lg border border-line bg-panel/80 px-3 py-1.5">{s}</span>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href="/brain" className="inline-flex h-11 items-center gap-2 rounded-xl bg-pink px-5 text-base font-black text-black transition-transform hover:scale-[1.03]">
              Connect the Brain <ArrowRight className="size-4" />
            </Link>
            <a href="https://github.com/h100envy/crawlhive-brain" target="_blank" rel="noreferrer" className="inline-flex h-11 items-center rounded-xl border border-line bg-panel px-4 text-sm font-semibold transition-colors hover:bg-panel-2">
              Docs on GitHub
            </a>
          </div>
        </div>
        {/* справа живой мозг роя; пример ответа API поверх, внизу */}
        <div className="relative min-h-[320px] lg:min-h-[420px]">
          <BrainNeurons className="absolute inset-0 rounded-2xl border border-cyan-400/20 bg-black/40" />
          <pre className="absolute right-3 bottom-3 left-3 overflow-hidden rounded-xl border border-white/10 bg-black/75 p-3 font-mono text-[11px] leading-relaxed text-fg/90 backdrop-blur sm:left-auto sm:w-[290px]">
            <span className="text-cyan-300">GET</span> <span className="text-muted">/wallet/7xKX…</span>
            {"\n"}
            {`{ "roles": { "sniper": 4, "bundle": 2 },
  "outcomes": { "dumped": 4 } }`}
          </pre>
        </div>
      </div>
    </div>
  );
}
