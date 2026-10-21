// x402 — оплата за вызов по HTTP 402 для ИИ-агентов: скан токена за USDC на Solana без аккаунта и ключа.
// Протокол x402 v2 (github.com/x402-foundation/x402, specs/x402-specification-v2.md, transports-v2/http.md,
// schemes/exact/scheme_exact_svm.md); клиентов v1 (заголовок X-PAYMENT) тоже понимаем.
// Порядок «authorization» из спеки: verify → работа → settle. Деньги уходят только после успешного скана:
// упавший скан не оплачивается. Транзакцию подписывает агент, fee payer и отправку в сеть делает фасилитатор;
// у сервера нет ни одного приватного ключа, USDC приходит прямо на X402_PAY_TO.
// Сумме, получателю и сети из заголовка клиента не верим: фасилитатору отдаём только свои требования.
import "server-only";
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { PaymentPayloadSchema } from "@x402/core/schemas";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, PaymentRequirementsV1, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { ApiError, getMeta, setMeta } from "./store";
import { ISSUER } from "./oauth";
import { clientIp } from "./http";
import { checkPublicUrl } from "./safe-fetch";
import { allowHit, SCAN_CHAINS } from "./scan";

// ---------- настройки ----------

const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
// Сеть по CAIP-2 → имя сети в v1 и минт USDC в ней. Другие сети не принимаем: цена в долларах.
const NETS: Record<string, { v1: string; usdc: string }> = {
  [MAINNET]: { v1: "solana", usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  [DEVNET]: { v1: "solana-devnet", usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
};
// PayAI: Solana mainnet без ключа API (бесплатный лимит на кошелёк получателя, дальше кредиты).
const DEFAULT_FACILITATOR = "https://facilitator.payai.network";

export type X402Route = "scan" | "scan-x" | "brain" | "brain-batch";

const ROUTES: Record<X402Route, { path: string; priceEnv: string; price: number; timeout: number; description: string }> = {
  scan: {
    path: "/api/x402/scan",
    priceEnv: "X402_PRICE_SCAN",
    price: 0.01,
    timeout: 60,
    description:
      "CrawlHive memecoin safety scan: market, holders, bundled wallets, dev history, copycat tickers and Contract X-Ray (owner powers from EVM bytecode or risky Token-2022 extensions). 0-100 score and a verdict.",
  },
  "scan-x": {
    path: "/api/x402/scan-x",
    priceEnv: "X402_PRICE_SCAN_X",
    price: 0.05,
    timeout: 90,
    description: "CrawlHive memecoin safety scan plus an X buzz check by Grok: who is talking about the token on X in the last two days, sentiment and scam warnings.",
  },
  // CrawlHive Brain (brain.ts): платят только сверх бесплатного лимита, путь у вызова свой (wallet/dev/token).
  brain: {
    path: "/api/brain/v1/wallet/{address}",
    priceEnv: "X402_PRICE_BRAIN",
    price: 0.002,
    timeout: 60,
    description: "CrawlHive Brain lookup: what the swarm remembers about a wallet, a dev or a token from past scans (roles, outcomes, verdict history). No new scan is run.",
  },
  "brain-batch": {
    path: "/api/brain/v1/wallets",
    priceEnv: "X402_PRICE_BRAIN_BATCH",
    price: 0.02,
    timeout: 60,
    description: "CrawlHive Brain batch: screen up to 100 wallets against the swarm's memory of snipers, bundles, devs and their outcomes.",
  },
};
const isBrain = (r: X402Route) => r === "brain" || r === "brain-batch";

interface Cfg {
  payTo: string;
  network: string;
  v1Network: string;
  asset: string;
  facilitator: string;
}

// Цена в долларах → атомарные единицы USDC (6 знаков). Кривое значение в env — цена по умолчанию.
function priceUsd(route: X402Route) {
  const r = ROUTES[route];
  const n = Number(process.env[r.priceEnv]);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : r.price;
}
const atomic = (usd: number) => String(Math.round(usd * 1e6));

let warned = "";
const warnOnce = (msg: string) => {
  if (warned !== msg) console.error(`[x402] ${msg}`);
  warned = msg;
};

// null — оплата выключена (нет X402_PAY_TO или настройка с ошибкой: тогда пишем в лог и не принимаем деньги).
export function x402Config(): Cfg | null {
  const payTo = process.env.X402_PAY_TO?.trim();
  if (!payTo) return null;
  try {
    new PublicKey(payTo);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payTo)) throw new Error();
  } catch {
    warnOnce("X402_PAY_TO is not a Solana address, x402 is off");
    return null;
  }
  const network = process.env.X402_NETWORK?.trim() || MAINNET;
  const net = NETS[network];
  if (!net) {
    warnOnce(`X402_NETWORK ${network} is not supported (use ${MAINNET} or ${DEVNET}), x402 is off`);
    return null;
  }
  // Фасилитатор — один фиксированный адрес из настроек: только https, без логина в URL, не во внутреннюю сеть.
  const raw = (process.env.X402_FACILITATOR?.trim() || DEFAULT_FACILITATOR).replace(/\/+$/, "");
  try {
    const u = checkPublicUrl(raw);
    if (u.protocol !== "https:") throw new Error("https only");
  } catch (e) {
    warnOnce(`X402_FACILITATOR is not a public https URL (${(e as Error).message}), x402 is off`);
    return null;
  }
  return { payTo, network, v1Network: net.v1, asset: net.usdc, facilitator: raw };
}

