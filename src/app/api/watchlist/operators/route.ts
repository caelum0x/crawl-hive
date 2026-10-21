// Watch операторов (Whale) вошедшего кошелька: список, последние алерты, добавить (POST {target} — кошелёк или
// id оператора, либо {wallets} — кошельки группы со страницы скана) и убрать (DELETE ?target=).
import type { NextRequest } from "next/server";
import { body, handle, walletFrom } from "@/lib/server/http";
import { addWatchOp, removeWatchOp, watchOpsState } from "@/lib/server/operator-watch";

export async function GET(req: NextRequest) {
  return handle(() => watchOpsState(walletFrom(req)));
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const owner = walletFrom(req);
    const b = await body<{ target?: string; wallets?: string[]; label?: string }>(req);
    return addWatchOp(owner, Array.isArray(b.wallets) ? b.wallets : b.target, b.label);
  });
}

export async function DELETE(req: NextRequest) {
  return handle(() => ({ removed: removeWatchOp(walletFrom(req), new URL(req.url).searchParams.get("target")) }));
}
