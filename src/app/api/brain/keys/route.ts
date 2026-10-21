// Личный ключ Brain вошедшего кошелька: POST — новый (старый отзывается, ключ видно один раз), DELETE — отозвать.
import type { NextRequest } from "next/server";
import { handle, walletFrom } from "@/lib/server/http";
import { brainKeyInfo, createBrainKey, revokeBrainKey } from "@/lib/server/brain-keys";

export async function GET(req: NextRequest) {
  return handle(() => ({ key: brainKeyInfo(walletFrom(req)) }));
}
export async function POST(req: NextRequest) {
  return handle(() => createBrainKey(walletFrom(req)));
}
export async function DELETE(req: NextRequest) {
  return handle(() => revokeBrainKey(walletFrom(req)));
}
