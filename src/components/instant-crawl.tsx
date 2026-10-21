"use client";
// Instant Crawl на главной: вставь адрес токена или $тикер — краулеры сканируют его за секунды, без кошелька.
// Ход работы виден в живом логе, результат — оценка 0–100 с причиной. Под ним кнопка «следить постоянно»:
// спавн краулера-наблюдателя за этим токеном. ?scan=<адрес> в URL запускает скан сразу (для ссылок).
import { TOKEN } from "@/lib/token";
import { XRayPanel, type XRayView } from "@/components/xray-panel";
import { BubbleMap, type BubbleMapData } from "@/components/bubble-map";
import { LaunchEvidence, type LaunchData } from "@/components/launch-evidence";
import { LarpLine, type LarpLineData } from "@/components/larp-line";
import { TrustScore, type TrustData } from "@/components/trust-score";
import { SinceLastScan, type SinceData } from "@/components/since-last-scan";
import { APP_URL, TelegramIcon } from "@/components/telegram-cta";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ExternalLink, Eye, Flame, Radar, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ShareScan } from "@/components/share-scan";
import { buybackFund, buybackUsd, solFmt, usdFmt, useTreasury } from "@/components/treasury-card";
import { XVoices, type XVoice } from "@/components/x-voices";
import { shareText } from "@/lib/scan-share";
import { useWallet } from "@/components/wallet-provider";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/client/use-api";
import { usePay } from "@/lib/client/use-pay";
import { CHAIN_LABEL, explorerToken } from "@/lib/scan-share";
import { useConfig } from "@/lib/client/use-config";
import { post } from "@/lib/client/api";
import { spawnWithBurn, type BurnStep } from "@/lib/client/burn";
import type { PublicCrawler } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";

type Verdict = "CLEAN" | "OK" | "RISKY" | "DANGER" | "TOO_EARLY";
interface LogLine {
  ts: number;
  crawler: string;
  text: string;
  tone?: "ok" | "warn" | "bad" | "info";
}
interface Result {
  id: string;
  chain: string;
  symbol: string;
  name: string;
  score: number | null;
  verdict: Verdict;
  reason: string;
  factors: { label: string; impact: number; note: string }[];
  market?: {
    priceUsd?: number;
    liquidityUsd?: number;
    fdv?: number;
    volume1h?: number;
    volume24h?: number;
    change1h?: number;
    ageHours?: number;
    buys1h?: number;
    sells1h?: number;
    url?: string;
  };
  holders?: { top1: number; top10: number; mintAuthority: boolean; freezeAuthority: boolean };
  bundles?: { checked: number; clusters: { wallets: number; pct: number; funder: string }[]; fresh: { wallets: number; pct: number } };
  dev?: { creator: string; launched: number; graduated: number; walletAgeHours?: number; walletTxs: number; holdsPct?: number };
  launch?: LaunchData;
  snipers?: { wallets: number; boughtPct: number; holdPct: number; sold: number; slots: number };
  insiders?: { wallets: number; pct: number };
  lp?: { status: string; lockedPct: number | null; unlockAt?: number; locker?: string };
  larp?: LarpLineData;
  trust?: TrustData;
  since?: SinceData;
  operators?: { operators: { wallets: number; pct: number; roles: string[]; devLinked: boolean; basis?: string[] }[]; devSnipers: number; history?: { wallets: number; tokens: number; dumped: number }; map?: BubbleMapData };
  evm?: { holders?: number; top10?: number; honeypot?: boolean; owner?: string | null };
  xray?: XRayView;
  core?: string;
  clones: number;
  original?: boolean;
  telegram: { channel: string; url: string }[];
}
interface XBuzz {
  sentiment: "bullish" | "mixed" | "bearish" | "quiet";
  summary: string;
  warnings: string[];
  posts: { handle: string; text: string; url: string }[];
  voices?: XVoice[];
}
interface Recent {
  id: string;
  chain: string;
  symbol: string;
  score: number | null;
  verdict: Verdict;
  at: number;
}

