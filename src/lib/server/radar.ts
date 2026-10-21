// Launch Radar: платформа сама сканирует свежие запуски (новые профили и бусты DexScreener на Solana и
// Robinhood Chain) и показывает вердикты всем — с задержкой. Владельцы краулеров получают такие находки
// в момент появления, поэтому лента заодно ведёт к спавну. Скан без X: Grok не вызывается, тратится только RPC.
// Здесь же раз в 10 минут замеряются цены для Track Record.
import "server-only";
import { getMeta, setMeta } from "./store";
import { bestPairs, latestBoosts, latestProfiles } from "./crawl/dexscreener";
import { runScan } from "./scan";
import { sampleTrack } from "./track";

const KEY = "radar";
const MAX = 150;
const TICK_MS = 3 * 60_000;
const PER_TICK = 4;
const SCAN_MS = 35_000;
const MIN_LIQ = 5_000;
const MIN_AGE_H = 0.6; // моложе 30 минут сканер честно отвечает TOO_EARLY — такие ждём
const MAX_AGE_H = 24;
const RECHECK_MS = 45 * 60_000; // TOO_EARLY пересканируем, когда токен подрастёт
const CHAINS = new Set(["solana", "robinhood", "bsc", "base"]);
export const RADAR_DELAY_MS = Number(process.env.RADAR_DELAY_MIN ?? 10) * 60_000;

export interface RadarEntry {
  id: string;
  chain: string;
  symbol: string;
  name: string;
  verdict: string;
  score: number | null;
  reason: string;
  flags: string[];
  liq: number;
  fdv: number;
  ageH: number | null;
  at: number;
  img?: string;
}

function all(): RadarEntry[] {
  try {
    return JSON.parse(getMeta(KEY) ?? "[]");
  } catch {
    return [];
  }
}

const g = globalThis as unknown as { __crawlhiveRadar?: { started: boolean; day: string; scans: number; busy: boolean } };
const st = () => (g.__crawlhiveRadar ??= { started: false, day: "", scans: 0, busy: false });

async function tick() {
  const s = st();
  if (s.busy) return;
  const day = new Date().toISOString().slice(0, 10);
  if (s.day !== day) Object.assign(s, { day, scans: 0 });
  const limit = Number(process.env.RADAR_DAILY ?? 500);
  if (s.scans >= limit) return;
  s.busy = true;
  try {
    const [profiles, boosts] = await Promise.all([latestProfiles().catch(() => []), latestBoosts().catch(() => [])]);
    const now0 = Date.now();
    const seen = new Set(all().filter((e) => e.verdict !== "TOO_EARLY" || now0 - e.at < RECHECK_MS).map((e) => e.id));
    const cands = new Map<string, string[]>();
    const icons = new Map<string, string>();
    for (const t of [...(profiles ?? []), ...(boosts ?? [])]) {
      if (t.icon && !icons.has(t.tokenAddress)) icons.set(t.tokenAddress, t.icon);
      if (!CHAINS.has(t.chainId) || seen.has(t.tokenAddress)) continue;
      const list = cands.get(t.chainId) ?? [];
      if (!list.includes(t.tokenAddress)) list.push(t.tokenAddress);
      cands.set(t.chainId, list);
    }
    // Свежие и с настоящей ликвидностью: пустые пары и старые токены радару не интересны.
    const picks: { chain: string; id: string; age: number; img?: string }[] = [];
    for (const [chain, ids] of cands) {
      const pairs = await bestPairs(chain, ids.slice(0, 60)).catch(() => new Map());
      for (const id of ids) {
        const p = pairs.get(id);
        const age = p?.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3600_000 : null;
        if (!p || (p.liquidity?.usd ?? 0) < MIN_LIQ || age === null || age < MIN_AGE_H || age > MAX_AGE_H) continue;
        picks.push({ chain, id, age, img: icons.get(id) ?? p.info?.imageUrl });
      }
    }
    picks.sort((a, b) => a.age - b.age);
    for (const p of picks.slice(0, Math.min(PER_TICK, limit - s.scans))) {
      s.scans++;
      try {
        const r = await Promise.race([
          runScan(p.id, () => {}, p.chain, { record: false, src: "radar" }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("radar scan timed out")), SCAN_MS)),
        ]);
        const entry: RadarEntry = {
          id: r.id,
          chain: r.chain,
          symbol: r.symbol,
          name: r.name,
          verdict: r.verdict,
          score: r.score,
          reason: r.reason.slice(0, 160),
          flags: r.factors.filter((f) => f.impact < 0).map((f) => f.label).slice(0, 4),
          liq: Math.round(r.market?.liquidityUsd ?? 0),
          fdv: Math.round(r.market?.fdv ?? 0),
          ageH: r.market?.ageHours != null ? Math.round(r.market.ageHours * 10) / 10 : null,
          at: Date.now(),
          img: p.img?.replace(/width=\d+&height=\d+/, "width=128&height=128"),
        };
        setMeta(KEY, JSON.stringify([entry, ...all().filter((e) => e.id !== entry.id)].slice(0, MAX)));
      } catch (e) {
        console.warn("[radar] scan failed", p.id, (e as Error).message);
      }
    }
  } catch (e) {
    console.warn("[radar]", (e as Error).message);
  } finally {
    s.busy = false;
  }
}

