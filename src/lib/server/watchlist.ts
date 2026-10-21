// Watchlist кошельков (Pro): человек следит за кошельками, и как только рой встречает такой кошелёк в новом скане
// (снайпер, бандл, дев, спонсор, держатель или связанный), бот пишет ему в Telegram. Лимит кошельков — по тарифу
// (tiers.ts). Владелец — кошелёк из подписанной сессии сайта или кошелёк, привязанный к чату бота (tg:<кошелёк>).
// Алерт уходит один раз на пару «кошелёк + токен» и через минуту после записи памяти: к этому времени скан
// сохранён, и в сообщении есть тикер и вердикт.
import "server-only";
import { ApiError, metaEntries } from "./store";
import { TIER_LIMITS, tierOf, type Tier } from "./tiers";
import { alertOnce, memDb, recentAlerts, watchAdd, watchCount, watchersOf, watchList, watchRemove, type MemRole } from "./memory-db";

const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const ALERT_DELAY_MS = Number(process.env.WATCH_ALERT_DELAY_MS ?? 60_000);
const ALERTS_PER_HOUR = 30; // на владельца: даже 500 кошельков не превратят бота в спам
const CHAIN_LABEL: Record<string, string> = { solana: "Solana", robinhood: "Robinhood Chain", bsc: "BNB Chain", base: "Base", ethereum: "Ethereum" };
const ROLE_LABEL: Record<string, string> = { sniper: "SNIPER", bundle: "BUNDLER", dev: "DEV", funder: "FUNDER", holder: "HOLDER", linked: "LINKED WALLET" };

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
export const normWallet = (w: string) => (w.startsWith("0x") ? w.toLowerCase() : w);
export function parseWallet(raw: unknown): string {
  const w = String(raw ?? "").trim();
  if (!SOL_RE.test(w) && !EVM_RE.test(w)) throw new ApiError("Not a Solana or EVM wallet address", 400);
  return normWallet(w);
}
function db() {
  const d = memDb();
  if (!d) throw new ApiError("Wallet memory is unavailable right now, try again later", 503);
  return d;
}
const cleanLabel = (l: unknown) => String(l ?? "").replace(/[<>&"]/g, "").trim().slice(0, 40);

// ---------- список ----------

export interface WatchEntry {
  wallet: string;
  label: string;
  at: number;
  tokens: number;
  dumpRate: number | null;
  risk: { score: number; level: string } | null;
}

async function brief(wallet: string): Promise<Omit<WatchEntry, "wallet" | "label" | "at">> {
  try {
    const { walletReport } = await import("./brain");
    const r = walletReport(wallet);
    const risk = r.risk as { score?: number; level?: string } | null | undefined;
    return { tokens: r.tokens, dumpRate: r.dumpRate, risk: risk && typeof risk.score === "number" ? { score: risk.score, level: String(risk.level) } : null };
  } catch {
    return { tokens: 0, dumpRate: null, risk: null };
  }
}

export async function watchState(owner: string) {
  const d = db();
  const { tier } = await tierOf(owner);
  const rows = watchList(d, owner);
  const list: WatchEntry[] = await Promise.all(rows.map(async (r) => ({ wallet: r.target, label: r.label, at: r.at, ...(await brief(r.target)) })));
  const { chatFor } = await import("./telegram");
  return {
    tier,
    limit: limitText(TIER_LIMITS[tier].watchlist),
    max: TIER_LIMITS[tier].watchlist,
    list,
    alerts: recentAlerts(d, owner, 30),
    telegram: !!chatFor(owner),
  };
}
const limitText = (n: number) => (Number.isFinite(n) ? n : null);

export async function addWatch(owner: string, rawWallet: unknown, rawLabel?: unknown): Promise<{ tier: Tier; count: number; max: number }> {
  const d = db();
  const wallet = parseWallet(rawWallet);
  if (normWallet(owner) === wallet) throw new ApiError("That's your own wallet", 400);
  const { tier } = await tierOf(owner);
  const max = TIER_LIMITS[tier].watchlist;
  const already = watchList(d, owner).some((r) => r.target === wallet);
  const count = watchCount(d, owner);
  if (!already && count >= max)
    throw new ApiError(max === 0 ? "Wallet watchlist is for $CRAWLHIVE holders and Pro. See crawlhive.xyz/pricing" : `Your ${tier} plan watches up to ${max} wallets. More on crawlhive.xyz/pricing`, 402);
  watchAdd(d, owner, wallet, cleanLabel(rawLabel));
  return { tier, count: already ? count : count + 1, max };
}

export function removeWatch(owner: string, rawWallet: unknown) {
  return watchRemove(db(), owner, parseWallet(rawWallet));
}

// ---------- алерты ----------

const sent = new Map<string, number[]>();
function underRate(owner: string) {
  const now = Date.now();
  const h = (sent.get(owner) ?? []).filter((t) => now - t < 3600_000);
  if (h.length >= ALERTS_PER_HOUR) return false;
  h.push(now);
  sent.set(owner, h);
  return true;
}

export async function alertText(target: string, label: string, token: string, chain: string, role: string) {
  const { savedScan } = await import("./scan");
  const { siteUrl } = await import("./telegram");
  const s = savedScan(token);
  const coin = s?.symbol ? `$${s.symbol}` : short(token);
  const b = await brief(target);
  // Своё же появление в этом токене не считаем прошлым: история «до», чтобы цифры не раздувались.
  const past = b.tokens > 1 ? `Its past: ${b.tokens - 1} other coin${b.tokens > 2 ? "s" : ""}${b.dumpRate != null ? `, ${Math.round(b.dumpRate * 100)}% dumped` : ""}${b.risk ? `, risk ${b.risk.score} ${b.risk.level}` : ""}.` : "First time the swarm sees it.";
  const verdict = s ? ` Verdict: ${s.verdict.replace("_", " ")}${s.score != null ? ` ${s.score}/100` : ""}.` : "";
  return [
    `👁 <b>Watched wallet ${short(target)}</b>${label ? ` (${label.replace(/[<>&]/g, "")})` : ""} just showed up as <b>${ROLE_LABEL[role] ?? role.toUpperCase()}</b> on <b>${coin.replace(/[<>&]/g, "")}</b> (${CHAIN_LABEL[chain] ?? chain}).`,
    `${past}${verdict}`,
    `Scan: ${siteUrl()}/scan/${token}`,
  ].join("\n");
}

// Вызывается из памяти роя после записи скана. Ничего не ждёт и не бросает: скан от этого не замедляется.
export function notifyWatchers(token: string, chain: string, roles: Map<string, MemRole>) {
  const d = memDb();
  if (!d || !roles.size) return;
  let rows;
  try {
    rows = watchersOf(d, [...roles.keys()]);
  } catch {
    return;
  }
  if (!rows.length) return;
  const t = setTimeout(() => {
    void dispatch(token, chain, roles, rows).catch((e) => console.warn("[watch] alert:", (e as Error).message));
  }, ALERT_DELAY_MS);
  t.unref?.();
}

async function dispatch(token: string, chain: string, roles: Map<string, MemRole>, rows: { owner: string; target: string; label: string }[]) {
  const d = memDb();
  if (!d) return;
  const { chatFor, send } = await import("./telegram");
  for (const r of rows) {
    const role = roles.get(r.target) ?? "linked";
    if (!alertOnce(d, { owner: r.owner, target: r.target, token, chain, role })) continue;
    // Тариф мог закончиться: алерт помним (для страницы), но в Telegram шлём только при действующем лимите.
    const { tier } = await tierOf(r.owner).catch(() => ({ tier: "free" as Tier }));
    if (TIER_LIMITS[tier].watchlist <= 0) continue;
    const chat = chatFor(r.owner);
    if (!chat || !underRate(r.owner)) continue;
    send(chat, await alertText(r.target, r.label, token, chain, role));
  }
}

// Кошельки, привязанные к чату бота: от их имени работают /watch и лимиты.
export function walletsOfChat(chat: string): string[] {
  return metaEntries("tg:").filter(([, c]) => c === chat).map(([k]) => k.slice(3));
}
