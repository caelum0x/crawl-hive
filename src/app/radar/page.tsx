"use client";
import { TOKEN } from "@/lib/token";
// Launch Radar: свежие запуски, которые платформа сканирует сама. Всем — с задержкой; владельцы краулеров
// получают такие находки сразу, поэтому рядом всегда призыв запустить свой краулер.
import Link from "next/link";
import { useMemo, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { VerdictPill } from "@/components/verdict";
import { Chip, LivePill, RadarScope, TokenAvatar } from "@/components/radar-scope";
import { useApi } from "@/lib/client/use-api";
import { cn, fmt, short, timeAgo } from "@/lib/utils";

interface Entry {
  id: string;
  chain: string;
  symbol: string;
  name: string;
  verdict: string;
  score: number | null;
  reason: string;
  flags: string[];
  liq: number;
  fdv: number;
  ageH: number | null;
  at: number;
  img?: string;
  narrative?: { id: string; title: string }; // монету заранее назвал Narrative Radar
}
interface Feed {
  items: Entry[];
  waiting: number;
  delayMin: number;
  live?: boolean;
  holderMin?: number;
  day: { scanned: number; danger: number; clean: number };
}

const CHAIN: Record<string, { t: string; c: string }> = {
  solana: { t: "Solana", c: "text-violet border-violet/40" },
  robinhood: { t: "Robinhood", c: "text-lime border-lime/40" },
  bsc: { t: "BNB", c: "text-honey border-honey/40" },
  base: { t: "Base", c: "text-sky border-sky/40" },
};
const COLOR: Record<string, string> = { CLEAN: "var(--lime)", OK: "var(--teal)", RISKY: "var(--honey)", DANGER: "var(--danger)", TOO_EARLY: "var(--muted)" };
const VERDICTS: [string, string, (v: string) => boolean][] = [
  ["all", "All verdicts", () => true],
  ["good", "✓ Clean / OK", (v) => v === "CLEAN" || v === "OK"],
  ["risky", "Risky", (v) => v === "RISKY"],
  ["danger", "Danger", (v) => v === "DANGER"],
];

const age = (h: number | null) => (h == null ? "-" : h < 1 ? `${Math.round(h * 60)}m` : `${Math.round(h)}h`);

function Box({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-[110px] rounded-xl border border-line bg-panel/70 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={cn("num mt-0.5 text-xl font-bold", tone)}>{value}</div>
    </div>
  );
}

function CopyCa({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard?.writeText(id).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}
      className="num flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-bg/60 px-2.5 py-1.5 text-xs text-muted hover:text-fg"
    >
      {short(id)}
      {done ? <Check className="size-3.5 text-lime" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function LaunchCard({ e, active }: { e: Entry; active: boolean }) {
  const color = COLOR[e.verdict] ?? "var(--muted)";
  const ch = CHAIN[e.chain];
  return (
    <div id={`r-${e.id}`} className={cn("flex scroll-mt-24 flex-col rounded-2xl border bg-panel p-4 transition-all", active ? "border-lime/70 shadow-[0_0_28px_rgba(163,230,53,.3)]" : "border-line hover:border-lime/40")}>
      <div className="flex items-center gap-3">
        <TokenAvatar img={e.img} symbol={e.symbol} color={color} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link href={`/scan/${e.id}`} className="num truncate text-lg font-bold hover:text-honey">
              ${e.symbol}
            </Link>
            <span className="num rounded-full border border-line px-1.5 text-[10px] text-muted">{age(e.ageH)}</span>
          </div>
          <div className="truncate text-sm text-muted">{e.name}</div>
        </div>
        <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px]", ch?.c ?? "border-line text-muted")}>{ch?.t ?? e.chain}</span>
      </div>

      {e.narrative && (
        <Link href={`/narratives#n-${e.narrative.id}`} className="mt-3 flex items-center gap-2 rounded-xl border border-violet/50 bg-gradient-to-r from-violet/15 to-pink/10 px-2.5 py-1.5 text-xs hover:border-violet">
          <span className="text-base">🔮</span>
          <span className="min-w-0">
            <span className="block font-bold text-violet">Called by Narrative Radar</span>
            <span className="block truncate text-muted">{e.narrative.title}</span>
          </span>
        </Link>
      )}
      <div className="mt-3 flex items-end justify-between gap-2 rounded-xl border border-line bg-bg/60 p-2.5">
        <div>
          <div className="text-[10px] text-muted uppercase tracking-wider">FDV at scan</div>
          <div className="num text-lg font-bold">${fmt(e.fdv)}</div>
          <div className="num text-[11px] text-muted">liq ${fmt(e.liq)}</div>
        </div>
        <div className="text-right">
          {e.score != null && (
            <div className="num text-lg font-bold" style={{ color }}>
              {e.score}
              <span className="text-xs text-muted">/100</span>
            </div>
          )}
          <VerdictPill verdict={e.verdict} />
        </div>
      </div>

      <p className="mt-2 line-clamp-2 flex-1 text-xs text-fg/75" title={e.reason}>
        {e.reason}
      </p>
      {!!e.flags.length && <div className="mt-1 truncate text-[11px] text-danger/85">{e.flags.join(" · ")}</div>}

      <div className="mt-3">
        <CopyCa id={e.id} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Link href={`/scan/${e.id}`} className="rounded-xl border border-lime/50 bg-lime/10 px-3 py-2 text-center text-sm font-semibold text-lime hover:bg-lime/15">
          Full scan
        </Link>
        <a href={`https://dexscreener.com/${e.chain}/${e.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-1 rounded-xl border border-line px-3 py-2 text-sm hover:border-sky/60 hover:text-sky">
          Chart <ExternalLink className="size-3" />
        </a>
      </div>
      <div className="num mt-2 text-right text-[10px] text-muted">scanned {timeAgo(e.at)}</div>
    </div>
  );
}

export default function RadarPage() {
  const { data } = useApi<Feed>("/api/radar", 30000);
  const [chain, setChain] = useState("all");
  const [verdict, setVerdict] = useState("all");
  const [active, setActive] = useState<string | null>(null);
  const d = data?.day;
  const vf = VERDICTS.find((v) => v[0] === verdict)![2];
  const [called, setCalled] = useState(false);
  const items = useMemo(() => (data?.items ?? []).filter((e) => (chain === "all" || e.chain === chain) && vf(e.verdict) && (!called || !!e.narrative)), [data, chain, vf, called]);
  const blips = items.slice(0, 16).map((e, i) => ({ id: e.id, label: `$${e.symbol}`, img: e.img, glyph: e.symbol.slice(0, 1).toUpperCase(), color: e.narrative ? "var(--violet)" : COLOR[e.verdict] ?? "var(--muted)", r: 0.05 + (i / Math.max(1, Math.min(16, items.length) - 1)) * 0.95 }));
  const pick = (id: string) => {
    setActive(id);
    document.getElementById(`r-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <>
      <section className="mb-8 grid items-center gap-8 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <LivePill>Live · the swarm scans fresh launches every 3 minutes</LivePill>
          <h1 className="mt-4 text-4xl leading-none font-bold tracking-tight lg:text-6xl">
            Launch <span className="bg-gradient-to-r from-lime via-teal to-sky bg-clip-text text-transparent">Radar</span>
          </h1>
          <p className="mt-4 max-w-xl text-fg/85">Fresh launches on Solana, Robinhood Chain, BNB Chain and Base, scanned by the swarm on its own. Nobody asked for these scans.</p>
          <p className="mt-1 max-w-xl text-sm text-muted">Holders, bundles and clusters, dev history, copycats, contract powers. Every verdict also goes on the Track Record and is checked against the price for 24 hours.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Box label="Scanned, 24h" value={d ? fmt(d.scanned) : "-"} tone="text-lime" />
            <Box label="Flagged DANGER" value={d ? `${d.scanned ? Math.round((d.danger / d.scanned) * 100) : 0}%` : "-"} tone="text-danger" />
            <Box label="Clean or OK" value={d ? `${d.scanned ? Math.round((d.clean / d.scanned) * 100) : 0}%` : "-"} tone="text-teal" />
            <Box label="Chains" value="3" />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {[
              ["all", "All chains"],
              ["solana", "● Solana"],
              ["robinhood", "● Robinhood"],
              ["bsc", "● BNB"],
              ["base", "● Base"],
            ].map(([k, t]) => (
              <Chip key={k} on={chain === k} onClick={() => setChain(k)}>
                {t}
              </Chip>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {VERDICTS.map(([k, t]) => (
              <Chip key={k} on={verdict === k} onClick={() => setVerdict(k)}>
                {t}
              </Chip>
            ))}
            <Chip on={called} onClick={() => setCalled((x) => !x)}>
              🔮 Called by Narrative Radar
            </Chip>
          </div>
        </div>
        <RadarScope blips={blips} active={active} onPick={pick} tone="var(--lime)" />
      </section>

      {data?.live ? (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-lime/40 bg-gradient-to-r from-lime/[0.09] to-transparent px-4 py-3 text-sm">
          <span className="rounded-md bg-lime px-2 py-0.5 text-xs font-black text-black">HOLDER</span>
          <span>
            <span className="font-semibold">You see the radar live.</span>
            <span className="text-muted"> Holder perk: launches show up the second the swarm scans them, no {data.delayMin}-minute delay.</span>
          </span>
        </div>
      ) : (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-honey/30 bg-gradient-to-r from-honey/[0.07] to-transparent px-4 py-3 text-sm">
          <span>
            <span className="font-semibold">{data?.waiting ?? 0} newer finds</span>
            <span className="text-muted">
              {" "}
              are waiting out the {data?.delayMin ?? 10}-minute delay. Hold {data?.holderMin ? data.holderMin.toLocaleString("en-US") : "about $10 of"} ${TOKEN.symbol} and connect your wallet to see them live, or spawn a crawler for launches filtered to your own rules.
            </span>
          </span>
          <Link href="/#treasury" className="rounded-xl bg-honey px-3 py-1.5 text-sm font-bold text-black hover:opacity-90">
            Get ${TOKEN.symbol}
          </Link>
        </div>
      )}

      {data && !items.length ? (
        <div className="rounded-2xl border border-line bg-panel px-4 py-12 text-center text-sm text-muted">{data.items.length ? "Nothing in this filter right now." : `The radar has just started. First launches show up here ${data.delayMin} minutes after the scan.`}</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((e) => (
            <LaunchCard key={e.id} e={e} active={active === e.id} />
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        Every verdict here also goes into the{" "}
        <Link href="/track" className="text-honey hover:underline">
          Track Record
        </Link>
        : 24 hours later you can see whether it came true. Not financial advice.
      </p>
    </>
  );
}