// ---------- фасилитатор ----------

const MAX_REPLY = 64 * 1024;

async function call<T>(cfg: Cfg, path: "/supported" | "/verify" | "/settle", body: unknown, timeoutMs: number): Promise<{ status: number; data: T | null }> {
  const r = await fetch(cfg.facilitator + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
    cache: "no-store",
  });
  const text = await r.text();
  if (text.length > MAX_REPLY) throw new Error(`facilitator ${path}: reply too large`);
  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {}
  return { status: r.status, data };
}

// fee payer фасилитатора (он платит комиссию сети) — из /supported, отдельно для v2 и v1. Кэш на 10 минут;
// если фасилитатор недоступен, час живём на прошлом ответе.
const g = globalThis as unknown as {
  __crawlhiveX402?: { sup?: { at: number; key: string; v2?: string; v1?: string }; seen?: Map<string, Seen> };
};
const mem = () => (g.__crawlhiveX402 ??= {});

async function feePayers(cfg: Cfg): Promise<{ v2?: string; v1?: string }> {
  const m = mem();
  const key = cfg.facilitator + cfg.network;
  const age = m.sup && m.sup.key === key ? Date.now() - m.sup.at : Infinity;
  if (age < 10 * 60_000) return m.sup!;
  try {
    const { status, data } = await call<SupportedResponse>(cfg, "/supported", undefined, 8_000);
    if (status !== 200 || !Array.isArray(data?.kinds)) throw new Error(`HTTP ${status}`);
    const pick = (v: number, net: string) => {
      const fp = data.kinds.find((k) => k.x402Version === v && k.scheme === "exact" && k.network === net)?.extra?.feePayer;
      return typeof fp === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(fp) ? fp : undefined;
    };
    const sup = { at: Date.now(), key, v2: pick(2, cfg.network), v1: pick(1, cfg.v1Network) };
    if (!sup.v2 && !sup.v1) throw new Error(`facilitator does not list exact payments on ${cfg.network}`);
    m.sup = sup;
    return sup;
  } catch (e) {
    console.warn(`[x402] /supported failed: ${(e as Error).message}`);
    if (age < 3600_000) return m.sup!;
    throw new ApiError("Payment facilitator is unreachable right now, try again shortly", 503);
  }
}

// ---------- требования к оплате ----------

// Путь берём из запроса: у Brain он содержит адрес (wallet/dev/token), у сканов совпадает с ROUTES.
const resourceUrl = (req: NextRequest, _route: X402Route) => `${ISSUER}${req.nextUrl.pathname}${req.nextUrl.search}`;

function reqV2(cfg: Cfg, route: X402Route, feePayer: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: cfg.network as PaymentRequirements["network"],
    amount: atomic(priceUsd(route)),
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: ROUTES[route].timeout,
    extra: { feePayer },
  };
}

