// A2A (Agent2Agent): CrawlHive как агент, с которым другие агенты говорят по протоколу A2A. Карточка лежит
// в /.well-known/agent-card.json, сам агент — POST /a2a (JSON-RPC 2.0). Поддержаны A2A 1.0 (SendMessage)
// и 0.3 (message/send): ответ сразу сообщением, без задач и без хранения состояния.
// Навыки: бесплатный скан (тот же лимит по IP, что у Instant Crawl на сайте), ончейн-доказательство записи
// и сводка Track Record. Платный скан без лимита — по x402, ссылка в карточке.
import "server-only";
import { allowHit, allowScan, runScan } from "./scan";
import { BRAIN_LIMITS, walletReport } from "./brain";
import { scanBrief } from "./scan-brief";
import { trackStats } from "./track";
import { findProof, proofSummary } from "./proof";
import { withDeadline, x402Config, x402Prices } from "./x402";

const SITE = "https://crawlhive.xyz";
const ENDPOINT = `${SITE}/a2a`;

export function agentCard() {
  const paid = x402Config() ? x402Prices() : null;
  return {
    name: "CrawlHive",
    description:
      "Memecoin safety scanner for Solana, BNB Chain, Robinhood Chain and Base. Send a token address, a pump.fun or DexScreener link or a $TICKER and get a 0-100 score, a verdict (CLEAN / OK / RISKY / DANGER / TOO_EARLY), holders, bundled wallets, dev history and Contract X-Ray. Every verdict is committed to Solana every 15 minutes, so the track record is verifiable." +
      (paid ? ` Unlimited scans are sold per call over x402 (USDC on Solana): $${paid.scan} per scan, $${paid.scanX} with an X check, see ${SITE}/.well-known/x402.` : ""),
    version: "1.0.0",
    supportedInterfaces: [{ url: ENDPOINT, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    // Для клиентов A2A 0.3, которые ещё читают поля верхнего уровня.
    protocolVersion: "0.3.0",
    url: ENDPOINT,
    preferredTransport: "JSONRPC",
    provider: { organization: "CrawlHive", url: SITE },
    documentationUrl: `${SITE}/#agents`,
    iconUrl: `${SITE}/icon.svg`,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: "scan-token",
        name: "Scan a memecoin",
        description: "Full safety scan of a token: market, holders, bundled wallets, dev history, copycat tickers, Contract X-Ray and the project site. Free, 8 scans per 10 minutes per network; takes 5-20 seconds.",
        tags: ["memecoin", "solana", "bsc", "base", "rug-check", "token-safety"],
        examples: ["scan DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "$BONK", "https://pump.fun/coin/<mint>", "scan 0x... on bsc"],
      },
      {
        id: "onchain-proof",
        name: "Onchain proof of a verdict",
        description: "Merkle proof that a CrawlHive verdict or crawler signal was committed to Solana before the price moved: the record, the path to the root and the Solana transaction with the root.",
        tags: ["proof", "merkle", "track-record", "solana"],
        examples: ["proof DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],
      },
      {
        id: "brain-wallet",
        name: "Wallet memory (CrawlHive Brain)",
        description: "What the swarm remembers about a wallet from past scans: tokens where it sniped, bundled, launched or funded, and how they ended. Instant, no new scan. Free, 30 per 10 minutes per network.",
        tags: ["wallet-reputation", "snipers", "memory"],
        examples: ["wallet 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],
      },
      {
        id: "track-record",
        name: "Track record",
        description: "How often tokens with each verdict dumped or rugged within 24 hours of the scan, misses included.",
        tags: ["track-record", "accuracy"],
        examples: ["track record"],
      },
    ],
  };
}

// ---------- разбор сообщения ----------

type Part = { kind?: string; text?: string; data?: unknown };
type Msg = { role?: string; messageId?: string; contextId?: string; taskId?: string; parts?: Part[] };
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { message?: Msg } };

const ADDR = /\b(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/;
const URL_RE = /https?:\/\/\S+/;
const TICKER = /\$[A-Za-z0-9_]{1,20}/;

function textOf(m: Msg | undefined) {
  return (m?.parts ?? [])
    .map((p) => (typeof p.text === "string" ? p.text : p.data && typeof p.data === "object" ? Object.values(p.data as Record<string, unknown>).filter((v) => typeof v === "string").join(" ") : ""))
    .join(" ")
    .trim()
    .slice(0, 500);
}

function target(t: string) {
  return t.match(URL_RE)?.[0] ?? t.match(ADDR)?.[0] ?? t.match(TICKER)?.[0] ?? (/^\S{2,20}$/.test(t) ? t : null);
}

async function answer(t: string, ip: string): Promise<{ text: string; data?: unknown }> {
  const low = t.toLowerCase();
  if (/\b(track record|accuracy|stats)\b/.test(low)) {
    const s = trackStats();
    const lines = s.by.filter((b) => b.settled).map((b) => `${b.verdict}: ${Math.round((b.dumped / b.settled) * 100)}% dumped (${b.dumped}/${b.settled})`);
    return { text: `CrawlHive track record, ${s.total} verdicts tracked. ${lines.join("; ") || "Nothing settled yet."} Details: ${SITE}/track`, data: { ...s, proof: await proofSummary() } };
  }
  if (/^\s*wallet\b/.test(low)) {
    const w = t.match(ADDR)?.[0];
    if (!w) return { text: "Send `wallet <address>`." };
    if (!allowHit(`brain:lookup:ip:${ip}`, BRAIN_LIMITS.lookup, 10 * 60_000)) throw new Error(`Free Brain limit reached (${BRAIN_LIMITS.lookup} per 10 minutes). API: ${SITE}/brain`);
    const r = walletReport(w);
    return {
      text: r.seen
        ? `${w}: seen on ${r.tokens} other token(s) as ${Object.keys(r.roles).join(", ")}; ${r.outcomes.dumped} of ${r.outcomes.settled} settled dumped (baseline ${r.baselineDumpRate != null ? Math.round(r.baselineDumpRate * 100) + "%" : "n/a"}). ${SITE}/brain`
        : `${w}: the swarm has not met this wallet yet. ${SITE}/brain`,
      data: r,
    };
  }
  if (/\bproof\b/.test(low)) {
    const q = t.match(ADDR)?.[0] ?? t.replace(/proof/i, "").trim();
    if (!q) return { text: "Send `proof <token address or signal id>`." };
    const m = findProof(q);
    if (!m.length) return { text: `No committed record for ${q} yet. Records are committed at the end of each 15-minute window. ${SITE}/track` };
    const top = m[0];
    return {
      text: `${q} is committed in the window starting ${new Date(top.from).toISOString()}, root ${top.root}${top.sig ? `, Solana tx https://solscan.io/tx/${top.sig}` : " (root pending onchain)"}. Leaf = sha256(0x00 || record JSON with sorted keys), node = sha256(0x01 || left || right).`,
      data: { matches: m },
    };
  }
  const q = target(t);
  if (!q) return { text: "Send a token address, a pump.fun or DexScreener link, or a $TICKER to scan it. Other commands: `wallet <address>`, `proof <address>`, `track record`." };
  if (!allowScan(ip)) {
    const p = x402Config() ? x402Prices() : null;
    throw new Error(`Free scan limit reached (8 per 10 minutes).${p ? ` Buy unlimited scans over x402: GET ${SITE}/api/x402/scan?q=… for $${p.scan} USDC.` : ""}`);
  }
  const chain = /\b(bsc|bnb)\b/.test(low) ? "bsc" : /\brobinhood\b/.test(low) ? "robinhood" : /\bbase\b/.test(low) ? "base" : undefined;
  const r = await withDeadline(runScan(q, () => {}, chain, { src: "agent" }), 45_000, "Scan took too long, try again");
  const brief = scanBrief(r);
  return { text: `$${r.symbol} (${r.chain}): ${r.verdict}${r.score != null ? `, score ${r.score}/100` : ""}. ${r.reason} Full report: ${brief.page}`, data: brief };
}

// ---------- JSON-RPC ----------

const rid = () => crypto.randomUUID();

export async function handleA2A(raw: unknown, ip: string, versionHeader: string | null) {
  const req = (raw ?? {}) as Rpc;
  const id = req.id ?? null;
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return err(-32600, "Invalid JSON-RPC request");
  const v1 = req.method === "SendMessage" || (versionHeader?.startsWith("1.") ?? false);
  if (req.method !== "SendMessage" && req.method !== "message/send") return err(-32601, `Method ${req.method} is not supported: this agent answers SendMessage / message/send directly, without tasks`);
  const msg = req.params?.message;
  const t = textOf(msg);
  if (!t) return err(-32602, "params.message must contain a text part");

  let out: { text: string; data?: unknown };
  try {
    out = await answer(t, ip);
  } catch (e) {
    out = { text: (e as Error).message || "Scan failed" };
  }
  const parts = v1
    ? [{ text: out.text }, ...(out.data ? [{ data: out.data, mediaType: "application/json" }] : [])]
    : [{ kind: "text", text: out.text }, ...(out.data ? [{ kind: "data", data: out.data }] : [])];
  const reply = v1
    ? { role: "ROLE_AGENT", messageId: rid(), contextId: msg?.contextId, parts }
    : { kind: "message", role: "agent", messageId: rid(), contextId: msg?.contextId, parts };
  return { jsonrpc: "2.0", id, result: v1 ? { message: reply } : reply };
}
