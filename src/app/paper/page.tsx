// Paper Trading: публичный бумажный P&L роя. Данные и расчёт в api/paper и paper.ts, здесь только метаданные.
import type { Metadata } from "next";
import { PaperView } from "@/components/paper-view";

export const metadata: Metadata = {
  title: "CrawlHive Paper Trading · the swarm trades its own signals",
  description: "Fake $100 on every Launch Radar verdict, sold 24 hours later. Public P&L for CLEAN-only and CLEAN + OK strategies against a buy-everything baseline. Paper money, not advice.",
};

export default function PaperPage() {
  return <PaperView />;
}
