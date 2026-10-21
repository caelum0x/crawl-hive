// Токен проекта на главной и байбек казны. Ключа казны на сервере нет и не будет: сервер собирает транзакцию
// (свап SOL → токен через Jupiter плюс сжигание купленного), подписывает и отправляет Phantom владельца,
// сервер находит транзакцию в сети, проверяет и записывает в публичную статистику.
// Оплату спавна (PAYMENT_TOKEN в solana.ts) это не трогает: здесь только TOKEN_MINT и TOKEN_SYMBOL.
import "server-only";
import { LAMPORTS_PER_SOL, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BUYBACK_TREASURY } from "../economy";
import { ApiError, getMeta, paymentTotals, setMeta } from "./store";
import { publicConfig, rpcConnection } from "./solana";
import { dexReserveSol } from "./dexfund";
import { BuybackError, USDC_MINT, buildBurnAllTx, buildBuybackTx, parseBuybackTx, readMint, type MintInfo } from "./buyback-tx";
import { x402Stats } from "./x402";
import { dexFundOff, dexFundStats } from "./dexfund";

// Сколько SOL оставляем в казне на комиссии и аренду аккаунтов, кнопка Max считает от остатка.
export const BUYBACK_RESERVE_SOL = 0.05;
// Плановое сжигание раз в 12 часов (BUYBACK_PLAN_SOL, по умолчанию 0.2 SOL). Подписывает всё равно владелец в Phantom:
// ключа казны на сервере нет, сумма просто подставляется в панель и в напоминание.
export const buybackPlanSol = () => Math.max(0, Number(process.env.BUYBACK_PLAN_SOL ?? 0.2));
const MAX_RECORDS = 500;
const MARKET_TTL_MS = 45_000;
const MINT_TTL_MS = 5 * 60_000;
const BAL_TTL_MS = 90_000;
const USDC_TTL_MS = 10 * 60_000; // USDC приходит редко (оплаты x402), после байбека кэш сбрасывается

export function tokenConfig() {
  const mint = process.env.TOKEN_MINT?.trim() || null;
  return {
    mint,
    symbol: process.env.TOKEN_SYMBOL?.trim() || "CRAWLHIVE",
    treasury: BUYBACK_TREASURY,
    cluster: publicConfig().cluster,
  };
}

// Ошибки модуля сборки транзакций приходят как BuybackError: переводим в ApiError, чтобы handle() отдал их как есть.
async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BuybackError) throw new ApiError(e.message, e.status);
    throw e;
  }
}

// ---------- кэш на globalThis (переживает горячую перезагрузку, как store) ----------

interface Market {
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number | null;
  change24h: number | null;
  volume24h: number | null;
  pairAddress: string | null;
  dexId: string | null;
  url: string | null;
  onCurve: boolean; // ещё на кривой pump.fun, пула на DEX нет
}

interface TokenCache {
  market?: { at: number; mint: string; v: Market | null };
  mint?: { at: number; mint: string; v: MintInfo };
  bal?: { at: number; sol: number };
  usdc?: { at: number; v: number };
  fees?: { at: number; mint: string; v: { sol: number; creator: string } | null };
  rate: Map<string, number>;
}
const g = globalThis as unknown as { __crawlhiveToken?: TokenCache };
const cache = (): TokenCache => (g.__crawlhiveToken ??= { rate: new Map() });

async function mintInfo(force = false): Promise<MintInfo | null> {
  const { mint } = tokenConfig();
  if (!mint) return null;
  const c = cache();
  if (!force && c.mint && c.mint.mint === mint && Date.now() - c.mint.at < MINT_TTL_MS) return c.mint.v;
  const v = await wrap(() => readMint(rpcConnection(), new PublicKey(mint)));
  c.mint = { at: Date.now(), mint, v };
  return v;
}

