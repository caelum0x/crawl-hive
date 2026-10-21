"use client";
// Бабл-карта держателей: каждый кружок — кошелёк, размер — доля, цвет — оператор (кошельки с общим спонсором,
// деньгами от дева или самим девом). Линии — кто кого пополнил. Одиночки приглушены, связанные группы горят неоном,
// справа рейтинг держателей, наведение синхронизировано. Раскладка — простая детерминированная физика без зависимостей.
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { WatchButton } from "./watch-button";
import { WatchOperatorButton } from "./watch-operator-button";

export interface BubbleNode {
  w: string;
  pct: number;
  g: number;
  roles: string[];
  hub?: boolean;
  seen?: { tokens: number; dumped: number; roles: string[] };
}
export interface BubbleMapData {
  nodes: BubbleNode[];
  links: [number, number, string?][]; // третье: основание связи (funder, transfer, same_tx, same_block, dev)
}
interface Op {
  wallets: number;
  pct: number;
  roles: string[];
  devLinked: boolean;
  basis?: string[];
}

// Основание связи словами. Общий спонсор — связь, а не доказательство общего владельца: так и пишем.
const BASIS_TEXT: Record<string, string> = {
  same_tx: "bought in the same transaction",
  same_block: "bought in the same block, near-equal amounts",
  dev: "money or tokens from the dev",
  transfer: "sent the token to each other",
  funder: "connection: shared funder",
};
const BASIS_RANK = ["same_tx", "same_block", "dev", "transfer", "funder"];

// Неон в цветах маскотов: оранжевый, розовый, лайм, голубой, фиолетовый, бирюзовый.
const NEON = ["#ff9f1c", "#ff4fa3", "#a3e635", "#38bdf8", "#a78bfa", "#2dd4bf"];
// Одиночные кошельки, как на Bubblemaps: у каждого свой яркий цвет (от адреса, чтобы не прыгал между сканами).
const SOLO = [
  "#f97316",
  "#e879f9",
  "#facc15",
  "#4ade80",
  "#22d3ee",
  "#818cf8",
  "#fb7185",
  "#34d399",
  "#fbbf24",
  "#60a5fa",
  "#c084fc",
  "#f472b6",
];
const DEV = "#f43f5e";
const W = 720;
const H = 470;
const ROLE_ICON: Record<string, string> = {
  sniper: "🎯",
  bundle: "🔗",
  dev: "🧑‍💻",
};

// Одиночкам цвета раздаются по порядку (по доле), чтобы соседи не повторялись; связанные — цвет оператора.
const palette = (data: BubbleMapData) => {
  const solo = new Map(
    data.nodes
      .filter((n) => n.g < 0 && !n.roles.includes("dev"))
      .map((n, k) => [n.w, k]),
  );
  return (n: BubbleNode) =>
    n.roles.includes("dev") && n.g < 0
      ? DEV
      : n.g >= 0
        ? NEON[n.g % NEON.length]
        : SOLO[(solo.get(n.w) ?? 0) % SOLO.length];
};
const ALL = [...NEON, ...SOLO, DEV];
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const pctText = (p: number) =>
  p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2);

