import type { Metadata } from "next";
import { Swap } from "@/components/Swap";

export const metadata: Metadata = { title: "Swap" };

export default function SwapPage() {
  return (
    <div className="wrap page">
      <div className="page-h">
        <div>
          <p className="eyebrow">Swap</p>
          <h1>Stock Tokens at the Chainlink price.</h1>
          <p>
            Buy and sell Robinhood Stock Tokens against the Pool for a flat fee and no other slippage. Swaps fill at the next Chainlink
            price, the same rule that protects every trade on Vestex.
          </p>
        </div>
      </div>
      <Swap />
    </div>
  );
}
