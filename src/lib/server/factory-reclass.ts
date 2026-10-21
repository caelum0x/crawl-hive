// Разовая переразметка старой памяти. Раньше «создателем» EVM-токена записывался адрес из GoPlus, а это часто
// контракт лаунчпада, который выпускает токены за всех (на Robinhood Chain один адрес Pons числился девом 20 монет).
// Здесь: адреса с ролью dev на многих токенах проверяем по коду; контракт становится factory (история сохраняется),
// а для его токенов ищем настоящего создателя: кто подписал выпуск (первый перевод с нулевого адреса) в окне вокруг
// пары на DexScreener (или времени, когда рой видел токен), назад до выпуска. Работает в фоне один раз (флаг в kv), сканы не ждут.
import "server-only";
import { createPublicClient, http, parseAbiItem, type Hex, type PublicClient } from "viem";
import { devToFactory, heavyDevs, kvGet, kvSet, launchOf, memDb, putLaunch } from "./memory-db";
import { evmLogsRpc } from "./scan-snipers-evm";
import { trackEntries } from "./track";

const FLAG = "factory_reclass_v1";
const MIN_TOKENS = 5;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO = "0x0000000000000000000000000000000000000000";
const CHUNK: Record<string, bigint> = { robinhood: 99_999n };
const MAX_CALLS = 150; // Robinhood: 100 тыс. блоков за запрос, ~3 часа; 150 запросов — около 2 недель назад

let running = false;

// Когда рой впервые увидел токен: самая ранняя запись Track Record (у wallet_roles время обновляется каждым сканом).
function firstSeen(token: string): number | null {
  const ts = trackTimes().get(token.toLowerCase());
  return ts ?? null;
}
let times: Map<string, number> | undefined;
function trackTimes() {
  if (times) return times;
  times = new Map();
  for (const e of trackEntries()) {
    const k = e.id.toLowerCase();
    if (!times.has(k) || e.at < times.get(k)!) times.set(k, e.at);
  }
  return times;
}

export function reclassFactories() {
  if (running) return;
  const d = memDb();
  if (!d || kvGet(d, FLAG)) return;
  running = true;
  run()
    .catch((e) => console.warn("[memory] factory reclass:", (e as Error).message))
    .finally(() => {
      running = false;
    });
}

async function run() {
  const d = memDb()!;
  const clients = new Map<string, PublicClient>();
  const client = (chain: string) => {
    if (!clients.has(chain)) {
      const url = evmLogsRpc(chain);
      if (url) clients.set(chain, createPublicClient({ transport: http(url, { timeout: 15_000 }) }) as PublicClient);
    }
    return clients.get(chain);
  };
  let moved = 0;
  let resolved = 0;
  for (const h of heavyDevs(d, MIN_TOKENS)) {
    if (!h.wallet.startsWith("0x")) continue; // на Solana создатель берётся из кривой pump.fun или первой транзакции, это кошелёк
    const c = client(h.chain);
    const code = c ? await c.getCode({ address: h.wallet as Hex }).catch(() => undefined) : undefined;
    if (!code || code === "0x") continue;
    const tokens = (d.db.prepare("SELECT token, chain, at FROM wallet_roles WHERE wallet = ? AND role = 'dev'").all(h.wallet) as unknown as { token: string; chain: string; at: number }[]);
    moved += devToFactory(d, h.wallet);
    for (const t of tokens) {
      const ev = await findDeployer(client(t.chain), t.chain, t.token, t.at).catch(() => null);
      putLaunch(d, { token: t.token, chain: t.chain, deployer: ev?.deployer ?? null, factory: h.wallet, poolCreator: null, tx: ev?.tx ?? null, launchedAt: ev?.at ?? null, seenAt: firstSeen(t.token) ?? t.at });
      if (ev?.deployer) {
        resolved++;
        // Настоящий создатель получает роль dev на этом токене со временем исходной записи.
        d.db.prepare("INSERT INTO wallet_roles (wallet, token, chain, role, at) VALUES (?, ?, ?, 'dev', ?) ON CONFLICT (wallet, token) DO UPDATE SET role = 'dev'").run(ev.deployer, t.token, t.chain, t.at || Date.now());
      }
    }
  }
  kvSet(d, FLAG, JSON.stringify({ at: Date.now(), moved, resolved }));
  console.log(`[memory] factory reclass: ${moved} dev records moved to factory, ${resolved} real deployers found`);
}