function layout(data: BubbleMapData) {
  const n = data.nodes.length;
  const max = Math.max(...data.nodes.map((x) => x.pct), 0.01);
  // Размер — от доли относительно самого крупного: кит сразу виден на фоне мелочи.
  const r = data.nodes.map((x) =>
    x.hub ? 9 : 13 + 50 * Math.sqrt(Math.max(x.pct, 0) / max),
  );
  const groups = [...new Set(data.nodes.map((x) => x.g))];
  const pos = data.nodes.map((node, i) => {
    const gi = groups.indexOf(node.g);
    const a = (gi / Math.max(groups.length, 1)) * Math.PI * 2 + i * 0.9;
    const d = node.g < 0 ? 170 : 90;
    return {
      x: W / 2 + Math.cos(a) * d + Math.sin(i * 12.9) * 25,
      y: H / 2 + Math.sin(a) * d * 0.75 + Math.cos(i * 7.3) * 25,
    };
  });
  for (let step = 0; step < 360; step++) {
    const cool = 1 - step / 360;
    const f = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const d = Math.hypot(dx, dy) || 0.01;
        const same =
          data.nodes[i].g === data.nodes[j].g && data.nodes[i].g >= 0;
        // Воздух между шарами: внутри группы плотнее, между группами и одиночками просторнее.
        const want = r[i] + r[j] + (same ? 14 : 30);
        if (d < want) {
          const k = ((want - d) / d) * 0.5;
          f[i].x -= dx * k;
          f[i].y -= dy * k;
          f[j].x += dx * k;
          f[j].y += dy * k;
        }
      }
    for (const [a, b] of data.links) {
      const dx = pos[b].x - pos[a].x;
      const dy = pos[b].y - pos[a].y;
      const d = Math.hypot(dx, dy) || 0.01;
      const k = ((d - (r[a] + r[b] + 34)) / d) * 0.06;
      f[a].x += dx * k;
      f[a].y += dy * k;
      f[b].x -= dx * k;
      f[b].y -= dy * k;
    }
    for (let i = 0; i < n; i++) {
      const pull = data.nodes[i].g < 0 ? 0.006 : 0.014;
      f[i].x += (W / 2 - pos[i].x) * pull;
      f[i].y += (H / 2 - pos[i].y) * pull * 1.3;
      pos[i].x += f[i].x * (0.35 + cool);
      pos[i].y += f[i].y * (0.35 + cool);
    }
  }
  // Окно под содержимое, с сохранением пропорций.
  const pad = 34;
  const minX = Math.min(...pos.map((p, i) => p.x - r[i])) - pad;
  const maxX = Math.max(...pos.map((p, i) => p.x + r[i])) + pad;
  const minY = Math.min(...pos.map((p, i) => p.y - r[i])) - pad;
  const maxY = Math.max(...pos.map((p, i) => p.y + r[i])) + pad;
  let vw = Math.max(maxX - minX, 380);
  let vh = Math.max(maxY - minY, 250);
  if (vw / vh > W / H) vh = vw / (W / H);
  else vw = vh * (W / H);
  return {
    pts: pos.map((p, i) => ({ ...p, r: r[i] })),
    vb: {
      x: (minX + maxX) / 2 - vw / 2,
      y: (minY + maxY) / 2 - vh / 2,
      w: vw,
      h: vh,
    },
  };
}

// Изогнутая связь: дуга чуть в сторону, чтобы линии не сливались с радиусами шаров.
function curve(a: { x: number; y: number }, b: { x: number; y: number }) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const k = 0.22;
  return `M${a.x},${a.y} Q${mx - dy * k},${my + dx * k} ${b.x},${b.y}`;
}

