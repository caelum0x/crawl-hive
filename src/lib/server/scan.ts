// Instant Crawl: бесплатный разовый скан токена без кошелька. Несколько краулеров разбегаются по одному
// адресу — рынок (DexScreener), права минта и держатели (Solana RPC; на Robinhood Chain — GeckoTerminal и
// владелец контракта), клоны тикера, упоминания в Telegram — и сводят всё в оценку 0–100 с одной строкой вывода.
import "server-only";
import { trackStats, trackVerdict, type TrackEntry } from "./track";
import { PublicKey } from "@solana/web3.js";
import { bestPairs, searchPairs, type PairInfo } from "./crawl/dexscreener";
import { fetchChannel } from "./crawl/sources/telegram";
import { rpcConnection } from "./solana";
import { getMeta, setMeta } from "./store";
import { traceBundles, type BundleReport } from "./scan-bundles";
import { traceSnipers, type SniperReport } from "./scan-snipers";
import { evmSnipersMaxAgeH, evmSnipersSupported, traceEvmSnipers } from "./scan-snipers-evm";
import { buildOperators, type LaunchEvidence, type OperatorReport } from "./scan-operators";
import { launchOf, memDb, putLaunch } from "./memory-db";
import { buildEvmMap, evmMapSupported } from "./scan-evm-map";
import { lpSupported, traceLp, type LpReport } from "./scan-lp";
import { larpVerdict, type LarpVerdict } from "./larpcheck";
import { trustEnabled, trustScore, type TrustScore } from "./trust";
import { compareToLast, recordSnapshot, type SinceLast } from "./scan-memory";
import { traceDev, type DevReport } from "./scan-dev";
import { EVM_SCAN, traceEvm, type EvmReport } from "./scan-evm";
import { BUZZ_TTL_MS, type XBuzz } from "./scan-x";
import { xrayEvm, xrayFactors, xrayLive, type XRayReport } from "./scan-xray";
import { t22Factors, xraySolana, type T22Report } from "./scan-t22";
import { siteFactors, xraySite, type SiteReport } from "./scan-site";
import type { XRayView } from "@/components/xray-panel";

export type Verdict = "CLEAN" | "OK" | "RISKY" | "DANGER" | "TOO_EARLY";

export interface ScanFactor {
  label: string;
  impact: number; // сколько очков сняло (отрицательное) или добавило
  note: string;
}

export interface ScanResult {
  id: string; // адрес токена
  chain: string;
  symbol: string;
  name: string;
  score: number | null; // null — слишком рано судить
  verdict: Verdict;
  reason: string;
  factors: ScanFactor[];
  market?: {
    priceUsd?: number;
    liquidityUsd?: number;
    fdv?: number;
    volume1h?: number;
    volume24h?: number;
    change1h?: number;
    ageHours?: number;
    buys1h?: number;
    sells1h?: number;
    url?: string;
    socials: number;
  };
  holders?: { top1: number; top10: number; mintAuthority: boolean; freezeAuthority: boolean };
  bundles?: BundleReport;
  dev?: DevReport;
  launch?: LaunchEvidence; // кто выпустил токен, фабрика лаунчпада, создатель пула, транзакция выпуска и время
  snipers?: SniperReport; // кто купил в первых блоках и сколько держит сейчас
  insiders?: { wallets: number; pct: number }; // топ-держатели, которых пополнил кошелёк создателя
  operators?: OperatorReport; // связанные кошельки, склеенные в владельцев, и их история на других токенах
  larp?: LarpVerdict; // второе мнение Larpcheck о проекте за токеном (со ссылкой на их проверку)
  trust?: TrustScore; // третий вердикт: общий балл CrawlHive и Larpcheck (только с TRUST_SCORE=1)
  lp?: LpReport; // кто держит ликвидность: сожжена, залочена (до какого числа) или в кошельке
  evm?: EvmReport; // Robinhood Chain: держатели, honeypot, владелец контракта
  xray?: XRayView; // Contract X-Ray: рычаги владельца из байткода (EVM) или расширений Token-2022 (Solana)
  core?: string; // базовый актив сети (SOL, USDC…): мем-проверки к нему не применяются
  clones: number;
  original?: boolean; // самый крупный из токенов с этим тикером
  telegram: { channel: string; url: string }[];
  x?: XBuzz; // догружается после вердикта, есть только в сохранённом скане
  since?: SinceLast; // что изменилось с прошлого скана этого токена
  scannedAt: number;
}

export interface ScanLog {
  crawler: string;
  text: string;
  tone?: "ok" | "warn" | "bad" | "info";
}

const TG_CHANNELS = ["pumpfun", "DexScreenerTrending"];

// Базовые активы Solana: у них нет «создателя-разработчика», а тикер SOL/USDC носят сотни копий,
// поэтому проверки держателей, клонов и связанных кошельков для них дают ложную тревогу.
const CORE: Record<string, string> = {
  So11111111111111111111111111111111111111112: "Wrapped SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "Jupiter",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "Marinade SOL",
  // Robinhood Chain (адреса EVM в нижнем регистре)
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "Wrapped ETH",
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG",
  "0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8": "USDC",
  // BNB Chain
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "Wrapped BNB",
  "0x55d398326f99059ff775485246999027b3197955": "USDT",
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
  // Base
  "0x4200000000000000000000000000000000000006": "Wrapped ETH",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "0xe9e7cea3dedca5984780bafc599bd69add087d56": "BUSD",
};
// Сети, которые умеет сканер. Ключ — chainId DexScreener.
export const SCAN_CHAINS: Record<string, string> = { solana: "Solana", robinhood: "Robinhood Chain", bsc: "BNB Chain", base: "Base" };
const chainName = (c: string) => SCAN_CHAINS[c] ?? c;
const RECENT_KEY = "recentScans";
// Сколько монет моложе 30 минут (TOO_EARLY) слились за сутки, по Track Record; кэш на 10 минут.
let earlyCache: { at: number; pct: number | null } | undefined;
function earlyDumpPct() {
  if (earlyCache && Date.now() - earlyCache.at < 600_000) return earlyCache.pct;
  const v = trackStats().by.find((x) => x.verdict === "TOO_EARLY");
  earlyCache = { at: Date.now(), pct: v && v.settled >= 50 ? Math.round((v.dumped / v.settled) * 100) : null };
  return earlyCache.pct;
}

const SAVED_KEY = "scanResults";
const SAVED_MAX = 200;
const CACHE_MS = 2 * 60_000;

// Символы бывают записаны как «$WIF»: сравниваем без знака доллара и регистра.
const sym = (s?: string) => (s ?? "").replace(/^\$/, "").toUpperCase();

