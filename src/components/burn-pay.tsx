"use client";
// Оплата сжиганием из своего кошелька: сервер собирает транзакцию burnChecked, Phantom подписывает и отправляет,
// сервер находит её в сети и засчитывает (Pro или вызовы Brain). Ключ и токены остаются у пользователя.
import { useState } from "react";
import { post } from "@/lib/client/api";
import { phantom, useWallet } from "./wallet-provider";
import { useToast } from "./ui/toast";

type Built = { quoteId: string; transaction: string; tokens: number; usd: number };
export type BurnResult = { proUntil: number | null; credits: number };

export function useBurnPay(onDone?: (r: BurnResult) => void) {
  const { mode, signedIn, connect } = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const pay = async (purpose: "pro" | "brain", calls?: number) => {
    const p = phantom();
    if (!p) return toast("Burning needs Phantom: open the site in a browser with Phantom", "error");
    try {
      // Подключение и вход меняют состояние кошелька не сразу: после них просим нажать ещё раз.
      if (!signedIn || mode !== "phantom") {
        await connect("phantom");
        return toast("Wallet connected. Press the button again to burn");
      }
      setBusy("Preparing the burn…");
      const b = await post<Built>("/api/user-burn", { action: "build", purpose, calls });
      setBusy(`Sign in Phantom: burn ${b.tokens.toLocaleString("en-US")} $CRAWLHIVE`);
      const { VersionedTransaction } = await import("@solana/web3.js");
      const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(b.transaction), (c) => c.charCodeAt(0)));
      let signature: string;
      try {
        signature = (await p.signAndSendTransaction(tx)).signature;
      } catch {
        throw new Error("You cancelled in Phantom. Nothing was burned.");
      }
      setBusy("Checking the burn onchain…");
      // Транзакция доходит до RPC сервера не сразу: пробуем засчитать несколько раз.
      let last: Error | null = null;
      for (let i = 0; i < 6; i++) {
        try {
          const r = await post<BurnResult>("/api/user-burn", { action: "confirm", quoteId: b.quoteId, signature });
          toast(purpose === "pro" ? "🔥 Burned. Pro is on, welcome to the hive" : `🔥 Burned. ${calls?.toLocaleString("en-US")} Brain calls added`);
          onDone?.(r);
          return r;
        } catch (e) {
          last = e as Error;
          if (!/not found/i.test(last.message)) break;
          await new Promise((r) => setTimeout(r, 4000));
        }
      }
      if (last) throw last;
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };
  return { pay, busy };
}