export async function treasurySol(force = false): Promise<number | null> {
  const c = cache();
  if (!force && c.bal && Date.now() - c.bal.at < BAL_TTL_MS) return c.bal.sol;
  try {
    const sol = (await rpcConnection().getBalance(new PublicKey(BUYBACK_TREASURY))) / LAMPORTS_PER_SOL;
    c.bal = { at: Date.now(), sol };
    return sol;
  } catch {
    return c.bal?.sol ?? null;
  }
}

// USDC на казне: сюда приходят оплаты x402 от ИИ-агентов.
export async function treasuryUsdc(force = false): Promise<number | null> {
  const c = cache();
  if (!force && c.usdc && Date.now() - c.usdc.at < USDC_TTL_MS) return c.usdc.v;
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(BUYBACK_TREASURY), false, TOKEN_PROGRAM_ID);
    const b = await rpcConnection().getTokenAccountBalance(ata).catch(() => null);
    const v = Number(b?.value.amount ?? 0) / 1e6;
    c.usdc = { at: Date.now(), v };
    return v;
  } catch {
    return c.usdc?.v ?? null;
  }
}

interface DexPair {
  pairAddress: string;
  dexId: string;
  url: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  fdv?: number;
  marketCap?: number;
}

// Цена, капитализация и пул с DexScreener. Пул с наибольшей ликвидностью; на кривой pump.fun пара одна (dexId pumpfun).
async function market(): Promise<Market | null> {
  const { mint } = tokenConfig();
  if (!mint) return null;
  const c = cache();
  if (c.market && c.market.mint === mint && Date.now() - c.market.at < MARKET_TTL_MS) return c.market.v;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { pairs?: DexPair[] | null };
    const pairs = (j.pairs ?? []).filter((p) => p.pairAddress);
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const v: Market | null = best
      ? {
          priceUsd: best.priceUsd ? Number(best.priceUsd) : null,
          marketCap: best.marketCap ?? null,
          fdv: best.fdv ?? null,
          liquidityUsd: best.liquidity?.usd ?? null,
          change24h: best.priceChange?.h24 ?? null,
          volume24h: best.volume?.h24 ?? null,
          pairAddress: best.pairAddress,
          dexId: best.dexId,
          url: best.url,
          onCurve: best.dexId === "pumpfun",
        }
      : null;
    c.market = { at: Date.now(), mint, v };
    return v;
  } catch {
    return c.market?.mint === mint ? c.market.v : null;
  }
}

// ---------- записи байбеков ----------

export interface BuybackRecord {
  sig: string;
  kind: "buyback" | "burn"; // burn — сжигание остатка без свапа
  sol: number;
  usdc?: number; // байбек на выручку x402: сколько USDC ушло в свап
  burned: number; // в целых токенах
  bought: number;
  at: number;
}

interface Ledger {
  sol: number;
  usdc?: number;
  burnedRaw: string;
  count: number;
  items: BuybackRecord[]; // новые в начале
}

function ledger(): Ledger {
  try {
    const raw = getMeta("buybacks");
    if (raw) return JSON.parse(raw) as Ledger;
  } catch {}
  return { sol: 0, burnedRaw: "0", count: 0, items: [] };
}

// Ближайшее плановое окно байбека: каждые 12 часов, в 00:00 и 12:00 UTC.
export function nextBuybackAt(now = Date.now()): number {
  const half = 12 * 3600_000;
  return Math.floor(now / half) * half + half;
}

export async function buybackStats() {
  const cfg = tokenConfig();
  const l = ledger();
  const m = cfg.mint ? await mintInfo().catch(() => null) : null;
  const burnedRaw = BigInt(l.burnedRaw);
  const scale = m ? 10 ** m.decimals : 1;
  // Доля сожжённого считается от эмиссии до наших сжиганий: текущая эмиссия плюс всё, что сожгли мы.
  const burnedPct = m && burnedRaw > BigInt(0) ? (Number(burnedRaw) / Number(m.supplyRaw + burnedRaw)) * 100 : 0;
  return {
    configured: !!cfg.mint,
    symbol: cfg.symbol,
    treasury: cfg.treasury,
    treasurySol: await treasurySol(),
    reserveSol: BUYBACK_RESERVE_SOL,
    dexReserveSol: await dexReserveSol(),
    count: l.count,
    solSpent: l.sol,
    usdcSpent: l.usdc ?? 0,
    treasuryUsdc: await treasuryUsdc(),
    revenue: await revenue(l),
    burned: m ? Number(burnedRaw) / scale : 0,
    burnedPct,
    // Сжигания пользователей за Pro и вызовы Brain (user-burns.ts) — отдельно, чтобы не смешивать с байбеками.
    userBurned: (await import("./user-burns")).userBurnStats().total,
    supply: m ? Number(m.supplyRaw) / scale : null,
    last: l.items.find((x) => x.kind === "buyback") ?? null,
    items: l.items,
    nextAt: nextBuybackAt(),
    planSol: buybackPlanSol(),
    paused: buybackPaused(),
  };
}