function reqV1(cfg: Cfg, route: X402Route, feePayer: string, url: string): PaymentRequirementsV1 {
  return {
    scheme: "exact",
    network: cfg.v1Network as PaymentRequirementsV1["network"],
    maxAmountRequired: atomic(priceUsd(route)),
    resource: url,
    description: ROUTES[route].description,
    mimeType: "application/json",
    payTo: cfg.payTo,
    maxTimeoutSeconds: ROUTES[route].timeout,
    asset: cfg.asset,
    outputSchema: { input: { type: "http", method: route === "brain-batch" ? "POST" : "GET", discoverable: true, queryParams: isBrain(route) ? {} : QUERY_SCHEMA }, output: { type: "json" } },
    extra: { feePayer },
  };
}

const QUERY_SCHEMA = {
  q: { type: "string", required: true, description: "Token address, DexScreener or pump.fun link, or $TICKER (max 200 chars)" },
  chain: { type: "string", enum: Object.keys(SCAN_CHAINS), description: "Where to look up a $TICKER (default solana); addresses find their chain by themselves" },
};

// Расширение bazaar (specs/extensions/bazaar.md): каталоги и фасилитатор узнают, какие параметры принимает вызов.
function bazaar(route: X402Route) {
  if (isBrain(route))
    return {
      info: {
        input: route === "brain" ? { type: "http", method: "GET" } : { type: "http", method: "POST", bodyType: "json", body: { wallets: ["<address>"] } },
        output: { type: "json", example: route === "brain" ? { wallet: "<address>", seen: true, tokens: 6, outcomes: { settled: 5, dumped: 4 } } : { checked: 2, seen: 1, results: [] } },
      },
    };
  return {
    info: {
      input: { type: "http", method: "GET", queryParams: { q: "$BONK", chain: "solana" } },
      output: { type: "json", example: { token: { symbol: "BONK", chain: "solana" }, score: 82, verdict: "OK", ...(route === "scan-x" ? { x: { sentiment: "mixed" } } : {}) } },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["GET"] },
            queryParams: {
              type: "object",
              properties: { q: { type: "string", maxLength: 200 }, chain: { type: "string", enum: Object.keys(SCAN_CHAINS) } },
              required: ["q"],
            },
          },
          required: ["type", "method"],
        },
        output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
      },
      required: ["input"],
    },
  };
}

function paymentRequired(cfg: Cfg, route: X402Route, url: string, fp: { v2?: string; v1?: string }, error: string) {
  const v2: PaymentRequired | null = fp.v2
    ? {
        x402Version: 2,
        error,
        resource: { url, description: ROUTES[route].description, mimeType: "application/json", serviceName: "CrawlHive", tags: ["crypto", "memecoins", "security", "solana"], iconUrl: `${ISSUER}/icon.svg` },
        accepts: [reqV2(cfg, route, fp.v2)],
        extensions: { bazaar: bazaar(route) },
      }
    : null;
  // Тело — объект v1 (там его ищут клиенты v1), заголовок PAYMENT-REQUIRED — v2, как велит транспорт v2.
  const v1 = fp.v1 ? { x402Version: 1 as const, error, accepts: [reqV1(cfg, route, fp.v1, url)] } : null;
  return { v2, v1 };
}

// ---------- ответы ----------

export const X402_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
};
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...X402_CORS, "Cache-Control": "no-store", ...headers } });

function challenge(pr: ReturnType<typeof paymentRequired>, status = 402, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (pr.v2) headers["PAYMENT-REQUIRED"] = b64(pr.v2);
  return json(pr.v1 ?? pr.v2, status, headers);
}

export const x402Off = () => json({ error: "x402 payments are not enabled yet" }, 503);

// ---------- разбор оплаты ----------

const MAX_HEADER = 8 * 1024; // транзакция Solana — до 1232 байт, в base64 с обёрткой JSON это 2–3 КБ
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

type Paid = { version: 1 | 2; payload: PaymentPayload; tx: string };

// undefined — заголовка нет; null — заголовок есть, но разобрать нельзя.
function readPayment(req: NextRequest): Paid | null | undefined {
  const raw = (req.headers.get("payment-signature") ?? req.headers.get("x-payment"))?.trim();
  if (!raw) return undefined;
  if (raw.length > MAX_HEADER || !B64_RE.test(raw)) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const p = PaymentPayloadSchema.safeParse(obj);
  if (!p.success) return null;
  const tx = (p.data.payload as { transaction?: unknown }).transaction;
  if (typeof tx !== "string" || tx.length < 64 || tx.length > 2048 || !B64_RE.test(tx)) return null;
  return { version: p.data.x402Version, payload: p.data as PaymentPayload, tx };
}