export function BubbleMap({
  data,
  ops,
  chain = "solana",
  className,
}: {
  data: BubbleMapData;
  ops?: Op[];
  chain?: string;
  className?: string;
}) {
  const { pts: pos, vb } = useMemo(() => layout(data), [data]);
  const colorOf = useMemo(() => palette(data), [data]);
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const explorer = (w: string) =>
    chain === "solana"
      ? `https://solscan.io/account/${w}`
      : `https://${chain === "bsc" ? "bscscan.com" : chain === "base" ? "basescan.org" : "robin.etherscan.io"}/address/${w}`;
  const lit = (i: number) => {
    const g = data.nodes[i].g;
    if (hover !== null)
      return i === hover || (g >= 0 && g === data.nodes[hover].g);
    return focus === null || focus === g;
  };
  const ranked = data.nodes
    .map((x, i) => ({ ...x, i }))
    .filter((x) => !x.hub)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 10);
  const top = Math.max(...ranked.map((x) => x.pct), 0.01);
  const linked = data.nodes
    .filter((x) => x.g >= 0 && !x.hub)
    .reduce((s, x) => s + x.pct, 0);
  const seenCount = data.nodes.filter((x) => x.seen).length;
  const groupsCount = new Set(
    data.nodes.filter((x) => x.g >= 0).map((x) => x.g),
  ).size;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-white/10 bg-[#05060a] shadow-[0_0_60px_rgba(167,139,250,0.08)]",
        className,
      )}
    >
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/5 px-5 py-4">
        <div>
          <div className="text-[11px] font-semibold tracking-[0.18em] text-white/40 uppercase">
            Bubble map
          </div>
          <div className="mt-0.5 text-lg font-bold">Who really holds it</div>
        </div>
        <div className="flex gap-5 text-right">
          <div>
            <div
              className="num text-lg font-bold"
              style={{ color: groupsCount ? NEON[0] : undefined }}
            >
              {groupsCount}
            </div>
            <div className="text-[10px] text-white/40 uppercase">operators</div>
          </div>
          <div>
            <div
              className="num text-lg font-bold"
              style={{
                color: linked >= 10 ? DEV : linked ? NEON[0] : undefined,
              }}
            >
              {linked.toFixed(1)}%
            </div>
            <div className="text-[10px] text-white/40 uppercase">
              held by linked
            </div>
          </div>
          <div>
            <div
              className="num text-lg font-bold"
              style={{ color: seenCount ? "#e879f9" : undefined }}
            >
              🧠 {seenCount}
            </div>
            <div className="text-[10px] text-white/40 uppercase">
              seen before
            </div>
          </div>
          <div>
            <div className="num text-lg font-bold">
              {data.nodes.filter((x) => !x.hub).length}
            </div>
            <div className="text-[10px] text-white/40 uppercase">wallets</div>
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-[1fr_230px]">
        {/* фон на весь блок: туманности и точечная сетка, карта по центру */}
        <div
          className="flex items-center"
          style={{
            backgroundImage:
              "radial-gradient(circle at 18% 12%, rgba(124,58,237,0.3), transparent 55%), radial-gradient(circle at 88% 92%, rgba(255,159,28,0.16), transparent 55%), radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px)",
            backgroundSize: "100% 100%, 100% 100%, 22px 22px",
          }}
        >
          <div className="relative w-full">
            <svg
              viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
              className="block w-full"
              role="img"
              aria-label="Bubble map of top holders, snipers and the dev"
            >
              <defs>
                {ALL.map((c, i) => (
                  <radialGradient
                    key={c}
                    id={`bm-f${i}`}
                    cx="50%"
                    cy="38%"
                    r="65%"
                  >
                    <stop offset="0%" stopColor={c} stopOpacity={0.55} />
                    <stop offset="75%" stopColor={c} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={c} stopOpacity={0.42} />
                  </radialGradient>
                ))}
                <filter
                  id="bm-glow"
                  x="-60%"
                  y="-60%"
                  width="220%"
                  height="220%"
                >
                  <feGaussianBlur stdDeviation="5" result="b" />
                  <feMerge>
                    <feMergeNode in="b" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
                <filter
                  id="bm-halo"
                  x="-100%"
                  y="-100%"
                  width="300%"
                  height="300%"
                >
                  <feGaussianBlur stdDeviation="30" />
                </filter>
              </defs>

              {/* ореол за каждым оператором */}
              {[
                ...new Set(data.nodes.map((x) => x.g).filter((g) => g >= 0)),
              ].map((g) => {
                const idx = data.nodes
                  .map((x, i) => (x.g === g ? i : -1))
                  .filter((i) => i >= 0);
                const cx = idx.reduce((s, i) => s + pos[i].x, 0) / idx.length;
                const cy = idx.reduce((s, i) => s + pos[i].y, 0) / idx.length;
                const rr =
                  Math.max(
                    ...idx.map(
                      (i) =>
                        Math.hypot(pos[i].x - cx, pos[i].y - cy) + pos[i].r,
                    ),
                  ) + 10;
                return (
                  <circle
                    key={`h${g}`}
                    cx={cx}
                    cy={cy}
                    r={rr}
                    fill={NEON[g % NEON.length]}
                    opacity={focus === null || focus === g ? 0.2 : 0.03}
                    filter="url(#bm-halo)"
                  />
                );
              })}

              {data.nodes.map((node, i) => {
                const p = pos[i];
                const c = colorOf(node);
                const fi = ALL.indexOf(c);
                // Связанные группы и дев выделены толще и ярче; одиночки тоже цветные, но спокойнее.
                const strong = node.g >= 0 || node.roles.includes("dev");
                const icon = node.roles
                  .map((x) => ROLE_ICON[x])
                  .filter(Boolean)[0];
                return (
                  <g
                    key={node.w}
                    className="bm-node cursor-pointer"
                    style={{
                      animationDelay: `${Math.min(i, 20) * 0.04}s, ${(i % 7) * 0.4}s`,
                      opacity: lit(i) ? 1 : 0.15,
                      transformOrigin: `${p.x}px ${p.y}px`,
                    }}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() =>
                      window.open(explorer(node.w), "_blank", "noopener")
                    }
                  >
                    {node.hub ? (
                      <>
                        <rect
                          x={p.x - p.r}
                          y={p.y - p.r}
                          width={p.r * 2}
                          height={p.r * 2}
                          rx={3}
                          transform={`rotate(45 ${p.x} ${p.y})`}
                          fill="#05060a"
                          stroke={c}
                          strokeWidth={2.5}
                          filter="url(#bm-glow)"
                        />
                        {node.roles.includes("dev") && (
                          <text
                            x={p.x}
                            y={p.y + p.r + 16}
                            textAnchor="middle"
                            fontSize={10}
                            fontWeight={800}
                            fill={DEV}
                            letterSpacing="0.12em"
                          >
                            DEV
                          </text>
                        )}
                      </>
                    ) : (
                      <>
                        {/* связанный кошелёк: второе пунктирное кольцо цвета оператора, видно даже рядом с похожим одиночкой */}
                        {node.g >= 0 && (
                          <circle
                            cx={p.x}
                            cy={p.y}
                            r={p.r + 7}
                            fill="none"
                            stroke={c}
                            strokeWidth={2}
                            strokeDasharray="3 5"
                            strokeLinecap="round"
                            filter="url(#bm-glow)"
                          />
                        )}
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={p.r}
                          fill={`url(#bm-f${fi})`}
                          stroke={c}
                          strokeOpacity={strong ? 1 : 0.85}
                          strokeWidth={hover === i ? 3 : strong ? 2.6 : 1.6}
                          filter="url(#bm-glow)"
                        />
                        {p.r >= 22 && (
                          <text
                            x={p.x}
                            y={p.y + 4}
                            textAnchor="middle"
                            fontSize={Math.min(20, p.r * 0.36)}
                            fontWeight={800}
                            fill="#fff"
                            className="num"
                          >
                            {pctText(node.pct)}%
                          </text>
                        )}
                        {icon && (
                          <g>
                            <circle
                              cx={p.x + p.r * 0.72}
                              cy={p.y - p.r * 0.72}
                              r={10}
                              fill="#05060a"
                              stroke={c}
                              strokeWidth={1.5}
                            />
                            <text
                              x={p.x + p.r * 0.72}
                              y={p.y - p.r * 0.72 + 4}
                              textAnchor="middle"
                              fontSize={11}
                            >
                              {icon}
                            </text>
                          </g>
                        )}
                        {node.seen && (
                          <g>
                            <rect
                              x={p.x - p.r * 0.72 - 15}
                              y={p.y - p.r * 0.72 - 10}
                              width={30}
                              height={18}
                              rx={9}
                              fill="#05060a"
                              stroke={node.seen.dumped ? DEV : "#e879f9"}
                              strokeWidth={1.5}
                            />
                            <text
                              x={p.x - p.r * 0.72}
                              y={p.y - p.r * 0.72 + 3}
                              textAnchor="middle"
                              fontSize={10}
                              fontWeight={800}
                              fill={node.seen.dumped ? DEV : "#e879f9"}
                            >
                              ↺{node.seen.tokens}
                            </text>
                          </g>
                        )}
                        {node.roles.includes("dev") && (
                          <text
                            x={p.x}
                            y={p.y + p.r + 15}
                            textAnchor="middle"
                            fontSize={10}
                            fontWeight={800}
                            fill={DEV}
                            letterSpacing="0.12em"
                          >
                            DEV
                          </text>
                        )}
                      </>
                    )}
                  </g>
                );
              })}

              {/* связи поверх стекла: видны сквозь полупрозрачные шары */}
              {data.links.map(([a, b, basis], i) => {
                const c =
                  data.nodes[a].g >= 0
                    ? colorOf(data.nodes[a])
                    : colorOf(data.nodes[b]);
                const on = lit(a) || lit(b);
                const d = curve(pos[a], pos[b]);
                return (
                  <g key={i} opacity={on ? 1 : 0.08} pointerEvents="none">
                    <path
                      d={d}
                      fill="none"
                      stroke={c}
                      strokeWidth={5}
                      strokeOpacity={0.25}
                      filter="url(#bm-glow)"
                    />
                    <path
                      d={d}
                      fill="none"
                      stroke={c}
                      strokeWidth={1.6}
                      strokeOpacity={basis === "funder" ? 0.6 : 0.95}
                      strokeDasharray={basis === "funder" ? "6 6" : undefined}
                    />
                    <path
                      d={d}
                      fill="none"
                      stroke="#fff"
                      strokeWidth={1.6}
                      strokeDasharray="2 10"
                      strokeLinecap="round"
                      className="bm-flow"
                    />
                  </g>
                );
              })}
            </svg>
            {hover !== null && (
              <div
                className="pointer-events-none absolute z-10 rounded-lg border border-white/10 bg-[#0b0c12]/95 px-3 py-2 text-xs shadow-xl backdrop-blur"
                style={{
                  left: `${((pos[hover].x - vb.x) / vb.w) * 100}%`,
                  top: `${((pos[hover].y - vb.y) / vb.h) * 100}%`,
                  transform: "translate(-50%, calc(-100% - 16px))",
                }}
              >
                <div className="num font-semibold">
                  {short(data.nodes[hover].w)}
                </div>
                <div className="text-white/60">
                  {data.nodes[hover].hub
                    ? data.nodes[hover].roles.includes("dev")
                      ? "the dev, holds nothing now"
                      : "funder of linked wallets"
                    : `holds ${data.nodes[hover].pct.toFixed(2)}%`}
                  {data.nodes[hover].roles.length
                    ? ` · ${data.nodes[hover].roles.join(" + ")}`
                    : ""}
                  {data.nodes[hover].g >= 0
                    ? ` · operator ${data.nodes[hover].g + 1}`
                    : ""}
                </div>
                {(() => {
                  // На чём держатся связи этого кошелька: сильнейшее основание первым.
                  const set = new Set(data.links.filter(([a, b]) => a === hover || b === hover).map(([, , x]) => x).filter(Boolean) as string[]);
                  const list = BASIS_RANK.filter((x) => set.has(x));
                  if (!list.length) return null;
                  return (
                    <div className="mt-0.5 text-white/70">
                      {list.map((x) => BASIS_TEXT[x]).join(" · ")}
                      {list.length === 1 && list[0] === "funder" && <div className="text-white/45">a connection, not proof of common control</div>}
                    </div>
                  );
                })()}
                {data.nodes[hover].seen && (
                  <div className="mt-0.5 text-[#f0abfc]">
                    🧠 seen on {data.nodes[hover].seen!.tokens} other token
                    {data.nodes[hover].seen!.tokens > 1 ? "s" : ""},{" "}
                    {data.nodes[hover].seen!.dumped} dumped
                    {data.nodes[hover].seen!.roles.length
                      ? ` (as ${data.nodes[hover].seen!.roles.join(", ")})`
                      : ""}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-white/5 px-4 py-3 md:border-t-0 md:border-l">
          <div className="mb-2 text-[10px] font-semibold tracking-[0.16em] text-white/40 uppercase">
            Top holders
          </div>
          <ol className="space-y-1">
            {ranked.map((x, k) => {
              const c = colorOf(x);
              return (
                <li
                  key={x.w}
                  onMouseEnter={() => setHover(x.i)}
                  onMouseLeave={() => setHover(null)}
                  className={cn(
                    "group cursor-pointer rounded-md px-1.5 py-1 transition-colors",
                    hover === x.i ? "bg-white/8" : "hover:bg-white/5",
                  )}
                >
                  <a
                    href={explorer(x.w)}
                    target="_blank"
                    rel="noreferrer"
                    className="block"
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span className="num w-4 text-white/35">{k + 1}</span>
                      <span
                        className="size-2 rounded-full"
                        style={{
                          background: c,
                          boxShadow: x.g >= 0 ? `0 0 8px ${c}` : undefined,
                        }}
                      />
                      <span className="num text-white/80">{short(x.w)}</span>
                      <span className="text-[11px]">
                        {x.roles.map((r) => ROLE_ICON[r]).join("")}
                        {x.seen ? (x.seen.dumped ? "⚠️" : "🧠") : ""}
                      </span>
                      <span className="num ml-auto font-semibold">
                        {pctText(x.pct)}%
                      </span>
                      <WatchButton wallet={x.w} className="md:opacity-0 md:group-hover:opacity-100" />
                    </div>
                    <div className="mt-1 ml-6 h-1 rounded-full bg-white/5">
                      <div
                        className="h-1 rounded-full"
                        style={{
                          width: `${Math.max(4, (x.pct / top) * 100)}%`,
                          background: c,
                          opacity: x.g >= 0 ? 1 : 0.8,
                        }}
                      />
                    </div>
                  </a>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      {!!ops?.length && (
        <div className="flex flex-wrap gap-2 border-t border-white/5 px-5 py-3">
          {ops.map((o, i) => (
            <span key={i} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setFocus(focus === i ? null : i)}
                className={cn(
                  "flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] transition-colors",
                  focus === i ? "bg-white/10" : "hover:bg-white/5",
                )}
                style={{ borderColor: `${NEON[i % NEON.length]}66` }}
              >
                <span
                  className="size-2 rounded-full"
                  style={{
                    background: NEON[i % NEON.length],
                    boxShadow: `0 0 8px ${NEON[i % NEON.length]}`,
                  }}
                />
                <span className="font-semibold">{o.basis?.length === 1 && o.basis[0] === "funder" ? `Connection ${i + 1}` : `Operator ${i + 1}`}</span>
                <span className="text-white/50">
                  {o.wallets} wallets · {o.pct.toFixed(1)}%
                  {o.roles.length ? ` · ${o.roles.join("+")}` : ""}
                  {o.basis?.length ? ` · ${o.basis.length === 1 && o.basis[0] === "funder" ? "shared funder only" : (BASIS_TEXT[o.basis[0]] ?? o.basis[0])}` : ""}
                </span>
              </button>
              {/* Кошельки этой группы на карте: по ним сервер находит оператора между токенами. */}
              <WatchOperatorButton wallets={data.nodes.filter((x) => x.g === i).map((x) => x.w)} />
            </span>
          ))}
        </div>
      )}
      <p className="border-t border-white/5 px-5 py-2.5 text-[10px] text-white/35">
        Top holders, first-block snipers and the dev. Every wallet has its own
        color; linked wallets share a color, wear a dashed ring and are joined by lines. Solid lines: same
        transaction or block, direct transfers or dev money. Dashed lines: a shared funder, which is a
        connection, not proof of common control. 🎯 sniper · 🔗 bundle · ◆
        funder · ↺N seen on N other tokens (red if they dumped). Pools and curves are left out.
      </p>
    </div>
  );
}