// Пауза байбеков (BUYBACK_PAUSED=dex): казна копит на профиль DexScreener, отсчёт и напоминания выключены.
export function buybackPaused(): string | null {
  return process.env.BUYBACK_PAUSED?.trim() || null;
}

// Откуда деньги казны, по источникам: спавны и продления (SOL), вызовы агентов по x402 (USDC), сбор на DEX (SOL).
// Каждый источник приходит своей транзакцией со своим memo, поэтому в сети они не смешиваются.
async function revenue(l: Ledger) {
  const p = paymentTotals();
  const x = x402Stats();
  const dex = dexFundOff() ? null : await dexFundStats().catch(() => null);
  return {
    spawns: { sol: p.sol, payments: p.payments },
    x402: {
      usdc: x.usdcTotal,
      calls: x.callsTotal,
      usdc24h: x.usdc24h,
      calls24h: x.calls24h,
      burnedFromUsdc: l.usdc ?? 0,
      recent: x.recent.filter((c) => c.tx).slice(0, 8).map((c) => ({ tx: c.tx, usd: c.usd, at: c.at, route: c.route })),
    },
    dexFund: dex ? { sol: dex.raisedSol, backers: dex.backers } : null,
  };
}

export async function tokenInfo() {
  const cfg = tokenConfig();
  const [mk, m] = await Promise.all([market(), cfg.mint ? mintInfo().catch(() => null) : Promise.resolve(null)]);
  return {
    configured: !!cfg.mint,
    symbol: cfg.symbol,
    mint: cfg.mint,
    treasury: cfg.treasury,
    decimals: m?.decimals ?? null,
    supply: m ? Number(m.supplyRaw) / 10 ** m.decimals : null,
    token2022: m ? !m.program.equals(TOKEN_PROGRAM_ID) : null,
    pump: !!cfg.mint && cfg.mint.endsWith("pump"),
    market: mk,
  };
}

// ---------- владелец: собрать → подписать в Phantom → подтвердить ----------

// Только подписанная сессия кошелька казны. Ключа казны у сервера нет, так что посторонний и с доступом к API
// максимум получит неподписанную транзакцию, которую некому подписать.
export function assertTreasury(wallet: string) {
  if (wallet !== BUYBACK_TREASURY) throw new ApiError("Only the treasury wallet can do this", 403);
}

function rateLimit(key: string, ms: number) {
  const c = cache();
  const now = Date.now();
  if (now - (c.rate.get(key) ?? 0) < ms) throw new ApiError("Too many requests, wait a moment", 429);
  c.rate.set(key, now);
}

function requireMainnet() {
  const cfg = tokenConfig();
  if (!cfg.mint) throw new ApiError(`$${cfg.symbol} is not launched yet: TOKEN_MINT is not set`, 400);
  if (cfg.cluster !== "mainnet-beta") throw new ApiError("Buybacks work on mainnet only (SOLANA_CLUSTER=mainnet-beta)", 400);
  return cfg.mint;
}

