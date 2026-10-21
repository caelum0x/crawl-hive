// CrawlHive Brain — память роя по API: что мы знаем о кошельке, деве и токене по прошлым сканам, и насколько
// честны наши вердикты. Новых сканов не запускает: только память кошельков и операторы (SQLite, memory-db.ts),
// снимки токенов, сохранённые сканы и Track Record.
// Доступ: бесплатно с лимитом по IP; с ключом (личный chk_, ключ бота chb_/cht_ или сессия сайта) лимит по тарифу
// кошелька: BRAIN_LIMITS × TIER_LIMITS[tier].brainMult (tiers.ts). Сверх лимита — сначала купленные сжиганием
// кредиты (user-burns.ts), потом оплата за вызов по x402 (USDC на Solana), выручка идёт в байбек как у сканов.
import "server-only";
import type { NextRequest } from "next/server";
import { connection } from "next/server";
import { sessionWallet } from "./auth";
import { botByKey } from "./bots";
import { devProfile } from "./dev-profile";
import { clientIp } from "./http";
import { walletByBrainKey } from "./brain-keys";
import { TIER_LIMITS, tierOf, type Tier } from "./tiers";
import { brainCredits, spendBrainCredit } from "./user-burns";
import { allowHit, savedScan } from "./scan";
import { tokenSnapshots } from "./scan-memory";
import { launchesBy, launchOf, memDb, operators, operatorTokens, rowsFor, type Launch } from "./memory-db";
import { walletEntries, walletMemCap, walletMemSize, type MemRole } from "./scan-operators";
import { ApiError } from "./store";
import { trackIndex, trackStats } from "./track";
import { paidCall, x402Config, type X402Route } from "./x402";

const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const DAY = 24 * 3600_000;
const WINDOW = 10 * 60_000;
export const BRAIN_BATCH_MAX = 100;

// Сколько бесплатных вызовов за 10 минут с одного IP. track без оплаты: это наша же открытая статистика.
export const BRAIN_LIMITS = { lookup: 30, batch: 5, track: 60 } as const;
export type BrainKind = keyof typeof BRAIN_LIMITS;
const PAID: Partial<Record<BrainKind, X402Route>> = { lookup: "brain", batch: "brain-batch" };

export const BRAIN_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT",
  "Access-Control-Expose-Headers": "X-Brain-Tier, X-Brain-Limit, X-Brain-Credits, PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
};

export const normAddr = (a: string) => (a.startsWith("0x") ? a.toLowerCase() : a);
export function brainAddress(raw: string | undefined) {
  const a = (raw ?? "").trim();
  if (!SOL_RE.test(a) && !EVM_RE.test(a)) throw new ApiError("Pass a Solana or EVM (0x…) address");
  return a;
}

// ---------- доступ ----------