// Клиент обязан заплатить ровно то, что мы просили. Возвращает, что не сошлось.
function mismatch(p: Paid, want: PaymentRequirements, wantV1?: PaymentRequirementsV1): string | null {
  if (p.version === 1) {
    const v = p.payload as unknown as { scheme: string; network: string };
    if (!wantV1) return "x402 v1 is not available here, use PAYMENT-SIGNATURE (v2)";
    if (v.scheme !== "exact") return "scheme";
    if (v.network !== wantV1.network) return "network";
    return null;
  }
  const a = (p.payload as { accepted: PaymentRequirements }).accepted;
  for (const k of ["scheme", "network", "amount", "asset", "payTo"] as const) if (a[k] !== want[k]) return k;
  if (a.extra?.feePayer !== want.extra?.feePayer) return "extra.feePayer";
  return null;
}

// ---------- повторы ----------
// Одна подписанная транзакция — одна оплата. Ключ — хэш транзакции из заголовка. busy — оплата сейчас
// обрабатывается (второй такой же запрос не проходит, так закрывается гонка из спеки SVM), done — уже
// списана, pending — ушла в сеть, но фасилитатор не дождался подтверждения: тот же заголовок можно прислать
// ещё раз, и мы переспросим исход, не списывая дважды. done и pending переживают перезапуск (meta).

interface Seen {
  s: "busy" | "done" | "pending";
  at: number;
}
const SEEN_KEY = "x402seen";
const SEEN_TTL = { busy: 5 * 60_000, done: 30 * 60_000, pending: 60 * 60_000 };
const SEEN_MAX = 5_000;

function seen(): Map<string, Seen> {
  const m = mem();
  if (!m.seen) {
    m.seen = new Map();
    try {
      for (const [k, v] of Object.entries(JSON.parse(getMeta(SEEN_KEY) ?? "{}") as Record<string, Seen>)) m.seen.set(k, v);
    } catch {}
  }
  const now = Date.now();
  for (const [k, v] of m.seen) if (now - v.at > SEEN_TTL[v.s]) m.seen.delete(k);
  return m.seen;
}

function mark(key: string, s: Seen["s"] | null) {
  const map = seen();
  if (s) map.set(key, { s, at: Date.now() });
  else map.delete(key);
  while (map.size > SEEN_MAX) map.delete(map.keys().next().value!);
  const keep: Record<string, Seen> = {};
  for (const [k, v] of map) if (v.s !== "busy") keep[k] = v;
  setMeta(SEEN_KEY, JSON.stringify(keep));
}

// ---------- журнал для админки ----------

interface PaidCall {
  at: number;
  route: X402Route;
  usd: number;
  payer: string;
  tx: string;
}
const LOG_KEY = "x402log";
const LOG_MAX = 1_000;
const TOTALS_KEY = "x402totals";

const readJson = <T,>(k: string, d: T): T => {
  try {
    return (JSON.parse(getMeta(k) ?? "") as T) ?? d;
  } catch {
    return d;
  }
};

function record(c: PaidCall) {
  setMeta(LOG_KEY, JSON.stringify([c, ...readJson<PaidCall[]>(LOG_KEY, [])].slice(0, LOG_MAX)));
  const t = readJson<{ calls: number; micro: number }>(TOTALS_KEY, { calls: 0, micro: 0 });
  setMeta(TOTALS_KEY, JSON.stringify({ calls: t.calls + 1, micro: t.micro + Math.round(c.usd * 1e6) }));
}

export function x402Stats() {
  const cfg = x402Config();
  const now = Date.now();
  const log = readJson<PaidCall[]>(LOG_KEY, []);
  const day = log.filter((c) => now - c.at < 86_400_000);
  const t = readJson<{ calls: number; micro: number }>(TOTALS_KEY, { calls: 0, micro: 0 });
  return {
    enabled: !!cfg,
    network: cfg?.network ?? null,
    calls24h: day.length,
    usdc24h: Math.round(day.reduce((s, c) => s + c.usd, 0) * 1e6) / 1e6,
    callsTotal: t.calls,
    usdcTotal: t.micro / 1e6,
    recent: log.slice(0, 10),
  };
}