const SAMPLE = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
const SAMPLE_RH = "0x500CeE0c4184faF3B3d0Cf8c0380B57B2dE44607"; // ROBINHOOD на Robinhood Chain
const SAMPLE_BSC = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"; // CAKE на BNB Chain
const SAMPLE_BASE = "0x532f27101965dd16442E59d40670FaF5eBB142E4"; // BRETT на Base
// Где искать $ТИКЕР. Адреса сеть определяют сами: base58 — Solana, 0x — та EVM-сеть, где у токена есть пара.
const NETS = [
  { id: "solana", label: "Solana" },
  { id: "robinhood", label: "Robinhood Chain" },
  { id: "bsc", label: "BNB Chain" },
  { id: "base", label: "Base" },
] as const;
type Net = (typeof NETS)[number]["id"];


export const VERDICT_STYLE: Record<Verdict, { text: string; ring: string; bg: string; label: string }> = {
  CLEAN: { text: "text-lime", ring: "#b6f23a", bg: "bg-lime/10 border-lime/40", label: "CLEAN" },
  OK: { text: "text-teal", ring: "#5eead4", bg: "bg-teal/10 border-teal/40", label: "OK" },
  RISKY: { text: "text-honey", ring: "#ffb020", bg: "bg-honey/10 border-honey/40", label: "RISKY" },
  DANGER: { text: "text-danger", ring: "#f87171", bg: "bg-danger/10 border-danger/40", label: "DANGER" },
  TOO_EARLY: { text: "text-muted", ring: "#8a9099", bg: "bg-panel-2 border-line", label: "TOO EARLY" },
};
const TONE: Record<string, string> = { ok: "text-lime", warn: "text-honey", bad: "text-danger", info: "text-sky" };

