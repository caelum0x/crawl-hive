// Превью ссылки на сайт (главная и страницы без своей карточки) в X и Telegram: что это и где работает.
// Стиль тот же, что у карточки скана (scan/[id]/opengraph-image.tsx).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

export const alt = "CrawlHive: free memecoin safety scanner";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#05060a";
const FG = "#f2f3f5";
const MUTED = "#8a9099";
const HONEY = "#ffb020";
const CHAINS: [string, string][] = [["Solana", "#c084fc"], ["BNB Chain", "#facc15"], ["Base", "#60a5fa"], ["Robinhood", "#a3e635"]];
const CHECKS = ["Bundles", "Snipers", "Dev history", "LP locks", "Bubble map", "Larpcheck"];

export default async function Image() {
  const file = (p: string) => readFile(path.join(process.cwd(), p)).catch(() => null);
  const [pic, m, b] = await Promise.all([file("public/tg/watch.png"), file("public/fonts/Inter-Medium.ttf"), file("public/fonts/Inter-ExtraBold.ttf")]);
  const fonts = [...(m ? [{ name: "Inter", data: m, weight: 500 as const, style: "normal" as const }] : []), ...(b ? [{ name: "Inter", data: b, weight: 800 as const, style: "normal" as const }] : [])];

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: BG, color: FG, padding: "48px 56px", position: "relative", fontFamily: "Inter", fontWeight: 500 }}>
        <div style={{ position: "absolute", top: 0, left: 0, width: 1200, height: 630, display: "flex", backgroundImage: "radial-gradient(circle at 12% 18%, rgba(255,159,28,0.30), transparent 45%), radial-gradient(circle at 92% 92%, rgba(244,114,182,0.28), transparent 45%)" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 26 }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ width: 18, height: 18, borderRadius: 9, background: HONEY, marginRight: 12 }} />
            <span style={{ fontWeight: 800 }}>Crawl</span>
            <span style={{ fontWeight: 800, color: HONEY }}>Hive</span>
          </div>
          <span style={{ color: MUTED }}>crawlhive.xyz</span>
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <span style={{ fontSize: 72, fontWeight: 800, lineHeight: 1.02, letterSpacing: -2 }}>Free memecoin</span>
            <span style={{ fontSize: 72, fontWeight: 800, lineHeight: 1.02, letterSpacing: -2, color: HONEY }}>safety scanner</span>
            <span style={{ fontSize: 30, color: "#d1d5db", marginTop: 18 }}>Drop any CA. The swarm checks it in seconds.</span>
            <div style={{ display: "flex", flexWrap: "wrap", marginTop: 26, width: 720 }}>
              {CHECKS.map((c) => (
                <span key={c} style={{ fontSize: 22, padding: "6px 16px", borderRadius: 12, background: "rgba(255,255,255,0.06)", border: "2px solid rgba(255,255,255,0.12)", marginRight: 10, marginBottom: 10 }}>{c}</span>
              ))}
            </div>
            <div style={{ display: "flex", marginTop: 8 }}>
              {CHAINS.map(([n, c]) => (
                <span key={n} style={{ fontSize: 22, fontWeight: 800, color: c, border: `2px solid ${c}`, borderRadius: 999, padding: "4px 16px", marginRight: 10 }}>{n}</span>
              ))}
            </div>
          </div>
          {pic && <img src={`data:image/png;base64,${pic.toString("base64")}`} width={300} height={300} />}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", color: MUTED, fontSize: 20 }}>
          <span>Bots on X (@crawlhivebot) and Telegram · no wallet, no signup</span>
          <span>not financial advice</span>
        </div>
      </div>
    ),
    { ...size, ...(fonts.length ? { fonts } : {}) },
  );
}
