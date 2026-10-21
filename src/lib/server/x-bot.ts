// Бот в X: отвечает тем, кто тегнул наш аккаунт под контрактом. Раз в минуту читает упоминания (X API v2,
// OAuth 1.0a от имени аккаунта бота), достаёт адрес из твита или из твита, на который ответили, сканирует и
// отвечает коротким вердиктом со ссылкой /scan/<адрес>: X развернёт её в нашу карточку. Без ключей X_* выключен.
// Защита от бана: отвечаем только на упоминания, не больше X_BOT_PER_USER_HOUR ответов человеку в час,
// X_BOT_DAILY в сутки, одну монету в одном треде не повторяем.
import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { getMeta, setMeta } from "./store";

const API = "https://api.x.com/2";
const POLL_MS = Number(process.env.X_BOT_POLL_SEC ?? 60) * 1000;
const DAILY = Number(process.env.X_BOT_DAILY ?? 200);
const PER_USER_HOUR = Number(process.env.X_BOT_PER_USER_HOUR ?? 2);
const ADDR_RE = /\b(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/;

const keys = () => {
  const k = { ck: process.env.X_API_KEY?.trim(), cs: process.env.X_API_SECRET?.trim(), at: process.env.X_ACCESS_TOKEN?.trim(), as: process.env.X_ACCESS_SECRET?.trim() };
  return k.ck && k.cs && k.at && k.as ? (k as { ck: string; cs: string; at: string; as: string }) : null;
};
export const xBotEnabled = () => !!keys() && process.env.X_BOT_OFF !== "1";

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Подпись OAuth 1.0a (HMAC-SHA1): параметры запроса строки входят в подпись, тело JSON — нет.
function authHeader(method: string, url: string) {
  const k = keys()!;
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: k.ck,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: k.at,
    oauth_version: "1.0",
  };
  const params = [...Object.entries(oauth), ...[...u.searchParams.entries()]].map(([a, b]) => [enc(a), enc(b)] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(params.map(([a, b]) => `${a}=${b}`).join("&"))].join("&");
  const sig = createHmac("sha1", `${enc(k.cs)}&${enc(k.as)}`).update(base).digest("base64");
  return "OAuth " + Object.entries({ ...oauth, oauth_signature: sig }).map(([a, b]) => `${enc(a)}="${enc(b)}"`).join(", ");
}

// X отклоняет пост с двумя и больше кэштегами (403), поэтому со второго $TICKER снимаем знак доллара.
const oneCashtag = (text: string) => {
  let seen = false;
  return text.replace(/\$([A-Za-z][A-Za-z0-9_]*)/g, (m, sym) => (seen ? sym : ((seen = true), m)));
};

