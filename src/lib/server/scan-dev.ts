// История разработчика (crawler_dev): кто создал токен и чем кончились его прошлые запуски. Работает для
// токенов pump.fun: аккаунт кривой (bonding curve, PDA от минта) хранит адрес создателя, а одним запросом
// getProgramAccounts по этому адресу находятся все кривые, которые он создал, с флагом «дошёл до пула».
// Плюс возраст кошелька создателя и сколько этого токена у него осталось.
// Для остальных лаунчпадов (Meteora DBC, Raydium LaunchLab, Moonshot…) создатель — тот, кто оплатил самую первую
// транзакцию с минтом: истории его запусков у нас нет, но возраст кошелька и доля считаются так же.
import "server-only";
import { PublicKey, type Connection } from "@solana/web3.js";

const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
// Раскладка кривой: 8 байт дискриминатора, 5×u64 резервов, bool complete (48), creator (49..81).
const COMPLETE_AT = 48;
const CREATOR_AT = 49;
// Публичный RPC отвечает на getProgramAccounts по pump.fun за доли секунды; платный тариф может его не пускать.
export const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const CACHE_MS = 30 * 60_000;

export interface DevReport {
  creator: string;
  platform: "pump.fun" | "other"; // other — создатель найден по первой транзакции, историю запусков не знаем
  launched: number; // токенов через pump.fun, включая этот
  graduated: number; // сколько ПРОШЛЫХ запусков (без этого токена) дошли до пула
  walletAgeHours?: number; // возраст кошелька создателя, если у него меньше 1000 транзакций
  walletTxs: number; // транзакций (до 1000)
  holdsPct?: number; // сколько этого токена у создателя сейчас, % эмиссии
  factory?: string; // программа лаунчпада (pump.fun), если токен выпущен через неё
  tx?: string; // транзакция выпуска, если нашли (первая транзакция с минтом)
  launchedAt?: number; // время выпуска, мс
}

const g = globalThis as unknown as { __crawlhiveDev?: Map<string, { at: number; report: DevReport }> };
const cache = () => (g.__crawlhiveDev ??= new Map());

async function rpc<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await r.json()) as { result?: T; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? method);
  return j.result as T;
}

// Создатель токена pump.fun или null, если у минта нет кривой (токен запущен не через pump.fun).
async function creatorOf(conn: Connection, mint: PublicKey): Promise<{ creator: string; complete: boolean } | null> {
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP);
  const acc = await conn.getAccountInfo(curve);
  if (!acc || !acc.owner.equals(PUMP) || acc.data.length < CREATOR_AT + 32) return null;
  return { creator: new PublicKey(acc.data.subarray(CREATOR_AT, CREATOR_AT + 32)).toBase58(), complete: acc.data[COMPLETE_AT] === 1 };
}

// Все кривые создателя: сколько запусков и сколько дошли до пула. Берём только байт complete.
export async function launchesOf(endpoint: string, creator: string) {
  const list = await rpc<{ account: { data: [string, string] } }[]>(endpoint, "getProgramAccounts", [
    PUMP.toBase58(),
    { encoding: "base64", dataSlice: { offset: COMPLETE_AT, length: 1 }, filters: [{ memcmp: { offset: CREATOR_AT, bytes: creator } }] },
  ]);
  const graduated = list.filter((a) => Buffer.from(a.account.data[0], "base64")[0] === 1).length;
  return { launched: list.length, graduated };
}

// Самая первая транзакция с минтом: идём по подписям назад страницами по 1000. У свежего токена боты за минуты
// набивают тысячи сделок, поэтому до 25 страниц, но не дольше 9 секунд — у старых токенов просто не ищем.
async function firstPayer(conn: Connection, mint: PublicKey): Promise<{ payer: string; sig: string; at?: number } | null> {
  let before: string | undefined;
  let oldest: string | undefined;
  let oldestAt: number | undefined;
  const deadline = Date.now() + 9_000;
  for (let page = 0; ; page++) {
    if (page >= 25 || Date.now() > deadline) return null;
    const sigs = await conn.getSignaturesForAddress(mint, { limit: 1000, before });
    if (!sigs.length) break;
    oldest = sigs[sigs.length - 1].signature;
    oldestAt = sigs[sigs.length - 1].blockTime ?? undefined;
    if (sigs.length < 1000) break;
    before = oldest;
  }
  if (!oldest) return null;
  // Сырой getTransaction: web3.js не разбирает транзакции версии 1.
  const tx = await rpc<{ transaction?: { message?: { accountKeys?: (string | { pubkey: string })[] } } } | null>(conn.rpcEndpoint, "getTransaction", [
    oldest,
    { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
  ]);
  const k = tx?.transaction?.message?.accountKeys?.[0];
  const payer = typeof k === "string" ? k : k?.pubkey;
  return payer ? { payer, sig: oldest, at: oldestAt ? oldestAt * 1000 : undefined } : null;
}

export async function traceDev(conn: Connection, mint: string, supplyRaw?: number): Promise<DevReport | null> {
  const hit = cache().get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.report;
  const key = new PublicKey(mint);
  const curve = await creatorOf(conn, key);
  const first = curve ? null : await firstPayer(conn, key).catch(() => null);
  const creator = curve?.creator ?? first?.payer;
  if (!creator) return null;
  const owner = new PublicKey(creator);

  const [launches, sigs, held] = await Promise.all([
    curve ? launchesOf(conn.rpcEndpoint, creator).catch(() => launchesOf(PUBLIC_RPC, creator)) : Promise.resolve({ launched: 1, graduated: 0 }),
    conn.getSignaturesForAddress(owner, { limit: 1000 }).catch(() => []),
    conn.getTokenAccountsByOwner(owner, { mint: key }).catch(() => null),
  ]);

  let holdsPct: number | undefined;
  if (held && supplyRaw) {
    let raw = 0;
    for (const a of held.value) raw += Number(a.account.data.readBigUInt64LE(64)); // amount в токен-аккаунте
    holdsPct = (raw / supplyRaw) * 100;
  }
  const oldest = sigs.length && sigs.length < 1000 ? sigs[sigs.length - 1].blockTime : undefined;
  const report: DevReport = {
    creator,
    platform: curve ? "pump.fun" : "other",
    launched: Math.max(1, launches.launched),
    graduated: Math.max(0, launches.graduated - (curve?.complete ? 1 : 0)),
    walletTxs: sigs.length,
    walletAgeHours: oldest ? (Date.now() / 1000 - oldest) / 3600 : undefined,
    holdsPct,
    ...(curve ? { factory: PUMP.toBase58() } : {}),
    ...(first ? { tx: first.sig, launchedAt: first.at } : {}),
  };
  cache().set(mint, { at: Date.now(), report });
  return report;
}
