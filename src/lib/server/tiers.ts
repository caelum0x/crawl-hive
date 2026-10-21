// Тарифы CrawlHive — один источник правды для сайта, ботов, расширения и Brain.
// Holder и Whale — держишь $CRAWLHIVE на сумму от порога в долларах (по текущей цене, чтобы порог не ломался
// при движении цены). Pro — оплачен сжиганием токенов на ~$10 за 30 дней (grantPro после проверки сжигания).
// Порядок: free < holder < pro < whale. Whale — только холд от порога Whale; Pro поверх холда Holder остаётся Pro.
import "server-only";
import { getMeta, setMeta } from "./store";
import { holderMin, tokenBalance } from "./rewards";

export type Tier = "free" | "holder" | "pro" | "whale";
export const TIER_ORDER: Tier[] = ["free", "holder", "pro", "whale"];

const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const TIER_USD = {
  holder: num(process.env.TIER_HOLDER_USD, 10),
  whale: num(process.env.TIER_WHALE_USD, 100),
  pro: num(process.env.TIER_PRO_USD, 10), // цена Pro за PRO_DAYS, сжиганием
};
export const PRO_DAYS = num(process.env.TIER_PRO_DAYS, 30);

// Лимиты по тарифам. Infinity — без лимита. Части продукта берут отсюда, а не держат свои числа.
export const TIER_LIMITS: Record<Tier, { watchlist: number; botScansDay: number; brainMult: number; radarDelayMin: number; positions: number; operators: number }> = {
  free: { watchlist: 0, botScansDay: 20, brainMult: 1, radarDelayMin: 5, positions: 0, operators: 0 },
  holder: { watchlist: 3, botScansDay: 60, brainMult: 10, radarDelayMin: 0, positions: 0, operators: 0 },
  pro: { watchlist: 50, botScansDay: Infinity, brainMult: 20, radarDelayMin: 0, positions: 20, operators: 0 },
  // operators — watch операторов целиком (группы связанных кошельков), только Whale.
  whale: { watchlist: 500, botScansDay: Infinity, brainMult: 50, radarDelayMin: 0, positions: 100, operators: 25 },
};

// Цена токена: из рынка (DexScreener через buyback.tokenInfo), кэш 5 минут.
let price: { at: number; usd: number | null } | undefined;
export async function tokenPriceUsd(): Promise<number | null> {
  if (price && Date.now() - price.at < 300_000) return price.usd;
  const { tokenInfo } = await import("./buyback");
  const usd = (await tokenInfo().catch(() => null))?.market?.priceUsd ?? null;
  price = { at: Date.now(), usd: usd && usd > 0 ? usd : (price?.usd ?? null) };
  return price.usd;
}

// Сколько токенов нужно держать для тарифа сейчас: порог в долларах (Holder $10, Whale $100) по текущей цене,
// так что количество монет само следует за ценой. Без цены — запасной порог в монетах (HOLDER_MIN, Whale ×10).
export async function tierTokens() {
  const p = await tokenPriceUsd();
  const coins = { holder: holderMin(), whale: holderMin() * 10 };
  if (!p) return { ...coins, pro: null as number | null, priceUsd: null as number | null };
  return {
    holder: Math.ceil(TIER_USD.holder / p),
    whale: Math.ceil(TIER_USD.whale / p),
    pro: Math.ceil(TIER_USD.pro / p),
    priceUsd: p,
  };
}

// ---------- Pro: оплачен сжиганием ----------
interface Sub { until: number; sigs: string[] }
const SUBS = "subs";
const subs = (): Record<string, Sub> => {
  try {
    return JSON.parse(getMeta(SUBS) ?? "{}");
  } catch {
    return {};
  }
};
export const proUntil = (wallet: string) => subs()[wallet]?.until ?? null;
export const usedBurnSig = (sig: string) => Object.values(subs()).some((s) => s.sigs.includes(sig));
// Продлевает Pro от конца текущей подписки (или от сейчас). Подпись сжигания проверяет вызывающий.
export function grantPro(wallet: string, days: number, sig: string) {
  const all = subs();
  const cur = all[wallet];
  const from = Math.max(Date.now(), cur?.until ?? 0);
  all[wallet] = { until: from + days * 86_400_000, sigs: [...(cur?.sigs ?? []), sig].slice(-50) };
  setMeta(SUBS, JSON.stringify(all));
  return all[wallet].until;
}

// ---------- итоговый тариф кошелька ----------
export interface TierInfo { tier: Tier; balance: number | null; proUntil: number | null; need: Awaited<ReturnType<typeof tierTokens>> }
export async function tierOf(wallet: string | null | undefined): Promise<TierInfo> {
  const need = await tierTokens();
  if (!wallet) return { tier: "free", balance: null, proUntil: null, need };
  const balance = await tokenBalance(wallet);
  const until = proUntil(wallet);
  const pro = !!until && until > Date.now();
  const bal = balance ?? 0;
  const tier: Tier = bal >= need.whale ? "whale" : pro ? "pro" : bal >= need.holder ? "holder" : "free";
  return { tier, balance, proUntil: pro ? until : null, need };
}
export const tierAtLeast = (t: Tier, min: Tier) => TIER_ORDER.indexOf(t) >= TIER_ORDER.indexOf(min);
