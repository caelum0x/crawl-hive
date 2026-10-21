// Оплата сжиганием: человек сам сжигает $CRAWLHIVE из своего кошелька (подписывает в Phantom), а мы засчитываем
// Pro на PRO_DAYS дней или вызовы Brain. Ключа и токенов у сервера нет: он только собирает неподписанную транзакцию
// (burnChecked + memo с номером котировки) и потом проверяет её в сети. Публичный журнал — meta "userBurns",
// котировки — meta "burnQuotes" (переживают перезапуск: сжёг, а сервер перезагрузился, засчитать всё равно можно),
// кредиты Brain — meta "brainCredits".
import "server-only";
import { randomBytes } from "node:crypto";
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createBurnCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readMint, type MintInfo } from "./buyback-tx";
import { publicConfig, rpcConnection } from "./solana";
import { ApiError, getMeta, setMeta } from "./store";
import { PRO_DAYS, TIER_USD, grantPro, tokenPriceUsd, usedBurnSig } from "./tiers";

export type BurnPurpose = "pro" | "brain";
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const QUOTE_TTL = 10 * 60_000;
const SLIP = 0.97; // принимаем сжигание от 97% котировки
export const BRAIN_PACKS = [1000, 5000, 20000] as const;
export const brainUsdPer1k = () => (Number(process.env.BRAIN_BURN_USD_PER_1K) > 0 ? Number(process.env.BRAIN_BURN_USD_PER_1K) : 1);

const read = <T,>(key: string, d: T): T => {
  try {
    return JSON.parse(getMeta(key) ?? "") as T;
  } catch {
    return d;
  }
};

// ---------- журнал ----------
export interface UserBurn { sig: string; wallet: string; purpose: BurnPurpose; tokens: number; calls?: number; days?: number; at: number }
interface Ledger { items: UserBurn[]; totalRaw: string; count: number }
const ledger = () => read<Ledger>("userBurns", { items: [], totalRaw: "0", count: 0 });
export function userBurnStats() {
  const l = ledger();
  return { count: l.count, total: Number(BigInt(l.totalRaw)) / 1e6, items: l.items.slice(0, 30) };
}

// ---------- кредиты Brain ----------
const credits = () => read<Record<string, number>>("brainCredits", {});
export const brainCredits = (wallet: string) => credits()[wallet] ?? 0;
export function spendBrainCredit(wallet: string) {
  const c = credits();
  if ((c[wallet] ?? 0) <= 0) return false;
  c[wallet] -= 1;
  setMeta("brainCredits", JSON.stringify(c));
  return true;
}

// ---------- котировки ----------
interface Quote { id: string; wallet: string; purpose: BurnPurpose; raw: string; calls?: number; exp: number }
const quotes = () => read<Record<string, Quote>>("burnQuotes", {});
function saveQuote(q: Quote) {
  const all = quotes();
  for (const [k, v] of Object.entries(all)) if (v.exp < Date.now() - 24 * 3600_000) delete all[k]; // сутки храним и просроченные
  all[q.id] = q;
  setMeta("burnQuotes", JSON.stringify(all));
}

let mintCache: { at: number; m: MintInfo } | undefined;
async function mint() {
  const addr = process.env.TOKEN_MINT?.trim();
  if (!addr) throw new ApiError("$CRAWLHIVE is not launched yet", 400);
  if (publicConfig().cluster !== "mainnet-beta") throw new ApiError("Burn payments work on mainnet only", 400);
  if (!mintCache || Date.now() - mintCache.at > 600_000) mintCache = { at: Date.now(), m: await readMint(rpcConnection(), new PublicKey(addr)) };
  return { addr, m: mintCache.m };
}

// Сколько токенов сжечь за покупку по текущей цене.
export async function burnPrice(purpose: BurnPurpose, calls?: number) {
  const p = await tokenPriceUsd();
  if (!p) throw new ApiError("Token price is unavailable right now, try again in a minute", 503);
  const usd = purpose === "pro" ? TIER_USD.pro : ((calls ?? 0) / 1000) * brainUsdPer1k();
  return { usd, tokens: Math.ceil(usd / p), priceUsd: p };
}

export async function buildUserBurn(wallet: string, purpose: unknown, callsRaw?: unknown) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new ApiError("Burning needs a Solana wallet (Phantom)");
  if (purpose !== "pro" && purpose !== "brain") throw new ApiError("Unknown purchase");
  const calls = purpose === "brain" ? Number(callsRaw) : undefined;
  if (purpose === "brain" && !BRAIN_PACKS.includes(calls as (typeof BRAIN_PACKS)[number])) throw new ApiError(`Pick a pack: ${BRAIN_PACKS.join(", ")} calls`);
  const { addr, m } = await mint();
  const { tokens, usd, priceUsd } = await burnPrice(purpose, calls);
  const raw = BigInt(tokens) * BigInt(10) ** BigInt(m.decimals);
  const conn = rpcConnection();
  const owner = new PublicKey(wallet);
  const mintKey = new PublicKey(addr);
  const ata = getAssociatedTokenAddressSync(mintKey, owner, false, m.program);
  const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
  if (BigInt(bal?.value.amount ?? "0") < raw) throw new ApiError(`You need ${tokens.toLocaleString("en-US")} $CRAWLHIVE in this wallet (about $${usd.toFixed(2)})`);
  const id = randomBytes(6).toString("hex");
  const bh = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: bh.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      createBurnCheckedInstruction(ata, mintKey, owner, raw, m.decimals, [], m.program),
      new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.from(`crawlhive:${purpose}:${id}`, "utf8") }),
    ],
  }).compileToV0Message();
  saveQuote({ id, wallet, purpose, raw: raw.toString(), calls, exp: Date.now() + QUOTE_TTL });
  return { quoteId: id, transaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64"), tokens, usd, priceUsd, calls, days: purpose === "pro" ? PRO_DAYS : undefined, expiresAt: Date.now() + QUOTE_TTL };
}