// Кошелёк из Bearer: личный ключ chk_, ключ бота chb_/cht_ (кошелёк владельца бота) или подписанная сессия сайта.
async function accessOf(req: Request): Promise<{ wallet: string | null; tier: Tier }> {
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Bearer ")) return { wallet: null, tier: "free" };
  const key = h.slice(7).trim();
  const wallet = key.startsWith("chk_") ? walletByBrainKey(key) : key.startsWith("chb_") || key.startsWith("cht_") ? (botByKey(key)?.wallet ?? null) : sessionWallet(req);
  if (!wallet) return { wallet: null, tier: "free" };
  return { wallet, tier: (await tierOf(wallet).catch(() => null))?.tier ?? "free" };
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

  const { wallet, tier } = await accessOf(req);
  const max = BRAIN_LIMITS[kind] * TIER_LIMITS[tier].brainMult;
  if (allowHit(wallet ? `brain:${kind}:w:${wallet}` : `brain:${kind}:ip:${clientIp(req)}`, max, WINDOW)) {
    const res = await run();
    return res.ok ? json(res.v, 200, { "X-Brain-Tier": tier, "X-Brain-Limit": `${max}/10min`, ...(wallet ? { "X-Brain-Credits": String(brainCredits(wallet)) } : {}) }) : res.r;
  }
  // Лимит тарифа кончился: тратим купленные сжиганием кредиты (track бесплатный, его не списываем).
  if (wallet && kind !== "track" && spendBrainCredit(wallet)) {
    const res = await run();
    return res.ok ? json(res.v, 200, { "X-Brain-Tier": tier, "X-Brain-Limit": `${max}/10min`, "X-Brain-Credits": String(brainCredits(wallet)) }) : res.r;
  }
  const need = `Limit reached (${max} calls per 10 minutes on the ${tier} tier).`;
  if (paid && x402Config()) return paidCall(req, paid, { ready: true, need: `${need} Pay per call over x402, or get a key and burn $CRAWLHIVE for calls at crawlhive.xyz/brain.`, work: async () => work() });
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

const memory = () => {
  const cap = walletMemCap();
  return { wallets: walletMemSize(), cap, tokensPerWallet: cap ? 20 : null, store: cap ? "meta" : "sqlite" };
};

// ---------- операторы и риск ----------

// Оператор: кошельки, которые рой видел в одной группе связанных кошельков на 2+ разных токенах (memory-db.ts).
function operatorStats(id: string) {
  const op = operators().byId.get(id);
  const d = memDb();
  if (!op || !d) return null;
  const toks = operatorTokens(d, op.wallets);
  const rows = rowsFor(d, op.wallets);
  const roles: Partial<Record<MemRole, number>> = {};
  for (const r of rows) roles[r.role] = (roles[r.role] ?? 0) + 1;
  const counts = { settled: 0, dumped: 0, rugged: 0, survived: 0, open: 0, untracked: 0 };
  const chains = new Set<string>();
  for (const r of rows) chains.add(r.chain);
  const tokens = toks.map((t) => {
    const { e, outcome } = outcomeOf(t.token);
    counts[outcome === "rugged" || outcome === "dumped" ? "dumped" : outcome]++;
    if (outcome === "rugged") counts.rugged++;
    if (outcome === "rugged" || outcome === "dumped" || outcome === "survived") counts.settled++;
    return { token: t.token, symbol: e?.symbol ?? null, verdict: e?.verdict ?? null, outcome, at: t.at || null };
  });
  const times = toks.map((t) => t.at).filter(Boolean);
  return {
    op,
    roles,
    chains: [...chains],
    tokens,
    outcomes: counts,
    dumpRate: counts.settled ? Math.round((counts.dumped / counts.settled) * 1000) / 1000 : null,
    firstSeen: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastSeen: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

// strong — в операторе есть бандлы (одна транзакция или блок) или деньги дева; иначе кошельки связаны в основном
// общими спонсорами, а это связь, не доказательство общего владельца.
function operatorBrief(wallet: string) {
  const id = operators().byWallet.get(normAddr(wallet));
  const st = id ? operatorStats(id) : null;
  return st ? { id: st.op.id, wallets: st.op.wallets.length, tokens: st.tokens.length, dumpRate: st.dumpRate, settled: st.outcomes.settled, strong: !!(st.roles.bundle || st.roles.dev) } : null;
}

// Ссылка на транзакцию выпуска в обозревателе сети.
const TX_URL: Record<string, string> = { solana: "https://solscan.io/tx/", bsc: "https://bscscan.com/tx/", base: "https://basescan.org/tx/", robinhood: "https://robin.etherscan.io/tx/" };
const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
// Доказательства запуска токена: транзакция выпуска, когда выпущен и когда рой его впервые увидел. Чего нет — null.
function evidence(token: string): { tx: string | null; txUrl: string | null; launchedAt: string | null; seenBySwarmAt: string | null; deployer: string | null; factory: string | null; poolCreator: string | null } | null {
  const d = memDb();
  const l: Launch | null = d ? launchOf(d, token) : null;
  if (!l) return null;
  return { tx: l.tx, txUrl: l.tx && TX_URL[l.chain] ? TX_URL[l.chain] + l.tx : null, launchedAt: iso(l.launchedAt), seenBySwarmAt: iso(l.seenAt), deployer: l.deployer, factory: l.factory, poolCreator: l.poolCreator };
}

// Риск кошелька 0-100. Доля рухнувших токенов стягивается к базе (как будто у кошелька есть ещё PRIOR токенов
// с обычным для мемкоинов исходом): 1 из 1 рухнувших почти ничего не значит, 9 из 10 — значит. Дальше вес роли
// (дев и спонсор весят больше снайпера, связанный держатель меньше всех) и история его оператора.
const PRIOR = 4;
// factory — контракт лаунчпада: выпускает токены за всех, о человеке ничего не говорит, поэтому почти без веса.
const ROLE_W: Record<MemRole, number> = { dev: 1, funder: 0.9, bundle: 0.85, sniper: 0.6, pool: 0.5, holder: 0.4, linked: 0.3, factory: 0.05 };
const shrink = (dumped: number, settled: number, base: number) => (dumped + PRIOR * base) / (settled + PRIOR);
// 0.5 = как у всех мемкоинов, 1 = рухнуло всё, 0 = заметно лучше базы.
const rel = (p: number, base: number) => Math.min(1, Math.max(0, 0.5 + ((p - base) / (1 - base)) * 0.5));

function walletRisk(roles: Partial<Record<MemRole, number>>, c: { settled: number; dumped: number }, op: ReturnType<typeof operatorBrief>) {
  const base = baselineDumpRate();
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const keys = Object.keys(roles);
  if (keys.length && keys.every((k) => k === "factory"))
    return { score: null, level: "unknown" as const, reasons: [`Launchpad or factory contract on ${roles.factory} coin${(roles.factory ?? 0) > 1 ? "s" : ""}: it creates tokens for many deployers, so its record says nothing about one person`] };
  if (base == null || (!c.settled && !op?.settled)) return { score: null, level: "unknown" as const, reasons: ["Not enough graded coins for this wallet yet"] };
  const p = shrink(c.dumped, c.settled, base);
  const top = (Object.keys(roles) as MemRole[]).sort((a, b) => ROLE_W[b] - ROLE_W[a])[0];
  const w = top ? ROLE_W[top] : 0.3;
  // Оператор, связанный только общими спонсорами, весит втрое меньше бандла или денег дева: связь, а не доказательство.
  const raw = op?.settled ? rel(shrink(op.settled * (op.dumpRate ?? 0), op.settled, base), base) : 0.5;
  const o = op && !op.strong ? 0.5 + (raw - 0.5) / 3 : raw;
  const score = Math.round(100 * (0.6 * rel(p, base) + 0.25 * w + 0.15 * o));
  const reasons: string[] = [];
  if (c.settled) reasons.push(`${c.dumped} of ${c.settled} graded coins dumped (baseline ${pct(base)})`);
  if (c.settled < 3) reasons.push("Few graded coins, score pulled toward the baseline");
  if (roles.dev) reasons.push(`Dev on ${roles.dev} coin${roles.dev > 1 ? "s" : ""}`);
  if (roles.funder) reasons.push(`Funded linked wallets on ${roles.funder} coin${roles.funder > 1 ? "s" : ""}`);
  if (roles.bundle) reasons.push(`Bundled on ${roles.bundle} coin${roles.bundle > 1 ? "s" : ""}`);
  if (roles.sniper) reasons.push(`Sniped ${roles.sniper} coin${roles.sniper > 1 ? "s" : ""}`);
  if (op)
    reasons.push(
      op.strong
        ? `Part of operator ${op.id}: ${op.wallets} wallets across ${op.tokens} coins (bundles or dev money)${op.dumpRate != null ? `, ${pct(op.dumpRate)} dumped` : ""}`
        : `Connected to group ${op.id} by shared funders: ${op.wallets} wallets across ${op.tokens} coins${op.dumpRate != null ? `, ${pct(op.dumpRate)} dumped` : ""}. A connection, not proof of common control`,
    );
  if (roles.factory) reasons.push(`Also a launchpad or factory contract on ${roles.factory} coin${roles.factory > 1 ? "s" : ""}`);
  if (roles.pool) reasons.push(`Created the pool on ${roles.pool} coin${roles.pool > 1 ? "s" : ""}`);
  return { score, level: score >= 65 ? ("high" as const) : score >= 50 ? ("medium" as const) : ("low" as const), reasons };
}

export function operatorReport(raw: string) {
  const id = (raw ?? "").trim();
  if (!/^op_[a-f0-9]{12}$/.test(id)) throw new ApiError("Pass an operator id like op_1a2b3c4d5e6f");
  const st = operatorStats(id);
  if (!st) throw new ApiError("No such operator. Operators are rebuilt every 10 minutes; ids can change when two operators merge.", 404);
  return {
    id,
    wallets: st.op.wallets.length,
    members: st.op.wallets.slice(0, 200),
    tokens: st.tokens.length,
    chains: st.chains,
    roles: st.roles,
    outcomes: st.outcomes,
    dumpRate: st.dumpRate,
    baselineDumpRate: baselineDumpRate(),
    firstSeen: st.firstSeen,
    lastSeen: st.lastSeen,
    coins: st.tokens.slice(0, 100),
    linkedBy: st.roles.bundle || st.roles.dev ? "bundles or dev money (strong)" : "mostly shared funders (a connection, not proof of common control)",
    notes: "An operator is a set of wallets the swarm saw linked together on 2 or more different coins. Links come from the same transaction or block (bundle), direct transfers, dev money, or a shared funder. A shared funder is a connection, not proof of common control. Ids are stable until two operators merge.",
  };
}

export function walletReport(raw: string) {
  const wallet = brainAddress(raw);
  const list = walletEntries(wallet).reverse();
  const operator = operatorBrief(wallet);
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
      ...(x.role === "dev" || x.role === "factory" || x.role === "pool" ? { evidence: evidence(x.token) } : {}),
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
    risk: walletRisk(roles, counts, operator),
    operator,
    history,
    memory: memory(),
    notes: "Seen means the swarm met this wallet as a sniper, bundle, dev (the wallet that signed the launch), factory (a launchpad contract that creates tokens for many people), pool creator, funder or linked holder while scanning other tokens. Linked by a shared funder is a connection, not proof of common control. Dumped means the token fell 50%+ within 24h of the scan (rugged included). Compare dumpRate with baselineDumpRate: most memecoins fall.",
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
    return { wallet: w, seen: r.seen, tokens: r.tokens, roles: r.roles, outcomes: r.outcomes, dumpRate: r.dumpRate, risk: r.risk, operator: r.operator };
  });
  return { checked: results.length, seen: results.filter((r) => r.seen).length, highRisk: results.filter((r) => r.risk.level === "high").length, operators: [...new Set(results.map((r) => r.operator?.id).filter(Boolean))], baselineDumpRate: baselineDumpRate(), results, memory: memory() };
}

export async function devReport(raw: string) {
  const dev = brainAddress(raw);
  const mem = walletEntries(dev).reverse();
  const d = memDb();
  // Запуски этого кошелька как настоящего создателя: из памяти ролей и из записанных доказательств запуска.
  const devTokens = new Map(mem.filter((x) => x.role === "dev").map((x) => [x.token, x.chain]));
  for (const l of d ? launchesBy(d, dev, "deployer") : []) if (!devTokens.has(l.token)) devTokens.set(l.token, l.chain);
  const launches = [...devTokens].map(([token, chain]) => {
    const { e, outcome } = outcomeOf(token);
    return { token, chain, symbol: e?.symbol ?? null, verdict: e?.verdict ?? null, outcome, evidence: evidence(token) };
  });
  // Контракт лаунчпада: выпускал токены за других. Его «запуски» не про одного человека — показываем, кто их подписал.
  const asFactory = [...new Set([...mem.filter((x) => x.role === "factory").map((x) => x.token), ...(d ? launchesBy(d, dev, "factory").map((l) => l.token) : [])])];
  const factory = asFactory.length
    ? {
        coins: asFactory.length,
        deployers: [...new Set(asFactory.map((t) => evidence(t)?.deployer).filter((x): x is string => !!x))].slice(0, 100),
        note: "This address is a launchpad or factory contract. It creates tokens for many different deployers, so these coins are not one person's launches.",
      }
    : null;
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
  if (!launches.length && !mem.length && !pumpfun?.coins.length && !factory) throw new ApiError("The hive has no memory of this wallet as a dev yet", 404);
  return {
    dev,
    seenAsDev: launches.length,
    launches,
    factory,
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