// DexScreener ищет «WIF» и «$WIF» по-разному (у dogwifhat символ записан со знаком доллара),
// поэтому спрашиваем оба варианта и склеиваем.
async function searchTicker(t: string): Promise<PairX[]> {
  const [a, b] = await Promise.all([searchPairs(t), searchPairs(`$${t}`).catch(() => [])]);
  const seen = new Set<string>();
  return ([...a, ...b] as PairX[]).filter((p) => !seen.has(p.pairAddress) && !!seen.add(p.pairAddress));
}

type PairX = PairInfo & {
  dexId?: string;
  txns?: { h1?: { buys?: number; sells?: number } };
  info?: { websites?: unknown[]; socials?: unknown[] };
  boosts?: { active?: number };
};

const g = globalThis as unknown as { __crawlhiveScan?: { cache: Map<string, { result: ScanResult; logs: ScanLog[] }>; hits: Map<string, number[]> } };
function mem() {
  g.__crawlhiveScan ??= { cache: new Map(), hits: new Map() };
  return g.__crawlhiveScan;
}

// Скользящее окно на ключ (IP, кошелёк плательщика): не больше max событий за windowMs.
// Ключи разных лимитов разводятся префиксом, окно у одного ключа всегда одно и то же.
export function allowHit(key: string, max: number, windowMs: number) {
  const m = mem();
  const now = Date.now();
  // Старые записи выбрасываем, иначе карта ключей растёт без конца.
  if (m.hits.size > 20_000) for (const [k, v] of m.hits) if (!v.some((t) => now - t < windowMs)) m.hits.delete(k);
  const list = (m.hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) return false;
  list.push(now);
  m.hits.set(key, list);
  return true;
}

// Не больше 8 сканов за 10 минут с одного адреса: краулеры ходят во внешние API.
export const allowScan = (ip: string) => allowHit(ip, 8, 10 * 60_000);

function isSolanaMint(s: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

const pct = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)}%`;
const usd = (n?: number) =>
  n === undefined ? "-" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${Math.round(n)}`;

