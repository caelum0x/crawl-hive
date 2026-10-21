// Paper Trading: рой торгует своими же сигналами на бумажные деньги. Ничего не покупаем по-настоящему:
// берём записи Track Record от Launch Radar (цена на момент скана уже хранится в price0) и считаем,
// что было бы с виртуальными $100 на каждый вердикт. Выход через 24 часа, по первому замеру после окна
// (lastPct), руг = -100%. Рядом базовая линия «покупать всё подряд»: видно, помогает ли фильтр вердиктов.
import "server-only";
import { trackEntries, type TrackEntry } from "./track";

const STAKE = 100;
const WINDOW_MS = 24 * 3600_000;
const CACHE_MS = 5 * 60_000;
const MAX_SANE_PCT = 4900; // как в Replay: больше ×50 за сутки почти всегда ошибка цены на момент скана
const DAY_MS = 24 * 3600_000;

export type PaperStrategyId = "clean" | "cleanOk" | "all";

const STRATEGIES: { id: PaperStrategyId; label: string; note: string; pick: (e: TrackEntry) => boolean }[] = [
  { id: "clean", label: "CLEAN only", note: "Buys only tokens the scanner called CLEAN", pick: (e) => e.verdict === "CLEAN" },
  { id: "cleanOk", label: "CLEAN + OK", note: "Also buys OK, a looser filter", pick: (e) => e.verdict === "CLEAN" || e.verdict === "OK" },
  { id: "all", label: "Buy every radar coin", note: "Baseline: no filter at all, every verdict including DANGER", pick: () => true },
];

export interface PaperTrade {
  id: string;
  chain: string;
  symbol: string;
  verdict: string;
  score: number | null;
  at: number;
  exitAt: number; // для открытых: когда закроется
  status: "closed" | "open" | "rugged";
  retPct: number; // для открытых: нереализованная доходность по последнему замеру
  pnl: number;
  markedAt: number | null; // время замера цены
  in: PaperStrategyId[];
}

export interface PaperStrategy {
  id: PaperStrategyId;
  label: string;
  note: string;
  trades: number; // закрытых
  wins: number;
  winRate: number | null;
  pnl: number;
  invested: number;
  avgRet: number | null;
  medianRet: number | null;
  best: { symbol: string; id: string; retPct: number } | null;
  worst: { symbol: string; id: string; retPct: number } | null;
  rugs: number;
  open: number;
  openPnl: number; // нереализованный итог по открытым
  curve: { day: string; pnl: number }[]; // накопленный реализованный P&L по дню выхода (UTC)
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);

// Превращаем запись Track Record в сделку. null — оценить нельзя (ни одного замера или явный сбой цены).
function toTrade(e: TrackEntry, now: number): PaperTrade | null {
  if (!(e.price0 > 0) || e.lastPct == null) return null;
  if ((e.peakPct ?? 0) > MAX_SANE_PCT || e.lastPct > MAX_SANE_PCT) return null;
  const ret = e.rugged ? -100 : e.lastPct;
  // Закрытой сделку считаем, как и Track Record, только после полных суток: руги закрываются раньше,
  // и иначе в первые часы статистика состояла бы почти из одних ругов.
  const settled = now - e.at >= WINDOW_MS && !!e.done;
  if (now - e.at >= WINDOW_MS && !e.done) return null; // окно прошло, а финального замера ещё нет
  return {
    id: e.id,
    chain: e.chain,
    symbol: e.symbol,
    verdict: e.verdict,
    score: e.score,
    at: e.at,
    exitAt: settled ? (e.sampledAt ?? e.at + WINDOW_MS) : e.at + WINDOW_MS,
    status: e.rugged ? "rugged" : settled ? "closed" : "open",
    retPct: r1(ret),
    pnl: r2((STAKE * ret) / 100),
    markedAt: e.sampledAt ?? null,
    in: STRATEGIES.filter((s) => s.pick(e)).map((s) => s.id),
  };
}

const isClosed = (t: PaperTrade, now: number) => now - t.at >= WINDOW_MS;

function summarize(s: (typeof STRATEGIES)[number], trades: PaperTrade[], now: number, days: string[]): PaperStrategy {
  const mine = trades.filter((t) => t.in.includes(s.id));
  const closed = mine.filter((t) => isClosed(t, now));
  const open = mine.filter((t) => !isClosed(t, now));
  const rets = closed.map((t) => t.retPct);
  const pnl = closed.reduce((n, t) => n + t.pnl, 0);
  const byRet = [...closed].sort((a, b) => b.retPct - a.retPct);
  const pick = (t?: PaperTrade) => (t ? { symbol: t.symbol, id: t.id, retPct: t.retPct } : null);
  // Кривая доходности: реализованный P&L копится по дню выхода, дни без сделок держат прошлое значение.
  const perDay = new Map<string, number>();
  for (const t of closed) perDay.set(dayOf(t.exitAt), (perDay.get(dayOf(t.exitAt)) ?? 0) + t.pnl);
  let acc = 0;
  const curve = days.map((day) => {
    acc += perDay.get(day) ?? 0;
    return { day, pnl: r2(acc) };
  });
  const wins = closed.filter((t) => t.retPct > 0).length;
  return {
    id: s.id,
    label: s.label,
    note: s.note,
    trades: closed.length,
    wins,
    winRate: closed.length ? Math.round((wins / closed.length) * 100) : null,
    pnl: r2(pnl),
    invested: closed.length * STAKE,
    avgRet: rets.length ? r1(rets.reduce((a, b) => a + b, 0) / rets.length) : null,
    medianRet: median(rets) == null ? null : r1(median(rets)!),
    best: pick(byRet[0]),
    worst: pick(byRet[byRet.length - 1]),
    rugs: closed.filter((t) => t.status === "rugged").length,
    open: open.length,
    openPnl: r2(open.reduce((n, t) => n + t.pnl, 0)),
    curve,
  };
}

function compute() {
  const now = Date.now();
  const radar = trackEntries().filter((e) => e.src === "radar");
  let skipped = 0;
  const trades: PaperTrade[] = [];
  for (const e of radar) {
    const t = toTrade(e, now);
    if (t) trades.push(t);
    else skipped++;
  }
  trades.sort((a, b) => b.at - a.at);
  // Дни для кривой: от первого выхода до сегодня, без дыр.
  const exits = trades.filter((t) => isClosed(t, now)).map((t) => t.exitAt);
  const days: string[] = [];
  if (exits.length) {
    for (let d = Date.parse(dayOf(Math.min(...exits))); d <= Date.parse(dayOf(now)); d += DAY_MS) days.push(dayOf(d));
  }
  return {
    since: radar.length ? Math.min(...radar.map((e) => e.at)) : null,
    stake: STAKE,
    windowHours: WINDOW_MS / 3600_000,
    strategies: STRATEGIES.map((s) => summarize(s, trades, now, days)),
    trades: trades.slice(0, 50),
    skipped, // записи радара без замеров цены или со сбоем цены: в расчёт не идут
    updatedAt: now,
  };
}

export type PaperData = ReturnType<typeof compute>;

// Журнал Track Record до 4000 записей, разбор дешёвый, но страницу открывают часто: кэш на 5 минут.
let cache: { at: number; data: PaperData } | null = null;
export function paperStats(): PaperData {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  cache = { at: Date.now(), data: compute() };
  return cache.data;
}
