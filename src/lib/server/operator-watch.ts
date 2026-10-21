// Watch операторов (только Whale): человек следит не за одним кошельком, а за целым оператором — группой связанных
// кошельков из памяти роя (memory-db.ts, op_members). Как только любой участник группы, включая добавленных в неё
// позже, появляется в новой монете снайпером, бандлом, девом, спонсором или связанным держателем, бот пишет в
// Telegram одно сообщение на пару «оператор + монета»: кто из участников там был, в каких ролях, прошлое оператора.
// Точка входа — rememberWallets (scan-operators.ts) после каждого скана, как и у watchlist кошельков.
import "server-only";
import { ApiError } from "./store";
import { TIER_LIMITS, TIER_USD, tierOf, type Tier } from "./tiers";
import { normWallet } from "./watchlist";
import {
  memDb,
  operators,
  opAlertOnce,
  recentOpAlerts,
  watchOpAdd,
  watchOpAll,
  watchOpAny,
  watchOpList,
  watchOpRemove,
  watchOpTouch,
  type MemRole,
  type WatchOpRow,
} from "./memory-db";

const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const OP_RE = /^op_[a-f0-9]{12}$/;
const ALERT_DELAY_MS = Number(process.env.WATCH_ALERT_DELAY_MS ?? 60_000);
const ALERTS_PER_HOUR = 30;
const MEMBERS_SHOWN = 8;
const CHAIN_LABEL: Record<string, string> = { solana: "Solana", robinhood: "Robinhood Chain", bsc: "BNB Chain", base: "Base", ethereum: "Ethereum" };
const ROLE_LABEL: Record<string, string> = { sniper: "SNIPER", bundle: "BUNDLER", dev: "DEV", funder: "FUNDER", holder: "HOLDER", linked: "LINKED" };
// Фабрика и создатель пула о человеке почти ничего не говорят: по ним алерт оператора не шлём.
const SKIP_ROLES = new Set<MemRole>(["factory", "pool"]);

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const esc = (s: string) => s.replace(/[<>&]/g, "");
const cleanLabel = (l: unknown) => String(l ?? "").replace(/[<>&"]/g, "").trim().slice(0, 40);
export const NOT_WHALE = `Operator watch is a Whale perk (hold about $${TIER_USD.whale} of $CRAWLHIVE). See crawlhive.xyz/pricing`;

function db() {
  const d = memDb();
  if (!d) throw new ApiError("Wallet memory is unavailable right now, try again later", 503);
  return d;
}

// Текущий оператор watch: по якорю (переживает слияние групп), иначе по последнему известному id.
function currentOp(row: Pick<WatchOpRow, "anchor" | "op">) {
  const ops = operators();
  const id = ops.byWallet.get(row.anchor) ?? (ops.byId.has(row.op) ? row.op : null);
  return id ? (ops.byId.get(id) ?? null) : null;
}

// Кошелёк, id оператора или список кошельков одной группы скана → оператор между токенами.
export function resolveOperator(input: unknown): { id: string; wallets: string[] } {
  const ops = operators();
  const list = (Array.isArray(input) ? input : [input]).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 60);
  if (!list.length) throw new ApiError("Pass a wallet or an operator id like op_1a2b3c4d5e6f", 400);
  for (const raw of list) {
    if (OP_RE.test(raw)) {
      const op = ops.byId.get(raw);
      if (op) return op;
      continue;
    }
    if (!SOL_RE.test(raw) && !EVM_RE.test(raw)) continue;
    const id = ops.byWallet.get(normWallet(raw));
    const op = id ? ops.byId.get(id) : undefined;
    if (op) return op;
  }
  if (list.length === 1 && OP_RE.test(list[0])) throw new ApiError("No such operator. Ids can change when two operators merge, try a member wallet instead", 404);
  throw new ApiError("Not a known operator yet. The swarm needs to see these wallets together on 2+ coins first. You can watch the wallets one by one meanwhile", 404);
}

// Кратко об операторе для списка и алерта: участники, монеты, доля рухнувших.
async function opBrief(id: string): Promise<{ members: number; coins: number; dumpRate: number | null; tokens: string[] } | null> {
  try {
    const { operatorReport } = await import("./brain");
    const r = operatorReport(id);
    return { members: r.wallets, coins: r.tokens, dumpRate: r.dumpRate, tokens: r.coins.map((c) => c.token) };
  } catch {
    return null;
  }
}

// ---------- список ----------

export interface WatchOpEntry {
  anchor: string;
  op: string | null; // null — группа сейчас не собирается в оператора (например, кошелёк стал общим сервисом)
  label: string;
  at: number;
  members: number;
  coins: number;
  dumpRate: number | null;
}

export async function watchOpsState(owner: string) {
  const d = db();
  const { tier } = await tierOf(owner);
  const rows = watchOpList(d, owner);
  const list: WatchOpEntry[] = await Promise.all(
    rows.map(async (r) => {
      const op = currentOp(r);
      const b = op ? await opBrief(op.id) : null;
      return { anchor: r.anchor, op: op?.id ?? null, label: r.label, at: r.at, members: b?.members ?? 0, coins: b?.coins ?? 0, dumpRate: b?.dumpRate ?? null };
    }),
  );
  const alerts = recentOpAlerts(d, owner, 20).map((a) => ({ op: a.op, token: a.token, chain: a.chain, members: safeMembers(a.members), at: a.at }));
  return { tier, max: TIER_LIMITS[tier].operators, list, alerts };
}

const safeMembers = (s: string): [string, string][] => {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
};

export async function addWatchOp(owner: string, input: unknown, rawLabel?: unknown): Promise<{ tier: Tier; op: string; members: number; count: number; max: number }> {
  const d = db();
  const { tier } = await tierOf(owner);
  const max = TIER_LIMITS[tier].operators;
  if (max <= 0) throw new ApiError(NOT_WHALE, 403);
  const op = resolveOperator(input);
  const rows = watchOpList(d, owner);
  // Уже следим за этим оператором (возможно, под другим якорем после слияния) — просто обновляем подпись.
  const had = rows.find((r) => currentOp(r)?.id === op.id);
  if (!had && rows.length >= max) throw new ApiError(`Your Whale plan watches up to ${max} operators. Remove one first`, 402);
  if (op.wallets.includes(normWallet(owner))) throw new ApiError("That operator includes your own wallet", 400);
  const label = cleanLabel(rawLabel);
  if (had) watchOpAdd(d, owner, had.anchor, op.id, label || had.label);
  else watchOpAdd(d, owner, op.wallets[0], op.id, label);
  return { tier, op: op.id, members: op.wallets.length, count: had ? rows.length : rows.length + 1, max };
}

// Убрать по якорю, id оператора или любому кошельку-участнику.
export function removeWatchOp(owner: string, raw: unknown): boolean {
  const d = db();
  const key = String(raw ?? "").trim();
  if (!key) return false;
  const rows = watchOpList(d, owner);
  const w = OP_RE.test(key) ? key : normWallet(key);
  const ops = operators();
  const target = OP_RE.test(key) ? key : ops.byWallet.get(w);
  const row = rows.find((r) => r.anchor === w || r.op === key || (target && currentOp(r)?.id === target));
  return row ? watchOpRemove(d, owner, row.anchor) : false;
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

// Один токен может прийти несколькими вызовами rememberWallets (EVM пишет дева отдельно): роли копим до отправки.
const pending = new Map<string, { chain: string; roles: Map<string, MemRole> }>();

// Вызывается из rememberWallets после записи скана. Ничего не ждёт и не бросает.
export function notifyOperatorWatchers(token: string, chain: string, roles: Map<string, MemRole>) {
  const d = memDb();
  if (!d || !roles.size) return;
  try {
    if (!watchOpAny(d)) return;
  } catch {
    return;
  }
  const p = pending.get(token);
  if (p) {
    for (const [w, r] of roles) if (!p.roles.has(w) || p.roles.get(w) === "linked") p.roles.set(w, r);
    return;
  }
  pending.set(token, { chain, roles: new Map(roles) });
  // Ждём, как и watchlist кошельков: к этому времени скан сохранён (тикер, вердикт), а группы записаны в память.
  const t = setTimeout(() => {
    const job = pending.get(token);
    pending.delete(token);
    if (job) void dispatch(token, job.chain, job.roles).catch((e) => console.warn("[watch-op] alert:", (e as Error).message));
  }, ALERT_DELAY_MS);
  t.unref?.();
}

async function dispatch(token: string, chain: string, roles: Map<string, MemRole>) {
  const d = memDb();
  if (!d) return;
  const ops = operators();
  // Кошельки скана → их операторы: какие участники каждого оператора здесь были и в каких ролях.
  const hits = new Map<string, [string, MemRole][]>();
  for (const [w, r] of roles) {
    if (SKIP_ROLES.has(r)) continue;
    const id = ops.byWallet.get(w);
    if (id) hits.set(id, [...(hits.get(id) ?? []), [w, r]]);
  }
  if (!hits.size) return;
  const { chatFor, send } = await import("./telegram");
  const done = new Set<string>(); // владелец+оператор: два якоря после слияния не дают двух сообщений
  for (const row of watchOpAll(d)) {
    const op = currentOp(row);
    const members = op ? hits.get(op.id) : undefined;
    if (!op || !members) continue;
    if (op.id !== row.op) watchOpTouch(d, row.owner, row.anchor, op.id);
    const key = `${row.owner}|${op.id}`;
    if (done.has(key)) continue;
    done.add(key);
    if (!opAlertOnce(d, { owner: row.owner, anchor: row.anchor, op: op.id, token, chain, members: JSON.stringify(members.slice(0, 50)) })) continue;
    // Тариф мог закончиться: алерт помним (для страницы), но в Telegram шлём только Whale.
    const { tier } = await tierOf(row.owner).catch(() => ({ tier: "free" as Tier }));
    if (TIER_LIMITS[tier].operators <= 0) continue;
    const chat = chatFor(row.owner);
    if (!chat || !underRate(row.owner)) continue;
    send(chat, await opAlertText(op.id, row.label, token, chain, members));
  }
}

export async function opAlertText(id: string, label: string, token: string, chain: string, members: [string, string][]) {
  const { savedScan } = await import("./scan");
  const { siteUrl } = await import("./telegram");
  const s = savedScan(token);
  const coin = s?.symbol ? `$${s.symbol}` : short(token);
  const b = await opBrief(id);
  // Эта монета уже может быть в памяти оператора: прошлое — без неё.
  const past = b ? b.coins - (b.tokens.includes(token) ? 1 : 0) : 0;
  const history = b && past > 0 ? `Its past: ${past} other coin${past > 1 ? "s" : ""}${b.dumpRate != null ? `, ${Math.round(b.dumpRate * 100)}% dumped` : ""}.` : "First coin the swarm sees it on.";
  const verdict = s ? ` Verdict: ${s.verdict.replace("_", " ")}${s.score != null ? ` ${s.score}/100` : ""}.` : "";
  const shown = members.slice(0, MEMBERS_SHOWN).map(([w, r]) => `<code>${esc(short(w))}</code> ${ROLE_LABEL[r] ?? r.toUpperCase()}`);
  const more = members.length > MEMBERS_SHOWN ? ` +${members.length - MEMBERS_SHOWN} more` : "";
  return [
    `🕸 <b>Watched operator ${id}</b>${label ? ` (${esc(label)})` : ""}${b ? `, ${b.members} wallets,` : ""} just showed up on <b>${esc(coin)}</b> (${CHAIN_LABEL[chain] ?? chain}).`,
    `${members.length} member${members.length > 1 ? "s" : ""} here: ${shown.join(", ")}${more}`,
    `${history}${verdict}`,
    `Scan: ${siteUrl()}/scan/${token}`,
  ].join("\n");
}
