// CrawlHive Brain — память роя по API: что мы знаем о кошельке, деве и токене по прошлым сканам, и насколько
// честны наши вердикты. Новых сканов не запускает: только walletMem, снимки токенов, сохранённые сканы и Track Record.
// Доступ: бесплатно с лимитом по IP; держателям $CRAWLHIVE (Bearer: сессия сайта или ключ бота chb_/cht_) лимит в
// BRAIN_HOLDER_X раз выше; сверх лимита — оплата за вызов по x402 (USDC на Solana), выручка идёт в байбек как у сканов.
import "server-only";
import type { NextRequest } from "next/server";
import { connection } from "next/server";
import { sessionWallet } from "./auth";
import { botByKey } from "./bots";
import { devProfile } from "./dev-profile";
import { clientIp } from "./http";
import { isHolder } from "./rewards";
import { allowHit, savedScan } from "./scan";
import { tokenSnapshots } from "./scan-memory";
import { walletEntries, walletMemSize, type MemRole } from "./scan-operators";
import { ApiError } from "./store";
import { trackIndex, trackStats } from "./track";
import { paidCall, x402Config, type X402Route } from "./x402";

const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const DAY = 24 * 3600_000;
const WINDOW = 10 * 60_000;
export const BRAIN_BATCH_MAX = 100;
const HOLDER_X = Math.max(1, Number(process.env.BRAIN_HOLDER_X ?? 10) || 10);

// Сколько бесплатных вызовов за 10 минут с одного IP. track без оплаты: это наша же открытая статистика.
export const BRAIN_LIMITS = { lookup: 30, batch: 5, track: 60 } as const;
export type BrainKind = keyof typeof BRAIN_LIMITS;
const PAID: Partial<Record<BrainKind, X402Route>> = { lookup: "brain", batch: "brain-batch" };

export const BRAIN_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT",
  "Access-Control-Expose-Headers": "X-Brain-Tier, X-Brain-Limit, PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
};

export const normAddr = (a: string) => (a.startsWith("0x") ? a.toLowerCase() : a);
export function brainAddress(raw: string | undefined) {
  const a = (raw ?? "").trim();
  if (!SOL_RE.test(a) && !EVM_RE.test(a)) throw new ApiError("Pass a Solana or EVM (0x…) address");
  return a;
}

// ---------- доступ ----------

// Кошелёк держателя из Bearer: ключ бота (chb_/cht_) — кошелёк владельца бота, иначе подписанная сессия сайта.
async function holderOf(req: Request): Promise<string | null> {
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Bearer ")) return null;
  const key = h.slice(7).trim();
  const wallet = key.startsWith("chb_") || key.startsWith("cht_") ? (botByKey(key)?.wallet ?? null) : sessionWallet(req);
  return wallet && (await isHolder(wallet).catch(() => false)) ? wallet : null;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...BRAIN_CORS, "Cache-Control": status === 200 ? "private, max-age=30" : "no-store", ...headers } });

// Обёртка маршрута Brain: оплата x402, если прислали заголовок; иначе бесплатный лимит (у держателя выше);
// лимит кончился — 402 с требованиями оплаты (или 429, если x402 выключен).
export async function brainRoute(req: NextRequest, kind: BrainKind, work: () => unknown | Promise<unknown>): Promise<Response> {
  await connection();
  const paid = PAID[kind];
  const run = async () => {
    try {
      return { ok: true as const, v: await work() };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false as const, r: json({ error: e.message }, e.status) };
      console.error(e);
      return { ok: false as const, r: json({ error: "Internal error" }, 500) };
    }
  };
  const payHeader = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
  if (paid && payHeader && x402Config()) return paidCall(req, paid, { ready: true, work: async () => work() });

  const holder = await holderOf(req);
  const max = BRAIN_LIMITS[kind] * (holder ? HOLDER_X : 1);
  const tier = holder ? "holder" : "free";
  if (allowHit(holder ? `brain:${kind}:w:${holder}` : `brain:${kind}:ip:${clientIp(req)}`, max, WINDOW)) {
    const res = await run();
    return res.ok ? json(res.v, 200, { "X-Brain-Tier": tier, "X-Brain-Limit": `${max}/10min` }) : res.r;
  }
  const need = `Free limit reached (${max} calls per 10 minutes${holder ? " for holders" : ""}).`;
  if (paid && x402Config()) return paidCall(req, paid, { ready: true, need: `${need} Pay per call over x402 to keep going${holder ? "" : ", or hold 100k $CRAWLHIVE for a 10x limit"}.`, work: async () => work() });
  return json({ error: `${need} Try again in a few minutes.` }, 429, { "Retry-After": "120" });
}