// Разбор ввода: адрес Solana, адрес EVM или $ТИКЕР (самая ликвидную пару в выбранной сети: Solana или Robinhood Chain).
async function resolve(q: string, log: (l: ScanLog) => void, hint = "solana"): Promise<{ chain: string; address: string; pair?: PairX }> {
  const net = SCAN_CHAINS[hint] ? hint : "solana";
  let s = q.trim();
  // Ссылка на DexScreener, pump.fun или Solscan: достаём из неё адрес.
  if (/^https?:\/\//i.test(s)) s = s.match(/0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g)?.pop() ?? s;
  if (isSolanaMint(s)) return { chain: "solana", address: s };
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) {
    const pairs = ((await searchPairs(s)) as PairX[]).filter((p) => p.baseToken.address.toLowerCase() === s.toLowerCase());
    // Один адрес бывает в нескольких EVM-сетях: сначала сеть, выбранная пользователем, потом поддерживаемые
    // сканером (Robinhood Chain, BNB Chain), внутри — самая ликвидная пара.
    const rank = (p: PairX) => (p.chainId === hint ? 2 : SCAN_CHAINS[p.chainId] ? 1 : 0);
    pairs.sort((a, b) => rank(b) - rank(a) || (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = pairs[0];
    if (!best) throw new Error("No trading pair found for this address");
    return { chain: best.chainId, address: best.baseToken.address, pair: best };
  }
  const ticker = s.replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(ticker)) throw new Error("Paste a token contract address or a $TICKER");
  log({ crawler: "resolver", text: `looking up $${ticker} on ${chainName(net)}…` });
  const pairs = (await searchTicker(ticker)).filter((p) => p.chainId === net && sym(p.baseToken.symbol) === ticker);
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  if (!pairs[0]) throw new Error(`No ${chainName(net)} token with ticker $${ticker}`);
  const others = new Set(pairs.map((p) => p.baseToken.address)).size - 1;
  log({ crawler: "resolver", text: `picked the most liquid $${ticker}${others ? ` (${others} more share this ticker)` : ""}`, tone: others ? "warn" : "info" });
  return { chain: net, address: pairs[0].baseToken.address, pair: pairs[0] };
}

// Держатели меняются, но не каждую секунду: повторный скан того же токена в течение 90 секунд берёт из кэша.
const gh = globalThis as unknown as { __crawlhiveHolders?: Map<string, { at: number; v: Awaited<ReturnType<typeof readHolders>> }> };
async function holdersOf(mint: string) {
  const m = (gh.__crawlhiveHolders ??= new Map());
  const hit = m.get(mint);
  if (hit && Date.now() - hit.at < 90_000) return hit.v;
  const v = await readHolders(mint);
  if (m.size > 2000) m.clear();
  m.set(mint, { at: Date.now(), v });
  return v;
}

async function readHolders(mint: string) {
  const conn = rpcConnection();
  const key = new PublicKey(mint);
  const [info, supply, largest] = await Promise.all([
    conn.getParsedAccountInfo(key),
    conn.getTokenSupply(key),
    conn.getTokenLargestAccounts(key),
  ]);
  const parsed = (info.value?.data as { parsed?: { info?: { mintAuthority?: string | null; freezeAuthority?: string | null } } })?.parsed?.info;
  const total = Number(supply.value.amount) || 1;
  const amounts = largest.value.map((a) => Number(a.amount));
  return {
    supplyRaw: Number(supply.value.amount) || 0,
    top1: (amounts[0] ?? 0) / total * 100,
    top2to11: amounts.slice(1, 11).reduce((s, x) => s + x, 0) / total * 100,
    top10: amounts.slice(0, 10).reduce((s, x) => s + x, 0) / total * 100,
    mintAuthority: !!parsed?.mintAuthority,
    freezeAuthority: !!parsed?.freezeAuthority,
    accounts: largest.value.map((a) => ({ account: a.address.toBase58(), pct: Number(a.amount) / total * 100 })),
  };
}

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

// record=false — скан для внутренних нужд (краулеры, Grok Bot): в публичную ленту «recently scanned» не попадает.
export async function runScan(
  q: string,
  emit: (l: ScanLog) => void,
  hint?: string,
  opts: { record?: boolean; src?: TrackEntry["src"] } = {},
): Promise<ScanResult> {
  const logs: ScanLog[] = [];
  const log = (l: ScanLog) => {
    logs.push(l);
    emit(l);
  };
  const { chain, address, pair: pre } = await resolve(q, log, hint);
  const cached = mem().cache.get(address);
  if (cached && Date.now() - cached.result.scannedAt < CACHE_MS) {
    // Свежий скан этого токена уже есть: проигрываем его лог, чтобы было видно, что нашли краулеры.
    emit({ crawler: "cache", text: `fresh scan from ${Math.round((Date.now() - cached.result.scannedAt) / 1000)}s ago`, tone: "info" });
    for (const l of cached.logs) {
      await new Promise((r) => setTimeout(r, 120));
      emit(l);
    }
    return cached.result;
  }
  const factors: ScanFactor[] = [];
  const hit = (label: string, impact: number, note: string) => factors.push({ label, impact, note });
  const core = CORE[address] ?? CORE[address.toLowerCase()];
  if (core) log({ crawler: "resolver", text: `${core} is a core ${chainName(chain)} asset: memecoin checks are skipped`, tone: "info" });

  // Краулеры работают параллельно, каждый пишет в лог по готовности.
  log({ crawler: "swarm", text: `${core ? 2 : chain === "solana" ? 6 : EVM_SCAN[chain] ? 4 : 3} crawlers dispatched to ${address.slice(0, 6)}…${address.slice(-4)} on ${chainName(chain)}` });

  const marketP = (async () => {
    const pair = (pre ?? (await bestPairs(chain, [address])).get(address)) as PairX | undefined;
    if (!pair) {
      log({ crawler: "crawler_market", text: "no trading pair on DexScreener yet", tone: "warn" });
      return undefined;
    }
    const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3600_000 : undefined;
    log({
      crawler: "crawler_market",
      text: `$${sym(pair.baseToken.symbol)} · ${pair.liquidity?.usd === undefined ? "no pool yet (bonding curve)" : `liquidity ${usd(pair.liquidity.usd)}`}${pair.liquidity?.usd === undefined && (pair.fdv ?? 0) < 1_000 ? "" : ` · FDV ${usd(pair.fdv)}`} · ${ageHours !== undefined ? `${ageHours < 48 ? `${ageHours.toFixed(1)}h` : `${Math.round(ageHours / 24)}d`} old` : "age unknown"}`,
      tone: (pair.liquidity?.usd ?? 0) < 10_000 ? "warn" : "ok",
    });
    return { pair, ageHours };
  })();

  const holdersP =
    chain === "solana" && !core
      ? holdersOf(address)
          .then((h) => {
            // У некоторых минтов supply в аккаунте не отражает реальную эмиссию — доли выходят за 100%.
            if (h.top1 > 100 || h.top10 > 100) {
              log({ crawler: "crawler_holders", text: "supply data is inconsistent, holder shares skipped", tone: "warn" });
              return undefined;
            }
            log({
              crawler: "crawler_holders",
              text: `top holder ${pct(h.top1)} · next 10 hold ${pct(h.top2to11)} · mint ${h.mintAuthority ? "OPEN" : "renounced"} · freeze ${h.freezeAuthority ? "ON" : "off"}`,
              tone: h.mintAuthority || h.freezeAuthority ? "bad" : h.top2to11 > 40 ? "warn" : "ok",
            });
            return h;
          })
          .catch(() => {
            log({ crawler: "crawler_holders", text: "holder data unavailable right now", tone: "warn" });
            return undefined;
          })
      : Promise.resolve(undefined);

  // Robinhood Chain: держатели и honeypot (GeckoTerminal), владелец контракта (RPC).
  const evmP: Promise<EvmReport | undefined> =
    EVM_SCAN[chain] && !core
      ? withTimeout(traceEvm(address, chain), 15_000)
          .then((e) => {
            log({
              crawler: "crawler_holders",
              text: `${e.holders !== undefined ? `${e.holders.toLocaleString("en-US")} holders` : "holder count unknown"}${e.top10 !== undefined ? ` · top 10 hold ${pct(e.top10)}` : ""} · owner ${e.owner ? `${e.owner.slice(0, 6)}…${e.owner.slice(-4)} (active)` : "renounced"}${e.honeypot ? " · HONEYPOT" : e.honeypot === false ? " · sellable" : ""}`,
              tone: e.honeypot ? "bad" : e.owner || (e.top10 ?? 0) > 90 || (e.holders ?? 999) < 50 ? "warn" : "ok",
            });
            return e;
          })
          .catch(() => {
            log({ crawler: "crawler_holders", text: "holder data unavailable right now", tone: "warn" });
            return undefined;
          })
      : Promise.resolve(undefined);

  // Contract X-Ray: что владелец может сделать с держателями. На EVM читаем байткод (работает и без
  // опубликованного исходника), на Solana — расширения Token-2022.
  const xrayP: Promise<XRayReport | T22Report | undefined> = core
    ? Promise.resolve(undefined)
    : EVM_SCAN[chain]
      ? xrayEvm(address, chain)
      : chain === "solana"
        ? withTimeout(xraySolana(rpcConnection(), address), 10_000).catch(() => undefined)
        : Promise.resolve(undefined);

  // Связанные кошельки: кто профинансировал топ-держателей. Идёт после держателей, ему нужен их список.
  const bundlesP: Promise<BundleReport | undefined> = holdersP.then((h) =>
    h
      ? withTimeout(traceBundles(rpcConnection(), h.accounts), 15_000)
          .then((b) => {
            const big = b.clusters[0];
            log({
              crawler: "crawler_bundles",
              text: big
                ? `${big.wallets} top wallets share one funder and hold ${pct(big.pct)}${b.clusters.length > 1 ? ` · ${b.clusters.length - 1} more linked group${b.clusters.length > 2 ? "s" : ""}` : ""}`
                : `traced funding of ${b.checked} top wallets: no linked groups${b.fresh.wallets ? ` · ${b.fresh.wallets} fresh wallet${b.fresh.wallets > 1 ? "s" : ""} hold ${pct(b.fresh.pct)}` : ""}`,
              tone: big && (big.pct >= 4 || big.wallets >= 3) ? "bad" : b.fresh.pct >= 15 || big ? "warn" : "ok",
            });
            return b;
          })
          .catch((e) => {
            console.error("[scan] bundles:", (e as Error).message);
            log({ crawler: "crawler_bundles", text: "could not trace wallet funding right now", tone: "warn" });
            return undefined;
          })
      : undefined,
  );

  // История разработчика: создатель, его прошлые запуски на pump.fun, возраст кошелька, сколько держит.
  const devP: Promise<DevReport | undefined> =
    chain === "solana" && !core
      ? holdersP.then((h) =>
          withTimeout(traceDev(rpcConnection(), address, h?.supplyRaw), 15_000)
            .then((d) => {
              if (!d) {
                log({ crawler: "crawler_dev", text: "creator not found: an old token or one minted outside launchpads", tone: "info" });
                return undefined;
              }
              const age = d.walletAgeHours === undefined ? `${d.walletTxs}+ txs` : d.walletAgeHours < 48 ? `wallet ${d.walletAgeHours.toFixed(1)}h old` : `wallet ${Math.round(d.walletAgeHours / 24)}d old`;
              const others = d.launched - 1;
              log({
                crawler: "crawler_dev",
                text: `creator ${d.creator.slice(0, 4)}…${d.creator.slice(-4)} · ${d.platform === "other" ? "found from the first transaction" : others ? `${others} earlier pump.fun launch${others > 1 ? "es" : ""}, ${d.graduated} graduated` : "first launch"} · ${age}${d.holdsPct !== undefined ? ` · holds ${pct(d.holdsPct)}` : ""}`,
                tone: devTone(d),
              });
              return d;
            })
            .catch((e) => {
              console.error("[scan] dev:", (e as Error).message);
              log({ crawler: "crawler_dev", text: "could not trace the creator right now", tone: "warn" });
              return undefined;
            }),
        )
      : Promise.resolve(undefined);

  // Снайперы: только молодые токены на Solana и только сканы людей (радар и краулеры не тратят RPC на историю минта).
  const snipersP: Promise<SniperReport | undefined> =
    evmSnipersSupported(chain) && !core && opts.record !== false
      ? marketP.then((m) => {
          const created = m?.pair.pairCreatedAt;
          if (!created || (Date.now() - created) / 3600_000 > evmSnipersMaxAgeH(chain)) return undefined;
          return withTimeout(traceEvmSnipers(chain, address, created, m?.pair.pairAddress), 20_000)
            .then((r) => {
              if (!r) {
                log({ crawler: "crawler_snipers", text: "could not find the launch block", tone: "info" });
                return undefined;
              }
              log({
                crawler: "crawler_snipers",
                text: r.wallets
                  ? `${r.wallets} wallet${r.wallets > 1 ? "s" : ""} bought in the first ${r.slots} seconds (${pct(r.boughtPct)}) · still hold ${pct(r.holdPct)}${r.sold ? ` · ${r.sold} sold out` : ""}`
                  : "no one but the creator bought in the first seconds",
                tone: r.holdPct >= 15 ? "bad" : r.holdPct >= 5 ? "warn" : "ok",
              });
              return r;
            })
            .catch((e) => {
              console.error("[scan] evm snipers:", (e as Error).message);
              log({ crawler: "crawler_snipers", text: "could not read the first buyers right now", tone: "warn" });
              return undefined;
            });
        })
      : chain === "solana" && !core && opts.record !== false
      ? Promise.all([holdersP, devP, marketP]).then(([h, d, m]) => {
          const age = m?.pair.pairCreatedAt ? (Date.now() - m.pair.pairCreatedAt) / 3600_000 : undefined;
          if (age !== undefined && age > 72) return undefined;
          const supplyP = h?.supplyRaw ? Promise.resolve(h.supplyRaw) : rpcConnection().getTokenSupply(new PublicKey(address)).then((x) => Number(x.value.amount) || 0);
          return withTimeout(supplyP.then((supply) => traceSnipers(rpcConnection(), address, supply, d?.creator)), 16_000)
            .then((r) => {
              if (!r) {
                log({ crawler: "crawler_snipers", text: "too much history to reach the first block", tone: "info" });
                return undefined;
              }
              log({
                crawler: "crawler_snipers",
                text: r.wallets
                  ? `${r.wallets} wallet${r.wallets > 1 ? "s" : ""} bought in the first ${r.slots + 1} blocks (${pct(r.boughtPct)}) · still hold ${pct(r.holdPct)}${r.sold ? ` · ${r.sold} sold out` : ""}`
                  : "no one but the creator bought in the first blocks",
                tone: r.holdPct >= 15 ? "bad" : r.holdPct >= 5 ? "warn" : "ok",
              });
              return r;
            })
            .catch((e) => {
              console.error("[scan] snipers:", (e as Error).message);
              log({ crawler: "crawler_snipers", text: "could not read the first buyers right now", tone: "warn" });
              return undefined;
            });
        })
      : Promise.resolve(undefined);

  // LP: сожжена, залочена (и до какого числа) или лежит в кошельке — Solana по RugCheck, BNB и Base по GoPlus.
  const days = (ms: number) => Math.max(0, Math.round((ms - Date.now()) / 86_400_000));
  const lpP: Promise<LpReport | undefined> =
    (chain === "solana" || lpSupported(chain)) && !core
      ? marketP.then((m) =>
          withTimeout(traceLp(chain, address, !!m?.pair && m.pair.liquidity?.usd === undefined, m?.pair.pairAddress), 12_000)
            .then((r) => {
              if (!r) return undefined;
              const text =
                r.status === "curve"
                  ? "still on the launchpad curve: no LP to pull yet"
                  : r.status === "burned"
                    ? `LP burned (${r.lockedPct}%): liquidity can't be pulled`
                    : r.status === "unlocked"
                      ? `only ${r.lockedPct ?? 0}% of the LP is locked or burned: liquidity can be pulled`
                      : `${r.lockedPct}% of the LP locked${r.locker ? ` in ${r.locker}` : ""}${r.unlockAt ? `, unlocks in ${days(r.unlockAt)} days (${new Date(r.unlockAt).toISOString().slice(0, 10)})` : ""}`;
              const soon = !!r.unlockAt && r.unlockAt - Date.now() < 30 * 86_400_000;
              log({ crawler: "crawler_lp", text, tone: r.status === "unlocked" || soon ? "bad" : r.status === "partly" ? "warn" : "ok" });
              return r;
            })
            .catch(() => undefined),
        )
      : Promise.resolve(undefined);

  const market = await marketP;
  const symbol = sym(market?.pair.baseToken.symbol);

  // Сайт проекта: у мем-лендинга нет причин просить у кошелька апрувы — так прячутся дрейнеры.
  const site = (market?.pair.info?.websites ?? []).map((w) => (typeof w === "string" ? w : (w as { url?: string })?.url)).find((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
  const siteP: Promise<SiteReport | undefined> =
    site && !core
      ? withTimeout(xraySite(site), 20_000)
          .then((r) => {
            if (r)
              log({
                crawler: "crawler_site",
                text: r.error ? `${r.host}: site unreachable, not checked` : r.findings.length ? `${r.host}: ${r.findings.map((f) => f.label.toLowerCase()).join(", ")}` : `${r.host}: ${r.scripts} scripts read, no drainer code`,
                tone: r.findings.some((f) => f.severity === "high") ? "bad" : r.findings.some((f) => f.severity === "medium") ? "warn" : r.error ? "info" : "ok",
              });
            return r;
          })
          .catch(() => undefined)
      : Promise.resolve(undefined);

  // Клоны: другие токены с тем же тикером. Если у кого-то из них ликвидность больше, этот, скорее всего, копия.
  const clonesP: Promise<{ n: number; biggerTwin?: number; original?: boolean }> = symbol && !core
    ? searchTicker(sym(symbol))
        .then((pairs) => {
          const same = pairs.filter((p) => p.chainId === chain && sym(p.baseToken.symbol) === sym(symbol));
          // Сравниваем по капитализации: у копии она на порядки меньше, даже если в одном пуле много ликвидности.
          const others = new Map<string, { fdv: number; liq: number; born: number }>();
          // Когда появилась первая пара нашего токена: копия всегда моложе оригинала.
          let mineBorn = market?.pair.pairCreatedAt ?? Infinity;
          for (const p of same) {
            const born = p.pairCreatedAt ?? Infinity;
            if (p.baseToken.address === address) {
              mineBorn = Math.min(mineBorn, born);
              continue;
            }
            const prev = others.get(p.baseToken.address) ?? { fdv: 0, liq: 0, born: Infinity };
            others.set(p.baseToken.address, { fdv: Math.max(prev.fdv, p.fdv ?? 0), liq: Math.max(prev.liq, p.liquidity?.usd ?? 0), born: Math.min(prev.born, born) });
          }
          const n = others.size;
          const mineFdv = market?.pair.fdv ?? 0;
          // Без FDV (так бывает у wrapped-активов) сравниваем по ликвидности пула.
          const mineLiq = market?.pair.liquidity?.usd ?? 0;
          const twin = [...others.values()]
            // Крупный «двойник», запущенный позже нашего токена, — сам копия с накрученной FDV, а не оригинал.
            .filter((o) => o.liq > 20_000 && !(o.born > mineBorn) && (mineFdv ? o.fdv > Math.max(mineFdv * 5, 100_000) : o.liq > mineLiq * 5))
            .sort((x, y) => y.fdv - x.fdv)[0];
          const biggerTwin = twin?.fdv;
          const top = Math.max(0, ...[...others.values()].filter((o) => !(o.born > mineBorn)).map((o) => o.fdv));
          const mine = mineFdv;
          log({
            crawler: "crawler_clones",
            text: biggerTwin
              ? `a bigger token already uses $${sym(symbol)} (${usd(biggerTwin)} FDV): this may be a copy`
              : n > 0 && mine >= top
                ? `the original $${sym(symbol)}: the biggest of ${n + 1} tokens with this ticker`
                : n > 0
                ? `${n} other token${n > 1 ? "s use" : " uses"} the ticker $${sym(symbol)}`
                : `ticker $${sym(symbol)} is unique on ${chainName(chain)}`,
            tone: biggerTwin ? "bad" : n > 2 ? "warn" : "ok",
          });
          return { n, biggerTwin, original: n > 0 && mine >= top };
        })
        .catch(() => ({ n: 0 }))
    : Promise.resolve({ n: 0 });

  const tgP = Promise.all(
    TG_CHANNELS.map(async (ch) => {
      try {
        const msgs = await fetchChannel(ch);
        // Символ задаёт создатель токена: регулярку из него не строим (ReDoS), ищем подстроку и проверяем границу.
        const tag = symbol ? `$${symbol}` : "";
        const hasTag = (t: string) => {
          if (!tag) return false;
          const up = t.toUpperCase();
          for (let i = up.indexOf(tag); i >= 0; i = up.indexOf(tag, i + 1)) if (!/[A-Z0-9_]/.test(up[i + tag.length] ?? "")) return true;
          return false;
        };
        const m = msgs.reverse().find((x) => x.text.includes(address) || hasTag(x.text));
        return m ? { channel: `t.me/${ch}`, url: m.url ?? `https://t.me/${ch}` } : null;
      } catch {
        return null;
      }
    }),
  ).then((r) => {
    const found = r.filter(Boolean) as { channel: string; url: string }[];
    log({ crawler: "crawler_telegram", text: found.length ? `mentioned in ${found.map((f) => f.channel).join(", ")}` : `no mentions in ${TG_CHANNELS.length} tracked channels`, tone: found.length ? "ok" : "info" });
    return found;
  });

  const larpP = core ? Promise.resolve(null) : larpVerdict(address).catch(() => null);
  const [holders, cloneInfo, telegram, bundles, dev, evm, xr, siteR, snipers, lp, larp] = await Promise.all([holdersP, clonesP, tgP, bundlesP, devP, evmP, xrayP, siteP, snipersP, lpP, larpP]);
  if (larp) log({ crawler: "larpcheck", text: `Larpcheck says ${larp.verdict}${larp.score != null ? ` (${larp.score}/100)` : ""}${larp.headline ? `: ${larp.headline}` : ""}`, tone: /LARP|SCAM/.test(larp.verdict) ? "bad" : /REAL/.test(larp.verdict) ? "ok" : "warn" });
  // Инсайдеры: топ-держатели, которым первый SOL прислал (или первую транзакцию оплатил) сам создатель.
  const devLinks = dev ? (bundles?.links ?? []).filter((l) => l.funder === dev.creator && l.wallet !== dev.creator) : [];
  const insiders = devLinks.length ? { wallets: devLinks.length, pct: Math.round(devLinks.reduce((x, l) => x + l.pct, 0) * 100) / 100 } : undefined;

  // Операторы: склеиваем держателей, снайперов и инсайдеров по связям; плюс память кошельков между сканами.
  // Solana — по спонсорам кошельков, EVM — по держателям из GoPlus и переводам токена между ними.
  const operatorsP: Promise<OperatorReport | undefined> | undefined =
    core
      ? undefined
      : chain === "solana"
        ? bundles || snipers
          ? withTimeout(buildOperators(rpcConnection(), { bundles, snipers, creator: dev?.creator, mint: address }), 10_000)
          : undefined
        : evmMapSupported(chain)
          ? withTimeout(buildEvmMap(chain, address, { snipers, pairCreatedAt: market?.pair.pairCreatedAt, pair: market?.pair.pairAddress }), 20_000)
          : undefined;
  const operators: OperatorReport | undefined = operatorsP
    ? await operatorsP
          .then((o) => {
            if (o) {
              const top = o.operators[0];
              log({
                crawler: "crawler_operators",
                text: [
                  top ? `${o.operators.length} operator${o.operators.length > 1 ? "s" : ""} · biggest: ${top.wallets} wallets hold ${pct(top.pct)} (${top.roles.join(" + ")})` : "no linked operators among holders and snipers",
                  o.devSnipers ? `${o.devSnipers} sniper${o.devSnipers > 1 ? "s" : ""} ${chain === "solana" ? "funded by" : "linked to"} the creator` : "",
                  o.history ? `${o.history.wallets} wallet${o.history.wallets > 1 ? "s" : ""} seen on ${o.history.tokens} other token${o.history.tokens > 1 ? "s" : ""}, ${o.history.dumped} dumped` : "",
                ].filter(Boolean).join(" · "),
                tone: o.devSnipers || (top && top.roles.length > 1 && top.pct >= 20) ? "bad" : top ? "warn" : "ok",
              });
            }
            return o;
          })
          .catch(() => undefined)
      : undefined;  let xray = xr && "program" in xr ? xrayViewSol(xr) : xr ? xrayViewEvm(xr, !!evm?.owner) : undefined;
  if (siteR) {
    const siteView = { host: siteR.host, wallet: siteR.wallet, error: siteR.error, findings: siteR.findings.map((f) => ({ label: f.label, note: f.note, severity: f.severity, detail: f.evidence })) };
    xray = xray ? { ...xray, site: siteView } : { kind: chain === "solana" ? "solana" : "evm", summary: "token contract not read", findings: [], site: siteView };
  }
  if (xray) log({ crawler: "crawler_xray", text: `${xray.summary}${xray.findings.length ? ` · ${xray.findings.filter((f) => f.severity !== "low").map((f) => f.label.toLowerCase()).join(", ") || "only launch mechanics"}` : " · nothing the owner can pull"}`, tone: xray.findings.some((f) => f.severity === "high") ? "bad" : xray.findings.some((f) => f.severity === "medium") ? "warn" : "ok" });
  const clones = cloneInfo.n;

  // Доказательства запуска: создатель (кошелёк, подписавший выпуск), фабрика лаунчпада, создатель пула, транзакция
  // и время выпуска, когда рой увидел токен. EVM — из buildEvmMap, Solana — из трейса создателя.
  const launch: LaunchEvidence | undefined = core
    ? undefined
    : chain === "solana"
      ? dev
        ? { deployer: dev.creator, factory: dev.factory, factoryLabel: dev.factory ? "pump.fun" : undefined, tx: dev.tx, launchedAt: dev.launchedAt ?? market?.pair.pairCreatedAt, seenAt: Date.now() }
        : undefined
      : operators?.launch
        ? { ...operators.launch } // время выпуска только из транзакции выпуска: пул на EVM часто создаётся намного позже
        : undefined;
  if (launch) {
    const d = memDb();
    const key = chain === "solana" ? address : address.toLowerCase();
    if (d)
      try {
        putLaunch(d, { token: key, chain, deployer: launch.deployer ?? null, factory: chain === "solana" ? null : (launch.factory ?? null), poolCreator: launch.poolCreator ?? null, tx: launch.tx ?? null, launchedAt: launch.launchedAt ?? null });
        // Из базы: когда рой увидел токен впервые и что уже нашёл фоновый поиск (настоящего создателя, транзакцию).
        const k = launchOf(d, key);
        if (k) {
          launch.seenAt = k.seenAt;
          launch.deployer ??= k.deployer ?? undefined;
          launch.tx ??= k.tx ?? undefined;
          launch.launchedAt = k.launchedAt ?? launch.launchedAt;
          launch.poolCreator ??= k.poolCreator ?? undefined;
        }
      } catch (e) {
        console.warn("[scan] launch:", (e as Error).message);
      }
  }

  // ---------- оценка ----------
  let score = 100;
  const p = market?.pair;
  const liq = p?.liquidity?.usd ?? 0;
  // Пара без ликвидности — токен ещё на bonding curve лаунчпада (pump.fun, Meteora DBC, Raydium LaunchLab,
  // Moonshot, Boop…): у кривой нет пула, и «$0 ликвидности» здесь неправда.
  const onCurve = !!p && p.liquidity?.usd === undefined;
  const launchpad = !p ? "" : /pump/i.test(p.dexId ?? "") ? "pump.fun" : /dbc|meteora/i.test(p.dexId ?? "") ? "Meteora DBC" : /launchlab/i.test(p.dexId ?? "") ? "Raydium LaunchLab" : /four/i.test(p.dexId ?? "") ? "four.meme" : p.dexId ?? "launchpad";
  if (!p) hit("No market", -35, "no trading pair found");
  else if (onCurve) hit("Bonding curve", -10, `still on the ${launchpad} curve, not graduated to a pool`);
  else if (liq < 5_000) hit("Thin liquidity", -25, `only ${usd(liq)} in the pool`);
  else if (liq < 20_000) hit("Low liquidity", -10, `${usd(liq)} in the pool`);
  if (lp && lp.status === "unlocked" && liq >= 5_000) hit("LP not locked", -15, `only ${lp.lockedPct ?? 0}% of the liquidity is locked or burned: it can be pulled any time`);
  else if (lp?.unlockAt && lp.unlockAt - Date.now() < 7 * 86_400_000) hit("LP unlocks this week", -20, `the locked LP unlocks on ${new Date(lp.unlockAt).toISOString().slice(0, 10)}${lp.locker ? ` (${lp.locker})` : ""}`);
  else if (lp?.unlockAt && lp.unlockAt - Date.now() < 30 * 86_400_000) hit("LP unlocks soon", -10, `the locked LP unlocks in ${days(lp.unlockAt)} days${lp.locker ? ` (${lp.locker})` : ""}`);
  else if (lp?.status === "burned") hit("LP burned", 5, "the liquidity tokens are burned: the pool can't be pulled");
  if (holders?.mintAuthority) hit("Mint open", -30, "the creator can still mint new tokens");
  if (holders?.freezeAuthority) hit("Freeze on", -25, "the creator can freeze holders' tokens");
  // Крупнейший держатель — обычно пул ликвидности, поэтому концентрацию считаем по следующим десяти.
  if (holders && holders.top2to11 > 50) hit("Concentrated", -20, `the next 10 wallets hold ${pct(holders.top2to11)}`);
  else if (holders && holders.top2to11 > 30) hit("Top-heavy", -10, `the next 10 wallets hold ${pct(holders.top2to11)}`);
  const cluster = bundles?.clusters[0];
  // Пять и больше топ-кошельков под одним хозяином — бандл, даже если доля пока небольшая.
  if (cluster && (cluster.pct >= 10 || cluster.wallets >= 5)) hit("Bundled", -25, `${cluster.wallets} linked wallets hold ${pct(cluster.pct)}`);
  else if (cluster && (cluster.pct >= 4 || cluster.wallets >= 3)) hit("Linked wallets", -10, `${cluster.wallets} top wallets share a funder (${pct(cluster.pct)})`);
  if (insiders && insiders.pct >= 5) hit("Dev-funded holders", -20, `${insiders.wallets} top wallet${insiders.wallets > 1 ? "s were" : " was"} funded by the creator and hold ${pct(insiders.pct)}`);
  else if (insiders) hit("Dev-funded wallets", -10, `${insiders.wallets} top wallet${insiders.wallets > 1 ? "s were" : " was"} funded by the creator (${pct(insiders.pct)})`);
  if (operators?.devSnipers) hit("Dev-funded snipers", -20, `${operators.devSnipers} wallet${operators.devSnipers > 1 ? "s" : ""} that bought in the first blocks ${chain === "solana" ? "were funded by" : "got tokens from or sent tokens to"} the creator`);
  const bigOp = operators?.operators[0];
  // Один кошелёк дева — это «Dev holds a lot», а не оператор: штрафуем только группы из 2+ кошельков.
  // Связь только через общего спонсора — это связь, а не доказательство одного владельца: штраф мягче и так и пишем.
  const funderOnly = bigOp?.basis?.length === 1 && bigOp.basis[0] === "funder";
  if (bigOp && bigOp.wallets >= 2 && ((bigOp.roles.length > 1 && bigOp.pct >= 15) || bigOp.pct >= 30))
    hit(
      "One operator",
      funderOnly ? -10 : -15,
      funderOnly
        ? `${bigOp.wallets} wallets connected by a shared funder hold ${pct(bigOp.pct)} (a connection, not proof of common control)`
        : `${bigOp.wallets} linked wallets (${bigOp.roles.join(" + ")}) hold ${pct(bigOp.pct)}`,
    );
  const hist = operators?.history;
  if (hist && hist.dumped >= 3 && hist.dumped / hist.tokens >= 0.5) hit("Known dump wallets", -10, `${hist.wallets} of these wallets were on ${hist.tokens} other tokens, ${hist.dumped} of them dumped`);
  if (snipers && snipers.holdPct >= 15) hit("Snipers hold a lot", -15, `${snipers.wallets} first-block buyers still hold ${pct(snipers.holdPct)}`);
  else if (snipers && snipers.holdPct >= 5) hit("Snipers", -5, `first-block buyers still hold ${pct(snipers.holdPct)}`);
  if (bundles && bundles.fresh.pct >= 15) hit("Fresh wallets", -10, `${bundles.fresh.wallets} wallets under 3 days old hold ${pct(bundles.fresh.pct)}`);
  if (dev) {
    const prior = dev.launched - 1;
    if (prior >= 10 && dev.graduated === 0) hit("Serial launcher", -25, `the creator launched ${prior} other tokens on pump.fun, none graduated`);
    else if (prior >= 3 && dev.graduated / prior < 0.1) hit("Weak dev record", -10, `${dev.graduated} of ${prior} earlier launches by this creator graduated`);
    else if (dev.graduated >= 2 && dev.graduated / prior >= 0.3) hit("Dev track record", 5, `${dev.graduated} of ${prior} earlier launches by this creator graduated`);
    if (dev.walletAgeHours !== undefined && dev.walletAgeHours < 24) hit("Fresh dev wallet", -5, `the creator wallet is ${dev.walletAgeHours.toFixed(1)}h old`);
    if (dev.holdsPct !== undefined && dev.holdsPct > 10) hit("Dev holds a lot", -10, `the creator still holds ${pct(dev.holdsPct)}`);
  }
  if (evm) {
    if (evm.honeypot) hit("Honeypot", -60, "GeckoTerminal flags it: you can buy but not sell");
    if (evm.owner) hit("Owner active", -10, "the deployer still controls the contract (fees, pausing, minting may be possible)");
    // Топ-10 на EVM включает пул ликвидности, поэтому порог выше, чем у Solana.
    if ((evm.top10 ?? 0) > 90) hit("Concentrated", -15, `the top 10 wallets (pool included) hold ${pct(evm.top10!)}`);
    if (evm.holders !== undefined && evm.holders < 50) hit("Few holders", -10, `only ${evm.holders} wallets hold it`);
  }
  if (xr && "program" in xr) for (const f of t22Factors(xr)) hit(f.label, f.impact, f.note);
  else if (xr) for (const f of xrayFactors(xr, !!evm?.owner)) hit(f.label, f.impact, f.note);
  if (siteR) for (const f of siteFactors(siteR)) hit(f.label, f.impact, f.note);
  if (cloneInfo.biggerTwin) hit("Possible copy", -45, `a token worth ${usd(cloneInfo.biggerTwin)} already uses this ticker`);
  else if (clones > 2 && !cloneInfo.original) hit("Copycats", -10, `${clones} other tokens share the ticker`);
  const buys = p?.txns?.h1?.buys ?? 0;
  const sells = p?.txns?.h1?.sells ?? 0;
  if (sells > 20 && sells > buys * 2) hit("Sell pressure", -10, `${sells} sells vs ${buys} buys in the last hour`);
  const socials = (p?.info?.websites?.length ?? 0) + (p?.info?.socials?.length ?? 0);
  if (p && !socials && !core) hit("No socials", -5, "no website or socials listed");
  if (p && (p.priceChange?.h1 ?? 0) < -40) hit("Dumping", -10, `${Math.round(p.priceChange?.h1 ?? 0)}% in the last hour`);
  if (telegram.length) hit("On the radar", 5, `mentioned in ${telegram.map((t) => t.channel).join(", ")}`);
  for (const f of factors) score += f.impact;
  score = Math.max(0, Math.min(100, score));
  // Жёсткое правило по данным Track Record (13.10): молодые токены со связанными или свежими кошельками
  // в первые часы массово рушились на 60–98% при вердикте OK/CLEAN. Взвешенная сумма тут обманывает:
  // такой токен не выше RISKY, сколько бы баллов он ни набрал.
  const YOUNG_RISK = ["Bundled", "Linked wallets", "Dev-funded holders", "Snipers hold a lot", "Dev-funded snipers", "One operator", "Known dump wallets", "Fresh dev wallet", "Fresh wallets", "Owner active", "Dev holds a lot"];
  const youngFlag = market?.ageHours !== undefined && market.ageHours < 24 ? factors.find((f) => YOUNG_RISK.includes(f.label)) : undefined;
  if (youngFlag && score >= 60) {
    hit("Young and linked", -(score - 59), `under a day old with "${youngFlag.label.toLowerCase()}": such launches often dump in the first hours`);
    score = 59;
  }

  // «Слишком рано» — только если явных красных флагов нет: связанные кошельки или серийного создателя видно
  // уже в первые минуты, и молчать о них нельзя.
  const SERIOUS = ["LP unlocks this week", "LP not locked", "Bundled", "Linked wallets", "Dev-funded holders", "Snipers hold a lot", "Dev-funded snipers", "One operator", "Fresh wallets", "Serial launcher", "Possible copy", "Dev holds a lot", "Concentrated"];
  const tooEarly =
    !!market && market.ageHours !== undefined && market.ageHours < 0.5 && !holders?.mintAuthority && !holders?.freezeAuthority && !evm?.honeypot && !xray?.findings.some((f) => f.severity === "high") && !factors.some((f) => SERIOUS.includes(f.label));
  const verdict: Verdict = tooEarly ? "TOO_EARLY" : score >= 80 ? "CLEAN" : score >= 60 ? "OK" : score >= 40 ? "RISKY" : "DANGER";
  const worst = [...factors].sort((a, b) => a.impact - b.impact)[0];
  const early = tooEarly ? earlyDumpPct() : null;
  const reason = tooEarly
    ? `Under 30 minutes old, early read only${early ? `: ${early}% of coins this young dumped within 24h` : ""}. Scan again after 30 min`
    : worst && worst.impact < 0
      ? `${worst.label}: ${worst.note}`
      : core
        ? `${core}: a core ${chainName(chain)} asset, not a memecoin`
        : "No red flags found by the crawlers";

  const trust = trustEnabled() ? trustScore({ score, verdict }, larp) : null;
  const result: ScanResult = {
    id: address,
    chain,
    symbol: symbol || address.slice(0, 4),
    name: p?.baseToken.name ?? "",
    // Свежей монете тоже показываем предварительную оценку: прочерк прятал самый частый исход (слив).
    score,
    verdict,
    reason,
    factors,
    market: p
      ? {
          priceUsd: p.priceUsd ? Number(p.priceUsd) : undefined,
          liquidityUsd: p.liquidity?.usd,
          // На кривой DexScreener часто отдаёт FDV в центах — такое не показываем.
          fdv: onCurve && (p.fdv ?? 0) < 1_000 ? undefined : p.fdv,
          volume1h: p.volume?.h1,
          volume24h: p.volume?.h24,
          change1h: p.priceChange?.h1,
          ageHours: market?.ageHours,
          buys1h: buys,
          sells1h: sells,
          url: p.url,
          socials,
        }
      : undefined,
    holders: holders && { top1: holders.top1, top10: holders.top10, mintAuthority: holders.mintAuthority, freezeAuthority: holders.freezeAuthority },
    bundles: bundles && { ...bundles, links: undefined, wallets: undefined, exchanges: undefined },
    snipers: snipers && { ...snipers, buyers: undefined },
    insiders,
    operators,
    ...(larp ? { larp } : {}),
    ...(trust ? { trust } : {}),
    lp,
    dev,
    ...(launch ? { launch } : {}),
    evm,
    xray,
    core,
    clones,
    original: !!cloneInfo.original,
    telegram,
    scannedAt: Date.now(),
  };
  // Память токена: что изменилось с прошлого скана, затем запоминаем текущий снимок.
  const since = compareToLast(result);
  if (since?.changes.length) result.since = since;
  recordSnapshot(result);
  log({
    crawler: "verdict",
    text: `${result.score ?? "-"} ${verdict.replace("_", " ")} · ${reason}`,
    tone: verdict === "CLEAN" || verdict === "OK" ? "ok" : verdict === "TOO_EARLY" ? "info" : "bad",
  });
  const cache = mem().cache;
  cache.delete(address);
  cache.set(address, { result, logs: logs.filter((l) => l.crawler !== "resolver") });
  // Кэш свежих сканов ограничен: Map хранит порядок вставки, самые старые уходят первыми.
  while (cache.size > 2_000) cache.delete(cache.keys().next().value!);
  if (opts.record !== false) remember(result);
  // Каждый вердикт попадает в Track Record: через сутки видно, сбылся ли он.
  trackVerdict(result, opts.src ?? (opts.record === false ? "crawler" : "scan"));
  return result;
}

// Отчёты X-Ray в общий вид для интерфейса: одинаковые строки для EVM и Solana.
function xrayViewEvm(x: XRayReport, ownerActive: boolean): XRayView {
  const live = xrayLive(x, ownerActive);
  const dead = x.powers.length - live.filter((p) => p.key !== "selfdestruct").length;
  const proxy = x.proxy ? ` · proxy (${x.proxy.kind})` : "";
  return {
    kind: "evm",
    summary: `read ${x.selectors} functions from the bytecode${x.unknown ? `, ${x.unknown} unknown` : ""}${x.engine ? " · storage traced (evmole)" : ""}${proxy}${dead > 0 ? ` · ${dead} owner power${dead > 1 ? "s" : ""} dead (ownership renounced)` : ""}`,
    findings: live.map((p) => ({ label: p.label, note: p.note, severity: p.severity, detail: p.fns.length ? p.fns.slice(0, 4).join(", ") : undefined })),
  };
}

function xrayViewSol(r: T22Report): XRayView {
  return {
    kind: "solana",
    summary: r.program === "spl" ? "classic SPL token: no extensions" : `Token-2022 · ${r.extensions.length ? `${r.extensions.length} extension${r.extensions.length > 1 ? "s" : ""} of note` : "metadata only"}`,
    findings: r.extensions.map((e) => ({ label: e.label, note: e.note, severity: e.severity, detail: e.detail })),
  };
}

function devTone(d: DevReport): ScanLog["tone"] {
  const prior = d.launched - 1;
  if ((prior >= 10 && d.graduated === 0) || (d.holdsPct ?? 0) > 10) return "bad";
  if ((prior >= 3 && d.graduated / prior < 0.1) || (d.walletAgeHours ?? 99) < 24) return "warn";
  return "ok";
}

// Лента «recently scanned»: последние 30 сканов, переживают перезапуск.
export interface RecentScan {
  id: string;
  chain: string;
  symbol: string;
  score: number | null;
  verdict: Verdict;
  at: number;
}

function remember(r: ScanResult) {
  const list = recentScans().filter((x) => x.id !== r.id);
  list.unshift({ id: r.id, chain: r.chain, symbol: r.symbol, score: r.score, verdict: r.verdict, at: r.scannedAt });
  setMeta(RECENT_KEY, JSON.stringify(list.slice(0, 30)));
  // Новый скан не затирает свежую сводку из X: за неё уже заплачено.
  const x = savedBuzz(r.id);
  save(x ? { ...r, x } : r);
}

// Полные результаты последних сканов: по ним строится страница /scan/<адрес> и картинка для X.
function savedScans(): ScanResult[] {
  try {
    return JSON.parse(getMeta(SAVED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(r: ScanResult) {
  const list = savedScans().filter((x) => x.id !== r.id);
  list.unshift(r);
  setMeta(SAVED_KEY, JSON.stringify(list.slice(0, SAVED_MAX)));
}

// EVM-адреса сравниваем без учёта регистра: в ссылке и у DexScreener он бывает разным.
export function savedScan(id: string): ScanResult | undefined {
  const evm = id.startsWith("0x");
  const key = evm ? id.toLowerCase() : id;
  return savedScans().find((x) => (evm ? x.id.toLowerCase() : x.id) === key);
}

// Сводка из X, сохранённая с прошлого скана, если она ещё свежая: переживает перезапуск, повторно не платим.
export function savedBuzz(id: string): XBuzz | null {
  const x = savedScan(id)?.x;
  return x && Date.now() - x.at < BUZZ_TTL_MS ? x : null;
}

// Сводка из X пришла позже вердикта — дописываем её в сохранённый скан.
export function attachBuzz(id: string, x: XBuzz) {
  const r = savedScan(id);
  if (r) save({ ...r, x });
}

export function recentScans(): RecentScan[] {
  try {
    return JSON.parse(getMeta(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}