// Все записи без задержки: для оповещений в Telegram (владельцам краулеров — сразу, остальным — после задержки).
export const radarAll = () => all();

// Связка с Narrative Radar: монета на тикере нарратива, созданная не раньше чем за час до его находки, — «радар
// нарративов назвал её заранее». Читаем нарративы прямо из хранилища, без импорта модуля (нет циклов).
const NARR_SPAN = 7 * 24 * 3600_000;
export function narrativeIndex() {
  try {
    const list = JSON.parse(getMeta("narrRadar") ?? "[]") as { id: string; ticker: string; title: string; at: number; takenFdv?: number }[];
    const now = Date.now();
    const by = new Map<string, { id: string; title: string; at: number }>();
    for (const n of list) if (now - n.at < NARR_SPAN && (n.takenFdv ?? 0) < Number(process.env.NARR_TAKEN_FDV ?? 500_000) && !by.has(n.ticker)) by.set(n.ticker, { id: n.id, title: n.title, at: n.at });
    return by;
  } catch {
    return new Map<string, { id: string; title: string; at: number }>();
  }
}
const sym = (s: string) => s.toUpperCase().replace(/^\$/, "").replace(/[^A-Z0-9]/g, "");
export function withNarrative(e: RadarEntry, idx = narrativeIndex()) {
  const n = idx.get(sym(e.symbol));
  const born = e.at - (e.ageH ?? 0) * 3600_000;
  return n && e.chain === "solana" && born >= n.at - 3600_000 ? { ...e, narrative: { id: n.id, title: n.title } } : e;
}

// Публичная лента: только то, что старше задержки. Сколько свежих находок ждёт — показываем числом.
// live — держателю $CRAWLHIVE лента без задержки.
// delayMin — задержка для бесплатного тарифа (tiers.ts); без неё старая RADAR_DELAY_MIN.
export function radarFeed(opts: { live?: boolean; delayMin?: number } = {}) {
  const now = Date.now();
  const list = all();
  const idx = narrativeIndex();
  const freeDelay = opts.delayMin !== undefined ? opts.delayMin * 60_000 : RADAR_DELAY_MS;
  const delay = opts.live ? 0 : freeDelay;
  const shown = list.filter((e) => now - e.at >= delay).slice(0, 60).map((e) => withNarrative(e, idx));
  const day = list.filter((e) => now - e.at < 24 * 3600_000);
  return {
    items: shown,
    waiting: list.filter((e) => now - e.at < delay).length,
    live: !!opts.live,
    delayMin: Math.round(freeDelay / 60_000),
    day: {
      scanned: day.length,
      danger: day.filter((e) => e.verdict === "DANGER").length,
      clean: day.filter((e) => e.verdict === "CLEAN" || e.verdict === "OK").length,
    },
  };
}

export function startRadar() {
  const s = st();
  if (s.started) return;
  s.started = true;
  if (process.env.RADAR_OFF !== "1" && process.env.CRAWL_DISABLED !== "1") {
    setTimeout(() => tick().catch(() => {}), 20_000);
    setInterval(() => tick().catch(() => {}), TICK_MS);
  }
  setInterval(() => sampleTrack().catch((e) => console.warn("[track]", (e as Error).message)), 5 * 60_000);
  console.log("[crawlhive] launch radar and track record started");
}