// ---------- данные ----------

type Outcome = "rugged" | "dumped" | "survived" | "open" | "untracked";

function outcomeOf(token: string) {
  const e = trackIndex().get(normAddr(token));
  if (!e) return { e, outcome: "untracked" as Outcome };
  const outcome: Outcome = e.anyRugged ? "rugged" : e.anyDumped ? "dumped" : e.done && Date.now() - e.at >= DAY ? "survived" : "open";
  return { e, outcome };
}

// Доля рухнувших среди закрытых исходов по всем вердиктам: с ней сравнивать историю кошелька. Мемкоины
// в основном падают, поэтому «5 из 6 рухнули» само по себе мало значит без этой базы.
let baseCache: { at: number; v: number | null } | null = null;
function baselineDumpRate() {
  if (baseCache && Date.now() - baseCache.at < 60_000) return baseCache.v;
  const by = trackStats().by;
  const settled = by.reduce((s, x) => s + x.settled, 0);
  const v = settled ? Math.round((by.reduce((s, x) => s + x.dumped, 0) / settled) * 1000) / 1000 : null;
  baseCache = { at: Date.now(), v };
  return v;
}

const memory = () => ({ wallets: walletMemSize(), cap: 8000, tokensPerWallet: 20 });

export function walletReport(raw: string) {
  const wallet = brainAddress(raw);
  const list = walletEntries(wallet).reverse();
  const roles: Partial<Record<MemRole, number>> = {};
  const counts = { settled: 0, dumped: 0, rugged: 0, survived: 0, open: 0, untracked: 0 };
  const history = list.map((x) => {
    const { e, outcome } = outcomeOf(x.token);
    roles[x.role] = (roles[x.role] ?? 0) + 1;
    counts[outcome === "rugged" || outcome === "dumped" ? "dumped" : outcome]++;
    if (outcome === "rugged") counts.rugged++;
    if (outcome === "rugged" || outcome === "dumped" || outcome === "survived") counts.settled++;
    return {
      token: x.token,
      chain: x.chain,
      role: x.role,
      symbol: e?.symbol ?? null,
      verdict: e?.verdict ?? null,
      score: e?.score ?? null,
      scannedAt: e ? new Date(e.at).toISOString() : null,
      outcome,
    };
  });
  return {
    wallet,
    seen: list.length > 0,
    tokens: list.length,
    chains: [...new Set(list.map((x) => x.chain))],
    roles,
    outcomes: counts,
    dumpRate: counts.settled ? Math.round((counts.dumped / counts.settled) * 1000) / 1000 : null,
    baselineDumpRate: baselineDumpRate(),
    history,
    memory: memory(),
    notes: "Seen means the swarm met this wallet as a sniper, bundle, dev, funder or linked holder while scanning other tokens. Dumped means the token fell 50%+ within 24h of the scan (rugged included). Compare dumpRate with baselineDumpRate: most memecoins fall.",
  };
}

// Проверка тела пакетного запроса до лимита и оплаты.
export function parseWallets(input: unknown) {
  const list = (input as { wallets?: unknown })?.wallets;
  if (!Array.isArray(list) || !list.length) throw new ApiError('Body must be {"wallets": ["address", …]}');
  if (list.length > BRAIN_BATCH_MAX) throw new ApiError(`At most ${BRAIN_BATCH_MAX} wallets per call`);
  return [...new Set(list.map((w) => brainAddress(String(w))))];
}

