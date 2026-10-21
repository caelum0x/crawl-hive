// Открытая часть Telegram-бота: всё, что работает без кошелька и краулеров.
// - скан токена на Solana и Robinhood Chain: карточка-картинка, вердикт Jev, кнопки;
// - автоскан в группах: кто-то кинул адрес контракта — бот отвечает коротким вердиктом;
// - список наблюдения с оповещениями (пара пропала, ликвидность вытащили, −50%, вердикт стал DANGER);
// - «через 24 часа»: бот сам возвращается и говорит, сбылся ли вердикт (данные Track Record);
// - подписка на Launch Radar с фильтрами; владельцы живых краулеров получают её без задержки;
// - inline-режим (@bot <адрес> в любом чате) и /track — точность сканера.
import "server-only";
import { TOKEN } from "@/lib/token";
import type { ScanResult } from "./scan";
import type { Tier } from "./tiers";
import { call, esc, send, sendPhoto, siteUrl, telegramBotName, telegramMainApp, type Keyboard } from "./telegram";
import { getMeta, listCrawlers, metaEntries, setMeta } from "./store";
import { addSupport, adminChats, adminStats, isAdmin as isProjectAdmin, markAnswered, rememberAdminChat, seenTgUser, supportList } from "./admin";

const GROUP_SCANS_PER_HOUR = 20;
const GROUP_TOKEN_COOLDOWN_MS = 30 * 60_000;
const WATCH_MAX = 5;
const WATCH_MS = 7 * 86400_000;
const WATCH_RESCAN_MS = 3 * 3600_000;
const FOLLOWUP_MS = 24 * 3600_000;
const FOLLOWUPS_PER_DAY = 3;
const ALERTS_PER_DAY = 25;
const ADDR_RE = /\b(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/;
const TICKER_RE = /^\$?([A-Za-z][A-Za-z0-9]{1,11})$/;

const VERDICT_ICON: Record<string, string> = { CLEAN: "🟢", OK: "🟢", RISKY: "🟠", DANGER: "🔴", TOO_EARLY: "⚪️" };
const CHAIN_LABEL: Record<string, string> = { solana: "Solana", robinhood: "Robinhood Chain", bsc: "BNB Chain", base: "Base" };
const fmtUsd = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`);
const pct = (n: number | null | undefined) => (n == null ? "-" : `${n > 0 ? "+" : ""}${Math.round(n)}%`);
const day = () => new Date().toISOString().slice(0, 10);

// ---------- настройки чатов ----------

interface ChatPrefs {
  followups?: boolean; // по умолчанию включены в личке
  autoscan?: boolean; // по умолчанию включён в группах
  alerts?: { on: boolean; mode: "clean" | "all"; minLiq: number };
  narr?: { on: boolean; mode: "first" | "all" }; // алерты о монетах на нарративах Narrative Radar
  burns?: boolean; // каждое подтверждённое сжигание $CRAWLHIVE
  threads?: Partial<Record<Topic, number>>; // в группе с темами: в какую тему слать каждый вид оповещений
  alertDay?: string;
  alertCount?: number;
  fuDay?: string;
  fuCount?: number;
}
type Topic = "radar" | "narr" | "burns";
// Тема форума запоминается там, где админ включил оповещения: Launch Radar — в 📡, нарративы — в 🔮, сжигания — в 🔥.
const inTopic = (chat: string, kind: Topic) => {
  const t = prefs(chat).threads?.[kind];
  return t ? { message_thread_id: t } : {};
};
function rememberTopic(chat: string, kind: Topic, thread?: number) {
  if (!chat.startsWith("-")) return;
  setPrefs(chat, { threads: { ...prefs(chat).threads, [kind]: thread || undefined } });
}

function prefsAll(): Record<string, ChatPrefs> {
  try {
    return JSON.parse(getMeta("tgprefs") ?? "{}");
  } catch {
    return {};
  }
}
export const prefs = (chat: string) => prefsAll()[chat] ?? {};
export function setPrefs(chat: string, patch: Partial<ChatPrefs>) {
  const all = prefsAll();
  all[chat] = { ...all[chat], ...patch };
  setMeta("tgprefs", JSON.stringify(all));
  return all[chat];
}

// Дневной лимит на оповещения одного вида: следим, чтобы бот не превратился в спам.
function takeQuota(chat: string, kind: "alert" | "fu", limit: number) {
  const p = prefs(chat);
  const dk = kind === "alert" ? "alertDay" : "fuDay";
  const ck = kind === "alert" ? "alertCount" : "fuCount";
  const n = p[dk] === day() ? (p[ck] ?? 0) : 0;
  if (n >= limit) return false;
  setPrefs(chat, { [dk]: day(), [ck]: n + 1 });
  return true;
}

// ---------- скан ----------

const hits = new Map<string, number[]>();
function allow(key: string, perHour: number, windowMs = 3600_000) {
  const now = Date.now();
  const h = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (h.length >= perHour) return false;
  h.push(now);
  hits.set(key, h);
  return true;
}

// Запрос к скану из текста: адрес (Solana или 0x… Robinhood Chain), ссылка DexScreener / pump.fun / GeckoTerminal или $TICKER.
export function scanQuery(text: string): string | null {
  const t = text.trim();
  if (/^\$[A-Za-z][A-Za-z0-9]{1,11}$/.test(t)) return t;
  const link = t.split(/\s+/).find((x) => /^https?:\/\/\S*(dexscreener\.com|pump\.fun|geckoterminal\.com)/.test(x));
  if (link) return link;
  return t.match(ADDR_RE)?.[1] ?? null;
}

// Короткий вывод Jev по скану: смотреть, следить или обходить. Без ключа — молча пропускаем.
const takeCache = new Map<string, { at: number; v: { take: string; conf: number } }>();

async function jevTake(r: ScanResult): Promise<{ take: string; conf: number } | null> {
  // Один и тот же токен в разных чатах не стоит повторных решений: кэш на 30 минут по токену и вердикту.
  const key = `${r.id}:${r.verdict}:${r.score}`;
  const hit = takeCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.v;
  try {
    const { jev, jevEnabled } = await import("./crawl/jev");
    if (!jevEnabled() || r.verdict === "TOO_EARLY") return null;
    const res = await jev(
      {
        token: r.symbol,
        chain: r.chain,
        safety_scan: { verdict: r.verdict, score: r.score, reason: r.reason, flags: r.factors.filter((f) => f.impact < 0).map((f) => f.label) },
        market: r.market ? { liquidity_usd: r.market.liquidityUsd, fdv_usd: r.market.fdv, age_hours: r.market.ageHours } : "no pair",
      },
      {
        take: {
          type: "choice",
          instructions: "What should a memecoin trader do with this token right now? Weigh the safety scan first.",
          criteria: {
            look: "Worth opening now: the scan is clean or OK and the market is real.",
            watch: "Not yet: too early, thin liquidity or a mixed scan.",
            avoid: "Risky: bad scan flags, rug or bundle signs, or a likely scam.",
          },
        },
      },
      5_000,
      "public",
    );
    const a = res.answers.take;
    if (a?.type !== "choice") return null;
    // Та же нижняя граница, что у Grok Bot: DANGER не бывает LOOK.
    const take = r.verdict === "DANGER" && a.choice !== "avoid" ? "avoid" : r.verdict === "RISKY" && a.choice === "look" ? "watch" : a.choice;
    const v = { take, conf: a.probabilities?.[a.choice] ?? a.confidence ?? 0 };
    takeCache.set(key, { at: Date.now(), v });
    if (takeCache.size > 2_000) takeCache.delete(takeCache.keys().next().value!);
    return v;
  } catch {
    return null;
  }
}

const TAKE_LABEL: Record<string, string> = { look: "👀 LOOK", watch: "⏳ WATCH", avoid: "⛔ AVOID" };

function caption(r: ScanResult, take: { take: string; conf: number } | null, compact = false) {
  const m = r.market;
  const mk = m
    ? [m.liquidityUsd ? `liq $${fmtUsd(m.liquidityUsd)}` : "", m.fdv ? `FDV $${fmtUsd(m.fdv)}` : "", m.ageHours != null ? `age ${m.ageHours < 1 ? `${Math.round(m.ageHours * 60)}m` : m.ageHours < 48 ? `${Math.round(m.ageHours)}h` : `${Math.round(m.ageHours / 24)}d`}` : ""]
        .filter(Boolean)
        .join(" · ")
    : "no tradable pair yet";
  const flags = r.factors.filter((f) => f.impact < 0).slice(0, compact ? 2 : 4);
  return [
    `${VERDICT_ICON[r.verdict] ?? "⚪️"} <b>$${esc(r.symbol)}</b> · <b>${r.score != null ? `${r.score} ` : ""}${r.verdict.replace("_", " ")}</b> · ${CHAIN_LABEL[r.chain] ?? r.chain}`,
    esc(r.reason),
    mk,
    ...flags.map((f) => `▫️ ${esc(f.label)}${compact ? "" : `: ${esc(f.note).slice(0, 80)}`}`),
    xrayLine(r, compact),
    take ? `⚡ Jev: <b>${TAKE_LABEL[take.take] ?? take.take}</b> · ${Math.round(take.conf * 100)}% sure` : "",
    compact ? "" : `<code>${esc(r.id)}</code>`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1000);
}

// Одна строка Contract X-Ray: самые опасные рычаги владельца и находки на сайте проекта.
function xrayLine(r: ScanResult, compact = false) {
  const x = r.xray;
  if (!x) return "";
  const bad = [...x.findings, ...(x.site?.findings ?? [])].filter((f) => f.severity === "high");
  if (bad.length) return `🩻 X-Ray: <b>${bad.slice(0, compact ? 2 : 3).map((f) => esc(f.label.toLowerCase())).join(", ")}</b>`;
  return compact ? "" : `🩻 X-Ray: ${x.findings.some((f) => f.severity === "medium") ? "minor owner powers only" : "nothing the owner can pull"}`;
}

const chartUrl = (r: ScanResult) => `https://dexscreener.com/${r.chain}/${r.id}`;

function keyboard(r: ScanResult, compact = false): Keyboard {
  const rows: Keyboard = [
    [
      { text: "🔎 Full scan", url: `${siteUrl()}/scan/${r.id}` },
      { text: "👁 Watch", callback_data: `w:${r.id}` },
    ],
  ];
  if (!compact) {
    rows.push([{ text: "📈 Chart", url: chartUrl(r) }, { text: "🔄 Rescan", callback_data: `r:${r.id}` }]);
    // Кнопка web_app работает только в личке; в группах ведём ссылкой t.me/<bot>?startapp.
    rows.push([{ text: "📱 Open in the app", web_app: { url: `${siteUrl()}/tg?scan=${r.id}` } }]);
  } else {
    const bot = telegramBotName();
    // Прямо в мини-апп ведёт только ?startapp, а он работает лишь с включённым Main Mini App;
    // иначе ведём в личку бота, где он отвечает кнопкой «Open the app».
    if (bot) rows[0].push({ text: "📱 App", url: telegramMainApp() ? `https://t.me/${bot}?startapp=scan_${r.id.slice(0, 50)}` : `https://t.me/${bot}?start=app` });
  }
  return rows;
}

async function scanCard(chat: string, r: ScanResult, opts: { compact?: boolean; replyTo?: number } = {}) {
  const take = await jevTake(r);
  const extra = opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {};
  if (opts.compact) return send(chat, caption(r, take, true), keyboard(r, true), extra);
  // Карточка — та же картинка, что в превью ссылки на X; параметр версии, чтобы Telegram не взял старую из кэша.
  return sendPhoto(chat, `${siteUrl()}/scan/${r.id}/opengraph-image?v=${r.scannedAt}`, caption(r, take), keyboard(r), extra);
}

async function runFor(q: string, chain?: string) {
  const { runScan } = await import("./scan");
  return runScan(q, () => {}, chain);
}

async function doScan(chat: string, q: string, chain?: string) {
  // Лимит сканов в сутки — по лучшему тарифу среди кошельков, привязанных к чату (tiers.ts); в группах свой лимит.
  const tier = await chatTier(chat);
  const { TIER_LIMITS } = await import("./tiers");
  const perDay = TIER_LIMITS[tier].botScansDay;
  if (Number.isFinite(perDay) && !allow(`s:${chat}`, perDay, 86_400_000))
    return send(chat, `Up to ${perDay} scans a day on the ${tier} plan. More with $${TOKEN.symbol} or Pro: ${siteUrl()}/pricing · Unlimited on ${siteUrl()}`);
  // Без лимита в сутки всё равно не даём долбить RPC очередью: не больше 60 в час.
  if (!Number.isFinite(perDay) && !allow(`sh:${chat}`, 60)) return send(chat, "Easy there: up to 60 scans an hour. Try again in a bit.");
  call("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
  try {
    const r = await runFor(q, chain);
    if (!chat.startsWith("-")) seenTgUser({ id: Number(chat) }, "scan");
    await scanCard(chat, r);
    rememberForFollowup(chat, r);
    // По тикеру ищем на Solana — предлагаем ту же монету в EVM-сетях.
    const t = q.match(TICKER_RE);
    if (q.startsWith("$") && t && r.chain === "solana")
      send(chat, `Looking for $${esc(t[1].toUpperCase())} on another chain?`, [
        [
          { text: "Robinhood Chain", callback_data: `t:rh:${t[1].slice(0, 12)}` },
          { text: "BNB Chain", callback_data: `t:bsc:${t[1].slice(0, 12)}` },
          { text: "Base", callback_data: `t:base:${t[1].slice(0, 12)}` },
        ],
      ]);
  } catch (e) {
    const msg = (e as Error).message;
    send(chat, `Could not scan that: ${esc(msg).slice(0, 160)}`, q.startsWith("$") && !chain
        ? [
            [
              { text: "Try Robinhood Chain", callback_data: `t:rh:${q.slice(1, 13)}` },
              { text: "Try BNB Chain", callback_data: `t:bsc:${q.slice(1, 13)}` },
              { text: "Try Base", callback_data: `t:base:${q.slice(1, 13)}` },
            ],
          ]
        : undefined,
    );
  }
}

// ---------- группы ----------

const groupSeen = new Map<string, number>();

async function groupAutoscan(chat: string, msgId: number, q: string) {
  if (prefs(chat).autoscan === false) return;
  const key = `${chat}:${q}`;
  const now = Date.now();
  if (now - (groupSeen.get(key) ?? 0) < GROUP_TOKEN_COOLDOWN_MS) return;
  if (!allow(`g:${chat}`, GROUP_SCANS_PER_HOUR)) return;
  groupSeen.set(key, now);
  try {
    await scanCard(chat, await runFor(q), { compact: true, replyTo: msgId });
  } catch {
    // в группе молчим о неудачах: адрес мог быть кошельком, а не токеном
  }
}

async function isAdmin(chat: string, userId?: number) {
  if (!userId) return false;
  const m = await call<{ status: string }>("getChatMember", { chat_id: chat, user_id: userId }).catch(() => null);
  return m?.status === "creator" || m?.status === "administrator";
}

// ---------- список наблюдения ----------

interface Watch {
  id: string;
  chain: string;
  symbol: string;
  verdict: string;
  price0: number;
  liq0: number;
  at: number;
  rescanAt: number;
  alerted: string[];
}
function watches(): Record<string, Watch[]> {
  try {
    return JSON.parse(getMeta("tgwatch") ?? "{}");
  } catch {
    return {};
  }
}
const saveWatches = (w: Record<string, Watch[]>) => setMeta("tgwatch", JSON.stringify(w));

// Общие для бота и мини-аппа операции со списком наблюдения.
export function watchList(chat: string) {
  return (watches()[chat] ?? []).filter((w) => Date.now() - w.at < WATCH_MS);
}

export async function watchAdd(chat: string, id: string): Promise<{ ok: true; watch: Watch } | { ok: false; error: string }> {
  // Добавление может запустить скан — лимит, как у сканов в чате.
  if (!allow(`w:${chat}`, 15)) return { ok: false, error: "Too many watch requests, try again later." };
  const all = watches();
  const mine = (all[chat] ?? []).filter((w) => Date.now() - w.at < WATCH_MS);
  const had = mine.find((w) => w.id === id);
  if (had) return { ok: true, watch: had };
  if (mine.length >= WATCH_MAX) return { ok: false, error: `Your watchlist is full (${WATCH_MAX}). Remove one first.` };
  const { savedScan, runScan } = await import("./scan");
  const r = savedScan(id) ?? (await runScan(id, () => {}, undefined, { record: false }).catch(() => undefined));
  if (!r?.market?.priceUsd) return { ok: false, error: "This token has no tradable pair yet, nothing to watch." };
  const now = Date.now();
  const w: Watch = { id, chain: r.chain, symbol: r.symbol, verdict: r.verdict, price0: r.market.priceUsd, liq0: r.market.liquidityUsd ?? 0, at: now, rescanAt: now + WATCH_RESCAN_MS, alerted: [] };
  all[chat] = [...mine, w];
  saveWatches(all);
  return { ok: true, watch: w };
}

export function watchRemove(chat: string, id: string) {
  const all = watches();
  all[chat] = (all[chat] ?? []).filter((w) => w.id !== id);
  saveWatches(all);
  return watchList(chat);
}

async function addWatch(chat: string, id: string) {
  const r = await watchAdd(chat, id);
  if (!r.ok) return send(chat, r.error);
  send(chat, `👁 Watching <b>$${esc(r.watch.symbol)}</b> for 7 days. I ping you if liquidity is pulled, the price falls 50% or the verdict turns DANGER.`);
}

export async function checkWatches() {
  const all = watches();
  const now = Date.now();
  const byChain = new Map<string, Set<string>>();
  for (const [chat, list] of Object.entries(all)) {
    all[chat] = list.filter((w) => now - w.at < WATCH_MS);
    if (!all[chat].length) delete all[chat];
    else for (const w of all[chat]) byChain.set(w.chain, (byChain.get(w.chain) ?? new Set()).add(w.id));
  }
  const { bestPairs } = await import("./crawl/dexscreener");
  const pairs = new Map<string, { priceUsd?: string; liquidity?: { usd?: number } } | undefined>();
  for (const [chain, ids] of byChain) {
    const got = await bestPairs(chain, [...ids]).catch(() => null);
    if (got) for (const id of ids) pairs.set(id, got.get(id));
  }
  for (const [chat, list] of Object.entries(all))
    for (const w of list) {
      if (!pairs.has(w.id)) continue;
      const p = pairs.get(w.id);
      const once = (k: string, html: string) => {
        if (w.alerted.includes(k)) return;
        w.alerted.push(k);
        send(chat, html, [[{ text: "🔎 Open scan", url: `${siteUrl()}/scan/${w.id}` }]]);
      };
      const price = Number(p?.priceUsd);
      if (!p || !(price > 0)) {
        once("gone", `🚨 <b>$${esc(w.symbol)}</b>: the trading pair is gone. Liquidity was likely pulled.`);
        continue;
      }
      const liq = p.liquidity?.usd ?? 0;
      const chg = ((price - w.price0) / w.price0) * 100;
      if (w.liq0 > 0 && liq < w.liq0 * 0.3) once("liq", `🚨 <b>$${esc(w.symbol)}</b>: liquidity fell from $${fmtUsd(w.liq0)} to $${fmtUsd(liq)}.`);
      if (chg <= -50) once("dump", `🔻 <b>$${esc(w.symbol)}</b> is down ${Math.round(chg)}% since you started watching.`);
    }
  saveWatches(all);
  const { runScan } = await import("./scan");
  for (const [chat, list] of Object.entries(all))
    for (const w of list) {
      if (w.rescanAt > now || w.alerted.includes("danger")) continue;
      w.rescanAt = now + WATCH_RESCAN_MS;
      const r = await runScan(w.id, () => {}, w.chain, { record: false }).catch(() => null);
      if (r && r.verdict === "DANGER" && w.verdict !== "DANGER") {
        w.alerted.push("danger");
        send(chat, `🔴 <b>$${esc(w.symbol)}</b> turned <b>DANGER</b> (${r.score ?? "-"}): ${esc(r.reason)}`, [[{ text: "🔎 Open scan", url: `${siteUrl()}/scan/${w.id}` }]]);
      }
      if (r) w.verdict = r.verdict;
    }
  saveWatches(all);
}

// ---------- «через 24 часа» ----------

interface Pending {
  chat: string;
  id: string;
  symbol: string;
  verdict: string;
  score: number | null;
  at: number;
}
function pendingFU(): Pending[] {
  try {
    return JSON.parse(getMeta("tgfollow") ?? "[]");
  } catch {
    return [];
  }
}

function rememberForFollowup(chat: string, r: ScanResult) {
  if (!r.market?.priceUsd || r.verdict === "TOO_EARLY" || prefs(chat).followups === false) return;
  const list = pendingFU().filter((x) => !(x.chat === chat && x.id === r.id));
  list.unshift({ chat, id: r.id, symbol: r.symbol, verdict: r.verdict, score: r.score, at: Date.now() });
  setMeta("tgfollow", JSON.stringify(list.slice(0, 3000)));
}

export async function sendFollowups() {
  const { trackEntry } = await import("./track");
  const now = Date.now();
  const keep: Pending[] = [];
  for (const p of pendingFU()) {
    if (now - p.at < FOLLOWUP_MS) {
      keep.push(p);
      continue;
    }
    const e = trackEntry(p.id, p.at);
    if (!e?.done) {
      if (now - p.at < FOLLOWUP_MS + 3 * 3600_000) keep.push(p); // ждём итога ещё 3 часа
      continue;
    }
    if (prefs(p.chat).followups === false || !takeQuota(p.chat, "fu", FOLLOWUPS_PER_DAY)) continue;
    const bad = p.verdict === "DANGER" || p.verdict === "RISKY";
    const head = `${VERDICT_ICON[p.verdict] ?? ""} 24h ago you scanned <b>$${esc(p.symbol)}</b>: ${p.score ?? "-"} ${p.verdict}.`;
    const what = e.rugged ? "the liquidity was pulled" : e.dumped ? `it fell ${pct(e.lowPct)}` : `low ${pct(e.lowPct)}, peak ${pct(e.peakPct)}, now ${pct(e.lastPct)}`;
    const line = bad
      ? e.dumped
        ? `✅ <b>We called it:</b> ${what}.`
        : `It held: ${what}. Not every risk plays out, but the flags were real.`
      : e.dumped
        ? `❌ <b>We missed this one:</b> ${what}. It is logged in the Track Record, misses included.`
        : `✅ <b>It held:</b> ${what}.`;
    send(p.chat, `${head}\n${line}`, [[{ text: "🎯 Track Record", url: `${siteUrl()}/track` }, { text: "🔎 Scan now", callback_data: `r:${p.id}` }]]);
  }
  setMeta("tgfollow", JSON.stringify(keep));
}

// ---------- Launch Radar ----------

const radarCursor = globalThis as unknown as { __crawlhiveTgRadar?: { delayed: number; live: number } };

// Держатели $CRAWLHIVE среди чатов с привязанным кошельком (/start с сайта): им live-радар и больше сканов.
async function holderChat(chat: string): Promise<boolean> {
  return (await chatTier(chat)) !== "free";
}
// Лучший тариф среди кошельков, привязанных к чату (/start с сайта); без кошелька — free.
async function chatTier(chat: string): Promise<Tier> {
  const { tierOf, TIER_ORDER } = await import("./tiers");
  let best: Tier = "free";
  for (const [k, c] of metaEntries("tg:")) {
    if (c !== chat) continue;
    const t = (await tierOf(k.slice(3)).catch(() => null))?.tier ?? "free";
    if (TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf(best)) best = t;
  }
  return best;
}
async function holderChats(chats: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const c of chats) if (await holderChat(c)) out.add(c);
  return out;
}

function ownerChats(): Set<string> {
  const out = new Set<string>();
  for (const [k, chat] of metaEntries("tg:")) {
    const wallet = k.slice(3);
    if (listCrawlers({ owner: wallet }, wallet).some((c) => c.live && c.status !== "paused")) out.add(chat);
  }
  return out;
}

export async function pushRadar() {
  const subs = Object.entries(prefsAll()).filter(([, p]) => p.alerts?.on);
  const cur = (radarCursor.__crawlhiveTgRadar ??= { delayed: Date.now(), live: Date.now() });
  if (!subs.length) {
    cur.delayed = cur.live = Date.now();
    return;
  }
  const { radarAll, RADAR_DELAY_MS, withNarrative, narrativeIndex } = await import("./radar");
  const now = Date.now();
  const owners = ownerChats();
  for (const c of await holderChats(subs.map(([chat]) => chat).filter((c) => !owners.has(c)))) owners.add(c);
  const idx = narrativeIndex();
  const list = radarAll().map((e) => withNarrative(e, idx) as typeof e & { narrative?: { id: string; title: string } });
  const fresh = (from: number, to: number) => list.filter((e) => e.at > from && e.at <= to).reverse();
  const live = fresh(cur.live, now);
  const delayed = fresh(cur.delayed, now - RADAR_DELAY_MS);
  cur.live = now;
  cur.delayed = Math.max(cur.delayed, now - RADAR_DELAY_MS);
  for (const [chat, p] of subs) {
    const a = p.alerts!;
    const isOwner = owners.has(chat);
    for (const e of isOwner ? live : delayed) {
      if (a.mode === "clean" && e.verdict !== "CLEAN" && e.verdict !== "OK") continue;
      if (e.liq < a.minLiq) continue;
      if (!takeQuota(chat, "alert", ALERTS_PER_DAY)) break;
      send(
        chat,
        [
          `📡 <b>New launch</b>${isOwner ? " · live" : ""} · ${CHAIN_LABEL[e.chain] ?? e.chain}`,
          `${VERDICT_ICON[e.verdict] ?? "⚪️"} <b>$${esc(e.symbol)}</b> · ${e.score ?? "-"} ${e.verdict.replace("_", " ")} · liq $${fmtUsd(e.liq)} · FDV $${fmtUsd(e.fdv)}${e.ageH != null ? ` · ${e.ageH < 1 ? `${Math.round(e.ageH * 60)}m` : `${e.ageH}h`} old` : ""}`,
          esc(e.reason),
          ...(e.narrative ? [`🔮 Called by Narrative Radar: <a href="${siteUrl()}/narratives#n-${e.narrative.id}">${esc(e.narrative.title)}</a>`] : []),
          `<code>${esc(e.id)}</code>`,
        ].join("\n"),
        [[{ text: "🔎 Full scan", url: `${siteUrl()}/scan/${e.id}` }, { text: "👁 Watch", callback_data: `w:${e.id}` }]],
        inTopic(chat, "radar"),
      );
    }
  }
}

function alertsMenu(chat: string) {
  const a = prefs(chat).alerts ?? { on: false, mode: "clean" as const, minLiq: 10_000 };
  const where = inTopic(chat, "radar");
  const mark = (b: boolean) => (b ? "● " : "○ ");
  send(
    chat,
    `📡 <b>Launch Radar alerts</b>: ${a.on ? "on" : "off"}\nFresh launches on Solana, Robinhood Chain, BNB Chain and Base, scanned by the swarm. Up to ${ALERTS_PER_DAY} a day. Crawler owners get them live, everyone else 10 minutes later.`,
    [
      [{ text: a.on ? "🔕 Turn off" : "🔔 Turn on", callback_data: a.on ? "a:off" : "a:on" }],
      [
        { text: `${mark(a.mode === "clean")}Clean / OK only`, callback_data: "a:m:clean" },
        { text: `${mark(a.mode === "all")}All verdicts`, callback_data: "a:m:all" },
      ],
      [5_000, 25_000, 100_000].map((v) => ({ text: `${mark(a.minLiq === v)}liq ≥ $${fmtUsd(v)}`, callback_data: `a:l:${v}` })),
    ],
    where,
  );
}

// ---------- Narrative Snipe Alerts ----------
function narrMenu(chat: string) {
  const n = prefs(chat).narr ?? { on: false, mode: "first" as const };
  const where = inTopic(chat, "narr");
  const mark = (b: boolean) => (b ? "● " : "○ ");
  send(
    chat,
    `🔮 <b>Narrative launch alerts</b>: ${n.on ? "on" : "off"}\nWhen a coin launches on a narrative our hunter found, the swarm scans it at once. Get the first clean coin of every narrative, or every launch with its verdict. Up to ${ALERTS_PER_DAY} alerts a day.`,
    [
      [{ text: n.on ? "🔕 Turn off" : "🔔 Turn on", callback_data: n.on ? "n:off" : "n:on" }],
      [
        { text: `${mark(n.mode === "first")}First clean coin only`, callback_data: "n:m:first" },
        { text: `${mark(n.mode === "all")}Every launch`, callback_data: "n:m:all" },
      ],
    ],
    where,
  );
}

export async function pushNarrativeLaunch(n: { id: string; title: string; ticker: string }, l: { mint: string; symbol: string; launchedAt: number; scannedAt: number; verdict: string | null; score: number | null; fdv: number | null }, firstClean: boolean) {
  const subs = Object.entries(prefsAll()).filter(([, p]) => p.narr?.on);
  if (!subs.length) return;
  const mins = Math.max(1, Math.round((l.scannedAt - l.launchedAt) / 60_000));
  const head = firstClean ? `🚨 <b>First clean coin on a narrative</b>` : `🔮 <b>New coin on a narrative</b>`;
  const text = [
    head,
    `“${esc(n.title)}” → <b>$${esc(l.symbol)}</b>`,
    `${VERDICT_ICON[l.verdict ?? ""] ?? "⚪️"} ${l.verdict ? `${l.verdict.replace("_", " ")}${l.score != null ? ` ${l.score}` : ""}` : "scan failed"}${l.fdv ? ` · FDV $${fmtUsd(l.fdv)}` : ""} · scanned ${mins} min after launch`,
    `<code>${esc(l.mint)}</code>`,
  ].join("\n");
  for (const [chat, p] of subs) {
    if (p.narr!.mode === "first" && !firstClean) continue;
    if (!takeQuota(chat, "alert", ALERTS_PER_DAY)) continue;
    send(chat, text, [[{ text: "🔎 Full scan", url: `${siteUrl()}/scan/${l.mint}` }, { text: "🔮 Narrative", url: `${siteUrl()}/narratives#n-${n.id}` }]], inTopic(chat, "narr"));
  }
}

// ---------- сжигания $CRAWLHIVE ----------
function burnsMenu(chat: string) {
  const on = !!prefs(chat).burns;
  send(
    chat,
    `🔥 <b>$${TOKEN.symbol} burn alerts</b>: ${on ? "on" : "off"}\nEvery buyback and burn from the treasury, posted here with its transaction the moment the server confirms it.`,
    [[{ text: on ? "🔕 Turn off" : "🔔 Turn on", callback_data: on ? "b:off" : "b:on" }]],
    inTopic(chat, "burns"),
  );
}

const nextBurn = () => {
  const d = new Date();
  const h = d.getUTCHours() < 12 ? 12 : 24;
  return h === 12 ? "12:00 UTC" : "00:00 UTC";
};

export function pushBurn(rec: { sig: string; kind: "buyback" | "burn"; sol: number; burned: number }, stats: { count: number; burned: number; burnedPct: number }) {
  const subs = Object.entries(prefsAll()).filter(([, p]) => p.burns);
  if (!subs.length) return;
  const n = (x: number) => Math.round(x).toLocaleString("en-US");
  const text = [
    rec.kind === "buyback" ? `🔥 <b>Burn #${stats.count}</b>: ${rec.sol.toFixed(2)} SOL bought back <b>${n(rec.burned)} $${TOKEN.symbol}</b> and burned it forever` : `🔥 <b>Burned ${n(rec.burned)} $${TOKEN.symbol}</b> from the treasury`,
    `Total burned: ${n(stats.burned)} (${stats.burnedPct.toFixed(2)}% of supply)`,
    `Next burn: ${nextBurn()}`,
  ].join("\n");
  for (const [chat] of subs)
    send(chat, text, [[{ text: "🔎 Transaction", url: `https://solscan.io/tx/${rec.sig}` }, { text: "🔥 All burns", url: `${siteUrl()}/#treasury` }]], inTopic(chat, "burns"));
}

export function setAlerts(chat: string, patch: Partial<NonNullable<ChatPrefs["alerts"]>>) {
  const cur = prefs(chat).alerts ?? { on: false, mode: "clean" as const, minLiq: 10_000 };
  setPrefs(chat, { alerts: { ...cur, ...patch } });
}

async function radarMessage(chat: string) {
  const { radarFeed } = await import("./radar");
  const f = radarFeed();
  if (!f.items.length) return send(chat, "Launch Radar has nothing to show yet. Try again in a few minutes.");
  send(
    chat,
    [
      `📡 <b>Launch Radar</b> · last ${Math.min(8, f.items.length)} launches (${f.delayMin} min delay)`,
      ...f.items.slice(0, 8).map((e) => `${VERDICT_ICON[e.verdict] ?? "⚪️"} <a href="${siteUrl()}/scan/${e.id}">$${esc(e.symbol)}</a> · ${e.score ?? "-"} ${e.verdict.replace("_", " ")} · liq $${fmtUsd(e.liq)} · ${e.chain === "robinhood" ? "RH" : e.chain === "bsc" ? "BNB" : "SOL"}`),
    ].join("\n"),
    [[{ text: "🔔 Get these as alerts", callback_data: "a:menu" }, { text: "🐝 Live with a crawler", url: `${siteUrl()}/spawn` }]],
  );
}

async function narrativesMessage(chat: string) {
  const { narrativeFeed } = await import("./narrative-radar");
  const { launchHrefFor } = await import("../narrative");
  const f = narrativeFeed();
  if (!f.items.length) return send(chat, "Narrative Radar has nothing to show yet. The first hunt lands in a few minutes.");
  const HEAT: Record<string, string> = { hot: "🔥", rising: "📈", early: "🌱" };
  send(
    chat,
    [
      `🔮 <b>Narrative Radar</b> · what the platform's hunter found on X`,
      ...f.items.slice(0, 6).map(
        (n) =>
          `${HEAT[n.heat] ?? "🌱"} <b>${esc(n.title)}</b> · $${esc(n.ticker)}\n${esc(n.why)}${n.clones === 0 ? "\n✓ no coin on this ticker yet" : ""}\n${n.launched ? `🚀 launched: <a href="${siteUrl()}/scan/${n.launched.mint}">$${esc(n.launched.symbol)}</a>` : `<a href="${esc(launchHrefFor({ title: n.title, ticker: n.ticker, why: n.why, post: n.posts[0], img: n.media?.[0], nid: n.id }, siteUrl()))}">🚀 Launch this narrative</a>`}`,
      ),
    ].join("\n\n"),
    [[{ text: "🔮 Open Narrative Radar", url: `${siteUrl()}/narratives` }], [{ text: "🔔 Alert me on narrative launches", callback_data: "n:menu" }]],
  );
}

async function trackMessage(chat: string) {
  const { trackStats } = await import("./track");
  const t = trackStats();
  const by = new Map(t.by.map((b) => [b.verdict, b]));
  const sum = (vs: string[]) => vs.reduce((a, v) => ({ s: a.s + (by.get(v as never)?.settled ?? 0), d: a.d + (by.get(v as never)?.dumped ?? 0) }), { s: 0, d: 0 });
  const bad = sum(["DANGER"]);
  const good = sum(["CLEAN", "OK"]);
  const share = (x: { s: number; d: number }) => (x.s ? `${Math.round((x.d / x.s) * 100)}% (${x.d} of ${x.s})` : "nothing settled yet");
  send(
    chat,
    [
      "🎯 <b>Track Record</b>: every verdict checked against the price for 24 hours",
      `🔴 DANGER that dumped: ${share(bad)}`,
      `🟢 CLEAN / OK that dumped: ${share(good)}`,
      `Tracked so far: ${t.total}`,
    ].join("\n"),
    [[{ text: "Open Track Record", url: `${siteUrl()}/track` }]],
  );
}

// ---------- inline-режим ----------

export async function handleInline(q: { id: string; query: string }) {
  const query = scanQuery(q.query);
  const help = { button: { text: "Scan in the bot", start_parameter: "inline" }, cache_time: 5, is_personal: true };
  if (!query) return call("answerInlineQuery", { inline_query_id: q.id, results: [], ...help }).catch(() => {});
  const { savedScan } = await import("./scan");
  let r: ScanResult | undefined = ADDR_RE.test(query) ? savedScan(query) : undefined;
  if (!r) r = await Promise.race([runFor(query), new Promise<undefined>((res) => setTimeout(() => res(undefined), 8_000))]).catch(() => undefined);
  if (!r) return call("answerInlineQuery", { inline_query_id: q.id, results: [], ...help }).catch(() => {});
  await call("answerInlineQuery", {
    inline_query_id: q.id,
    cache_time: 60,
    results: [
      {
        type: "article",
        id: r.id.slice(0, 60),
        title: `$${r.symbol} · ${r.score != null ? `${r.score} ` : ""}${r.verdict.replace("_", " ")}`,
        description: r.reason.slice(0, 120),
        thumbnail_url: `${siteUrl()}/scan/${r.id}/opengraph-image?v=${r.scannedAt}`,
        input_message_content: { message_text: `${caption(r, null, true)}\n\n<a href="${siteUrl()}/scan/${r.id}">Full scan on CrawlHive</a>`, parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        reply_markup: { inline_keyboard: [[{ text: "🔎 Full scan", url: `${siteUrl()}/scan/${r.id}` }]] },
      },
    ],
  }).catch((e) => console.warn("[telegram] inline", (e as Error).message));
}

// ---------- кнопки ----------

export async function handleCallback(q: { id: string; data?: string; from?: { id: number }; message?: { chat: { id: number }; message_thread_id?: number } }) {
  call("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
  const chat = q.message ? String(q.message.chat.id) : null;
  const d = q.data ?? "";
  if (!chat) return;
  if (d.startsWith("w:")) return addWatch(chat, d.slice(2));
  if (d.startsWith("r:")) return doScan(chat, d.slice(2));
  if (d.startsWith("t:rh:")) return doScan(chat, `$${d.slice(5)}`, "robinhood");
  if (d.startsWith("t:bsc:")) return doScan(chat, `$${d.slice(6)}`, "bsc");
  if (d.startsWith("t:base:")) return doScan(chat, `$${d.slice(7)}`, "base");
  // В группах настройки меняют только админы: иначе любой участник включил бы оповещения на всю группу.
  if (d.startsWith("a:") && chat.startsWith("-") && !(await isAdmin(chat, q.from?.id))) return;
  if (d.startsWith("b:") && chat.startsWith("-") && !(await isAdmin(chat, q.from?.id))) return;
  if (d === "b:on" || d === "b:off") {
    if (d === "b:on") rememberTopic(chat, "burns", q.message?.message_thread_id);
    setPrefs(chat, { burns: d === "b:on" });
    return burnsMenu(chat);
  }
  if (d.startsWith("n:") && chat.startsWith("-") && !(await isAdmin(chat, q.from?.id))) return;
  if (d === "n:menu") return narrMenu(chat);
  if (d === "n:on" || d === "n:off") {
    if (d === "n:on") rememberTopic(chat, "narr", q.message?.message_thread_id);
    setPrefs(chat, { narr: { ...(prefs(chat).narr ?? { on: false, mode: "first" as const }), on: d === "n:on" } });
    return narrMenu(chat);
  }
  if (d.startsWith("n:m:")) {
    setPrefs(chat, { narr: { ...(prefs(chat).narr ?? { on: false, mode: "first" as const }), mode: d.slice(4) === "all" ? "all" : "first" } });
    return narrMenu(chat);
  }
  if (d === "a:menu") return alertsMenu(chat);
  if (d === "a:on" || d === "a:off") {
    if (d === "a:on") rememberTopic(chat, "radar", q.message?.message_thread_id);
    setAlerts(chat, { on: d === "a:on" });
    return alertsMenu(chat);
  }
  if (d.startsWith("a:m:")) {
    setAlerts(chat, { mode: d.slice(4) === "all" ? "all" : "clean" });
    return alertsMenu(chat);
  }
  if (d.startsWith("a:l:")) {
    setAlerts(chat, { minLiq: Number(d.slice(4)) || 10_000 });
    return alertsMenu(chat);
  }
}

// ---------- сообщения ----------

// Приветствие: баннер приложения и коротко — что умеет бот. Остальные команды работают, но в меню их нет.
// ---------- watchlist кошельков (Pro) ----------

// Владелец watchlist в этом чате: кошелёк с лучшим тарифом среди привязанных к чату.
async function watchOwner(chat: string): Promise<string | null> {
  const { walletsOfChat } = await import("./watchlist");
  const { tierOf, TIER_ORDER } = await import("./tiers");
  let best: { w: string; i: number } | null = null;
  for (const w of walletsOfChat(chat)) {
    const i = TIER_ORDER.indexOf((await tierOf(w).catch(() => null))?.tier ?? "free");
    if (!best || i > best.i) best = { w, i };
  }
  return best?.w ?? null;
}

const LINK_FIRST = () => `Link your wallet first: open ${siteUrl()}/watchlist, sign in and press <b>Connect Telegram</b>. Then /watch works here.`;

async function watchWallet(chat: string, arg: string) {
  const [addr, ...label] = arg.trim().split(/\s+/);
  if (!addr) return send(chat, "Send /watch followed by a wallet address and an optional label, e.g. <code>/watch 7xKX…abcd sniper guy</code>. I DM you when that wallet shows up on a new coin.");
  const owner = await watchOwner(chat);
  if (!owner) return send(chat, LINK_FIRST());
  const { addWatch } = await import("./watchlist");
  try {
    const r = await addWatch(owner, addr, label.join(" "));
    return send(chat, `👁 Watching <code>${esc(addr.slice(0, 4))}…${esc(addr.slice(-4))}</code>${label.length ? ` (${esc(label.join(" ").slice(0, 40))})` : ""}. ${r.count}/${r.max} on your ${r.tier} plan.\nI'll DM you the moment the swarm sees it on a new coin. /watchlist · /unwatch &lt;address&gt;`);
  } catch (e) {
    return send(chat, esc((e as Error).message));
  }
}

async function walletWatchText(chat: string) {
  const owner = await watchOwner(chat);
  if (!owner) return `👛 <b>Wallets</b>\n${LINK_FIRST()}`;
  const { watchState } = await import("./watchlist");
  const st = await watchState(owner).catch(() => null);
  if (!st) return "👛 <b>Wallets</b>\nWallet memory is unavailable right now.";
  if (!st.max) return `👛 <b>Wallets</b>\nWallet watchlist is for $${TOKEN.symbol} holders and Pro: ${siteUrl()}/pricing`;
  const rows = st.list.map(
    (w) => `<code>${esc(w.wallet.slice(0, 4))}…${esc(w.wallet.slice(-4))}</code>${w.label ? ` ${esc(w.label)}` : ""} · ${w.tokens} coin${w.tokens === 1 ? "" : "s"}${w.risk ? ` · risk ${w.risk.score} ${w.risk.level}` : ""}`,
  );
  return [`👛 <b>Wallets</b> · ${st.list.length}/${st.max ?? "∞"} (${st.tier})`, ...(rows.length ? rows : ["Empty. Add one: /watch &lt;wallet&gt; [label]"])].join("\n");
}

// Watch оператора (Whale): /watchop <кошелёк-участник или op_…> [подпись]. Кошелёк сводится к его оператору.
async function watchOperator(chat: string, arg: string) {
  const [target, ...label] = arg.trim().split(/\s+/);
  if (!target) return send(chat, "Send /watchop followed by a member wallet or an operator id, e.g. <code>/watchop op_1a2b3c4d5e6f</code>. I DM you when any wallet of that operator shows up on a new coin (Whale).");
  const owner = await watchOwner(chat);
  if (!owner) return send(chat, LINK_FIRST());
  const { addWatchOp } = await import("./operator-watch");
  try {
    const r = await addWatchOp(owner, target, label.join(" "));
    return send(chat, `🕸 Watching operator <code>${esc(r.op)}</code> (${r.members} wallets). ${r.count}/${r.max} on your Whale plan.\nOne DM per coin when any of its wallets shows up. /watchlist · /unwatch ${esc(r.op)}`);
  } catch (e) {
    return send(chat, esc((e as Error).message));
  }
}

async function operatorWatchText(chat: string) {
  const owner = await watchOwner(chat);
  if (!owner) return null;
  const { watchOpsState } = await import("./operator-watch");
  const st = await watchOpsState(owner).catch(() => null);
  if (!st) return null;
  if (!st.max) return `🕸 <b>Operators</b>\nOperator watch is a Whale perk: ${siteUrl()}/pricing`;
  const rows = st.list.map(
    (o) => `<code>${esc(o.op ?? o.anchor.slice(0, 4) + "…" + o.anchor.slice(-4))}</code>${o.label ? ` ${esc(o.label)}` : ""} · ${o.op ? `${o.members} wallets · ${o.coins} coin${o.coins === 1 ? "" : "s"}${o.dumpRate != null ? ` · ${Math.round(o.dumpRate * 100)}% dumped` : ""}` : "not linked right now"}`,
  );
  return [`🕸 <b>Operators</b> · ${st.list.length}/${st.max}`, ...(rows.length ? rows : ["Empty. Add one: /watchop &lt;wallet or op id&gt;"])].join("\n");
}

function welcome(chat: string) {
  const bot = telegramBotName();
  sendPhoto(
    chat,
    `${siteUrl()}/tg/hero.jpg`,
    [
      "🐝 <b>CrawlHive</b>: memecoin crawlers that never sleep.",
      "",
      "🔎 <b>Send me a token</b> (address, link or $TICKER) and I check it in seconds: holders, bundles, dev wallet, copycats, plus a ⚡ Jev take.",
      "Solana · Robinhood Chain · BNB Chain · pump.fun · Meteora · four.meme",
      "",
      "👛 <b>/watch</b> &lt;wallet&gt;: I DM you when a wallet you follow shows up on a new coin ($CRAWLHIVE holders and Pro).",
      "🕸 <b>/watchop</b> &lt;wallet or op id&gt;: watch a whole operator, every linked wallet (Whale).",
      "",
      `🔥 <b>$${TOKEN.symbol}</b> is live: the treasury buys back and burns it every 12 hours.`,
      `<code>${TOKEN.mint}</code>`,
      "",
      "🆘 Need help? /support",
    ].join("\n"),
    [
      [{ text: "📱 Open the CrawlHive app", web_app: { url: `${siteUrl()}/tg` } }],
      [{ text: `🔥 Buy $${TOKEN.symbol}`, url: TOKEN.buy }, { text: "📈 Chart", url: TOKEN.chart }],
      [...(bot ? [{ text: "👥 Add to a group", url: `https://t.me/${bot}?startgroup=scan` }] : []), { text: "🌐 crawlhive.xyz", url: siteUrl() }],
    ],
  );
}

// ---------- поддержка и админка ----------

const waitingSupport = new Map<string, number>(); // чат → до какого времени ждём текст обращения

async function submitSupport(chat: string, from: { id: number; first_name?: string; username?: string }, text: string) {
  waitingSupport.delete(chat);
  addSupport({ from: from.id, name: from.first_name ?? "", username: from.username, text: text.slice(0, 2000), at: Date.now() });
  const who = `${esc(from.first_name ?? "")}${from.username ? ` (@${esc(from.username)})` : ""} · id <code>${from.id}</code>`;
  for (const a of adminChats()) send(a, `🆘 <b>Support</b> from ${who}\n\n${esc(text.slice(0, 2000))}\n\nReply: <code>/reply ${from.id} your answer</code>`);
  send(chat, "✅ Thanks! Your message reached the team. We'll answer right here.");
}

async function adminMessage(chat: string) {
  const st = await adminStats();
  const v = st.scans.verdicts24h;
  const usd = (n?: number) => (n == null ? "-" : `$${Math.round(n).toLocaleString("en-US")}`);
  send(
    chat,
    [
      "📊 <b>CrawlHive dashboard</b>",
      "",
      `👥 Telegram users: <b>${st.users.telegram}</b> (24h active ${st.users.telegram24h}, new ${st.users.new24h}, app ${st.users.app24h})`,
      `🌐 Site today: <b>${st.traffic.visitorsToday ?? "-"}</b> visitors, ${st.traffic.requestsToday ?? "-"} page views, ${st.traffic.blocked} blocked`,
      `🔎 Verdicts 24h: scans ${v.scan ?? 0} · crawlers ${v.crawler ?? 0} · radar ${v.radar ?? 0} · agents ${v.agent ?? 0}`,
      `🐝 Crawlers: <b>${st.crawlers.live}</b> live (${st.crawlers.active} active) · signals 24h ${st.crawlers.signals24h} · hit ${st.crawlers.scored ? Math.round((st.crawlers.hits / st.crawlers.scored) * 100) : 0}%`,
      `💰 Payments: ${st.money.payments} · ${st.money.sol.toFixed(3)} SOL + ${st.money.eth.toFixed(4)} ETH · treasury ${st.money.treasury.sol != null ? `${st.money.treasury.sol.toFixed(3)} SOL` : "-"} (${usd(st.money.treasury.sol != null && st.money.treasury.solUsd ? st.money.treasury.sol * st.money.treasury.solUsd : undefined)})`,
      `🤖 AI today: Grok ${st.ai.grok.calls}/${st.ai.grok.limit} · Jev ${st.ai.jev.calls} calls, $${st.ai.jev.cost.toFixed(4)}`,
      `🔌 Agents: ${st.agents.bots} bots (${st.agents.botsLive} live), ${st.agents.oauthApps} connected apps, ${st.agents.dutyCrawlers} Grok duty`,
      st.x402.enabled ? `🪙 x402: ${st.x402.calls24h} paid calls 24h, $${st.x402.usdc24h.toFixed(2)} USDC (total ${st.x402.callsTotal}, $${st.x402.usdcTotal.toFixed(2)})` : "🪙 x402: off",
      `👁 Watchlists ${st.telegram.watchers} · alert subs ${st.telegram.alertSubs} · groups ${st.telegram.groups}`,
      `🆘 Support: <b>${st.support.open}</b> open`,
      st.crawlers.failing.length ? `⚠️ Failing crawlers: ${st.crawlers.failing.map((c) => esc(c.name)).join(", ")}` : "✅ No failing crawlers",
    ].join("\n"),
    [[{ text: "📊 Open the full dashboard", web_app: { url: `${siteUrl()}/tg/admin` } }]],
  );
}

export async function handlePublic(m: { chat: { id: number; type: string }; text: string; message_id: number; message_thread_id?: number; from?: { id: number; first_name?: string; username?: string } }) {
  const chat = String(m.chat.id);
  if (m.from) seenTgUser(m.from);
  const [cmd0, ...rest] = m.text.trim().split(/\s+/);
  const cmd = cmd0.startsWith("/") ? cmd0.replace(/@\w+$/, "").toLowerCase() : "";
  const arg = rest.join(" ");
  const group = m.chat.type !== "private";

  if (cmd === "/scan") return arg ? doScan(chat, scanQuery(arg) ?? arg) : send(chat, "Send /scan followed by a token address, link or $TICKER.");
  if (cmd === "/radar") return radarMessage(chat);
  if (cmd === "/narratives") return narrativesMessage(chat);
  if (cmd === "/track") return trackMessage(chat);
  if (group) {
    if (cmd === "/autoscan") {
      if (!(await isAdmin(chat, m.from?.id))) return send(chat, "Only group admins can change this.");
      const on = arg.toLowerCase() !== "off";
      setPrefs(chat, { autoscan: on });
      return send(chat, on ? "✅ I will answer contract addresses posted here." : "Autoscan is off. /scan still works.");
    }
    // Оповещения в группе включают админы, и бот запоминает тему, где команда отправлена.
    if (cmd === "/alerts" || cmd === "/narrativealerts" || cmd === "/burns") {
      if (!(await isAdmin(chat, m.from?.id))) return send(chat, "Only group admins can change this.", undefined, m.message_thread_id ? { message_thread_id: m.message_thread_id } : {});
      const kind: Topic = cmd === "/alerts" ? "radar" : cmd === "/burns" ? "burns" : "narr";
      rememberTopic(chat, kind, m.message_thread_id);
      return kind === "radar" ? alertsMenu(chat) : kind === "narr" ? narrMenu(chat) : burnsMenu(chat);
    }
    if (cmd === "/start" || cmd === "/help")
      return send(chat, "🐝 Post any Solana, Robinhood Chain, BNB Chain or Base contract address and I reply with a quick verdict.\nAdmins: /autoscan off to stop · /scan &lt;address&gt; · /radar · /track\nAlerts into this topic: /alerts (Launch Radar) · /narrativealerts · /burns ($CRAWLHIVE burns)");
    if (!cmd) {
      const q = m.text.match(ADDR_RE)?.[1] ?? scanQuery(m.text);
      if (q && !q.startsWith("$")) return groupAutoscan(chat, m.message_id, q);
    }
    return;
  }

  // Поддержка: /support текст — сразу; /support без текста — ждём следующее сообщение 10 минут.
  if (cmd === "/token" || cmd === "/ca") {
    const { tokenInfo, buybackStats } = await import("./buyback");
    const [t, b] = await Promise.all([tokenInfo().catch(() => null), buybackStats().catch(() => null)]);
    const m = (t as { market?: { marketCap?: number; change24h?: number } } | null)?.market;
    const done = b?.count ?? 0;
    return send(
      chat,
      [
        `🔥 <b>$${TOKEN.symbol}</b> · Solana`,
        `<code>${TOKEN.mint}</code>`,
        m?.marketCap ? `Market cap $${fmtUsd(m.marketCap)}${m.change24h != null ? ` · ${m.change24h > 0 ? "+" : ""}${Math.round(m.change24h)}% 24h` : ""}` : "",
        b?.paused
          ? `Buybacks are paused: the treasury is paying for the DexScreener profile first${done ? ` · ${done} done so far, ${Math.round(b.burned).toLocaleString("en-US")} burned` : ""}.`
          : `Buyback &amp; burn every 12 hours from the treasury${done ? ` · ${done} done, ${Math.round(b!.burned).toLocaleString("en-US")} burned` : ""}.`,
      ].filter(Boolean).join("\n"),
      [
        [{ text: `🔥 Buy $${TOKEN.symbol}`, url: TOKEN.buy }, { text: "📈 Chart", url: TOKEN.chart }],
        [{ text: "🔥 Buybacks & burns", url: `${siteUrl()}/#treasury` }],
      ],
    );
  }
  if (cmd === "/support") {
    if (!m.from) return;
    if (arg.trim()) return submitSupport(chat, m.from, arg);
    waitingSupport.set(chat, Date.now() + 10 * 60_000);
    return send(chat, "🆘 Tell us what happened in one message: what you tried, the token address if there is one. The team answers right here.");
  }
  if (!cmd && (waitingSupport.get(chat) ?? 0) > Date.now() && m.from) return submitSupport(chat, m.from, m.text);
  // Админка владельца проекта.
  if (cmd === "/admin") {
    if (!m.from || !isProjectAdmin(m.from)) return send(chat, `This command is for the CrawlHive team. Your Telegram id: <code>${m.from?.id ?? "?"}</code>`);
    rememberAdminChat(chat);
    return adminMessage(chat);
  }
  if (cmd === "/reply") {
    if (!m.from || !isProjectAdmin(m.from)) return;
    const [to, ...words] = arg.split(/\s+/);
    if (!/^\d+$/.test(to ?? "") || !words.length) return send(chat, "Usage: /reply &lt;user id&gt; &lt;text&gt;");
    send(to, `💬 <b>CrawlHive support</b>\n\n${esc(words.join(" "))}\n\nAnything else? /support`);
    markAnswered(Number(to));
    return send(chat, "✅ Sent.");
  }
  if (cmd === "/alerts") return alertsMenu(chat);
  if (cmd === "/narrativealerts") return narrMenu(chat);
  if (cmd === "/burns") return burnsMenu(chat);
  if (cmd === "/watch") return watchWallet(chat, arg);
  if (cmd === "/watchop") return watchOperator(chat, arg);
  if (cmd === "/watchlist") {
    const mine = (watches()[chat] ?? []).filter((w) => Date.now() - w.at < WATCH_MS);
    const tokens = mine.length
      ? ["👁 <b>Tokens</b>", ...mine.map((w) => `<a href="${siteUrl()}/scan/${w.id}">$${esc(w.symbol)}</a> · ${w.verdict.replace("_", " ")} · ${Math.ceil((w.at + WATCH_MS - Date.now()) / 86400_000)}d left\n<code>${esc(w.id)}</code>`)].join("\n")
      : "No tokens watched. Scan a token and tap 👁 Watch.";
    const opsText = await operatorWatchText(chat);
    return send(chat, `${await walletWatchText(chat)}${opsText ? `\n\n${opsText}` : ""}\n\n${tokens}`);
  }
  if (cmd === "/unwatch") {
    const target = arg.trim();
    // Сначала кошельки из watchlist (Pro), потом токены из старого списка наблюдения.
    const owner = await watchOwner(chat);
    if (owner && target) {
      const { removeWatch } = await import("./watchlist");
      if (await Promise.resolve().then(() => removeWatch(owner, target)).catch(() => false)) return send(chat, "Removed from your wallet watchlist.");
      // Потом операторы (Whale): по id или кошельку-участнику.
      const { removeWatchOp } = await import("./operator-watch");
      if (await Promise.resolve().then(() => removeWatchOp(owner, target)).catch(() => false)) return send(chat, "Stopped watching that operator.");
    }
    const all = watches();
    const before = all[chat]?.length ?? 0;
    all[chat] = (all[chat] ?? []).filter((w) => w.id !== target);
    saveWatches(all);
    return send(chat, (all[chat]?.length ?? 0) < before ? "Removed." : "Send /unwatch followed by a wallet, operator id or token address from /watchlist.");
  }
  if (cmd === "/settings") {
    const p = prefs(chat);
    return send(chat, `⚙️ <b>Settings</b>\n24h follow-ups: ${p.followups === false ? "off" : "on"}\nRadar alerts: ${p.alerts?.on ? "on" : "off"}\n\n/followups on|off · /alerts`);
  }
  if (cmd === "/followups") {
    const on = arg.toLowerCase() !== "off";
    setPrefs(chat, { followups: on });
    return send(chat, on ? "✅ I will tell you 24 hours later whether a verdict came true." : "Follow-ups are off.");
  }
  if (cmd === "/start" || cmd === "/help") return welcome(chat);
  const q = scanQuery(m.text);
  if (q) return doScan(chat, q);
  send(chat, "Send me a token address, a DexScreener / pump.fun link or a $TICKER and I'll check it. Need help? /support");
}

// Напоминание команде: каждые 12 часов (00:00 и 12:00 UTC) — пора выкупить и сжечь токен на деньги казны.
// Один раз на окно; без адреса токена молчим.
export async function buybackReminder() {
  const { tokenConfig, nextBuybackAt, treasurySol, buybackPaused, buybackPlanSol } = await import("./buyback");
  const plan = buybackPlanSol();
  if (!tokenConfig().mint || buybackPaused()) return;
  const slot = nextBuybackAt() - 12 * 3600_000; // начало текущего окна
  if (Date.now() - slot > 30 * 60_000 || getMeta("buybackRemind") === String(slot)) return;
  setMeta("buybackRemind", String(slot));
  const sol = await treasurySol(true).catch(() => null);
  const spendable = sol == null ? null : Math.max(0, sol - 0.05);
  for (const a of adminChats())
    send(
      a,
      `🔥 <b>Buyback time: ${plan} SOL</b>\n\nTreasury: <b>${sol == null ? "-" : sol.toFixed(3)} SOL</b>${spendable ? ` · ${spendable.toFixed(3)} SOL to spend` : ""}.${spendable != null && spendable < plan ? " ⚠️ Less than the plan in the treasury." : ""}\nOpen the site with the treasury wallet in Phantom: the amount is already filled in, press <b>Buy back &amp; burn</b>.`,
      [[{ text: "🔥 Open buyback", url: `${siteUrl()}/#treasury` }]],
    );
}