const usd = (n?: number) =>
  n === undefined ? "-" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(n < 1 ? 6 : 0)}`;
const clock = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
type XState = XBuzz | null | "offer" | "loading" | undefined;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function InstantCrawl() {
  const [q, setQ] = useState("");
  const [net, setNet] = useState<Net>("solana");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // undefined — X недоступен, "offer" — можно запустить кнопкой, "loading" — Grok ищет, null — пропущено.
  const [x, setX] = useState<XState>(undefined);
  const xes = useRef<EventSource | null>(null);
  const es = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const { data: recent, reload } = useApi<Recent[]>("/api/scan/recent", 8000);
  const treasury = useTreasury();

  const scan = useCallback(
    (input: string) => {
      const v = input.trim();
      if (!v || running) return;
      es.current?.close();
      xes.current?.close();
      setQ(v);
      setLines([{ ts: Date.now(), crawler: "swarm", text: `crawl ${v.length > 20 ? short(v) : v}`, tone: "info" }]);
      setResult(null);
      setX(undefined);
      setError(null);
      setRunning(true);
      const src = new EventSource(`/api/scan?q=${encodeURIComponent(v)}&chain=${net}`);
      es.current = src;
      let gotResult = false;
      const done = () => {
        src.close();
        setRunning(false);
        setX((cur) => (cur === "loading" ? null : cur));
        reload();
      };
      src.onmessage = (m) => {
        const e = JSON.parse(m.data);
        if (e.type === "log") setLines((l) => [...l, e]);
        else if (e.type === "result") {
          // Вердикт готов; поток остаётся открытым, пока догружается X.
          gotResult = true;
          setResult(e.result);
          setRunning(false);
          try {
            window.history.replaceState(null, "", `/?scan=${e.result.id}`);
          } catch {}
          reload();
        } else if (e.type === "x") setX(e.x);
        else if (e.type === "xoffer") setX("offer");
        else if (e.type === "done") done();
        else if (e.type === "error") {
          setError(e.message);
          done();
        }
      };
      src.onerror = () => {
        if (src.readyState === EventSource.CLOSED) return;
        if (gotResult) return done();
        setError((x) => x ?? "Connection lost, try again");
        done();
      };
    },
    [running, reload, net],
  );

  // Поиск по X платный, поэтому только по кнопке: отдельный поток /api/scan/x для уже готового вердикта.
  const checkX = useCallback(() => {
    if (!result) return;
    xes.current?.close();
    setX("loading");
    const src = new EventSource(`/api/scan/x?id=${encodeURIComponent(result.id)}`);
    xes.current = src;
    const finish = () => {
      src.close();
      setX((cur) => (cur === "loading" ? null : cur));
    };
    src.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "log") setLines((l) => [...l, e]);
      else if (e.type === "x") setX(e.x);
      else if (e.type === "done") finish();
    };
    src.onerror = () => {
      if (src.readyState !== EventSource.CLOSED) finish();
    };
  }, [result]);

  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("scan");
    if (v) scan(v);
    return () => {
      es.current?.close();
      xes.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  const active = running || lines.length > 0;
  const live = running || x === "loading";

  return (
    <section className="mb-6">
      <div className="ring-gradient relative overflow-hidden rounded-2xl bg-panel/70 p-5 lg:p-7">
        <div aria-hidden className="pointer-events-none absolute -top-32 left-1/3 size-96 rounded-full bg-gradient-to-br from-honey/20 via-pink/10 to-transparent blur-3xl" />
        <div className="relative">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-line bg-bg/60 px-2.5 py-1 text-[11px] text-muted">
              <span className="size-1.5 animate-pulse rounded-full bg-lime" /> free · no wallet · ~10 seconds
            </div>
            {treasury?.address && (
              <a
                href="#treasury"
                className="inline-flex items-center gap-1.5 rounded-full border border-honey/40 bg-honey/10 px-2.5 py-1 text-[11px] text-honey hover:bg-honey/20"
              >
                <Flame className="size-3" /> <span className="num font-semibold">{treasury.ethAddress && buybackUsd(treasury) !== null ? usdFmt(buybackUsd(treasury)!) : `${solFmt(buybackFund(treasury))} SOL`}</span> in the buyback fund
              </a>
            )}
            <a
              href={TOKEN.buy}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-[#ff6b2c]/60 bg-[#ff6b2c]/15 px-2.5 py-1 text-[11px] font-semibold text-[#ff9a5c] hover:bg-[#ff6b2c]/25"
            >
              🔥 ${TOKEN.symbol} is live · buy
            </a>
          </div>
          <h1 className="max-w-3xl text-3xl leading-tight font-bold tracking-tight lg:text-5xl">
            Send the <span className="text-gradient">swarm</span> after any memecoin
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted lg:text-base">
            Paste a contract address or a $ticker, on Solana, Robinhood Chain, BNB Chain or Base. Works for pump.fun, Meteora, Raydium LaunchLab and four.meme launches. Crawlers check the market, the mint, who funded the top wallets, copycat tickers, Telegram and X, then return a verdict.
          </p>
          <form
            className="mt-5 flex max-w-3xl flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              scan(q);
            }}
          >
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-line bg-bg/80 px-3 focus-within:border-honey/60">
              <span className="num text-xs text-muted">CA</span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="token address, DexScreener link or $TICKER"
                className="num h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/70"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <Button size="lg" className="h-12 px-6" disabled={running || !q.trim()}>
              <Radar className={cn("size-4", running && "animate-spin")} /> {running ? "crawling…" : "crawl"}
            </Button>
          </form>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1">
              $ticker on
              {NETS.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setNet(n.id)}
                  className={cn("rounded-md border px-1.5 py-0.5", net === n.id ? "border-honey/60 bg-honey/10 text-honey" : "border-line hover:text-fg")}
                >
                  {n.label}
                </button>
              ))}
            </span>
            <button type="button" onClick={() => scan(net === "robinhood" ? SAMPLE_RH : net === "bsc" ? SAMPLE_BSC : net === "base" ? SAMPLE_BASE : SAMPLE)} className="text-honey hover:underline" disabled={running}>
              try a sample →
            </button>
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="size-3.5 text-lime" /> read-only, nothing to sign
            </span>
            <a
              href={APP_URL}
              target="_blank"
              rel="noreferrer"
              className="tg-shine relative inline-flex items-center gap-1.5 overflow-hidden rounded-lg px-2.5 py-1 font-semibold text-white"
              style={{ background: "linear-gradient(135deg, #2AABEE, #229ED9)" }}
            >
              <TelegramIcon className="size-3.5" /> or open the Telegram app
            </a>
          </div>

          {active && (
            <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              <div className="overflow-hidden rounded-xl border border-line bg-[#05060a]">
                <div className="flex items-center justify-between border-b border-line px-3 py-2 text-[11px]">
                  <span className="num text-lime">❯ tail -f crawler.log</span>
                  {live ? (
                    <span className="flex items-center gap-1 text-lime">
                      <span className="size-1.5 animate-pulse rounded-full bg-lime" /> live
                    </span>
                  ) : (
                    <span className="text-muted">done</span>
                  )}
                </div>
                <div ref={logRef} className="num max-h-64 min-h-40 space-y-1 overflow-y-auto p-3 text-[11.5px] leading-relaxed">
                  {lines.map((l, i) => (
                    <div key={i} className="flash-in flex gap-2">
                      <span className="hidden shrink-0 text-muted/60 sm:inline">{clock(l.ts)}</span>
                      <span className="hidden shrink-0 text-muted sm:inline">→</span>
                      <span className={cn("shrink-0", l.crawler === "verdict" ? "text-honey" : "text-violet")}>{l.crawler}</span>
                      <span className={cn("min-w-0", l.tone ? TONE[l.tone] : "text-fg")}>{l.text}</span>
                    </div>
                  ))}
                  {live && <div className="animate-pulse text-muted">▍</div>}
                  {error && <div className="text-danger">✕ {error}</div>}
                </div>
              </div>
              {result ? <ResultCard r={result} x={x} onCheckX={checkX} /> : <ResultSkeleton running={running} />}
            </div>
          )}
          {result && x !== undefined && x !== null && x !== "offer" && (
            <XVoices symbol={result.symbol} loading={x === "loading"} voices={x === "loading" ? undefined : x.voices} />
          )}
        </div>
      </div>

      {!!recent?.length && <RecentScans rows={recent} onOpen={scan} />}
    </section>
  );
}

function ScoreRing({ score, verdict }: { score: number | null; verdict: Verdict }) {
  const st = VERDICT_STYLE[verdict];
  const pctv = score ?? 0;
  return (
    <div
      className="grid size-20 shrink-0 place-items-center rounded-full"
      style={{ background: `conic-gradient(${st.ring} ${pctv * 3.6}deg, rgba(255,255,255,0.06) 0)` }}
    >
      <div className="grid size-16 place-items-center rounded-full bg-panel">
        <span className={cn("num text-2xl font-bold", st.text)}>{score ?? "-"}</span>
      </div>
    </div>
  );
}

function ResultSkeleton({ running }: { running: boolean }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">
      {running ? "Crawlers are working…" : "No result"}
    </div>
  );
}

function ResultCard({ r, x, onCheckX }: { r: Result; x: XState; onCheckX: () => void }) {
  const st = VERDICT_STYLE[r.verdict];
  const toast = useToast();
  const m = r.market;
  const age = m?.ageHours === undefined ? "-" : m.ageHours < 48 ? `${m.ageHours.toFixed(1)}h` : `${Math.round(m.ageHours / 24)}d`;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center gap-4">
        <ScoreRing score={r.score} verdict={r.verdict} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xl font-bold">${r.symbol}</span>
            <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px] font-semibold", st.bg, st.text)}>{st.label}</span>
            <span className="rounded-md border border-violet/40 px-1.5 py-0.5 text-[10px] text-violet">{CHAIN_LABEL[r.chain] ?? r.chain}</span>
          </div>
          <div className="truncate text-xs text-muted">{r.name}</div>
          <div className="mt-1 text-sm">{r.reason}</div>
        </div>
      </div>
      {r.larp && <LarpLine l={r.larp} ours={{ verdict: r.verdict, factors: r.factors }} />}
      {r.trust && <TrustScore t={r.trust} />}
      <SinceLastScan s={r.since} />
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        {[
          ["Liquidity", usd(m?.liquidityUsd)],
          ["FDV", usd(m?.fdv)],
          ["Age", age],
          ["Vol 1h", usd(m?.volume1h)],
          ["Buys / sells 1h", m ? `${m.buys1h ?? 0} / ${m.sells1h ?? 0}` : "-"],
          r.evm
            ? ["Holders", r.evm.holders !== undefined ? r.evm.holders.toLocaleString("en-US") : "-"]
            : ["Top 10 wallets", r.holders ? `${r.holders.top10.toFixed(0)}%` : "-"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-panel-2 px-2 py-1.5">
            <div className="text-[10px] text-muted uppercase">{k}</div>
            <div className="num font-semibold">{v}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {r.holders && (
          <>
            <Flag ok={!r.holders.mintAuthority} label={r.holders.mintAuthority ? "mint open" : "mint renounced"} />
            <Flag ok={!r.holders.freezeAuthority} label={r.holders.freezeAuthority ? "freeze on" : "no freeze"} />
          </>
        )}
        {r.bundles && <BundleFlag b={r.bundles} />}
        {r.dev && <DevFlag d={r.dev} />}
        {r.insiders && <Flag ok={false} label={`${r.insiders.wallets} dev-funded wallet${r.insiders.wallets > 1 ? "s" : ""} · ${r.insiders.pct.toFixed(1)}%`} />}
        {r.lp && r.lp.status !== "curve" && (
          <Flag
            ok={r.lp.status === "burned" || (r.lp.status === "locked" && (!r.lp.unlockAt || r.lp.unlockAt - Date.now() > 30 * 86_400_000))}
            label={
              r.lp.status === "burned"
                ? "LP burned"
                : r.lp.status === "unlocked"
                  ? `LP not locked (${r.lp.lockedPct ?? 0}%)`
                  : `LP ${r.lp.lockedPct}% locked${r.lp.unlockAt ? ` · unlocks ${new Date(r.lp.unlockAt).toISOString().slice(0, 10)}` : ""}`
            }
          />
        )}
        {r.operators?.operators[0] && (
          <Flag
            ok={r.operators.operators[0].roles.length < 2 && r.operators.operators[0].pct < 20}
            label={`${r.operators.operators[0].basis?.length === 1 && r.operators.operators[0].basis[0] === "funder" ? "connection (shared funder)" : "operator"}: ${r.operators.operators[0].wallets} wallets · ${r.operators.operators[0].pct.toFixed(1)}% · ${r.operators.operators[0].roles.join("+")}`}
          />
        )}
        {!!r.operators?.devSnipers && <Flag ok={false} label={`${r.operators.devSnipers} dev-funded sniper${r.operators.devSnipers > 1 ? "s" : ""}`} />}
        {r.operators?.history && <Flag ok={r.operators.history.dumped < 3} label={`wallets seen on ${r.operators.history.tokens} other tokens · ${r.operators.history.dumped} dumped`} />}
        {r.snipers && (r.snipers.wallets ? <Flag ok={r.snipers.holdPct < 5} label={`${r.snipers.wallets} sniper${r.snipers.wallets > 1 ? "s" : ""} · hold ${r.snipers.holdPct.toFixed(1)}%${r.snipers.sold ? ` · ${r.snipers.sold} sold` : ""}`} /> : <Flag ok label="no snipers" />)}
        {r.evm && (
          <>
            {r.evm.honeypot !== undefined && <Flag ok={!r.evm.honeypot} label={r.evm.honeypot ? "honeypot: can't sell" : "sellable"} />}
            <Flag ok={!r.evm.owner} label={r.evm.owner ? "owner active" : "ownership renounced"} />
            {r.evm.top10 !== undefined && <Flag ok={r.evm.top10 <= 90} label={`top 10 hold ${r.evm.top10.toFixed(0)}%`} />}
          </>
        )}
        {r.core && <Flag ok label={`core asset · ${r.core}`} />}
        {!r.core && <Flag ok={r.clones <= 2 || !!r.original} label={r.original ? `original · ${r.clones} copycats` : r.clones ? `${r.clones} copycat tickers` : "unique ticker"} />}
        {r.telegram.map((t) => (
          <a key={t.channel} href={t.url} target="_blank" rel="noreferrer" className="rounded-md border border-sky/40 px-1.5 py-0.5 text-sky hover:bg-sky/10">
            seen in {t.channel}
          </a>
        ))}
      </div>
      {r.launch && <LaunchEvidence l={r.launch} chain={r.chain} />}
      <ShareScan id={r.id} text={shareText(r)} />
      {r.operators?.map && <BubbleMap data={r.operators.map} ops={r.operators.operators} chain={r.chain} />}
      {r.xray && <XRayPanel x={r.xray} />}
      {x !== undefined && <XPanel x={x} onCheck={onCheckX} />}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <WatchButton r={r} />
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
        <button className="ml-auto text-[11px] text-muted hover:text-fg" onClick={() => navigator.clipboard?.writeText(r.id).then(() => toast("Address copied"))}>
          {short(r.id)}
        </button>
      </div>
      <p className="text-[10px] text-muted">Automated checks, not financial advice. A high score is not a guarantee.</p>
    </div>
  );
}

function BundleFlag({ b }: { b: NonNullable<Result["bundles"]> }) {
  const c = b.clusters[0];
  if (c) return <Flag ok={c.pct < 4 && c.wallets < 3} label={`${c.wallets} linked wallets · ${c.pct.toFixed(1)}%`} />;
  if (b.fresh.pct >= 15) return <Flag ok={false} label={`fresh wallets hold ${b.fresh.pct.toFixed(0)}%`} />;
  return b.checked ? <Flag ok label="no linked wallets" /> : null;
}

// Создатель токена: прошлые запуски на pump.fun и сколько из них дошли до пула; ссылка на страницу репутации дева.
function DevFlag({ d }: { d: NonNullable<Result["dev"]> }) {
  const prior = d.launched - 1;
  const bad = (prior >= 10 && d.graduated === 0) || (prior >= 3 && d.graduated / prior < 0.1) || (d.holdsPct ?? 0) > 10;
  const label = prior ? `dev: ${prior} earlier launch${prior > 1 ? "es" : ""} · ${d.graduated} graduated` : "dev: first launch";
  return (
    <a
      href={`/dev/${d.creator}`}
      title="Every coin this creator launched and how it ended"
      className={cn("rounded-md border px-1.5 py-0.5 hover:bg-panel-2", bad ? "border-danger/40 text-danger" : "border-lime/40 text-lime")}
    >
      {label}
      {d.holdsPct !== undefined ? ` · holds ${d.holdsPct.toFixed(1)}%` : ""}
    </a>
  );
}

const MOOD: Record<XBuzz["sentiment"], string> = { bullish: "text-lime", mixed: "text-honey", bearish: "text-danger", quiet: "text-muted" };
function XPanel({ x, onCheck }: { x: Exclude<XState, undefined>; onCheck: () => void }) {
  if (x === null) return null;
  if (x === "offer")
    return (
      <button
        onClick={onCheck}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-sky/40 bg-panel-2/60 p-3 text-left text-xs hover:bg-sky/10"
      >
        <span>
          <span className="font-semibold">𝕏 Check X</span> <span className="text-muted">· Grok reads who is talking about it, about half a minute</span>
        </span>
        <span className="text-sky">Run →</span>
      </button>
    );
  return (
    <div className="rounded-lg border border-line bg-panel-2/60 p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-semibold">𝕏 buzz</span>
        {x === "loading" ? (
          <span className="flex items-center gap-1 text-muted">
            <span className="size-1.5 animate-pulse rounded-full bg-sky" /> Grok is reading X…
          </span>
        ) : (
          <span className={cn("font-semibold uppercase", MOOD[x.sentiment])}>{x.sentiment}</span>
        )}
      </div>
      {x === "loading" ? (
        <div className="space-y-1.5">
          <div className="h-2.5 w-11/12 animate-pulse rounded bg-line" />
          <div className="h-2.5 w-2/3 animate-pulse rounded bg-line" />
        </div>
      ) : (
        <>
          <p className="text-fg/90">{x.summary}</p>
          {!!x.warnings.length && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {x.warnings.map((w) => (
                <span key={w} className="rounded-md border border-danger/40 px-1.5 py-0.5 text-[11px] text-danger">
                  ⚠ {w}
                </span>
              ))}
            </div>
          )}
          {!!x.posts.length && (
            <ul className="mt-2 space-y-1">
              {x.posts.map((p) => (
                <li key={p.url} className="truncate">
                  <a href={p.url} target="_blank" rel="noreferrer" className="hover:underline">
                    <span className="text-sky">@{p.handle}</span> <span className="text-muted">{p.text}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Flag({ ok, label }: { ok: boolean; label: string }) {
  return <span className={cn("rounded-md border px-1.5 py-0.5", ok ? "border-lime/40 text-lime" : "border-danger/40 text-danger")}>{label}</span>;
}

// «Следить постоянно»: спавн on-chain краулера с этим токеном в списке наблюдения (всплески объёма)
// и поиском по тикеру. Цена — тир Larva.
function WatchButton({ r }: { r: Result }) {
  const { cfg, unit, simulated, price: priceOf, fmtPrice, signLabel } = usePay();
  const STEP: Record<BurnStep, string> = { prepare: "Preparing…", sign: signLabel, confirm: "Checking payment…" };
  const router = useRouter();
  const toast = useToast();
  const { address, signedIn, connect, signIn } = useWallet();
  const [step, setStep] = useState<BurnStep | "busy" | null>(null);
  if (r.chain !== "solana" && r.chain !== "robinhood") return null;
  const price = priceOf("larva");
  const watch = async () => {
    if (!address) return connect();
    if (!signedIn) return signIn();
    const payload = {
      name: `Watch $${r.symbol}`.slice(0, 24),
      source: "onchain" as const,
      chain: r.chain as "solana" | "robinhood",
      narratives: ["ai" as const],
      targets: [r.id],
      frequencyMin: 30,
      tier: "larva" as const,
      spec: {
        instructions: `Watch $${r.symbol} (${r.id}). Report volume spikes, big buys and new pairs for this token.`,
        signalKinds: ["whale_buy" as const, "mention_spike" as const, "new_pair" as const],
        minConfidence: 0.4,
        onchain: { feeds: ["boosts" as const], minLiquidityUsd: 0, minVolume1hUsd: 0, maxFdvUsd: 0, maxAgeHours: 0 },
      },
    };
    try {
      setStep("busy");
      const c = simulated ? await post<PublicCrawler>("/api/crawlers", payload) : await spawnWithBurn(payload, setStep);
      toast(`A crawler now watches $${r.symbol} for you`);
      router.push(`/crawler/${c.id}`);
    } catch (e) {
      toast((e as Error).message, "error");
      setStep(null);
    }
  };
  return (
    <Button size="sm" onClick={watch} disabled={!!step || !cfg}>
      <Eye className="size-4" />
      {step ? (step === "busy" ? "…" : STEP[step]) : `Watch 30 days · ${fmtPrice(price)} ${unit}`}
    </Button>
  );
}

function RecentScans({ rows, onOpen }: { rows: Recent[]; onOpen: (id: string) => void }) {
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-line bg-panel/70">
      <div className="flex items-center justify-between border-b border-line px-4 py-2 text-[11px]">
        <span className="flex items-center gap-1.5 text-lime">
          <span className="size-1.5 rounded-full bg-lime" /> recently scanned
        </span>
        <span className="text-muted">click to open</span>
      </div>
      <div className="divide-y divide-line">
        {rows.slice(0, 5).map((r) => {
          const st = VERDICT_STYLE[r.verdict];
          return (
            <button
              key={r.id}
              onClick={() => onOpen(r.id)}
              className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-3 px-4 py-2 text-left text-sm transition hover:bg-panel-2 sm:grid-cols-[1.2fr_1fr_auto_auto_auto]"
            >
              <span className="truncate font-medium">${r.symbol}</span>
              <span className="num hidden truncate text-xs text-muted sm:block">{short(r.id)}</span>
              <span className={cn("num w-8 text-right font-semibold", st.text)}>{r.score ?? "-"}</span>
              <span className={cn("w-20 text-[11px] font-semibold", st.text)}>{st.label}</span>
              <span className="hidden w-16 text-right text-[11px] text-muted sm:block">{timeAgo(r.at)}</span>
            </button>
          );
        })}
      </div>
      <Link href="/market" className="flex items-center justify-center gap-1 border-t border-line py-2 text-xs text-honey hover:bg-panel-2">
        Want this on autopilot? Pick a ready-made crawler <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}
