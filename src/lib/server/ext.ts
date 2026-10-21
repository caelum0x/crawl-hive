// Браузерное расширение CrawlHive: по адресу страницы терминала (GMGN, DexScreener, Axiom, Photon, pump.fun, FOMO,
// Birdeye, Solscan, BscScan, BaseScan) находим токен на Solana, BNB Chain, Robinhood Chain или Base — у DexScreener, Axiom и Photon в адресе пара, её разворачиваем через
// DexScreener — и отдаём короткий вердикт для плашки. Скан общий с сайтом: тот же кэш, тот же лимит по IP.
import "server-only";
import { runScan, type ScanResult } from "./scan";
import { ApiError } from "./store";

const CHAIN_HINT: [RegExp, string][] = [
  [/\/(sol|solana)\//i, "solana"],
  [/\/(bsc|bnb)\//i, "bsc"],
  [/\/(robinhood|rh)\//i, "robinhood"],
  [/\/base\//i, "base"],
  [/basescan\.org/i, "base"],
  [/bscscan\.com|four\.meme/i, "bsc"],
  [/pump\.fun|axiom\.trade|photon-sol|bullx|padre|letsbonk|bonk\.fun/i, "solana"],
];
// Не только base58: DexScreener пишет адрес пары в URL маленькими буквами (там бывает «l»), пару разворачивает DexScreener.
const ADDR = /0x[a-fA-F0-9]{40}|[0-9A-Za-z]{32,44}/g;

export function parsePageUrl(raw: string): { address: string; chain?: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  // Birdeye и часть терминалов пишут сеть в параметре (?chain=bsc), его тоже учитываем.
  const net = u.searchParams.get("chain") ?? u.searchParams.get("network") ?? "";
  const hay = `${u.hostname}${u.pathname}${net ? `/${net}/` : ""}`;
  const found: string[] = [...(u.pathname.match(ADDR) ?? []), ...(u.search.match(ADDR) ?? [])];
  const address = found.pop();
  if (!address) return null;
  const chain = CHAIN_HINT.find(([re]) => re.test(hay))?.[1] ?? (address.startsWith("0x") ? undefined : "solana");
  return { address, chain };
}

// Адрес мог быть парой: DexScreener скажет, какой токен в ней базовый.
async function tokenOf(address: string, chain?: string): Promise<{ token: string; chain?: string }> {
  const dsChain = chain === "robinhood" ? "robinhood" : chain;
  if (!dsChain) return { token: address, chain };
  const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${dsChain}/${address}`, { signal: AbortSignal.timeout(6000) }).catch(() => null);
  const j = (r?.ok ? await r.json().catch(() => null) : null) as { pairs?: { baseToken?: { address?: string } }[]; pair?: { baseToken?: { address?: string } } } | null;
  const base = j?.pair?.baseToken?.address ?? j?.pairs?.[0]?.baseToken?.address;
  return { token: base ?? address, chain };
}

export async function extVerdict(input: { url?: string; q?: string; chain?: string }) {
  const parsed = input.url ? parsePageUrl(input.url) : input.q ? { address: input.q.trim(), chain: input.chain } : null;
  if (!parsed) throw new ApiError("No token on this page");
  const { token, chain } = await tokenOf(parsed.address, parsed.chain ?? input.chain);
  if (!/^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(token)) throw new ApiError("No token on this page");
  const r: ScanResult = await runScan(token, () => {}, chain);
  const flags = [...r.factors].filter((f) => f.impact < 0).sort((a, b) => a.impact - b.impact).slice(0, 8).map((f) => ({ label: f.label, note: f.note }));
  const op = r.operators?.operators[0];
  // Мини-карта для плашки: крупнейшие кошельки без спонсоров-хабов, с группой и отметкой «уже встречался».
  const map = (r.operators?.map?.nodes ?? [])
    .filter((n) => !n.hub)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 12)
    .map((n) => ({ pct: n.pct, g: n.g, seen: n.seen?.tokens ?? 0 }));
  return {
    id: r.id,
    chain: r.chain,
    symbol: r.symbol,
    score: r.score,
    verdict: r.verdict,
    reason: r.reason,
    flags,
    snipers: r.snipers ? { wallets: r.snipers.wallets, holdPct: r.snipers.holdPct, sold: r.snipers.sold } : null,
    operator: op ? { wallets: op.wallets, pct: op.pct, roles: op.roles } : null,
    devSnipers: r.operators?.devSnipers ?? 0,
    since: r.since ? { prevAt: r.since.prevAt, changes: r.since.changes.slice(0, 4) } : null,
    map: map.length >= 3 ? map : null,
    operators: r.operators?.operators.length ?? 0,
    history: r.operators?.history ?? null,
    trust: r.trust ?? null,
    larp: r.larp ? { verdict: r.larp.verdict, score: r.larp.score, url: r.larp.url } : null,
    lp: r.lp ? { status: r.lp.status, lockedPct: r.lp.lockedPct, unlockAt: r.lp.unlockAt ?? null, locker: r.lp.locker ?? null } : null,
    dev: r.dev ? { creator: r.dev.creator, launched: r.dev.launched, graduated: r.dev.graduated } : null,
    url: `https://crawlhive.xyz/scan/${r.id}`,
    scannedAt: r.scannedAt,
  };
}
