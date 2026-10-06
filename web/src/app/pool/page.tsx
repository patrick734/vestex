import type { Metadata } from "next";
import { Pool } from "@/components/Pool";

export const metadata: Metadata = { title: "Pool" };

export default function PoolPage() {
  return (
    <div className="wrap page">
      <div className="page-h">
        <div>
          <p className="eyebrow">Pool</p>
          <h1>Be the house for Perps and Swap.</h1>
          <p>
            Deposit USDG into the Pool that backs every Perps position and fills every Swap. You earn the Pool&apos;s share of the fees
            and carry the other side of traders&apos; positions.
          </p>
        </div>
      </div>
      <Pool />
    </div>
  );
}
