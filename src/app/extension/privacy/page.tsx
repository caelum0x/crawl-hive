// Политика конфиденциальности браузерного расширения CrawlHive (обязательна для Chrome Web Store).
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Extension privacy · CrawlHive" };

const ITEMS: [string, string][] = [
  ["What the extension reads", "Only the address of the tab you are on, and only on the token pages of GMGN, DexScreener, Axiom, Photon, pump.fun, FOMO, Birdeye, Solscan, BscScan and BaseScan. It does not read the page content, your inputs, cookies, other tabs or your browsing history."],
  ["What it sends", "When a page has a token or pair address in its URL, the extension sends that page URL to crawlhive.xyz to get the scan verdict. Nothing else is sent: no wallet, no account, no identifiers."],
  ["What it stores", "Two settings on your device: whether the panel is collapsed, and (for developers) an API address override. No data is stored on our side beyond the public scan of the token, which anyone can open at crawlhive.xyz/scan/<address>."],
  ["Wallets and keys", "The extension never asks for, reads or touches a wallet, seed phrase, private key or signature. It cannot trade or move funds."],
  ["Third parties", "The extension talks only to crawlhive.xyz. CrawlHive itself reads public market and chain data (DexScreener, RugCheck, GoPlus, Solana and EVM RPC nodes) to build the verdict."],
  ["Not advice", "A verdict is automated information about a token, not financial advice. Memecoins are extremely risky."],
  ["Contact", "Questions: @crawlhivexyz on X or /support in @crawlhivebot on Telegram. The extension is open source: github.com/h100envy/crawl-hive/tree/main/extension."],
];

export default function ExtensionPrivacy() {
  return (
    <>
      <PageHeader title="CrawlHive extension: privacy" sub="Short version: it reads the URL of token pages on supported sites, asks crawlhive.xyz for the verdict, and shows it. Nothing about you is collected." />
      <Card className="space-y-4 p-5 text-sm leading-relaxed text-fg/85">
        {ITEMS.map(([h, t]) => (
          <div key={h}>
            <div className="font-semibold text-fg">{h}</div>
            <p className="mt-1">{t}</p>
          </div>
        ))}
        <p className="text-xs text-muted">Last updated: October 19, 2026.</p>
      </Card>
    </>
  );
}