// ---------- ввод ----------

// Проверка q и chain ДО запроса оплаты: за заведомо пустой запрос деньги не просим. null — q нет вовсе:
// это проба каталога или агента, ей отвечаем 402 с требованиями.
export function scanInput(req: NextRequest): { q: string; chain?: string } | null | Response {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const chain = req.nextUrl.searchParams.get("chain")?.trim() || undefined;
  if (chain && !SCAN_CHAINS[chain]) return json({ error: `chain must be one of: ${Object.keys(SCAN_CHAINS).join(", ")}` }, 400);
  if (!q) return null;
  if (q.length > 200) return json({ error: "q is too long (200 characters max)" }, 400);
  const s = /^https?:\/\//i.test(q) ? q.match(/0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g)?.pop() : q;
  if (!s || !(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[a-fA-F0-9]{40}$/.test(s) || /^\$?[A-Za-z0-9]{2,12}$/.test(s)))
    return json({ error: "q must be a token address, a DexScreener / pump.fun link or a $TICKER" }, 400);
  return { q, chain };
}

// ---------- платный вызов ----------

const IP_MAX = 60; // попыток оплаты с одного IP за 10 минут (402 без оплаты сюда не считаются, их держит proxy.ts)
const PAYER_MAX = 30; // оплаченных вызовов с одного кошелька за 10 минут
const WINDOW = 10 * 60_000;

