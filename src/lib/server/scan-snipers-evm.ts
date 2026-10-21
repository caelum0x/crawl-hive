// Снайперы в EVM-сетях (Robinhood Chain, BNB Chain, Base): кто купил токен в первые секунды после создания и сколько держит сейчас.
// Выпуск ищем назад от времени пары (DexScreener): у лаунчпадов с кривой пара появляется при переезде в пул, на Robinhood
// кривая Pons живёт и по нескольку дней, поэтому там ищем до двух недель (узел отдаёт 10 млн блоков за запрос), в BNB и Base до 6 часов.
// Покупки — переводы токена от кривой лаунчпада или пула за 5 секунд с первой продажи; создатель (отправитель
// транзакции выпуска) не считается. Покупка через роутер (кривая -> роутер -> кошелёк в одной транзакции) засчитывается
// конечному кошельку. Остатки — balanceOf. Узел Robinhood отдаёт логи за любое время. Для BNB и Base по умолчанию
// publicnode: логи он отдаёт только примерно за последние 8 800 блоков (BNB около часа, Base около пяти часов), поэтому
// без своего RPC (BSC_LOGS_RPC_URL, BASE_LOGS_RPC_URL) снайперы там считаются только у самых свежих токенов.
import "server-only";
import { createPublicClient, http, parseAbi, parseAbiItem, type Hex } from "viem";
import type { SniperReport } from "./scan-snipers";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const ZERO = "0x0000000000000000000000000000000000000000";
// Адреса сжигания: пыль на них при выпуске не продажа и не должна сдвигать начало окна.
const BURN = new Set([ZERO, "0x000000000000000000000000000000000000dead", "0xdead000000000000000042069420694206942069"]);
// Uniswap v4 держит все пулы в одном контракте PoolManager: у таких пар вместо адреса id пула, покупки идут от него.
const V4_POOL_MANAGER: Record<string, string> = {
  base: "0x498581ff718922c3f8e6a244956af099b2652b2b",
  bsc: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
  robinhood: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
};
// Сколько блоков узел отдаёт за один запрос логов выпуска и как далеко назад от пары его ищем. Запрос с фильтром по
// нулевому отправителю узел Robinhood отдаёт сразу на 10 млн блоков (около 11 дней), publicnode — на 5 тыс.
const MINT_CHUNK: Record<string, bigint> = { robinhood: 9_999_999n };
const MINT_BACK_SEC: Record<string, number> = { robinhood: 14 * 86_400 };
const MINT_BACK_DEFAULT = 6 * 3600;
const HOPS = 4; // сколько пересылок внутри транзакции проходим от кривой до кошелька
const WINDOW_SEC = 5;
const MAX_WALLETS = 20;
const CACHE_MS = 30 * 60_000;

const RPC: Record<string, () => string | undefined> = {
  robinhood: () => process.env.ROBINHOOD_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com",
  bsc: () => process.env.BSC_LOGS_RPC_URL?.trim() || "https://bsc-rpc.publicnode.com",
  base: () => process.env.BASE_LOGS_RPC_URL?.trim() || "https://base-rpc.publicnode.com",
};
export const evmSnipersSupported = (chain: string) => !!RPC[chain]?.();
// Узел с логами для сети (тот же, что у снайперов): им пользуется и бабл-карта EVM.
export const evmLogsRpc = (chain: string) => RPC[chain]?.();
export const evmOwnLogs = (chain: string) => !OWN_LOGS[chain] || !!process.env[OWN_LOGS[chain]]?.trim();
// До какого возраста токена хватает глубины логов узла: свой RPC — трое суток, publicnode — с запасом от предела.
const OWN_LOGS: Record<string, string> = { bsc: "BSC_LOGS_RPC_URL", base: "BASE_LOGS_RPC_URL" };
const PUBLIC_MAX_AGE_H: Record<string, number> = { bsc: 0.9, base: 4.5 };
export const evmSnipersMaxAgeH = (chain: string) =>
  OWN_LOGS[chain] && !process.env[OWN_LOGS[chain]]?.trim() ? (PUBLIC_MAX_AGE_H[chain] ?? 72) : 72;

