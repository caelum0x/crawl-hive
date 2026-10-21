// Paper Trading: бумажный P&L стратегий по вердиктам Launch Radar (расчёт в paper.ts).
import { handle } from "@/lib/server/http";
import { paperStats } from "@/lib/server/paper";

export async function GET() {
  return handle(() => paperStats());
}