async function x<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (body && typeof (body as { text?: unknown }).text === "string") body = { ...(body as object), text: oneCashtag((body as { text: string }).text) };
  const url = `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: authHeader(method, url), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as T & { title?: string; detail?: string };
  if (!res.ok) throw Object.assign(new Error(`X ${res.status}: ${j.detail ?? j.title ?? "error"}`), { status: res.status });
  return j;
}

interface Tweet {
  id: string;
  text: string;
  author_id?: string;
  conversation_id?: string;
  referenced_tweets?: { type: string; id: string }[];
  entities?: { urls?: { expanded_url?: string; unwound_url?: string }[]; cashtags?: { tag: string }[] };
}

// Адрес контракта из твита: из текста или из ссылок (pump.fun, DexScreener, GMGN), которые X прячет за t.co.
// Тикер из твита: кэштег X или $ТИКЕР в тексте (без $SOL, $ETH и подобных базовых).
const BASE_TICKERS = new Set(["SOL", "ETH", "BTC", "BNB", "USDC", "USDT", "WETH", "WSOL", "BASE"]);
const tickerOf = (t?: Tweet) => {
  if (!t) return undefined;
  const tags = [...(t.entities?.cashtags ?? []).map((c) => c.tag), ...[...t.text.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,11})\b/g)].map((m) => m[1])];
  return tags.map((x) => x.toUpperCase()).find((x) => !BASE_TICKERS.has(x));
};

// Монета по тикеру: самая ликвидная пара на наших сетях, только если она явно главная (втрое ликвиднее следующей
// монеты с тем же тикером): иначе честно не угадываем.
async function byTicker(ticker: string): Promise<{ address: string; chain: string } | null> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(ticker)}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  const j = (res?.ok ? await res.json().catch(() => null) : null) as { pairs?: { chainId: string; baseToken: { address: string; symbol: string }; liquidity?: { usd?: number } }[] } | null;
  const best = new Map<string, { address: string; chain: string; liq: number }>();
  for (const p of j?.pairs ?? []) {
    if (!["solana", "bsc", "base", "robinhood"].includes(p.chainId) || p.baseToken.symbol.toUpperCase() !== ticker) continue;
    const k = `${p.chainId}:${p.baseToken.address.toLowerCase()}`;
    const liq = p.liquidity?.usd ?? 0;
    if (!best.has(k) || best.get(k)!.liq < liq) best.set(k, { address: p.baseToken.address, chain: p.chainId, liq });
  }
  const list = [...best.values()].sort((a, b) => b.liq - a.liq);
  if (!list[0] || list[0].liq < 5_000 || (list[1] && list[0].liq < list[1].liq * 3)) return null;
  return list[0];
}

const addrOf = (t?: Tweet) => {
  if (!t) return undefined;
  const urls = (t.entities?.urls ?? []).map((u) => u.unwound_url ?? u.expanded_url ?? "").join(" ");
  return `${t.text} ${urls}`.replace(/@\w+/g, " ").match(ADDR_RE)?.[1];
};

// Состояние в meta: последний обработанный id, счётчики, отвеченные пары «тред+монета».
interface State {
  me?: string;
  since?: string;
  day?: string;
  count?: number;
  users?: Record<string, number[]>;
  done?: string[];
  log?: { id: string; symbol: string; verdict: string; score: number | null; at: number }[]; // ответы бота для дневной сводки
  digestDay?: string;
}
const KEY = "xbot";
const load = (): State => {
  try {
    return JSON.parse(getMeta(KEY) ?? "{}");
  } catch {
    return {};
  }
};
const save = (s: State) => setMeta(KEY, JSON.stringify(s));

const VERDICT_ICON: Record<string, string> = { CLEAN: "🟢", OK: "🟢", RISKY: "🟠", DANGER: "🔴", TOO_EARLY: "⚪️" };

// Значок вердикта Larpcheck: зелёный для REAL, красный для LARP и SCAM, жёлтый для остального.
const larpIcon = (v: string) => (/SCAM|LARP/.test(v) ? "🔴" : /REAL/.test(v) && !/PARTLY/.test(v) ? "🟢" : "🟡");

function replyText(r: { symbol: string; score: number | null; verdict: string; reason: string; id: string; larp?: { verdict: string; score: number | null; headline?: string | null } }, site: string, byTick = false) {
  // Монету нашли по тикеру: пишем, какой контракт проверили, чтобы человек мог сверить.
  const head = `${VERDICT_ICON[r.verdict] ?? "⚪️"} CrawlHive: $${r.symbol} ${r.score != null ? `${r.score}/100 ` : ""}${r.verdict.replace("_", " ")}${byTick ? `\nMost liquid $${r.symbol}: ${r.id.slice(0, 6)}…${r.id.slice(-4)}` : ""}`;
  const link = `\n\nFull scan, holders map: ${site}/scan/${r.id}`;
  // Причина риска — коротко; Larpcheck — отдельным блоком со своим значком и, если влезает, их выводом.
  const reason = r.reason.length > 70 ? `${r.reason.slice(0, 69)}…` : r.reason;
  let larp = "";
  if (r.larp) {
    larp = `\n\n🔍 Larpcheck: ${larpIcon(r.larp.verdict)} ${r.larp.verdict}${r.larp.score != null ? ` ${r.larp.score}/100` : ""}`;
    // X считает любую ссылку за 23 символа, поэтому длинный адрес скана места не съедает.
    const linkLen = link.length - `${site}/scan/${r.id}`.length + 23;
    const room = 280 - head.length - 1 - reason.length - larp.length - linkLen - 6;
    const h = r.larp.headline?.trim();
    if (h && room > 40) larp += `\n"${h.length > room ? `${h.slice(0, room - 1)}…` : h}"`;
  }
  return `${head}\n${reason}${larp}${link}`;
}

// ---------- дневная сводка ----------
// Раз в сутки (X_BOT_DIGEST_HOUR UTC, по умолчанию 15) отдельный пост: сколько монет бот проверил за 24 часа,
// сколько DANGER / RISKY / CLEAN, и лучший улов — монета с DANGER или RISKY за 24-72 часа, которая потом
// действительно рухнула (по Track Record). Нет такой — строку не пишем, ничего не выдумываем.
const DIGEST_HOUR = Number(process.env.X_BOT_DIGEST_HOUR ?? 15);
const DIGEST_MIN = 3;

async function digestText(s: State): Promise<string | null> {
  const now = Date.now();
  const day = (s.log ?? []).filter((e) => now - e.at < 24 * 3600_000);
  if (day.length < DIGEST_MIN) return null;
  const n = (f: (v: string) => boolean) => day.filter((e) => f(e.verdict)).length;
  const lines = [
    `🐙 Last 24h on X: I scanned ${day.length} coins you tagged me under`,
    "",
    `🔴 ${n((v) => v === "DANGER")} DANGER`,
    `🟠 ${n((v) => v === "RISKY")} RISKY`,
    `🟢 ${n((v) => v === "CLEAN" || v === "OK")} CLEAN`,
  ];
  const { trackOutcomes, trackEntry } = await import("./track");
  const out = trackOutcomes();
  const catches = (s.log ?? [])
    .filter((e) => now - e.at < 72 * 3600_000 && (e.verdict === "DANGER" || e.verdict === "RISKY"))
    .map((e) => ({ e, o: out.get(e.id), t: trackEntry(e.id, e.at) }))
    .filter((c) => c.o?.dumped || c.o?.rugged)
    .sort((a, b) => (a.t?.lowPct ?? 0) - (b.t?.lowPct ?? 0));
  const best = catches[0];
  if (best) {
    const drop = best.t?.lowPct != null && best.t.lowPct < 0 ? `${Math.round(best.t.lowPct)}%` : best.o?.rugged ? "rugged" : "dumped";
    lines.push("", `Best catch: $${best.e.symbol} flagged ${best.e.verdict}, then ${drop}`);
  }
  lines.push("", "Tag @crawlhivebot under any coin", "crawlhive.xyz");
  let text = lines.join("\n");
  // Ссылка считается за 23 символа; при переборе сначала убираем пустые строки.
  if (text.length - "crawlhive.xyz".length + 23 > 280) text = lines.filter(Boolean).join("\n");
  return text;
}

async function maybeDigest(s: State) {
  if (process.env.X_BOT_DIGEST_OFF === "1") return;
  const d = new Date();
  const today = d.toISOString().slice(0, 10);
  if (s.digestDay === today || d.getUTCHours() < DIGEST_HOUR) return;
  s.digestDay = today; // помечаем сразу: даже если постить нечего, повторно в этот день не пробуем
  const text = await digestText(s);
  if (!text) return;
  await x("POST", "/tweets", { text });
  console.log("[xbot] digest posted");
}

async function tick() {
  const s = load();
  const today = new Date().toISOString().slice(0, 10);
  if (s.day !== today) Object.assign(s, { day: today, count: 0 });
  if (!s.me) s.me = (await x<{ data: { id: string } }>("GET", "/users/me")).data.id;
  const q = new URLSearchParams({ max_results: "20", expansions: "referenced_tweets.id", "tweet.fields": "author_id,conversation_id,referenced_tweets,entities" });
  if (s.since) q.set("since_id", s.since);
  const res = await x<{ data?: Tweet[]; includes?: { tweets?: Tweet[] }; meta?: { newest_id?: string } }>("GET", `/users/${s.me}/mentions?${q}`);
  const refs = new Map((res.includes?.tweets ?? []).map((t) => [t.id, t]));
  // Первый запуск: запоминаем точку и не отвечаем на старые упоминания.
  if (!s.since) {
    s.since = res.meta?.newest_id ?? "0";
    return save(s);
  }
  if (res.meta?.newest_id) s.since = res.meta.newest_id;
  const { runScan, allowHit } = await import("./scan");
  const site = process.env.SITE_URL?.replace(/\/$/, "") || "https://crawlhive.xyz";
  for (const t of [...(res.data ?? [])].reverse()) {
    if (t.author_id === s.me || (s.count ?? 0) >= DAILY) continue;
    const parent = t.referenced_tweets?.find((r) => r.type === "replied_to" || r.type === "quoted");
    // Достаточно тегнуть бота ответом на твит с контрактом: адрес берём из упоминания, а если его нет, то из твита выше.
    let addr = addrOf(t) ?? (parent ? addrOf(refs.get(parent.id)) : undefined);
    // Контракта нет: пробуем тикер из упоминания или из твита выше.
    let byTick = false;
    if (!addr) {
      const tick = tickerOf(t) ?? (parent ? tickerOf(refs.get(parent.id)) : undefined);
      const hit = tick ? await byTicker(tick).catch(() => null) : null;
      if (hit) {
        addr = hit.address;
        byTick = true;
      }
    }
    if (!addr) continue;
    const pair = `${t.conversation_id ?? t.id}:${addr.toLowerCase()}`;
    if (s.done?.includes(pair)) continue;
    const now = Date.now();
    const recent = (s.users?.[t.author_id ?? ""] ?? []).filter((at) => now - at < 3600_000);
    if (recent.length >= PER_USER_HOUR || !allowHit(`xbot:${t.author_id}`, PER_USER_HOUR, 3600_000)) continue;
    try {
      const r = await runScan(addr, () => {}, undefined, { src: "agent" });
      await x("POST", "/tweets", { text: replyText(r, site, byTick), reply: { in_reply_to_tweet_id: t.id } });
      s.count = (s.count ?? 0) + 1;
      s.users = { ...s.users, [t.author_id ?? ""]: [...recent, now] };
      s.done = [...(s.done ?? []), pair].slice(-500);
      s.log = [...(s.log ?? []), { id: r.id, symbol: r.symbol, verdict: r.verdict, score: r.score, at: now }].slice(-300);
      console.log(`[xbot] replied ${t.id} $${r.symbol} ${r.verdict}`);
    } catch (e) {
      console.warn("[xbot]", (e as Error).message);
      if ((e as { status?: number }).status === 429) break;
      // Адрес не читается или пары нет: не молчим, а объясняем, что не так (один раз на тред).
      if (!(e as { status?: number }).status) {
        const cut = /pu$|pum$|p$/.test(addr) && !addr.endsWith("pump");
        const msg = /No trading pair/i.test((e as Error).message)
          ? `I couldn't find a trading pair for ${addr.slice(0, 6)}…${addr.slice(-4)} yet. If it just launched, try again in a few minutes 🐙`
          : `That doesn't look like a valid token contract${cut ? ": it seems cut off (pump.fun addresses end in \"pump\")" : ""}. Copy the full CA and tag me again 🐙`;
        await x("POST", "/tweets", { text: msg, reply: { in_reply_to_tweet_id: t.id } }).catch(() => {});
        s.users = { ...s.users, [t.author_id ?? ""]: [...recent, now] };
        s.done = [...(s.done ?? []), pair].slice(-500);
      }
    }
  }
  await maybeDigest(s).catch((e) => console.warn("[xbot] digest", (e as Error).message));
  save(s);
}

export function startXBot() {
  if (!xBotEnabled()) return;
  const g = globalThis as unknown as { __crawlhiveXBot?: boolean };
  if (g.__crawlhiveXBot) return;
  g.__crawlhiveXBot = true;
  console.log("[xbot] watching mentions");
  const loop = () =>
    tick()
      .catch((e) => console.warn("[xbot]", (e as Error).message))
      .finally(() => setTimeout(loop, POLL_MS));
  setTimeout(loop, 10_000);
}
