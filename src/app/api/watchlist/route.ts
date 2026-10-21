// Watchlist кошельков вошедшего кошелька: список с краткой историей, последние алерты, лимит по тарифу,
// добавить (POST {wallet, label}) и убрать (DELETE ?wallet=). Владелец — только из подписанной сессии.
import type { NextRequest } from "next/server";
import { body, handle, walletFrom } from "@/lib/server/http";
import { addWatch, removeWatch, watchState } from "@/lib/server/watchlist";

export async function GET(req: NextRequest) {
  return handle(() => watchState(walletFrom(req)));
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const owner = walletFrom(req);
    const b = await body<{ wallet?: string; label?: string }>(req);
    return addWatch(owner, b.wallet, b.label);
  });
}

export async function DELETE(req: NextRequest) {
  return handle(() => ({ removed: removeWatch(walletFrom(req), new URL(req.url).searchParams.get("wallet")) }));
}
