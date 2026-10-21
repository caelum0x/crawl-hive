// Страница браузерного расширения: что оно делает, где работает, как поставить.
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Browser extension · CrawlHive", description: "The CrawlHive verdict right on the token page of your terminal, for Solana, BNB Chain, Robinhood Chain and Base, with a second opinion from Larpcheck." };

const SITES = ["GMGN", "DexScreener", "Axiom", "Photon", "pump.fun", "FOMO", "Birdeye", "Solscan", "BscScan", "BaseScan"];
const STORE_URL = "https://chromewebstore.google.com/detail/crawlhive-memecoin-safety/fockphbbbdmefepkngelchjnhnfdkmnm";

export default function ExtensionPage() {
  return (
    <>
      <PageHeader
        title={
          <>
            🧩 CrawlHive <span className="text-gradient">in your terminal</span>
          </>
        }
        sub="No tab switching. Open a token in your trading terminal and the swarm's verdict shows up in the corner: score, red flags, snipers, linked operators, LP lock and the dev's history."
      />
      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <Card className="overflow-hidden p-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/extension/screenshot-1.png" alt="CrawlHive panel on a pump.fun token page" className="w-full" />
        </Card>
        <div className="space-y-5">
          <Card className="p-5 text-sm">
            <div className="text-lg font-bold">Works on</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {SITES.map((s) => (
                <span key={s} className="rounded-lg border border-line px-2.5 py-1">
                  {s}
                </span>
              ))}
            </div>
            <div className="mt-4 text-lg font-bold">What the panel shows</div>
            <ul className="mt-2 space-y-1 text-fg/85">
              <li>• Score and verdict: CLEAN, OK, RISKY or DANGER</li>
              <li>• The worst red flags with one-line reasons</li>
              <li>• Snipers, linked operators and dev-funded wallets</li>
              <li>• LP: burned, locked until when, or unlocked</li>
              <li>• The dev&apos;s earlier coins, one tap away</li>
              <li>• A second opinion from Larpcheck on the project</li>
            </ul>
          </Card>
          <Card className="p-5 text-sm">
            <div className="text-lg font-bold">Install</div>
            <a
              href={STORE_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-honey via-coral to-pink px-4 py-3 text-base font-bold text-black transition-opacity hover:opacity-90"
            >
              🧩 Add to Chrome
            </a>
            <p className="mt-2 text-center text-xs text-muted">Free on the Chrome Web Store. Works in Chrome, Brave, Edge and Arc.</p>
            <p className="mt-4 text-fg/85">Or install it by hand in developer mode:</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-fg/85">
              <li>
                Download{" "}
                <a href="/extension/crawlhive-extension.zip" className="text-honey hover:underline">
                  crawlhive-extension.zip
                </a>{" "}
                and unzip it.
              </li>
              <li>Open chrome://extensions and turn on Developer mode.</li>
              <li>Click &quot;Load unpacked&quot; and pick the unzipped folder.</li>
            </ol>
            <p className="mt-3 text-xs text-muted">
              Free, no wallet, no account. Reads only the URL of token pages on these sites.{" "}
              <Link href="/extension/privacy" className="text-honey hover:underline">
                Privacy
              </Link>{" "}
              ·{" "}
              <a href="https://github.com/h100envy/crawl-hive/tree/main/extension" target="_blank" rel="noreferrer" className="text-honey hover:underline">
                Source code
              </a>
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
