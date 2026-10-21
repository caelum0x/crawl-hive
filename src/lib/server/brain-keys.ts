// Личные ключи Brain (chk_…): один ключ на кошелёк, выдаётся вошедшему на сайте. Храним только sha256 и хвост
// для показа; сам ключ видно один раз при создании. Лимиты ключа — по тарифу его кошелька (tiers.ts).
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { allowHit } from "./scan";
import { ApiError, getMeta, setMeta } from "./store";

interface KeyRec { wallet: string; at: number; tail: string; used?: number }
const META = "brainKeys";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const all = (): Record<string, KeyRec> => {
  try {
    return JSON.parse(getMeta(META) ?? "{}");
  } catch {
    return {};
  }
};
const save = (v: Record<string, KeyRec>) => setMeta(META, JSON.stringify(v));

export const isBrainKey = (k: string) => /^chk_[A-Za-z0-9_-]{32,64}$/.test(k);
export function walletByBrainKey(key: string): string | null {
  if (!isBrainKey(key)) return null;
  return all()[sha(key)]?.wallet ?? null;
}
export function brainKeyInfo(wallet: string) {
  const r = Object.values(all()).find((x) => x.wallet === wallet);
  return r ? { tail: r.tail, createdAt: r.at } : null;
}
// Новый ключ (старый того же кошелька отзывается).
export function createBrainKey(wallet: string) {
  if (!allowHit(`brainkey:${wallet}`, 5, 3600_000)) throw new ApiError("Too many new keys this hour, try later", 429);
  const v = all();
  for (const [h, r] of Object.entries(v)) if (r.wallet === wallet) delete v[h];
  const key = `chk_${randomBytes(24).toString("base64url")}`;
  v[sha(key)] = { wallet, at: Date.now(), tail: key.slice(-4) };
  save(v);
  return { key, tail: key.slice(-4) };
}
export function revokeBrainKey(wallet: string) {
  const v = all();
  let n = 0;
  for (const [h, r] of Object.entries(v)) if (r.wallet === wallet) (delete v[h], n++);
  save(v);
  return { revoked: n };
}
