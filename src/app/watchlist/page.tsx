"use client";
// Watchlist кошельков: за кем следишь, их история в памяти роя и алерты, когда такой кошелёк появляется
// в новой монете. Алерты приходят в Telegram; лимит кошельков зависит от тарифа (holder, Pro, whale).
// Ниже — операторы (только Whale): watch целой группы связанных кошельков, а не одного адреса.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Eye, Lock, Network, Trash2, Wallet } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { TelegramCard } from "@/components/telegram-card";
import { useToast } from "@/components/ui/toast";
import { useWallet } from "@/components/wallet-provider";
import { useApi } from "@/lib/client/use-api";
import { del, post } from "@/lib/client/api";

interface Entry {
  wallet: string;
  label: string;
  at: number;
  tokens: number;
  dumpRate: number | null;
  risk: { score: number; level: string } | null;
}
interface Alert {
  target: string;
  token: string;
  chain: string;
  role: string;
  at: number;
}
interface OpEntry {
  anchor: string;
  op: string | null;
  label: string;
  at: number;
  members: number;
  coins: number;
  dumpRate: number | null;
}
interface OpAlert {
  op: string;
  token: string;
  chain: string;
  members: [string, string][];
  at: number;
}
interface OpState {
  tier: string;
  max: number;
  list: OpEntry[];
  alerts: OpAlert[];
}
interface State {
  tier: string;
  max: number | null;
  list: Entry[];
  alerts: Alert[];
  telegram: boolean;
}

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const RISK_TONE: Record<string, string> = { high: "text-coral", medium: "text-honey", low: "text-lime" };
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export default function WatchlistPage() {
  const { address, signedIn, connect, signIn } = useWallet();
  const ready = !!address && signedIn;
  const toast = useToast();
  const { data, reload, error } = useApi<State>(ready ? "/api/watchlist" : null, 30000);
  const [wallet, setWallet] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const ops = useApi<OpState>(ready ? "/api/watchlist/operators" : null, 30000);
  const [opTarget, setOpTarget] = useState("");
  const [opLabel, setOpLabel] = useState("");

  // Быстрое добавление со страницы скана: /watchlist?add=<кошелёк>, оператор — /watchlist?op=<кошелёк группы>
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const add = q.get("add");
    if (add) setWallet(add);
    const op = q.get("op");
    if (op) setOpTarget(op);
  }, []);

  const add = async () => {
    setBusy(true);
    try {
      await post("/api/watchlist", { wallet: wallet.trim(), label });
      setWallet("");
      setLabel("");
      toast("Watching. You'll get a Telegram DM when it shows up on a new coin");
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const addOp = async () => {
    setBusy(true);
    try {
      const r = await post<{ op: string; members: number }>("/api/watchlist/operators", { target: opTarget.trim(), label: opLabel });
      setOpTarget("");
      setOpLabel("");
      toast(`Watching operator ${r.op} (${r.members} wallets)`);
      ops.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const removeOp = async (anchor: string) => {
    try {
      await del(`/api/watchlist/operators?target=${encodeURIComponent(anchor)}`);
      ops.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const remove = async (w: string) => {
    try {
      await del(`/api/watchlist?wallet=${encodeURIComponent(w)}`);
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const header = (
    <PageHeader
      title="Wallet watchlist"
      sub="Follow snipers, bundlers and rug devs. The moment the swarm sees one of them on a new coin, you get a Telegram DM with the coin, its role and its track record."
    />
  );

  if (!ready)
    return (
      <>
        {header}
        <Card className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <Lock className="size-8 text-honey" />
          <div className="font-semibold">Sign in to manage your watchlist</div>
          <p className="max-w-sm text-sm text-muted">Signing is free and sends no transaction. The watchlist is for $CRAWLHIVE holders and Pro.</p>
          <Button onClick={() => (address ? signIn() : connect())}>
            <Wallet className="size-4" /> {address ? "Sign in" : "Connect wallet"}
          </Button>
        </Card>
      </>
    );

  const max = data?.max ?? 0;
  const full = !!data && data.list.length >= max;
  return (
    <>
      {header}
      <TelegramCard />
      {data && !data.telegram && max > 0 && (
        <p className="mb-4 text-sm text-honey">Connect Telegram above: alerts are delivered there.</p>
      )}

      <Card className="mb-5 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <Eye className="size-4 text-sky" />
          <span className="font-semibold">Add a wallet</span>
          {data && (
            <span className="ml-auto text-xs text-muted">
              {data.list.length}/{max} on your <b className="text-fg">{data.tier}</b> plan
            </span>
          )}
        </div>
        {data && max === 0 ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            The wallet watchlist starts with the Holder plan (3 wallets). Pro watches 50, Whale 500.
            <Link href="/pricing" className="rounded-lg bg-honey px-3 py-1.5 font-semibold text-black">
              See plans
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input placeholder="Wallet address (Solana or 0x…)" value={wallet} onChange={(e) => setWallet(e.target.value)} className="sm:flex-1" />
            <Input placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} className="sm:w-48" maxLength={40} />
            <Button onClick={add} disabled={busy || !wallet.trim() || full}>
              <Eye className="size-4" /> Watch
            </Button>
          </div>
        )}
        {full && max > 0 && (
          <p className="mt-2 text-xs text-muted">
            Your plan is full. <Link href="/pricing" className="text-honey underline">Upgrade</Link> to watch more.
          </p>
        )}
        {error && <p className="mt-2 text-xs text-coral">{error}</p>}
      </Card>

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Card className="p-4">
          <div className="mb-3 text-sm font-semibold">Watching</div>
          {!data?.list.length ? (
            <p className="text-sm text-muted">Nothing yet. Tip: open any scan, find a sniper or a linked wallet on the bubble map and tap 👁.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.list.map((w) => (
                <li key={w.wallet} className="flex items-center gap-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="num font-medium">
                      {short(w.wallet)} {w.label && <span className="ml-1 text-muted">{w.label}</span>}
                    </div>
                    <div className="text-xs text-muted">
                      {w.tokens ? `${w.tokens} coin${w.tokens === 1 ? "" : "s"} in memory` : "not seen yet"}
                      {w.dumpRate != null && ` · ${Math.round(w.dumpRate * 100)}% dumped`}
                    </div>
                  </div>
                  {w.risk && (
                    <span className={`num text-xs font-bold ${RISK_TONE[w.risk.level] ?? "text-muted"}`}>
                      risk {w.risk.score}
                    </span>
                  )}
                  <button onClick={() => remove(w.wallet)} className="text-muted hover:text-coral" aria-label="Stop watching">
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3 text-sm font-semibold">Latest alerts</div>
          {!data?.alerts.length ? (
            <p className="text-sm text-muted">No alerts yet. They show up here and in Telegram.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.alerts.map((a) => (
                <li key={`${a.target}:${a.token}`} className="rounded-lg border border-line px-3 py-2">
                  <span className="num">{short(a.target)}</span> as <b>{a.role}</b> on{" "}
                  <Link href={`/scan/${a.token}`} className="num text-honey underline">
                    {short(a.token)}
                  </Link>
                  <span className="ml-1 text-xs text-muted">· {ago(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-5 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <Network className="size-4 text-sky" />
          <span className="font-semibold">Operators (Whale)</span>
          {ops.data && ops.data.max > 0 && (
            <span className="ml-auto text-xs text-muted">
              {ops.data.list.length}/{ops.data.max}
            </span>
          )}
        </div>
        <p className="mb-3 text-xs text-muted">
          Watch a whole group of linked wallets, not just one. When any of its wallets, even ones added later, shows up on a new coin as sniper, bundler, dev or linked holder, you get one DM per coin.
        </p>
        {ops.data && ops.data.max === 0 ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            Operator watch is a Whale perk: hold about $100 of $CRAWLHIVE and watch up to 25 operators.
            <Link href="/pricing" className="rounded-lg bg-honey px-3 py-1.5 font-semibold text-black">
              See plans
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input placeholder="Member wallet or operator id (op_…)" value={opTarget} onChange={(e) => setOpTarget(e.target.value)} className="sm:flex-1" />
            <Input placeholder="Label (optional)" value={opLabel} onChange={(e) => setOpLabel(e.target.value)} className="sm:w-48" maxLength={40} />
            <Button onClick={addOp} disabled={busy || !opTarget.trim() || (!!ops.data && ops.data.list.length >= ops.data.max)}>
              <Network className="size-4" /> Watch operator
            </Button>
          </div>
        )}
        {ops.error && <p className="mt-2 text-xs text-coral">{ops.error}</p>}
        {!!ops.data?.list.length && (
          <ul className="mt-3 divide-y divide-line">
            {ops.data.list.map((o) => (
              <li key={o.anchor} className="flex items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="num font-medium">
                    {o.op ?? short(o.anchor)} {o.label && <span className="ml-1 text-muted">{o.label}</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {o.op ? `${o.members} wallets · ${o.coins} coin${o.coins === 1 ? "" : "s"}` : "not linked right now, still watching"}
                    {o.dumpRate != null && ` · ${Math.round(o.dumpRate * 100)}% dumped`}
                  </div>
                </div>
                <button onClick={() => removeOp(o.anchor)} className="text-muted hover:text-coral" aria-label="Stop watching operator">
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {!!ops.data?.alerts.length && (
          <ul className="mt-3 space-y-2 text-sm">
            {ops.data.alerts.map((a) => (
              <li key={`${a.op}:${a.token}`} className="rounded-lg border border-line px-3 py-2">
                <span className="num">{a.op}</span>: {a.members.length} wallet{a.members.length === 1 ? "" : "s"} ({[...new Set(a.members.map(([, r]) => r))].join(", ")}) on{" "}
                <Link href={`/scan/${a.token}`} className="num text-honey underline">
                  {short(a.token)}
                </Link>
                <span className="ml-1 text-xs text-muted">· {ago(a.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
