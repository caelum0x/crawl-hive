// Страница одного скана: /scan/<адрес>. Её ссылку кидают в X — превью строится из opengraph-image рядом.
// Показывает сохранённый результат и ведёт на свежий скан. Если токен ещё не сканировали — сразу запускает скан.
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ArrowRight, ExternalLink, Radar } from "lucide-react";
import { savedScan, type ScanResult } from "@/lib/server/scan";
import { launchOf, memDb } from "@/lib/server/memory-db";
import { CHAIN_LABEL, VERDICT_COLOR, VERDICT_LABEL, explorerToken, shareText } from "@/lib/scan-share";
import { ShareScan } from "@/components/share-scan";
import { XVoices } from "@/components/x-voices";
import { XRayPanel } from "@/components/xray-panel";
import { BubbleMap } from "@/components/bubble-map";
import { LaunchEvidence } from "@/components/launch-evidence";
import { LarpLine } from "@/components/larp-line";
import { TrustScore } from "@/components/trust-score";
import { SinceLastScan } from "@/components/since-last-scan";
import { cn, timeAgo } from "@/lib/utils";

export async function generateMetadata({ params }: PageProps<"/scan/[id]">): Promise<Metadata> {
  await connection();
  const { id } = await params;
  const r = savedScan(id);
  if (!r) return { title: "Instant Crawl · CrawlHive" };
  const title = r.score === null ? `$${r.symbol}: too early to judge · CrawlHive` : `$${r.symbol} scored ${r.score}/100 ${VERDICT_LABEL[r.verdict]} · CrawlHive`;
  return {
    title,
    description: r.reason,
    openGraph: { title, description: r.reason, type: "website" },
    twitter: { card: "summary_large_image", title, description: r.reason },
  };
}

export default function ScanPage({ params }: PageProps<"/scan/[id]">) {
  return (
    <Suspense fallback={<div className="py-20 text-center text-muted">Loading scan…</div>}>
      <ScanView params={params} />
    </Suspense>
  );
}

