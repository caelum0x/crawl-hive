"use client";
// Личный ключ Brain и вызовы за сжигание: создать или сменить ключ (виден один раз), отозвать, купить пакет вызовов.
import { useState } from "react";
import Link from "next/link";
import { del, post } from "@/lib/client/api";
import { useApi } from "@/lib/client/use-api";
import { fmt } from "@/lib/utils";
import { useBurnPay } from "./burn-pay";
import { TIER_LABEL, type TierApi } from "./pricing-client";
import { useWallet } from "./wallet-provider";
import { useToast } from "./ui/toast";
import { Card } from "./ui/card";
import { Button } from "./ui/button";

export function BrainKeys() {
  const { signedIn, connect } = useWallet();
  const toast = useToast();
  const { data, reload } = useApi<TierApi>(signedIn ? "/api/tier" : null, 120_000);
  const { pay, busy } = useBurnPay(() => reload());
  const [fresh, setFresh] = useState<string | null>(null);

  const create = async () => {
    try {
      const r = await post<{ key: string }>("/api/brain/keys");
      setFresh(r.key);
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const revoke = async () => {
    await del("/api/brain/keys").catch(() => {});
    setFresh(null);
    reload();
    toast("Key revoked");
  };
  const price = (calls: number) => {
    const p = data?.need.priceUsd;
    const usd = (calls / 1000) * (data?.brain.usdPer1k ?? 1);
    return p ? `${fmt(Math.ceil(usd / p))} tokens · ~$${usd}` : `~$${usd}`;
  };

  return (
    <Card className="p-5 text-sm">
      <div className="text-lg font-bold">🔑 Your Brain key</div>
      {!signedIn ? (
        <div className="mt-2 space-y-2 text-fg/85">
          <p>Connect your wallet to get a personal key. Your limits follow your tier, and you can top up by burning $CRAWLHIVE.</p>
          <Button size="sm" onClick={() => connect()}>
            Connect wallet
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-3 text-fg/85">
          <div>
            Tier: <b>{data ? TIER_LABEL[data.tier] : "…"}</b> · burn credits: <b className="num">{fmt(data?.brain.credits ?? 0)}</b> calls ·{" "}
            <Link href="/pricing" className="text-honey hover:underline">
              tiers
            </Link>
          </div>
          {fresh ? (
            <div className="rounded-lg border border-lime/50 bg-lime/10 p-3">
              <div className="text-xs text-muted">Copy it now, we only show it once:</div>
              <code className="mt-1 block break-all font-mono text-xs text-lime">{fresh}</code>
            </div>
          ) : data?.brain.key ? (
            <div className="font-mono text-xs">chk_…{data.brain.key.tail}</div>
          ) : (
            <div className="text-muted">No key yet.</div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={create}>
              {data?.brain.key ? "Rotate key" : "Create key"}
            </Button>
            {data?.brain.key && (
              <Button size="sm" variant="danger" onClick={revoke}>
                Revoke
              </Button>
            )}
          </div>
          <div className="text-xs text-muted">Send it as Authorization: Bearer chk_… on every Brain call.</div>
          <div className="border-t border-line pt-3">
            <div className="font-semibold text-fg">Top up by burning $CRAWLHIVE</div>
            <p className="mt-1 text-xs text-muted">Credits kick in after your tier limit and never expire. You burn the tokens yourself in Phantom.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(data?.brain.packs ?? [1000, 5000, 20000]).map((c) => (
                <Button key={c} size="sm" variant="outline" disabled={!!busy} onClick={() => pay("brain", c)}>
                  🔥 {fmt(c)} calls <span className="text-muted">· {price(c)}</span>
                </Button>
              ))}
            </div>
            {busy && <div className="mt-2 text-xs text-honey">{busy}</div>}
          </div>
        </div>
      )}
    </Card>
  );
}
