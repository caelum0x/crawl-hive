// Страница CrawlHive Brain: что это, эндпоинты с примерами curl, лимиты и цены, MCP. Сам API — в api/brain/v1.
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "CrawlHive Brain · memecoin memory API",
  description: "The swarm's memory as an API: wallet, dev and token reputation from every CrawlHive scan, plus graded verdict accuracy. Free tier, pay per call over x402.",
};

const BASE = "https://crawlhive.xyz/api/brain/v1";
const REPO = "https://github.com/h100envy/crawlhive-brain";

const ENDPOINTS: { method: string; path: string; what: string; curl: string }[] = [
  {
    method: "GET",
    path: "/wallet/{address}",
    what: "Where the swarm met this wallet: tokens where it was a sniper, bundle, dev, funder or linked holder, on which chains, and how each token ended (dumped, rugged, survived, still open).",
    curl: `curl ${BASE}/wallet/<wallet>`,
  },
  {
    method: "POST",
    path: "/wallets",
    what: "Batch screen up to 100 wallets at once, for example the top holders of a token you are about to buy.",
    curl: `curl -X POST ${BASE}/wallets \\\n  -H "Content-Type: application/json" \\\n  -d '{"wallets": ["<wallet1>", "<wallet2>"]}'`,
  },
  {
    method: "GET",
    path: "/dev/{address}",
    what: "Dev reputation: launches the swarm saw from this wallet and their outcomes. On Solana also its pump.fun history: how many coins, how many graduated, how many died.",
    curl: `curl ${BASE}/dev/<creator>`,
  },
  {
    method: "GET",
    path: "/token/{address}",
    what: "The last verdict on a token, its snapshots over time, what changed since the previous scan and how it ended 24h after the scan. Only for tokens the swarm already scanned.",
    curl: `curl ${BASE}/token/<token>`,
  },
  {
    method: "GET",
    path: "/track",
    what: "How often each verdict dumped within 24 hours, misses included. Use it to calibrate how much to trust a verdict. Always free.",
    curl: `curl ${BASE}/track`,
  },
];

export default function BrainPage() {
  return (
    <>
      <PageHeader
        title={
          <>
            🧠 CrawlHive <span className="text-gradient">Brain</span>
          </>
        }
        sub="Every scan teaches the swarm which wallets snipe, bundle and rug, which devs launch again and again, and how each verdict played out. Brain is that memory as an API for your bot, terminal or AI agent. It answers from memory instantly and never runs a new scan."
      />

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          {ENDPOINTS.map((e) => (
            <Card key={e.path} className="p-5 text-sm">
              <div className="flex flex-wrap items-center gap-2 font-mono">
                <span className={e.method === "GET" ? "rounded bg-lime/15 px-2 py-0.5 font-bold text-lime" : "rounded bg-honey/15 px-2 py-0.5 font-bold text-honey"}>{e.method}</span>
                <span className="font-semibold">/api/brain/v1{e.path}</span>
              </div>
              <p className="mt-2 text-fg/85">{e.what}</p>
              <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-black/50 p-3 font-mono text-xs text-fg/90">{e.curl}</pre>
            </Card>
          ))}
        </div>

        <div className="space-y-5">
          <Card className="p-5 text-sm">
            <div className="text-lg font-bold">Limits and pricing</div>
            <ul className="mt-2 space-y-1.5 text-fg/85">
              <li>• Free: 30 lookups and 5 batches per 10 minutes per IP, /track 60 per 10 minutes</li>
              <li>• Holders of 100,000 $CRAWLHIVE: 10x the free limits. Send your CrawlHive bot key (chb_…) or site session as Authorization: Bearer</li>
              <li>• Beyond the limit: pay per call over x402 in USDC on Solana, $0.002 per lookup and $0.02 per batch. No account, no API key</li>
              <li>• Brain revenue goes to $CRAWLHIVE buyback and burn, like paid scans</li>
            </ul>
          </Card>
          <Card className="p-5 text-sm">
            <div className="text-lg font-bold">For AI agents</div>
            <p className="mt-2 text-fg/85">
              The same answers are tools in the CrawlHive MCP server: <span className="font-mono">brain_wallet</span>, <span className="font-mono">brain_wallets</span>, <span className="font-mono">brain_dev</span>, <span className="font-mono">brain_token</span> and{" "}
              <span className="font-mono">brain_track</span>. Connect at <span className="font-mono">crawlhive.xyz/mcp</span> with a bot key or the Connect button, see{" "}
              <Link href="/agents" className="text-honey hover:underline">
                For Agents
              </Link>
              .
            </p>
          </Card>
          <Card className="p-5 text-sm">
            <div className="text-lg font-bold">Read it honestly</div>
            <p className="mt-2 text-fg/85">
              &quot;Dumped&quot; means the token fell 50% or more within 24 hours of the scan, rugs included. Most memecoins fall, so every answer carries baselineDumpRate: compare a wallet&apos;s record with it, not with zero. Memory covers wallets the swarm met while scanning and keeps the
              most recent 8,000 wallets.
            </p>
          </Card>
          <Card className="p-5 text-sm">
            <div className="text-lg font-bold">Docs</div>
            <p className="mt-2 text-fg/85">
              Full reference and the OpenAPI spec live in the{" "}
              <a href={REPO} target="_blank" rel="noreferrer" className="text-honey hover:underline">
                crawlhive-brain repo
              </a>
              .
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
