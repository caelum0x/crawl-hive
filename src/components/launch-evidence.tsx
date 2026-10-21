// Доказательства запуска на странице скана: кто подписал выпуск (настоящий создатель), через какой лаунчпад или
// фабрику, кто создал пул, транзакция выпуска со ссылкой, когда выпущен и когда рой впервые увидел токен.
// Чего не нашли — честно пишем «not found», не подставляем догадки.
import { ExternalLink } from "lucide-react";

export interface LaunchData {
  deployer?: string;
  factory?: string;
  factoryLabel?: string;
  poolCreator?: string;
  tx?: string;
  launchedAt?: number;
  seenAt: number;
}

const TX: Record<string, string> = { solana: "https://solscan.io/tx/", bsc: "https://bscscan.com/tx/", base: "https://basescan.org/tx/", robinhood: "https://robin.etherscan.io/tx/" };
const ADDR: Record<string, string> = { solana: "https://solscan.io/account/", bsc: "https://bscscan.com/address/", base: "https://basescan.org/address/", robinhood: "https://robin.etherscan.io/address/" };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const when = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function LaunchEvidence({ l, chain }: { l: LaunchData; chain: string }) {
  const rows: [string, React.ReactNode][] = [
    [
      "Deployer",
      l.deployer ? (
        <a href={`/dev/${l.deployer}`} className="num text-honey hover:underline" title="The wallet that signed the launch: every coin it launched and how it ended">
          {short(l.deployer)}
        </a>
      ) : (
        <span className="text-muted">{l.factory ? "searching the launch transaction…" : "not found"}</span>
      ),
    ],
  ];
  if (l.factory)
    rows.push([
      "Launchpad",
      <a key="f" href={ADDR[chain] ? ADDR[chain] + l.factory : undefined} target="_blank" rel="noreferrer" className="text-fg/90 hover:underline">
        {l.factoryLabel ?? "launchpad contract"} <span className="num text-muted">{chain === "solana" ? "" : short(l.factory)}</span>
      </a>,
    ]);
  if (l.poolCreator) rows.push(["Pool created by", <a key="p" href={ADDR[chain] ? ADDR[chain] + l.poolCreator : undefined} target="_blank" rel="noreferrer" className="num hover:underline">{l.poolCreator === l.deployer ? "the deployer" : short(l.poolCreator)}</a>]);
  rows.push([
    "Launch tx",
    l.tx && TX[chain] ? (
      <a href={TX[chain] + l.tx} target="_blank" rel="noreferrer" className="num inline-flex items-center gap-1 text-sky hover:underline">
        {short(l.tx)} <ExternalLink className="size-3" />
      </a>
    ) : (
      <span className="text-muted">not found</span>
    ),
  ]);
  rows.push(["Launched", l.launchedAt ? when(l.launchedAt) : <span className="text-muted">unknown</span>]);
  rows.push(["First seen by the swarm", when(l.seenAt)]);
  return (
    <div className="rounded-lg border border-line bg-panel-2/50 p-3 text-xs">
      <div className="mb-2 font-semibold">Launch evidence</div>
      <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-2 sm:justify-start">
            <span className="text-muted">{k}</span>
            <span>{v}</span>
          </div>
        ))}
      </div>
      {l.factory && <p className="mt-2 text-[10px] text-muted">The launchpad contract creates tokens for many people. The deployer is the wallet that signed this launch, and its history is what matters.</p>}
    </div>
  );
}
