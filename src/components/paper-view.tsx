"use client";
// Paper Trading: бумажные $100 на каждый вердикт Launch Radar, выход через сутки. Показываем стратегии
// по вердиктам рядом с базовой линией «покупать всё», чтобы было видно, помогает ли фильтр вообще.
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card, CardHeader, Stat } from "@/components/ui/card";
import { VerdictPill, pct } from "@/components/verdict";
import { useApi } from "@/lib/client/use-api";
import { cn, fmt, short, timeAgo } from "@/lib/utils";

type Sid = "clean" | "cleanOk" | "all";
interface Strategy {
  id: Sid;
  label: string;
  note: string;
  trades: number;
  wins: number;
  winRate: number | null;
  pnl: number;
  invested: number;
  avgRet: number | null;
  medianRet: number | null;
  best: { symbol: string; id: string; retPct: number } | null;
  worst: { symbol: string; id: string; retPct: number } | null;
  rugs: number;
  open: number;
  openPnl: number;
  curve: { day: string; pnl: number }[];
}
interface Trade {
  id: string;
  chain: string;
  symbol: string;
  verdict: string;
  score: number | null;
  at: number;
  exitAt: number;
  status: "closed" | "open" | "rugged";
  retPct: number;
  pnl: number;
  markedAt: number | null;
  in: Sid[];
}
interface Data {
  since: number | null;
  stake: number;
  windowHours: number;
  strategies: Strategy[];
  trades: Trade[];
  skipped: number;
  updatedAt: number;
}

// Цвета стратегий: одни и те же на карточках, в легенде и на кривой.
const TONE: Record<Sid, { tone: "lime" | "teal" | "sky"; stroke: string; text: string }> = {
  clean: { tone: "lime", stroke: "stroke-lime", text: "text-lime" },
  cleanOk: { tone: "teal", stroke: "stroke-teal", text: "text-teal" },
  all: { tone: "sky", stroke: "stroke-sky", text: "text-sky" },
};

const usd = (n: number) => `${n < 0 ? "-" : n > 0 ? "+" : ""}$${fmt(Math.abs(n), Math.abs(n) < 100 ? 2 : 0)}`;
const tone = (n: number | null) => (n == null || n === 0 ? "text-muted" : n > 0 ? "text-lime" : "text-danger");
const date = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function StrategyCard({ s }: { s: Strategy }) {
  const t = TONE[s.id];
  const ret = s.invested ? (s.pnl / s.invested) * 100 : null;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className={cn("text-sm font-semibold", t.text)}>{s.label}</h3>
          <p className="mt-0.5 text-xs text-muted">{s.note}</p>
        </div>
        <span className={cn("num text-xl font-semibold", tone(s.pnl))}>{s.trades ? usd(s.pnl) : "-"}</span>
      </div>
      <dl className="num mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <dt className="text-muted">Closed trades</dt>
        <dd className="text-right">{s.trades}</dd>
        <dt className="text-muted">Win rate</dt>
        <dd className="text-right">{s.winRate == null ? "-" : `${s.winRate}% (${s.wins}/${s.trades})`}</dd>
        <dt className="text-muted">Return on ${fmt(s.invested)} staked</dt>
        <dd className={cn("text-right", tone(ret))}>{pct(ret)}</dd>
        <dt className="text-muted">Avg / median trade</dt>
        <dd className="text-right">
          <span className={tone(s.avgRet)}>{pct(s.avgRet)}</span> / <span className={tone(s.medianRet)}>{pct(s.medianRet)}</span>
        </dd>
        <dt className="text-muted">Best</dt>
        <dd className="truncate text-right">
          {s.best ? (
            <Link href={`/scan/${s.best.id}`} className="hover:text-honey">
              ${s.best.symbol} <span className={tone(s.best.retPct)}>{pct(s.best.retPct)}</span>
            </Link>
          ) : "-"}
        </dd>
        <dt className="text-muted">Worst</dt>
        <dd className="truncate text-right">
          {s.worst ? (
            <Link href={`/scan/${s.worst.id}`} className="hover:text-honey">
              ${s.worst.symbol} <span className={tone(s.worst.retPct)}>{pct(s.worst.retPct)}</span>
            </Link>
          ) : "-"}
        </dd>
        <dt className="text-muted">Rugs eaten</dt>
        <dd className="text-right">{s.rugs}</dd>
        <dt className="text-muted">Open now</dt>
        <dd className="text-right">
          {s.open} {s.open > 0 && <span className={tone(s.openPnl)}>({usd(s.openPnl)} unrealized)</span>}
        </dd>
      </dl>
    </Card>
  );
}

