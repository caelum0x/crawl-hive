// Тарифы CrawlHive: Free, Holder, Pro (оплата сжиганием) и Whale по всем частям продукта.
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PricingClient } from "@/components/pricing-client";
import { BurnLog } from "@/components/burn-log";

export const metadata: Metadata = {
  title: "Pricing · CrawlHive",
  description: "Free memecoin safety scans for everyone. Hold $CRAWLHIVE for Holder and Whale perks, or burn it for Pro: wallet watchlist, unlimited bot scans, live radar and more Brain API calls.",
};

export default function PricingPage() {
  return (
    <>
      <PageHeader
        title={
          <>
            💎 <span className="text-gradient">Pricing</span>
          </>
        }
        sub="Scanning stays free. Hold $CRAWLHIVE for Holder and Whale perks, or burn it for Pro. Every Pro payment is a public burn."
      />
      <PricingClient />
      <div className="mt-6">
        <BurnLog />
      </div>
    </>
  );
}
