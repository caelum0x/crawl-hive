// Track Record: проверяем сканер реальностью. Каждый вердикт (скан пользователя, проверка безопасности
// краулера, Launch Radar, агент через MCP) запоминается вместе с ценой и ликвидностью на момент скана.
// Следующие 24 часа цену замеряем каждые 10 минут. Итог честный и без подбора примеров: какая доля токенов
// с каждым вердиктом рухнула (−50% от цены скана) или потеряла ликвидность (руг) за сутки.
import "server-only";
import { getMeta, setMeta } from "./store";
import { bestPairs } from "./crawl/dexscreener";

const KEY = "track";
const MAX = 4000;
const WINDOW_MS = 24 * 3600_000;
const SAMPLE_MS = 10 * 60_000;
const DUMP_PCT = -50; // рухнул: минимум за сутки на 50% ниже цены скана
const RUG_LIQ = 0.2; // руг: ликвидность упала до 20% от исходной или пара исчезла

export type TrackVerdict = "CLEAN" | "OK" | "RISKY" | "DANGER" | "TOO_EARLY";

export interface TrackEntry {
  id: string; // адрес токена
  chain: string;
  symbol: string;
  verdict: TrackVerdict;
  score: number | null;
  src: "scan" | "crawler" | "radar" | "agent";
  at: number;
  price0: number;
  liq0: number;
  fdv0?: number; // капитализация на момент скана (для Replay: «$41k → $392k»)
  peakPct?: number;
  peakAt?: number; // когда был пик
  name?: string;
  lowPct?: number;
  lastPct?: number;
  liqNow?: number;
  sampledAt?: number;
  missing?: number; // сколько замеров подряд пара не находилась
  done?: boolean;
  dumped?: boolean;
  rugged?: boolean;
}

function all(): TrackEntry[] {
  try {
    return JSON.parse(getMeta(KEY) ?? "[]");
  } catch {
    return [];
  }
}
const save = (l: TrackEntry[]) => setMeta(KEY, JSON.stringify(l.slice(0, MAX)));

// Один токен — одна запись за окно: повторные сканы того же токена не накручивают статистику.
export function trackVerdict(r: {
  id: string;
  chain: string;
  symbol: string;
  verdict: TrackVerdict;
  score: number | null;
  name?: string;
  market?: { priceUsd?: number; liquidityUsd?: number; fdv?: number };
}, src: TrackEntry["src"]) {
  const price0 = Number(r.market?.priceUsd);
  const liq0 = Number(r.market?.liquidityUsd);
  if (!(price0 > 0) || !(liq0 > 0) || !["solana", "robinhood", "bsc", "base"].includes(r.chain)) return;
  const list = all();
  const now = Date.now();
  const prev = list.findIndex((e) => e.id === r.id && now - e.at < WINDOW_MS);
  // Настоящий вердикт вытесняет «слишком рано»: судить сканер по TOO_EARLY нечестно в обе стороны.
  if (prev >= 0) {
    if (list[prev].verdict !== "TOO_EARLY" || r.verdict === "TOO_EARLY") return;
    list.splice(prev, 1);
  }
  const fdv0 = Number(r.market?.fdv) > 0 ? Math.round(Number(r.market?.fdv)) : undefined;
  list.unshift({ id: r.id, chain: r.chain, symbol: r.symbol, name: r.name?.slice(0, 40), verdict: r.verdict, score: r.score, src, at: now, price0, liq0, ...(fdv0 ? { fdv0 } : {}) });
  save(list);
}

// Замер цены открытых записей: пачками по 30 адресов на сеть.
export async function sampleTrack() {
  const list = all();
  const now = Date.now();
  const open = list.filter((e) => !e.done && now - (e.sampledAt ?? e.at) >= SAMPLE_MS - 30_000);
  if (!open.length) return 0;
  const byChain = new Map<string, TrackEntry[]>();
  for (const e of open) byChain.set(e.chain, [...(byChain.get(e.chain) ?? []), e]);
  for (const [chain, entries] of byChain) {
    let pairs: Awaited<ReturnType<typeof bestPairs>>;
    try {
      pairs = await bestPairs(chain, entries.map((e) => e.id));
    } catch (e) {
      console.warn("[track] dexscreener failed:", (e as Error).message);
      continue;
    }
    for (const e of entries) {
      const p = pairs.get(e.id);
      const price = Number(p?.priceUsd);
      e.sampledAt = now;
      if (!p || !(price > 0)) {
        // Пара пропала: три замера подряд (30 минут) — считаем, что ликвидность вытащили.
        e.missing = (e.missing ?? 0) + 1;
        if (e.missing >= 3) Object.assign(e, { rugged: true, dumped: true, lowPct: -100, lastPct: -100 });
      } else {
        e.missing = 0;
        const pct = Math.round(((price - e.price0) / e.price0) * 1000) / 10;
        if (e.peakPct === undefined || pct > e.peakPct) e.peakAt = now;
        e.peakPct = Math.max(e.peakPct ?? pct, pct);
        e.lowPct = Math.min(e.lowPct ?? pct, pct);
        e.lastPct = pct;
        e.liqNow = Math.round(p.liquidity?.usd ?? 0);
        if (e.lowPct <= DUMP_PCT) e.dumped = true;
        // Ликвидность одной пары DexScreener бывает ниже суммы по всем пулам на момент скана, поэтому
        // одно падение ликвидности ругом не считаем — только вместе с падением цены.
        if (e.liqNow < e.liq0 * RUG_LIQ && e.lowPct <= DUMP_PCT) e.rugged = e.dumped = true;
      }
      if (now - e.at >= WINDOW_MS || e.rugged) e.done = true;
    }
  }
  save(list);
  return open.length;
}

