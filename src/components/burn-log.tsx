"use client";
// Публичный журнал сжиганий за Pro и вызовы Brain: кто, сколько, зачем, ссылка на транзакцию.
import { useApi } from "@/lib/client/use-api";
import { fmt, short } from "@/lib/utils";
import { Card } from "./ui/card";

type Log = { count: number; total: number; items: { sig: string; wallet: string; purpose: "pro" | "brain"; tokens: number; calls?: number; at: number }[] };

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function BurnLog({ limit = 12, compact = false }: { limit?: number; compact?: boolean }) {
  const { data } = useApi<Log>("/api/user-burn", 60_000);
  return (
    <Card className="p-5 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-lg font-bold">🔥 Burned for Pro &amp; Brain</div>
        <div className="text-muted">
          {data ? (
            <>
              <span className="num font-bold text-coral">{fmt(Math.round(data.total))}</span> $CRAWLHIVE in {data.count} burn{data.count === 1 ? "" : "s"}
            </>
          ) : (
            "…"
          )}
        </div>
      </div>
      {!compact && <p className="mt-1 text-muted">Every payment is a burn signed by the buyer. The tokens leave the supply for good, nobody receives them.</p>}
      <div className="mt-3 divide-y divide-line">
        {data?.items.slice(0, limit).map((b) => (
          <div key={b.sig} className="flex items-center gap-3 py-2">
            <span className="num w-24 shrink-0 text-xs text-muted">{short(b.wallet)}</span>
            <span className="flex-1">
              <span className="num font-semibold">{fmt(Math.round(b.tokens))}</span> <span className="text-muted">for</span> {b.purpose === "pro" ? <span className="font-bold text-pink">Pro</span> : <span className="font-bold text-teal">{fmt(b.calls ?? 0)} Brain calls</span>}
            </span>
            <a href={`https://solscan.io/tx/${b.sig}`} target="_blank" rel="noreferrer" className="text-xs text-honey hover:underline">
              tx
            </a>
            <span className="w-16 text-right text-xs text-muted">{ago(b.at)}</span>
          </div>
        ))}
        {data && !data.items.length && <div className="py-3 text-muted">No burns yet. Be the one who starts the fire.</div>}
      </div>
    </Card>
  );
}