export function walletsReport(wallets: string[]) {
  const results = wallets.map((w) => {
    const r = walletReport(w);
    return { wallet: w, seen: r.seen, tokens: r.tokens, roles: r.roles, outcomes: r.outcomes, dumpRate: r.dumpRate };
  });
  return { checked: results.length, seen: results.filter((r) => r.seen).length, baselineDumpRate: baselineDumpRate(), results, memory: memory() };
}

export async function devReport(raw: string) {
  const dev = brainAddress(raw);
  const mem = walletEntries(dev).reverse();
  const launches = mem
    .filter((x) => x.role === "dev")
    .map((x) => {
      const { e, outcome } = outcomeOf(x.token);
      return { token: x.token, chain: x.chain, symbol: e?.symbol ?? null, verdict: e?.verdict ?? null, outcome };
    });
  // История запусков на pump.fun (Helius + кривые) — только для Solana и только если она достаётся; кэш 6 ч.
  let pumpfun: Awaited<ReturnType<typeof devProfile>> | null = null;
  let pumpfunError: string | null = null;
  if (SOL_RE.test(dev)) {
    try {
      pumpfun = await devProfile(dev);
    } catch (e) {
      pumpfunError = (e as Error).message;
    }
  }
  if (!launches.length && !mem.length && !pumpfun?.coins.length) throw new ApiError("The hive has no memory of this wallet as a dev yet", 404);
  return {
    dev,
    seenAsDev: launches.length,
    launches,
    otherRoles: [...new Set(mem.filter((x) => x.role !== "dev").map((x) => x.role))],
    pumpfun: pumpfun && { launched: pumpfun.launched, graduated: pumpfun.graduated, verdict: pumpfun.verdict, summary: pumpfun.summary, coins: pumpfun.coins.slice(0, 50) },
    pumpfunError,
    baselineDumpRate: baselineDumpRate(),
  };
}

export function tokenReport(raw: string) {
  const token = brainAddress(raw);
  const saved = savedScan(token);
  const { e, outcome } = outcomeOf(token);
  const { snaps, since } = tokenSnapshots(token);
  if (!saved && !e && !snaps.length) throw new ApiError("The hive has no memory of this token yet. Scan it once at crawlhive.xyz and ask again.", 404);
  const last = snaps[snaps.length - 1];
  const latest = saved
    ? { verdict: saved.verdict, score: saved.score, reason: saved.reason, scannedAt: new Date(saved.scannedAt).toISOString() }
    : last
      ? { verdict: last.verdict, score: last.score, reason: null, scannedAt: new Date(last.at).toISOString() }
      : { verdict: e!.verdict, score: e!.score, reason: null, scannedAt: new Date(e!.at).toISOString() };
  return {
    token: saved?.id ?? token,
    chain: saved?.chain ?? e?.chain ?? null,
    symbol: saved?.symbol ?? e?.symbol ?? null,
    latest,
    since: since ? { prevAt: new Date(since.prevAt).toISOString(), changes: since.changes } : null,
    snapshots: snaps.map((s) => ({ ...s, at: new Date(s.at).toISOString() })),
    outcome: e
      ? { status: outcome, verdictAtScan: e.verdict, scannedAt: new Date(e.at).toISOString(), peakPct: e.peakPct ?? null, lowPct: e.lowPct ?? null, lastPct: e.lastPct ?? null }
      : { status: outcome },
    scanUrl: `https://crawlhive.xyz/scan/${saved?.id ?? token}`,
  };
}

export function trackReport() {
  const t = trackStats();
  return {
    windowHours: t.windowHours,
    dumpThresholdPct: t.dumpPct,
    since: t.since ? new Date(t.since).toISOString() : null,
    tracked: t.total,
    verdicts: t.by.map((v) => ({ ...v, dumpRate: v.settled ? Math.round((v.dumped / v.settled) * 1000) / 1000 : null })),
    baselineDumpRate: baselineDumpRate(),
    notes: "Each verdict is graded 24h after the scan. Dumped = fell 50%+ (rugged included). CLEAN tokens dump too: most memecoins do. Read the gap between verdicts, not any single number.",
  };
}