export async function paidCall(
  req: NextRequest,
  route: X402Route,
  o: { ready: boolean; need?: string; precheck?: () => string | null; work: () => Promise<unknown> },
): Promise<Response> {
  const cfg = x402Config();
  if (!cfg) return x402Off();
  const why = o.precheck?.();
  if (why) return json({ error: why }, 503);
  let fp: { v2?: string; v1?: string };
  try {
    fp = await feePayers(cfg);
  } catch (e) {
    return json({ error: (e as Error).message }, 503);
  }
  const url = resourceUrl(req, route);
  const pr = (error: string) => paymentRequired(cfg, route, url, fp, error);
  const pay = readPayment(req);
  if (pay === undefined) return challenge(pr(o.need ?? (o.ready ? "PAYMENT-SIGNATURE header is required" : "Pass ?q=<token address or $TICKER>, then pay")));
  if (pay === null) return challenge(pr("Malformed payment header"), 400);
  if (!o.ready) return json({ error: "q is required: a token address, a DexScreener / pump.fun link or a $TICKER. You were not charged." }, 400);

  const want = reqV2(cfg, route, fp.v2 ?? fp.v1!);
  const wantV1 = fp.v1 ? reqV1(cfg, route, fp.v1, url) : undefined;
  if (pay.version === 2 && !fp.v2) return challenge(pr("x402 v2 is not available on this network, use X-PAYMENT (v1)"));
  const bad = mismatch(pay, want, wantV1);
  if (bad) return challenge(pr(`Payment does not match the requirements (${bad})`));
  if (!allowHit(`x402ip:${clientIp(req)}`, IP_MAX, WINDOW)) return json({ error: "Too many paid calls from your network, slow down" }, 429, { "Retry-After": "60" });

  // Фасилитатору — только наши требования: сумма, получатель и сеть из заголовка клиента сюда не попадают.
  const requirements = pay.version === 2 ? want : wantV1!;
  const body = { x402Version: pay.version, paymentPayload: pay.payload, paymentRequirements: requirements };
  const key = createHash("sha256").update(pay.tx).digest("base64url");
  const prev = seen().get(key);
  if (prev?.s === "busy") return json({ error: "This payment is already being processed" }, 409);
  if (prev?.s === "done") return challenge(pr("This payment was already used"));
  mark(key, "busy");

  let payer = "";
  if (prev?.s !== "pending") {
    // Сверка без списания: подпись, баланс, сумма и получатель внутри транзакции.
    let v: { status: number; data: VerifyResponse | null };
    try {
      v = await call<VerifyResponse>(cfg, "/verify", body, 15_000);
    } catch (e) {
      mark(key, null);
      console.warn(`[x402] verify failed: ${(e as Error).message}`);
      return json({ error: "Payment facilitator is unreachable right now. You were not charged." }, 503);
    }
    if (!v.data?.isValid) {
      mark(key, null);
      const reason = v.data?.invalidReason || `facilitator HTTP ${v.status}`;
      return challenge(pr(`Payment rejected: ${reason}${v.data?.invalidMessage ? ` (${String(v.data.invalidMessage).slice(0, 200)})` : ""}`));
    }
    payer = v.data.payer ?? "";
    if (payer && !allowHit(`x402payer:${payer}`, PAYER_MAX, WINDOW)) {
      mark(key, null);
      return json({ error: "Too many paid calls from this wallet, slow down. You were not charged." }, 429, { "Retry-After": "60" });
    }
  }

  let result: unknown;
  try {
    result = await o.work();
  } catch (e) {
    // Скан не удался — settle не зовём, подписанная транзакция просто истечёт.
    if (prev?.s === "pending") mark(key, "pending");
    else mark(key, null);
    const status = e instanceof ApiError ? e.status : 422;
    return json({ error: `${(e as Error).message || "Scan failed"}. You were not charged.` }, status);
  }

  // Списание. settlement_pending и 409 — исход ещё не известен: пару раз переспрашиваем тем же запросом.
  // Весь шаг укладывается в ~75 с: агент не должен висеть минутами.
  let s: SettleResponse | null = null;
  let unknown = false;
  const until = Date.now() + 75_000;
  for (let attempt = 0; attempt < 3 && Date.now() < until - 5_000; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 4_000));
    try {
      const r = await call<SettleResponse>(cfg, "/settle", body, Math.min(60_000, until - Date.now()));
      s = r.data;
      unknown = r.status === 409 || r.status >= 500 || s?.errorReason === "settlement_pending";
    } catch (e) {
      console.warn(`[x402] settle failed: ${(e as Error).message}`);
      s = null;
      unknown = true;
    }
    if (!unknown) break;
  }
  const respHeader = pay.version === 2 ? "PAYMENT-RESPONSE" : "X-PAYMENT-RESPONSE";
  if (s?.success && s.transaction) {
    mark(key, "done");
    record({ at: Date.now(), route, usd: priceUsd(route), payer: (s.payer || payer).slice(0, 64), tx: s.transaction.slice(0, 128) });
    const out = { success: true, transaction: s.transaction, network: s.network ?? requirements.network, payer: s.payer || payer };
    return json(result, 200, { [respHeader]: b64(out) });
  }
  const fail = { success: false, errorReason: s?.errorReason || "unexpected_settle_error", transaction: s?.transaction ?? "", network: requirements.network, payer: s?.payer || payer };
  if (unknown) {
    mark(key, "pending");
    return challenge(pr("Settlement is still pending on Solana. Send the same request with the same payment header again in a minute: you will get the result and will not be charged twice."), 402, { [respHeader]: b64(fail) });
  }
  mark(key, null);
  return challenge(pr(`Settlement failed: ${fail.errorReason}. You were not charged.`), 402, { [respHeader]: b64(fail) });
}

// ---------- каталог ----------

// /.well-known/x402: список платных вызовов. Формат x402scan (version + resources) и подробности в items
// в виде записей каталога из спеки (§8 Discovery: resource, type, x402Version, accepts, lastUpdated).
export async function x402Manifest() {
  const cfg = x402Config();
  if (!cfg) return null;
  let fp: { v2?: string; v1?: string } = {};
  try {
    fp = await feePayers(cfg);
  } catch {}
  const routes = Object.keys(ROUTES) as X402Route[];
  return {
    version: 1,
    x402Version: 2,
    kind: "resource-server",
    name: "CrawlHive",
    description: "Memecoin safety scans for AI agents, paid per call in USDC on Solana. No account, no API key.",
    docs: "https://github.com/h100envy/crawl-hive#pay-per-call-with-x402",
    // Пути Brain с {address} — шаблоны, их каталоги не должны опрашивать как есть.
    resources: routes.filter((r) => !isBrain(r)).map((r) => `${ISSUER}${ROUTES[r].path}`),
    items: routes.map((r) => ({
      resource: `${ISSUER}${ROUTES[r].path}`,
      type: "http",
      method: r === "brain-batch" ? "POST" : "GET",
      x402Version: 2,
      description: ROUTES[r].description,
      price: { currency: "USD", amount: String(priceUsd(r)), asset: "USDC", network: cfg.network },
      queryParams: isBrain(r) ? {} : QUERY_SCHEMA,
      accepts: fp.v2 ? [reqV2(cfg, r, fp.v2)] : [],
      lastUpdated: new Date().toISOString(),
    })),
    facilitator: cfg.facilitator,
    instructions: `GET ${ISSUER}/api/x402/scan?q=<token address or $TICKER> answers 402 with the payment requirements in the PAYMENT-REQUIRED header. Sign the USDC transfer with any x402 client (e.g. @x402/fetch + @x402/svm) and repeat the request with the PAYMENT-SIGNATURE header. You are charged only when the scan succeeds.`,
  };
}