export async function buildBuyback(wallet: string, amountSol: unknown, slippageBps: unknown, source: unknown = "sol") {
  assertTreasury(wallet);
  const mint = requireMainnet();
  const amount = Number(amountSol);
  if (!Number.isFinite(amount) || amount <= 0) throw new ApiError("Enter an amount of SOL above zero");
  if (amount < 0.001) throw new ApiError("Minimum buyback is 0.001 SOL");
  const slip = Math.round(Number(slippageBps ?? 300));
  if (!Number.isFinite(slip) || slip < 10 || slip > 2000) throw new ApiError("Slippage must be between 0.1% and 20%");
  // Лимит после проверки ввода: опечатка в сумме не должна блокировать следующую попытку.
  rateLimit(`build:${wallet}`, 3000);
  if (source === "usdc") {
    // Байбек на выручку x402: тратим USDC казны, SOL не трогаем.
    if (amount < 0.01) throw new ApiError("Minimum USDC buyback is 0.01 USDC");
    const usdc = await treasuryUsdc(true);
    if (usdc === null) throw new ApiError("Cannot read the treasury USDC balance, try again", 502);
    if (amount > usdc + 1e-9) throw new ApiError(`Too much: the treasury holds ${usdc.toFixed(2)} USDC from x402 calls`);
    const mu = (await mintInfo(true))!;
    const units = BigInt(Math.floor(amount * 1e6));
    return wrap(() => buildBuybackTx(rpcConnection(), { owner: new PublicKey(wallet), mint: new PublicKey(mint), lamports: units, slippageBps: slip, mintInfo: mu, usdc: true }));
  }
  const bal = await treasurySol(true);
  if (bal === null) throw new ApiError("Cannot read the treasury balance, try again", 502);
  // SOL сбора на DEX не выкупаем, пока профиль не оплачен (dexfund.ts).
  const dex = await dexReserveSol();
  const max = bal - BUYBACK_RESERVE_SOL - dex;
  if (amount > max + 1e-9)
    throw new ApiError(`Too much: the treasury has ${bal.toFixed(4)} SOL, keeps ${BUYBACK_RESERVE_SOL} SOL for fees${dex ? ` and ${dex.toFixed(4)} SOL raised for the DEX profile` : ""}, so at most ${Math.max(0, max).toFixed(4)} SOL`);
  const m = (await mintInfo(true))!;
  const lamports = BigInt(Math.round(amount * LAMPORTS_PER_SOL));
  return wrap(() => buildBuybackTx(rpcConnection(), { owner: new PublicKey(wallet), mint: new PublicKey(mint), lamports, slippageBps: slip, mintInfo: m }));
}

export async function buildBurnLeftover(wallet: string) {
  assertTreasury(wallet);
  const mint = requireMainnet();
  rateLimit(`build:${wallet}`, 3000);
  const m = (await mintInfo(true))!;
  return wrap(() => buildBurnAllTx(rpcConnection(), { owner: new PublicKey(wallet), mint: new PublicKey(mint), mintInfo: m }));
}

// Остаток токена в ATA казны: пыль сверх сожжённого минимума, для кнопки «Burn leftover».
export async function treasuryLeftover(): Promise<number> {
  const { mint } = tokenConfig();
  const m = await mintInfo().catch(() => null);
  if (!mint || !m) return 0;
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(BUYBACK_TREASURY), false, m.program);
  const bal = await rpcConnection().getTokenAccountBalance(ata).catch(() => null);
  return Number(bal?.value.amount ?? 0) / 10 ** m.decimals;
}

