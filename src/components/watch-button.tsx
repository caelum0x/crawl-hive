"use client";
// Кнопка «👁 следить за кошельком» на бабл-карте скана. Вошёл в кошелёк — добавляем сразу; нет — открываем
// /watchlist с подставленным адресом.
import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { useWallet } from "@/components/wallet-provider";
import { post } from "@/lib/client/api";
import { cn } from "@/lib/utils";

export function WatchButton({ wallet, className }: { wallet: string; className?: string }) {
  const { address, signedIn } = useWallet();
  const toast = useToast();
  const [done, setDone] = useState(false);
  const click = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!address || !signedIn) return void window.open(`/watchlist?add=${encodeURIComponent(wallet)}`, "_blank", "noopener");
    try {
      await post("/api/watchlist", { wallet });
      setDone(true);
      toast("Watching this wallet. Alerts go to your Telegram");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };
  return (
    <button
      type="button"
      onClick={click}
      title={done ? "Watching" : "Watch this wallet: get a Telegram DM when it shows up on a new coin"}
      aria-label="Watch this wallet"
      className={cn("rounded px-1 text-[11px] leading-none transition-opacity", done ? "opacity-100" : "opacity-60 hover:opacity-100", className)}
    >
      {done ? "✅" : "👁"}
    </button>
  );
}