// Работа за оплату должна успеть до settle: подписанная транзакция живёт, пока жив её blockhash (~60–90 с).
// Не успели — 504 без списания; сам скан доработает в фоне и попадёт в кэш, повтор будет быстрым.
export function withDeadline<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new ApiError(msg, 504)), ms)))]).finally(() => clearTimeout(t));
}

// Цены для описаний в MCP и на сайте.
export const x402Prices = () => ({ scan: priceUsd("scan"), scanX: priceUsd("scan-x"), brain: priceUsd("brain"), brainBatch: priceUsd("brain-batch") });

// /openapi.json: описание API для агентов и каталогов (x402scan читает его первым, Circle требует).
// Платные операции помечены x-payment-info и ответом 402, бесплатные (доказательство, A2A) — без них.
export function openApi() {
  const cfg = x402Config();
  const routes = (Object.keys(ROUTES) as X402Route[]).filter((r) => !isBrain(r));
  const scanParams = [
    { name: "q", in: "query", required: true, description: "Token address, pump.fun or DexScreener link, or $TICKER", schema: { type: "string", maxLength: 200 } },
    { name: "chain", in: "query", required: false, description: "Where to look up a $TICKER (default solana)", schema: { type: "string", enum: ["solana", "bsc", "robinhood"] } },
  ];
  const paths: Record<string, unknown> = {};
  if (cfg)
    for (const r of routes)
      paths[ROUTES[r].path] = {
        get: {
          operationId: r === "scan" ? "scanToken" : "scanTokenWithX",
          summary: ROUTES[r].description,
          parameters: scanParams,
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: String(priceUsd(r)) },
            protocols: [{ x402: { scheme: "exact", network: cfg.network, asset: cfg.asset, payTo: cfg.payTo, facilitator: cfg.facilitator } }],
          },
          responses: {
            "200": { description: "Scan result", content: { "application/json": { schema: { type: "object" } } } },
            "402": { description: "Payment required: requirements in the PAYMENT-REQUIRED header (x402 v2) and the body (v1)" },
            "504": { description: "Scan did not finish in time; you were not charged" },
          },
        },
      };
  paths["/api/proof"] = {
    get: {
      operationId: "onchainProof",
      security: [],
      summary: "Onchain proof: Merkle roots of all verdicts and crawler signals committed to Solana every 15 minutes. With q, returns the record, its Merkle path and the Solana transaction holding the root.",
      parameters: [{ name: "q", in: "query", required: false, description: "Token address or signal id", schema: { type: "string", maxLength: 100 } }],
      responses: { "200": { description: "Proof summary or matches", content: { "application/json": { schema: { type: "object" } } } } },
    },
  };
  paths["/a2a"] = {
    post: {
      operationId: "a2aSendMessage",
      security: [],
      summary: "A2A JSON-RPC endpoint (SendMessage / message/send). Free scans, 8 per 10 minutes per network. Agent card: /.well-known/agent-card.json",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
      responses: { "200": { description: "JSON-RPC response with the agent message" } },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "CrawlHive API",
      version: "1.0.0",
      description: "Memecoin safety scans for AI agents. Paid per call in USDC on Solana over x402 (no account, no API key), plus a free A2A agent and an onchain-verifiable track record.",
      contact: { url: ISSUER },
      "x-guidance":
        "To scan a memecoin, GET /api/x402/scan?q=<token address, pump.fun or DexScreener link, or $TICKER>. The first call answers 402 with x402 payment requirements (USDC on Solana); pay with any x402 client and repeat. You are charged only when the scan succeeds. Use /api/x402/scan-x to add an X buzz check by Grok. For free, rate-limited scans talk to the A2A agent at /a2a. To check that a verdict was not edited later, GET /api/proof?q=<token address>.",
    },
    servers: [{ url: ISSUER }],
    paths,
    "x-discovery": { x402: `${ISSUER}/.well-known/x402`, a2a: `${ISSUER}/.well-known/agent-card.json`, mcp: `${ISSUER}/mcp` },
  };
}