const g = globalThis as unknown as { __crawlhiveEvmSnipers?: Map<string, { at: number; r: SniperReport | null }> };
const cache = () => (g.__crawlhiveEvmSnipers ??= new Map());

export async function traceEvmSnipers(chain: string, token: string, pairCreatedAt?: number, pairAddress?: string): Promise<SniperReport | null> {
  const url = RPC[chain]?.();
  if (!url || !pairCreatedAt) return null;
  const key = `${chain}:${token.toLowerCase()}`;
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.r;
  const p = pairAddress?.toLowerCase();
  const r = await read(url, token as Hex, pairCreatedAt, p && !/^0x[0-9a-f]{40}$/.test(p) ? V4_POOL_MANAGER[chain] : p, MINT_CHUNK[chain] ?? 5_000n, MINT_BACK_SEC[chain] ?? MINT_BACK_DEFAULT);
  if (r) cache().set(key, { at: Date.now(), r });
  if (cache().size > 3000) cache().clear();
  return r;
}

async function read(url: string, token: Hex, pairCreatedAt: number, pair: string | undefined, mintChunk: bigint, mintBackSec: number): Promise<SniperReport | null> {
  const c = createPublicClient({ transport: http(url, { timeout: 12_000 }) });
  // Публичный узел изредка отвечает ошибкой на частые запросы: один повтор, иначе разовый сбой выглядел как «нет выпуска».
  const getLogs = async (q: { args?: { from: Hex }; fromBlock: bigint; toBlock: bigint }) => {
    for (let i = 0; ; i++) {
      try {
        return await c.getLogs({ address: token, event: TRANSFER, ...q });
      } catch (e) {
        if (i >= 1) throw e;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  };
  const head = await c.getBlock();
  const past = await c.getBlock({ blockNumber: head.number - 10_000n });
  const blockSec = Number(head.timestamp - past.timestamp) / 10_000;
  // Узлы BNB и Base (publicnode) отвергают запрос, если окно заходит дальше последнего блока.
  const upTo = (b: bigint) => (b > head.number ? head.number : b);
  // Время пары у DexScreener — не всегда запуск: у лаунчпадов с кривой (Pons) это переезд в пул, иногда через десятки
  // минут торгов. Поэтому выпуск (первый Transfer с нулевого адреса) ищем назад от пары, до MINT_BACK_SEC.
  const pairBlock = head.number - BigInt(Math.ceil((Number(head.timestamp) - pairCreatedAt / 1000) / blockSec));
  const stop = pairBlock - BigInt(Math.ceil(mintBackSec / blockSec));
  let mint: { block: bigint; to: Hex; tx: Hex } | null = null;
  // Время блока считаем по последним 10 тыс. блокам, а оно плавает: запас вперёд от пары 10 минут, а не 2.
  for (let b = upTo(pairBlock + BigInt(Math.ceil(600 / blockSec))); b > stop && !mint; b -= mintChunk) {
    const logs = await getLogs({ args: { from: ZERO }, fromBlock: b >= mintChunk ? b - mintChunk + 1n : 0n, toBlock: b }).catch(() => null);
    if (!logs) break; // узел не отдаёт логи так глубоко
    const first = logs[0];
    if (first) mint = { block: first.blockNumber, to: first.args.to as Hex, tx: first.transactionHash };
  }
  if (!mint) return null;
  const creator = (await c.getTransaction({ hash: mint.tx })).from.toLowerCase();
  const window = BigInt(Math.ceil(WINDOW_SEC / blockSec));
  const span = BigInt(Math.ceil(900 / blockSec));
  // Откуда идут покупки. Выпуск на контракт (кривая лаунчпада) — продаёт он, а после переезда и пул. Выпуск на кошелёк
  // дева — дев раздаёт и заливает ликвидность сам, покупки идут из пула: тогда считаем только пул.
  const mintTo = mint.to.toLowerCase();
  const curve = ((await c.getCode({ address: mint.to }).catch(() => undefined)) ?? "0x") !== "0x";
  const sources = new Set<string>([...(curve ? [mintTo] : []), ...(pair ? [pair] : [])]);
  if (!sources.size) sources.add(mintTo);
  const skip = (t: string) => !t || t === creator || BURN.has(t) || sources.has(t);
  // Отсчёт окна — с первой продажи постороннему адресу (не сжигание), а не с выпуска.
  const early = await getLogs({ fromBlock: mint.block, toBlock: upTo(mint.block + span) }).catch(() => []);
  const firstSale = early.find((l) => sources.has((l.args.from ?? "").toLowerCase()) && !skip((l.args.to ?? "").toLowerCase()));
  if (!firstSale) return null;
  const start = firstSale.blockNumber;
  // Конец окна — по времени блоков, а не по среднему: блок с меткой не позже start + WINDOW_SEC (двоичный поиск, ~8 запросов).
  // Средняя скорость по свежим блокам отличается от той, что была на запуске, и окно в блоках теряло покупки на 5-й секунде.
  const t0 = (await c.getBlock({ blockNumber: start })).timestamp + BigInt(WINDOW_SEC);
  let lo = start;
  let hi = upTo(start + window * 3n);
  while (hi > lo) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await c.getBlock({ blockNumber: mid })).timestamp <= t0) lo = mid;
    else hi = mid - 1n;
  }
  const logs = await getLogs({ fromBlock: start, toBlock: lo });
  // Переводы по транзакциям: покупка через роутер или агрегатор приходит сначала на него, потом он пересылает кошельку.
  type Tr = { from: string; to: string; value: bigint; idx: number; used?: boolean };
  const byTx = new Map<string, Tr[]>();
  for (const l of logs) {
    const list = byTx.get(l.transactionHash) ?? [];
    list.push({ from: (l.args.from ?? "").toLowerCase(), to: (l.args.to ?? "").toLowerCase(), value: l.args.value ?? 0n, idx: l.logIndex });
    byTx.set(l.transactionHash, list);
  }
  const bought = new Map<string, bigint>();
  // Идём по пересылкам после этого перевода в той же транзакции; что адрес не переслал дальше, остаётся ему.
  const credit = (list: Tr[], who: string, amount: bigint, after: number, depth: number) => {
    if (skip(who)) return; // вернулось в кривую или пул (арбитраж), ушло создателю или в сжигание
    for (const o of depth < HOPS ? list : []) {
      if (amount <= 0n) break;
      if (o.used || o.from !== who || o.idx <= after) continue;
      o.used = true;
      const take = o.value < amount ? o.value : amount;
      credit(list, o.to, take, o.idx, depth + 1);
      amount -= take;
    }
    if (amount > 0n) bought.set(who, (bought.get(who) ?? 0n) + amount);
  };
  for (const list of byTx.values()) {
    list.sort((a, b) => a.idx - b.idx);
    for (const t of list) if (!t.used && sources.has(t.from)) (t.used = true), credit(list, t.to, t.value, t.idx, 0);
  }
  const supply = await c.readContract({ address: token, abi: ERC20, functionName: "totalSupply" });
  if (!supply) return null;
  // Кошельки-контракты (роутеры, агрегаторы, комиссия лаунчпада) не снайперы: отсекаем адреса с кодом до среза по MAX_WALLETS,
  // иначе крупные контракты вытесняли настоящие кошельки из двадцатки.
  const all = [...bought.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, MAX_WALLETS * 3);
  const codes = await Promise.all(all.map(([w]) => c.getCode({ address: w as Hex }).catch(() => undefined)));
  // Кошелёк с делегированием EIP-7702 (код 0xef0100 + адрес) остаётся кошельком: так торгуют многие боты и смарт-аккаунты.
  const eoa = all.filter((_, i) => !codes[i] || codes[i] === "0x" || codes[i]!.startsWith("0xef0100")).slice(0, MAX_WALLETS);
  const left = await Promise.all(eoa.map(([w]) => c.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [w as Hex] }).catch(() => 0n)));
  const pct = (x: bigint) => Number((x * 1_000_000n) / supply) / 10_000; // доля в процентах, два знака
  return {
    wallets: eoa.length,
    boughtPct: pct(eoa.reduce((s, [, v]) => s + v, 0n)),
    holdPct: pct(left.reduce((s, x) => s + x, 0n)),
    sold: left.filter((x) => x === 0n).length,
    slots: WINDOW_SEC,
    buyers: eoa.map(([wallet], i) => ({ wallet, leftPct: pct(left[i]) })),
  };
}