// Кривая доходности: простой SVG без библиотек, ось нуля пунктиром.
function EquityCurve({ strategies }: { strategies: Strategy[] }) {
  const days = strategies[0]?.curve.map((c) => c.day) ?? [];
  if (days.length < 2) return <p className="px-4 py-10 text-center text-sm text-muted">The curve needs at least two days of closed trades. Check back tomorrow.</p>;
  const W = 720;
  const H = 220;
  const P = { l: 56, r: 12, t: 12, b: 24 };
  const vals = strategies.flatMap((s) => s.curve.map((c) => c.pnl));
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const x = (i: number) => P.l + (i / (days.length - 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + ((hi - v) / span) * (H - P.t - P.b);
  const ticks = [hi, (hi + lo) / 2, lo];
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));
  return (
    <div className="p-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Cumulative realized paper P&L by day">
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} className="stroke-line" strokeWidth={1} />
            <text x={P.l - 6} y={y(v) + 4} textAnchor="end" className="fill-muted text-[10px]">
              {usd(Math.round(v))}
            </text>
          </g>
        ))}
        <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} className="stroke-muted" strokeWidth={1} strokeDasharray="4 4" />
        {days.map((d, i) =>
          i % labelEvery === 0 || i === days.length - 1 ? (
            <text key={d} x={x(i)} y={H - 6} textAnchor="middle" className="fill-muted text-[10px]">
              {d.slice(5)}
            </text>
          ) : null,
        )}
        {strategies.map((s) => (
          <polyline
            key={s.id}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            className={TONE[s.id].stroke}
            points={s.curve.map((c, i) => `${x(i)},${y(c.pnl)}`).join(" ")}
          />
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 text-xs">
        {strategies.map((s) => (
          <span key={s.id} className="flex items-center gap-1.5">
            <span className={cn("h-0.5 w-4 rounded", TONE[s.id].tone === "lime" ? "bg-lime" : TONE[s.id].tone === "teal" ? "bg-teal" : "bg-sky")} />
            <span className={TONE[s.id].text}>{s.label}</span>
            <span className="num text-muted">{usd(s.curve[s.curve.length - 1]?.pnl ?? 0)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Status({ t }: { t: Trade }) {
  if (t.status === "rugged") return <span className="font-semibold text-danger">rugged</span>;
  if (t.status === "open") return <span className="text-muted">open · closes in {Math.max(0, Math.ceil((t.exitAt - Date.now()) / 3600_000))}h</span>;
  return <span className="text-muted">closed {date(t.exitAt)}</span>;
}

export function PaperView() {
  const { data } = useApi<Data>("/api/paper", 300_000);
  const by = new Map((data?.strategies ?? []).map((s) => [s.id, s]));
  const clean = by.get("clean");
  const base = by.get("all");
  // Главный вопрос страницы: обгоняет ли фильтр CLEAN покупку всего подряд в расчёте на сделку.
  const edge = clean?.avgRet != null && base?.avgRet != null ? clean.avgRet - base.avgRet : null;

  return (
    <>
      <PageHeader
        title="Paper Trading"
        sub={`The swarm trades its own signals with fake money. Every token Launch Radar scans gets a virtual $${data?.stake ?? 100} buy at the scan price and gets sold ${data?.windowHours ?? 24} hours later. A rug counts as -100%. No cherry picking, losers stay on the board.`}
      />
      <p className="-mt-3 mb-5 text-xs text-coral">Paper money only. Not financial advice. Past results mean nothing for the next coin.</p>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="CLEAN only P&L" value={clean?.trades ? usd(clean.pnl) : "-"} hint={clean ? `${clean.trades} closed trades` : undefined} tone="lime" />
        <Stat label="CLEAN win rate" value={clean?.winRate == null ? "-" : `${clean.winRate}%`} hint={base?.winRate != null ? `buy-everything: ${base.winRate}%` : undefined} tone="teal" />
        <Stat label="Filter edge per trade" value={edge == null ? "-" : pct(edge)} hint="CLEAN avg return minus buy-everything avg" tone="honey" />
        <Stat label="Data since" value={data?.since ? date(data.since) : "-"} hint={data ? `updated ${timeAgo(data.updatedAt)}` : "loading"} tone="sky" />
      </div>

      <div className="mb-5 grid gap-3 lg:grid-cols-3">
        {(data?.strategies ?? []).map((s) => (
          <StrategyCard key={s.id} s={s} />
        ))}
      </div>

      <Card className="mb-5">
        <CardHeader title="Equity curve" sub="Cumulative realized P&L by the day each trade closed, UTC. Open trades are not in here." />
        {data ? <EquityCurve strategies={data.strategies} /> : <p className="px-4 py-10 text-center text-sm text-muted">Loading…</p>}
      </Card>

      <Card className="mb-5">
        <CardHeader title="Last 50 trades" sub="Every radar coin, whatever the verdict. Open trades show the latest 10-minute price check." />
        {!data?.trades.length ? (
          <p className="px-4 py-6 text-center text-sm text-muted">No trades yet. They show up as soon as Launch Radar scans fresh launches.</p>
        ) : (
          <ul className="divide-y divide-line/60">
            {data.trades.map((t) => (
              <li key={t.id + t.at} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 text-sm">
                <span className="min-w-0">
                  <Link href={`/scan/${t.id}`} className="font-semibold hover:text-honey">${t.symbol}</Link>
                  <span className="num ml-2 text-[11px] text-muted">{short(t.id)} · {t.chain} · bought {timeAgo(t.at)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs">
                  <VerdictPill verdict={t.verdict} score={t.score} />
                  <Status t={t} />
                  <span className={cn("num w-20 text-right font-semibold", tone(t.retPct))}>{pct(t.retPct)}</span>
                  <span className={cn("num w-16 text-right", tone(t.pnl))}>{usd(t.pnl)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-muted">
        How it works: the buy price is the price Track Record stored at scan time, the exit is the first price check after {data?.windowHours ?? 24} hours. No fees, no slippage, no position limits, so real trading would do worse.
        {data?.since ? ` Radar trades are recorded since ${date(data.since)}, older ones roll off the log.` : ""}
        {data?.skipped ? ` ${data.skipped} radar scans are left out: no price check yet or a broken scan price.` : ""} Full verdict outcomes live on <Link href="/track" className="text-honey hover:underline">Track Record</Link>.
      </p>
    </>
  );
}
