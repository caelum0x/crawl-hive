"use client";
// Кнопка «следить за оператором» у групп на бабл-карте скана. Видна всем; сервер сам ответит, что это Whale,
// если тариф ниже. Не вошёл в кошелёк — объясняем и открываем /watchlist с подставленным кошельком группы.
import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { useWallet } from "@/components/wallet-provider";
import { post } from "@/lib/client/api";
import { cn } from "@/lib/utils";

export function WatchOperatorButton({ wallets, className }: { wallets: string[]; className?: string }) {
  const { address, signedIn } = useWallet();
  const toast = useToast();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!wallets.length) return null;
  const click = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!address || !signedIn) {
      toast("Operator watch is a Whale perk. Sign in on the watchlist page to add it");
      return void window.open(`/watchlist?op=${encodeURIComponent(wallets[0])}`, "_blank", "noopener");
    }
    setBusy(true);
    try {
      const r = await post<{ op: string; members: number }>("/api/watchlist/operators", { wallets });
      setDone(true);
      toast(`Watching operator ${r.op} (${r.members} wallets). Alerts go to your Telegram`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={click}
      disabled={busy}
      title={done ? "Watching this operator" : "Watch the whole operator (Whale): a Telegram DM when any of its wallets shows up on a new coin"}
      aria-label="Watch operator"
      className={cn("rounded-full border border-white/10 px-2 py-1 text-[11px] leading-none transition-colors hover:bg-white/5", done && "border-lime/50 text-lime", className)}
    >
      {done ? "✅ Watching" : "🕸 Watch operator"}
    </button>
  );
}