// ---------- для страницы ----------

export interface VerdictStats {
  verdict: TrackVerdict;
  tracked: number; // всего с этим вердиктом
  settled: number; // прошли сутки или руг — исход известен
  dumped: number; // рухнули на 50%+ или руг
  rugged: number;
  medianPeak: number | null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function trackStats() {
  const list = all();
  const verdicts: TrackVerdict[] = ["CLEAN", "OK", "RISKY", "DANGER", "TOO_EARLY"];
  const by = verdicts.map((v): VerdictStats => {
    const xs = list.filter((e) => e.verdict === v);
    // Итог считаем только после полных суток с момента скана: руги закрываются раньше, и иначе
    // в первые часы «закрытыми» оказывались бы почти одни руги — ложные 100% в обе стороны.
    const now = Date.now();
    const settled = xs.filter((e) => e.done && now - e.at >= WINDOW_MS);
    return {
      verdict: v,
      tracked: xs.length,
      settled: settled.length,
      dumped: settled.filter((e) => e.dumped).length,
      rugged: settled.filter((e) => e.rugged).length,
      medianPeak: median(settled.map((e) => e.peakPct ?? 0)),
    };
  });
  // «Мы предупреждали»: DANGER/RISKY, которые потом рухнули. «Пропустили»: CLEAN/OK, которые всё равно рухнули.
  const pub = (e: TrackEntry) => ({
    id: e.id,
    chain: e.chain,
    symbol: e.symbol,
    verdict: e.verdict,
    score: e.score,
    src: e.src,
    at: e.at,
    peakPct: e.peakPct ?? null,
    lowPct: e.lowPct ?? null,
    lastPct: e.lastPct ?? null,
    done: !!e.done,
    dumped: !!e.dumped,
    rugged: !!e.rugged,
  });
  const warned = list.filter((e) => (e.verdict === "DANGER" || e.verdict === "RISKY") && e.dumped).slice(0, 12).map(pub);
  const missed = list.filter((e) => (e.verdict === "CLEAN" || e.verdict === "OK") && e.dumped).slice(0, 12).map(pub);
  const recent = list.slice(0, 40).map(pub);
  return { since: list.length ? list[list.length - 1].at : null, total: list.length, by, warned, missed, recent, windowHours: 24, dumpPct: DUMP_PCT };
}

// Запись по токену для скана, сделанного в момент `at` (бот «через 24 часа» спрашивает, чем кончилось).
export function trackEntry(id: string, at: number) {
  return all().find((e) => e.id === id && Math.abs(e.at - at) < WINDOW_MS);
}

// Вердикты, записанные в окне [from, to): их отпечатки уходят в блокчейн (proof.ts).
export function trackBetween(from: number, to: number) {
  return all().filter((e) => e.at >= from && e.at < to);
}

// ---------- Replay: витрина попаданий, но честная ----------
// Gem Replay — CLEAN/OK, которые за сутки выросли хотя бы вдвое; Rug Replay — DANGER, которые потом рухнули на 90%+
// или потеряли ликвидность. Рядом всегда счётчики промахов: сколько CLEAN/OK всё равно рухнули.
const MAX_SANE_PCT = 4900; // больше ×50 за сутки — почти всегда ошибка цены на момент скана
const MIN_LIQ0 = 2000;

export function replayFeed() {
  const list = all();
  const now = Date.now();
  const sane = (e: TrackEntry) => e.liq0 >= MIN_LIQ0 && (e.peakPct ?? 0) <= MAX_SANE_PCT;
  const good = (e: TrackEntry) => e.verdict === "CLEAN" || e.verdict === "OK";
  const view = (e: TrackEntry) => ({
    id: e.id,
    chain: e.chain,
    symbol: e.symbol,
    name: e.name ?? null,
    verdict: e.verdict,
    score: e.score,
    src: e.src,
    at: e.at,
    fdv0: e.fdv0 ?? null,
    multiple: e.peakPct != null ? Math.round((1 + e.peakPct / 100) * 10) / 10 : null,
    hoursToPeak: e.peakAt ? Math.round(((e.peakAt - e.at) / 3600_000) * 10) / 10 : null,
    lowPct: e.lowPct ?? null,
    rugged: !!e.rugged,
  });
  const gems = list.filter((e) => good(e) && sane(e) && (e.peakPct ?? 0) >= 100).sort((a, b) => (b.peakPct ?? 0) - (a.peakPct ?? 0));
  const rugs = list.filter((e) => e.verdict === "DANGER" && e.liq0 >= MIN_LIQ0 && (e.rugged || (e.lowPct ?? 0) <= -90));
  const settledGood = list.filter((e) => good(e) && e.done && now - e.at >= WINDOW_MS);
  const settledDanger = list.filter((e) => e.verdict === "DANGER" && e.done && now - e.at >= WINDOW_MS);
  return {
    gems: gems.slice(0, 60).map(view),
    rugs: rugs.slice(0, 60).map(view),
    stats: {
      good: settledGood.length,
      goodDoubled: settledGood.filter((e) => sane(e) && (e.peakPct ?? 0) >= 100).length,
      goodDumped: settledGood.filter((e) => e.dumped).length,
      danger: settledDanger.length,
      dangerDumped: settledDanger.filter((e) => e.dumped).length,
      gems: gems.length,
      rugs: rugs.length,
    },
  };
}

// Исходы токенов по адресам (для памяти кошельков: сколько из «их» токенов потом рухнули).
export function trackOutcomes(): Map<string, { dumped: boolean; rugged: boolean; done: boolean }> {
  const m = new Map<string, { dumped: boolean; rugged: boolean; done: boolean }>();
  for (const e of all()) {
    const prev = m.get(e.id);
    m.set(e.id, { dumped: !!e.dumped || !!prev?.dumped, rugged: !!e.rugged || !!prev?.rugged, done: !!e.done || !!prev?.done });
  }
  return m;
}

// Последняя запись Track Record по каждому токену (EVM в нижнем регистре) — для Brain API. Кэш на 30 с:
// пакетный запрос по сотне кошельков не должен разбирать весь журнал на каждый токен.
let indexCache: { at: number; m: Map<string, TrackEntry & { anyDumped: boolean; anyRugged: boolean }> } | null = null;
export function trackIndex() {
  if (indexCache && Date.now() - indexCache.at < 30_000) return indexCache.m;
  const m = new Map<string, TrackEntry & { anyDumped: boolean; anyRugged: boolean }>();
  for (const e of all()) {
    const k = e.id.startsWith("0x") ? e.id.toLowerCase() : e.id;
    const prev = m.get(k);
    if (!prev) m.set(k, { ...e, anyDumped: !!e.dumped, anyRugged: !!e.rugged });
    else {
      prev.anyDumped ||= !!e.dumped;
      prev.anyRugged ||= !!e.rugged;
    }
  }
  indexCache = { at: Date.now(), m };
  return m;
}

// Для ежедневного контента: лучшее попадание CLEAN/OK и самый наглядный пойманный DANGER за окно.
export function dayHighlights(fromMs: number) {
  const list = all().filter((e) => e.at >= fromMs);
  const sane = (e: TrackEntry) => e.liq0 >= MIN_LIQ0 && (e.peakPct ?? 0) <= MAX_SANE_PCT;
  const gem = list.filter((e) => (e.verdict === "CLEAN" || e.verdict === "OK") && sane(e) && (e.peakPct ?? 0) >= 100).sort((a, b) => (b.peakPct ?? 0) - (a.peakPct ?? 0))[0];
  const rug = list.filter((e) => e.verdict === "DANGER" && e.liq0 >= MIN_LIQ0 && (e.rugged || (e.lowPct ?? 0) <= -80)).sort((a, b) => (a.lowPct ?? 0) - (b.lowPct ?? 0))[0];
  const view = (e?: TrackEntry) =>
    e && { id: e.id, chain: e.chain, symbol: e.symbol, name: e.name ?? null, verdict: e.verdict, score: e.score, src: e.src, at: e.at, fdv0: e.fdv0 ?? null, peakPct: e.peakPct ?? null, lowPct: e.lowPct ?? null, rugged: !!e.rugged, hoursToPeak: e.peakAt ? Math.round(((e.peakAt - e.at) / 3600_000) * 10) / 10 : null };
  const by: Record<string, number> = {};
  for (const e of list) by[e.src] = (by[e.src] ?? 0) + 1;
  return { gem: view(gem), rug: view(rug), verdicts: list.length, bySource: by };
}
