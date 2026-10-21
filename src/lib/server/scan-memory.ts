// Память токенов: после каждого скана сохраняем короткий снимок, а при следующем скане того же токена
// показываем, что изменилось (оценка, вердикт, ликвидность, доли топ-10, снайперов и оператора, LP, Larpcheck).
// Хранится в meta tokenSnaps: { токен: [снимки, новые в конце] }, без сетевых запросов.
import "server-only";
import { getMeta, setMeta } from "./store";
import type { ScanResult } from "./scan";

export interface Snap {
  at: number;
  score: number | null;
  verdict: string;
  liq?: number;
  fdv?: number;
  top10?: number;
  holders?: number;
  snipers?: number; // % у снайперов сейчас
  operator?: number; // % у крупнейшего оператора
  lp?: string;
  lpPct?: number | null;
  larp?: string;
}

export interface SinceChange {
  label: string;
  from: string;
  to: string;
  tone: "bad" | "good" | "info";
}
export interface SinceLast {
  prevAt: number;
  changes: SinceChange[];
}

const KEY = "tokenSnaps";
const PER_TOKEN = 10;
const MAX_TOKENS = 5000;
const RANK: Record<string, number> = { DANGER: 0, RISKY: 1, TOO_EARLY: 2, OK: 3, CLEAN: 4 };

const idOf = (id: string) => (id.startsWith("0x") ? id.toLowerCase() : id);
let cache: Record<string, Snap[]> | null = null;
const load = (): Record<string, Snap[]> => {
  if (cache) return cache;
  try {
    cache = JSON.parse(getMeta(KEY) ?? "{}");
  } catch {
    cache = {};
  }
  return cache!;
};

function snapOf(r: ScanResult): Snap {
  return {
    at: r.scannedAt,
    score: r.score,
    verdict: r.verdict,
    liq: r.market?.liquidityUsd,
    fdv: r.market?.fdv,
    top10: r.holders?.top10 ?? r.evm?.top10,
    holders: r.evm?.holders,
    snipers: r.snipers?.holdPct,
    operator: r.operators?.operators[0]?.pct,
    lp: r.lp?.status,
    lpPct: r.lp?.lockedPct,
    larp: r.larp?.verdict,
  };
}

const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${Math.round(n)}`);
const pct = (n: number) => `${n.toFixed(1)}%`;

export function compareToLast(r: ScanResult): SinceLast | undefined {
  const list = load()[idOf(r.id)];
  const prev = list?.[list.length - 1];
  return prev ? diff(prev, snapOf(r)) : undefined;
}

// Снимки токена для Brain API: старые первыми, и что изменилось между двумя последними.
export function tokenSnapshots(id: string): { snaps: Snap[]; since?: SinceLast } {
  const snaps = load()[idOf(id)] ?? [];
  return { snaps, since: snaps.length > 1 ? diff(snaps[snaps.length - 2], snaps[snaps.length - 1]) : undefined };
}

function diff(prev: Snap, now: Snap): SinceLast {
  const changes: SinceChange[] = [];
  if (prev.verdict !== now.verdict)
    changes.push({ label: "Verdict", from: prev.verdict.replace("_", " "), to: now.verdict.replace("_", " "), tone: (RANK[now.verdict] ?? 2) < (RANK[prev.verdict] ?? 2) ? "bad" : "good" });
  if (prev.score != null && now.score != null && Math.abs(now.score - prev.score) >= 5)
    changes.push({ label: "Score", from: String(prev.score), to: String(now.score), tone: now.score < prev.score ? "bad" : "good" });
  if (prev.liq && now.liq != null && Math.abs(now.liq - prev.liq) / prev.liq >= 0.25)
    changes.push({ label: "Liquidity", from: usd(prev.liq), to: usd(now.liq), tone: now.liq < prev.liq ? "bad" : "good" });
  // Рост доли у концентрированных держателей — плохо, снижение — хорошо.
  for (const [label, a, b] of [
    ["Top 10 hold", prev.top10, now.top10],
    ["Snipers hold", prev.snipers, now.snipers],
    ["Biggest operator", prev.operator, now.operator],
  ] as [string, number | undefined, number | undefined][]) {
    if (a != null && b != null && Math.abs(b - a) >= 3) changes.push({ label, from: pct(a), to: pct(b), tone: b > a ? "bad" : "good" });
  }
  if (prev.lp && now.lp && prev.lp !== now.lp) {
    const safe = (s: string) => s === "burned" || s === "locked";
    changes.push({ label: "LP", from: prev.lp, to: now.lp, tone: safe(now.lp) && !safe(prev.lp) ? "good" : !safe(now.lp) && safe(prev.lp) ? "bad" : "info" });
  }
  if (prev.larp && now.larp && prev.larp !== now.larp)
    changes.push({ label: "Larpcheck", from: prev.larp, to: now.larp, tone: /LARP|SCAM/.test(now.larp) ? "bad" : /REAL/.test(now.larp) ? "good" : "info" });
  return { prevAt: prev.at, changes };
}

export function recordSnapshot(r: ScanResult) {
  if (r.core) return;
  const all = load();
  const id = idOf(r.id);
  const list = all[id] ?? [];
  const last = list[list.length - 1];
  // Повтор из кэша свежего скана не плодит одинаковые снимки.
  if (last && r.scannedAt - last.at < 60_000) return;
  delete all[id];
  all[id] = [...list, snapOf(r)].slice(-PER_TOKEN);
  const keys = Object.keys(all);
  // Объект хранит порядок вставки: самые давно обновлённые токены — первые.
  for (let i = 0; i < keys.length - MAX_TOKENS; i++) delete all[keys[i]];
  setMeta(KEY, JSON.stringify(all));
}