const usd = (n?: number) =>
  n === undefined ? "-" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(n < 1 ? 6 : 0)}`;

async function ScanView({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const r = savedScan(id);
  if (!r) redirect(`/?scan=${encodeURIComponent(id)}`);
  // Доказательства запуска свежими из базы: настоящего создателя фоновый поиск может найти уже после скана.
  const db = memDb();
  const fresh = db ? launchOf(db, r.chain === "solana" ? r.id : r.id.toLowerCase()) : null;
  const launch = fresh
    ? { ...r.launch, deployer: fresh.deployer ?? r.launch?.deployer, factory: r.launch?.factory ?? fresh.factory ?? undefined, poolCreator: fresh.poolCreator ?? r.launch?.poolCreator, tx: fresh.tx ?? r.launch?.tx, launchedAt: fresh.launchedAt ?? r.launch?.launchedAt, seenAt: fresh.seenAt }
    : r.launch;
  const color = VERDICT_COLOR[r.verdict];
  const m = r.market;
  const age = m?.ageHours === undefined ? "-" : m.ageHours < 48 ? `${m.ageHours.toFixed(1)}h` : `${Math.round(m.ageHours / 24)}d`;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-3 flex items-center justify-between text-xs text-muted">
        <span>Instant Crawl result · scanned {timeAgo(r.scannedAt)}</span>
        <Link href="/" className="hover:text-fg">
          scan another token →
        </Link>
      </div>
      <div className="ring-gradient overflow-hidden rounded-2xl bg-panel/70 p-5 lg:p-7">
        <div className="flex flex-wrap items-center gap-5">
          <div
            className="grid size-28 shrink-0 place-items-center rounded-full"
            style={{ background: `conic-gradient(${color} ${(r.score ?? 0) * 3.6}deg, rgba(255,255,255,0.06) 0)` }}
          >
            <div className="grid size-22 place-items-center rounded-full bg-panel">
              <span className="num text-4xl font-bold" style={{ color }}>
                {r.score ?? "-"}
              </span>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-bold">${r.symbol}</h1>
              <span className="rounded-md border px-2 py-0.5 text-xs font-semibold" style={{ color, borderColor: `${color}66` }}>
                {VERDICT_LABEL[r.verdict]}
              </span>
              <span className="rounded-md border border-violet/40 px-1.5 py-0.5 text-[10px] text-violet">{CHAIN_LABEL[r.chain] ?? r.chain}</span>
            </div>
            {r.name && <div className="truncate text-sm text-muted">{r.name}</div>}
            <p className="mt-1">{r.reason}</p>
          </div>
        </div>

        {r.larp && <LarpLine l={r.larp} ours={{ verdict: r.verdict, factors: r.factors }} className="mt-5" />}
        {r.trust && <TrustScore t={r.trust} className="mt-3" />}
        <SinceLastScan s={r.since} className="mt-3" />

        <div className="mt-5 grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-6">
          {[
            ["Liquidity", usd(m?.liquidityUsd)],
            ["FDV", usd(m?.fdv)],
            ["Age", age],
            ["Vol 24h", usd(m?.volume24h)],
            ["Top 10", r.holders ? `${r.holders.top10.toFixed(0)}%` : "-"],
            ["Copycats", String(r.clones)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-panel-2 px-2 py-1.5">
              <div className="text-[10px] text-muted uppercase">{k}</div>
              <div className="num font-semibold">{v}</div>
            </div>
          ))}
        </div>

        <Factors r={r} />

        {launch && (
          <div className="mt-4">
            <LaunchEvidence l={{ ...launch, deployer: launch.deployer ?? undefined }} chain={r.chain} />
          </div>
        )}
        <ShareScan id={r.id} text={shareText(r)} className="mt-4" />

        {r.operators?.map && <BubbleMap data={r.operators.map} ops={r.operators.operators} chain={r.chain} className="mt-4" />}

        {r.xray && <XRayPanel x={r.xray} className="mt-4" />}

        {r.x && (
          <div className="mt-4 rounded-lg border border-line bg-panel-2/60 p-3 text-sm">
            <div className="mb-1 text-xs font-semibold">
              𝕏 buzz · <span className="uppercase">{r.x.sentiment}</span>
            </div>
            <p className="text-fg/90">{r.x.summary}</p>
            {!!r.x.posts.length && (
              <ul className="mt-2 space-y-1 text-xs">
                {r.x.posts.slice(0, 4).map((p) => (
                  <li key={p.url} className="truncate">
                    <a href={p.url} target="_blank" rel="noreferrer" className="hover:underline">
                      <span className="text-sky">@{p.handle}</span> <span className="text-muted">{p.text}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!!r.x?.voices?.length && <XVoices symbol={r.symbol} voices={r.x.voices} />}

        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Link
            href={`/?scan=${r.id}`}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-honey px-4 text-sm font-semibold text-black hover:bg-[#ffc24d]"
          >
            <Radar className="size-4" /> Run a fresh crawl
          </Link>
          {m?.url && (
            <a href={m.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
              DexScreener <ExternalLink className="size-3" />
            </a>
          )}
          {explorerToken(r.chain, r.id) && (
            <a href={explorerToken(r.chain, r.id)!.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
              {explorerToken(r.chain, r.id)!.label} <ExternalLink className="size-3" />
            </a>
          )}
        </div>
        <p className="num mt-3 truncate text-[11px] text-muted">{r.id}</p>
        <p className="mt-1 text-[10px] text-muted">Automated checks at the time of the scan, not financial advice. Run a fresh crawl for current data.</p>
      </div>

      <Link
        href="/market"
        className="mt-4 flex items-center justify-center gap-1 rounded-xl border border-line bg-panel/70 py-3 text-sm text-honey hover:bg-panel-2"
      >
        Get alerts on tokens like this: spawn a crawler <ArrowRight className="size-4" />
      </Link>
    </div>
  );
}

function Factors({ r }: { r: ScanResult }) {
  if (!r.factors.length) return <p className="mt-4 text-sm text-lime">No red flags found by the crawlers.</p>;
  return (
    <ul className="mt-4 divide-y divide-line rounded-lg border border-line text-sm">
      {[...r.factors]
        .sort((a, b) => a.impact - b.impact)
        .map((f) => (
          <li key={f.label} className="flex items-center gap-3 px-3 py-2">
            <span className={cn("num w-10 shrink-0 text-right font-semibold", f.impact < 0 ? "text-danger" : "text-lime")}>
              {f.impact > 0 ? `+${f.impact}` : f.impact}
            </span>
            <span className="font-medium">{f.label}</span>
            <span className="min-w-0 truncate text-muted">{f.note}</span>
          </li>
        ))}
    </ul>
  );
}