export function llmsTxt() {
  const p = x402Prices();
  const on = !!x402Config();
  return `# CrawlHive

> Memecoin safety scanner for Solana, BNB Chain, Robinhood Chain and Base. A scan returns a 0-100 score and a verdict (CLEAN / OK / RISKY / DANGER / TOO_EARLY) with holders, bundled wallets, dev history, copycat tickers and Contract X-Ray. Every verdict is committed to Solana every 15 minutes, so the track record can be verified.

## For agents
${on ? `- [Paid scan, $${p.scan} USDC over x402](${ISSUER}/api/x402/scan?q=%24BONK): GET with q=<address | link | $TICKER>, answers 402 with payment requirements; no account, no API key
- [Paid scan + X check, $${p.scanX} USDC over x402](${ISSUER}/api/x402/scan-x?q=%24BONK)
- [x402 manifest](${ISSUER}/.well-known/x402)\n` : ""}- [A2A agent card](${ISSUER}/.well-known/agent-card.json): free scans over A2A JSON-RPC at ${ISSUER}/a2a
- [MCP server](${ISSUER}/mcp): scan_token, crawler signals, trending scans (OAuth or bot key)
- [OpenAPI](${ISSUER}/openapi.json)

## Track record
- [Track Record](${ISSUER}/track): how often tokens with each verdict dumped within 24 hours, misses included
- [Onchain proof API](${ISSUER}/api/proof): Merkle roots on Solana; ?q=<token address> returns the record, its path and the transaction

## Token
- $CRAWLHIVE on Solana: D4jNDQa3Cu4v8VMCAc2z7pgGGo7aGqzjXmwGR9wapump
`;
}

// Транзакция оплаты для человека с Phantom (/agents): та же, что собирает @x402/svm у агента — лимит и цена
// вычислений, TransferChecked USDC на казну, memo с нонсом, комиссию платит фасилитатор. Сервер только
// собирает её без подписей: подписывает кошелёк, в сеть отправляет фасилитатор после удачного скана.
export async function buildPaymentTx(route: X402Route, wallet: string) {
  const cfg = x402Config();
  if (!cfg) throw new ApiError("x402 payments are not enabled yet", 503);
  let owner: PublicKey;
  try {
    owner = new PublicKey(wallet);
  } catch {
    throw new ApiError("wallet must be a Solana address");
  }
  const fp = await feePayers(cfg);
  if (!fp.v2) throw new ApiError("x402 v2 is not available on this network", 503);
  const req = reqV2(cfg, route, fp.v2);
  const { ComputeBudgetProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const { rpcConnection } = await import("./solana");
  const conn = rpcConnection();
  const mint = new PublicKey(req.asset);
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new ApiError("USDC mint not found", 503);
  const program = info.owner;
  const decimals = info.data[44];
  const source = spl.getAssociatedTokenAddressSync(mint, owner, false, program);
  const dest = spl.getAssociatedTokenAddressSync(mint, new PublicKey(req.payTo), true, program);
  const bal = await conn.getTokenAccountBalance(source).catch(() => null);
  if (!bal || BigInt(bal.value.amount) < BigInt(req.amount)) throw new ApiError(`This wallet needs at least ${Number(req.amount) / 10 ** decimals} USDC`);
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: new PublicKey(fp.v2),
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      spl.createTransferCheckedInstruction(source, mint, dest, owner, BigInt(req.amount), decimals, [], program),
      new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from(createHash("sha256").update(`${wallet}${Date.now()}${Math.random()}`).digest("hex").slice(0, 32)) }),
    ],
  }).compileToV0Message();
  return { transaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64"), accepted: req };
}