// Блок по времени: двоичный поиск по меткам блоков (узлы без архива не отдают код контракта в прошлом, а блоки отдают).
async function blockAt(c: PublicClient, ts: number) {
  let lo = 1n;
  let hi = await c.getBlockNumber();
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const b = await c.getBlock({ blockNumber: mid });
    if (Number(b.timestamp) * 1000 < ts) lo = mid;
    else hi = mid;
  }
  return hi;
}

// Самое раннее появление пары на DexScreener: якорь, от которого идём назад к выпуску.
async function pairCreatedAt(token: string) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
  const j = (r?.ok ? await r.json().catch(() => null) : null) as { pairs?: { pairCreatedAt?: number }[] } | null;
  const ts = (j?.pairs ?? []).map((p) => p.pairCreatedAt).filter((x): x is number => !!x);
  return ts.length ? Math.min(...ts) : null;
}

// Подписант выпуска: первый Transfer с нулевого адреса. У лаунчпадов вроде Pons токен долго живёт на кривой и пул
// появляется позже, поэтому от якоря (пара на DexScreener или время, когда рой видел токен) идём назад кусками.
export async function findDeployer(c: PublicClient | undefined, chain: string, token: string, seenAt: number) {
  if (!c) return null;
  const known = launchOf(memDb()!, token);
  if (known?.deployer) return null;
  const anchor = (await pairCreatedAt(token)) ?? seenAt ?? Date.now();
  const chunk = CHUNK[chain] ?? 9_999n;
  let to = await blockAt(c, anchor + 600_000);
  for (let n = 0; n < (CHUNK[chain] ? MAX_CALLS : 60) && to > 0n; n++) {
    const from = to - chunk < 0n ? 0n : to - chunk;
    const logs = await c.getLogs({ address: token as Hex, event: TRANSFER, args: { from: ZERO }, fromBlock: from, toBlock: to }).catch(() => []);
    if (logs.length) {
      const l = logs[0];
      const tx = await c.getTransaction({ hash: l.transactionHash }).catch(() => null);
      const blk = await c.getBlock({ blockNumber: l.blockNumber }).catch(() => null);
      return { deployer: tx?.from.toLowerCase() ?? null, via: tx?.to?.toLowerCase() ?? null, tx: l.transactionHash, at: blk ? Number(blk.timestamp) * 1000 : null };
    }
    to = from - 1n;
  }
  return null;
}

// Скан нашёл фабрику, но не создателя (выпуск давно, за окном логов): ищем в фоне по одному, без дублей.
const queue: { chain: string; token: string; factory: string }[] = [];
const queued = new Set<string>();
let draining = false;
export function queueDeployer(chain: string, token: string, factory: string) {
  if (queued.has(token) || queued.size > 500) return;
  queued.add(token);
  queue.push({ chain, token, factory });
  if (!draining) void drain();
}
async function drain() {
  draining = true;
  try {
    while (queue.length) {
      const j = queue.shift()!;
      const d = memDb();
      const url = evmLogsRpc(j.chain);
      if (!d || !url) continue;
      const c = createPublicClient({ transport: http(url, { timeout: 15_000 }) }) as PublicClient;
      const ev = await findDeployer(c, j.chain, j.token, Date.now()).catch(() => null);
      if (!ev?.deployer) continue;
      putLaunch(d, { token: j.token, chain: j.chain, deployer: ev.deployer, factory: j.factory, poolCreator: null, tx: ev.tx, launchedAt: ev.at });
      d.db.prepare("INSERT INTO wallet_roles (wallet, token, chain, role, at) VALUES (?, ?, ?, 'dev', ?) ON CONFLICT (wallet, token) DO UPDATE SET role = 'dev'").run(ev.deployer, j.token, j.chain, Date.now());
    }
  } finally {
    draining = false;
  }
}
