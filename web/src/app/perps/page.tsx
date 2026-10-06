import type { Metadata } from "next";
import { Perps } from "@/components/Perps";

export const metadata: Metadata = { title: "Perps" };

export default function PerpsPage() {
  return (
    <div className="wrap page">
      <div className="page-h">
        <div>
          <p className="eyebrow">Perps</p>
          <h1>Long or short tokenized stocks, up to 10x.</h1>
          <p>
            Margin in USDG, priced by Chainlink, with the Pool on the other side. Every order fills at the first Chainlink price reported
            after you place it, so nobody can trade against a price that is already out of date.
          </p>
        </div>
      </div>
      <Perps />
    </div>
  );
}