// Проверка по самой транзакции: успех, подпись кошелька, burn/burnChecked нашего минта программой токена от его имени.
export function burnedBy(tx: ParsedTransactionWithMeta, wallet: string, mintAddr: string, program: string): bigint {
  if (tx.meta?.err) throw new ApiError("Transaction failed on-chain");
  const keys = tx.transaction.message.accountKeys;
  const k = keys.find((x) => x.pubkey.toBase58() === wallet);
  if (!k?.signer) throw new ApiError("Transaction was not signed by your wallet", 403);
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions)];
  let raw = BigInt(0);
  for (const ix of all) {
    if (!("parsed" in ix) || ix.programId.toBase58() !== program) continue;
    const p = ix.parsed as { type?: string; info?: { mint?: string; authority?: string; multisigAuthority?: string; amount?: string; tokenAmount?: { amount?: string } } };
    const info = p.info;
    if ((p.type === "burn" || p.type === "burnChecked") && info?.mint === mintAddr && (info.authority ?? info.multisigAuthority) === wallet)
      raw += BigInt(info.tokenAmount?.amount ?? info.amount ?? "0");
  }
  if (raw <= BigInt(0)) throw new ApiError("Transaction does not burn $CRAWLHIVE from your wallet");
  return raw;
}

const ALLOWED_PROGRAMS = [TOKEN_2022_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58()];
const inflight = new Set<string>();

export async function confirmUserBurn(wallet: string, quoteId: unknown, signature: unknown) {
  const sig = String(signature ?? "");
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw new ApiError("Bad signature");
  const q = quotes()[String(quoteId ?? "")];
  if (!q || q.wallet !== wallet) throw new ApiError("Quote not found, start again", 404);
  if (usedBurnSig(sig) || ledger().items.some((x) => x.sig === sig)) throw new ApiError("This burn was already counted", 409);
  if (inflight.has(sig)) throw new ApiError("Already checking this burn, wait a moment", 429);
  inflight.add(sig);
  try {
    const { addr, m } = await mint();
    if (!ALLOWED_PROGRAMS.includes(m.program.toBase58())) throw new ApiError("Unexpected token program", 500);
    const conn = rpcConnection();
    let tx: ParsedTransactionWithMeta | null = null;
    for (let i = 0; i < 20 && !tx; i++) {
      tx = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!tx) throw new ApiError("Transaction not found yet. If Phantom shows it as sent, press Confirm again in a minute.", 404);
    // Сжечь надо было в окне котировки (блок-тайм), иначе цена могла уйти.
    const at = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
    if (at > q.exp + 60_000) throw new ApiError("The quote expired before the burn landed. Start again.", 410);
    const raw = burnedBy(tx, wallet, addr, m.program.toBase58());
    const need = (BigInt(q.raw) * BigInt(Math.round(SLIP * 1000))) / BigInt(1000);
    if (raw < need) throw new ApiError("Burned less than the quote");
    // перечитываем: параллельный confirm той же подписи не должен засчитать дважды
    if (usedBurnSig(sig) || ledger().items.some((x) => x.sig === sig)) throw new ApiError("This burn was already counted", 409);
    const tokens = Number(raw) / 10 ** m.decimals;
    const rec: UserBurn = { sig, wallet, purpose: q.purpose, tokens, at };
    let until: number | undefined;
    if (q.purpose === "pro") {
      until = grantPro(wallet, PRO_DAYS, sig);
      rec.days = PRO_DAYS;
    } else {
      const c = credits();
      c[wallet] = (c[wallet] ?? 0) + (q.calls ?? 0);
      setMeta("brainCredits", JSON.stringify(c));
      rec.calls = q.calls;
    }
    const l = ledger();
    l.items = [rec, ...l.items].slice(0, 300);
    l.totalRaw = (BigInt(l.totalRaw) + raw).toString();
    l.count += 1;
    setMeta("userBurns", JSON.stringify(l));
    const all = quotes();
    delete all[q.id];
    setMeta("burnQuotes", JSON.stringify(all));
    return { record: rec, proUntil: until ?? null, credits: brainCredits(wallet) };
  } finally {
    inflight.delete(sig);
  }
}