export async function confirmBuyback(wallet: string, signature: unknown) {
  assertTreasury(wallet);
  const mint = requireMainnet();
  rateLimit(`confirm:${wallet}`, 1500);
  const sig = String(signature ?? "");
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw new ApiError("Bad signature");
  const known = ledger().items.find((x) => x.sig === sig);
  if (known) return { record: known, duplicate: true, stats: await buybackStats() };

  // Транзакция появляется в RPC с задержкой: ждём до ~30 секунд.
  const conn = rpcConnection();
  let tx: ParsedTransactionWithMeta | null = null;
  for (let i = 0; i < 20 && !tx; i++) {
    tx = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!tx) throw new ApiError("Transaction not found yet. If Phantom shows it as sent, press Confirm again in a minute.", 404);
  const p = await wrap(async () => parseBuybackTx(tx!, BUYBACK_TREASURY, mint));
  const m = (await mintInfo(true))!;
  const scale = 10 ** m.decimals;
  const rec: BuybackRecord = {
    sig,
    kind: p.kind,
    sol: Math.round(p.solSpent * 1e9) / 1e9,
    ...(p.usdcSpent ? { usdc: Math.round(p.usdcSpent * 1e6) / 1e6 } : {}),
    burned: Number(p.burnedRaw) / scale,
    bought: Number(p.boughtRaw) / scale,
    at: p.at,
  };
  // Перечитываем журнал после сетевых запросов: параллельный confirm той же подписи не должен посчитать её дважды.
  const l = ledger();
  if (l.items.some((x) => x.sig === sig)) return { record: rec, duplicate: true, stats: await buybackStats() };
  l.sol = Math.round((l.sol + rec.sol) * 1e9) / 1e9;
  if (rec.usdc) l.usdc = Math.round(((l.usdc ?? 0) + rec.usdc) * 1e6) / 1e6;
  l.burnedRaw = (BigInt(l.burnedRaw) + p.burnedRaw).toString();
  l.count += rec.kind === "buyback" ? 1 : 0;
  // Список ограничен, итоги — нет: они копятся отдельно и не теряются при обрезке.
  l.items = [rec, ...l.items].sort((a, b) => b.at - a.at).slice(0, MAX_RECORDS);
  setMeta("buybacks", JSON.stringify(l));
  cache().bal = undefined;
  cache().usdc = undefined;
  const stats = await buybackStats();
  // Каждое подтверждённое сжигание — сразу в Telegram: тема 🔥 Burns в группе и все, кто подписался через /burns.
  import("./telegram-public").then((t) => t.pushBurn(rec, stats)).catch(() => {});
  return { record: rec, duplicate: false, stats };
}

// Итоги для админки.
export function buybackTotals() {
  const l = ledger();
  return { count: l.count, sol: l.sol, burnedRaw: l.burnedRaw, last: l.items[0]?.at ?? null };
}

// ---------- подсказка о комиссиях создателя на pump.fun ----------
// Комиссии создателя копятся в хранилище создателя: на кривой — PDA ["creator-vault", creator] программы pump
// (лампорты сверх аренды), после выхода на PumpSwap — WSOL-аккаунт PDA ["creator_vault", creator] программы AMM.
// Хранилище общее на все монеты этого создателя, поэтому это подсказка, а не точная сумма по токену.
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RENT_EMPTY = 890_880;

export async function creatorFeesHint(): Promise<{ sol: number; creator: string } | null> {
  const { mint } = tokenConfig();
  if (!mint || !mint.endsWith("pump")) return null;
  const c = cache();
  if (c.fees && c.fees.mint === mint && Date.now() - c.fees.at < 60_000) return c.fees.v;
  let v: { sol: number; creator: string } | null = null;
  try {
    const conn = rpcConnection();
    const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP_PROGRAM);
    const info = await conn.getAccountInfo(curve);
    if (info && info.data.length >= 81) {
      const creator = new PublicKey(info.data.subarray(49, 81));
      const [curveVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM);
      const [ammVaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), creator.toBuffer()], PUMP_AMM_PROGRAM);
      const ammVault = getAssociatedTokenAddressSync(NATIVE_MINT, ammVaultAuth, true, TOKEN_PROGRAM_ID);
      const [a, b] = await Promise.all([conn.getAccountInfo(curveVault), conn.getTokenAccountBalance(ammVault).catch(() => null)]);
      const lamports = Math.max(0, (a?.lamports ?? 0) - RENT_EMPTY) + Number(b?.value.amount ?? 0);
      v = { sol: lamports / LAMPORTS_PER_SOL, creator: creator.toBase58() };
    }
  } catch {
    v = c.fees?.mint === mint ? c.fees.v : null;
  }
  c.fees = { at: Date.now(), mint, v };
  return v;
}
