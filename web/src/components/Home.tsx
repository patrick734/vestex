"use client";

import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { DEPLOYMENT } from "@/lib/config";
import { ONE, OptionState, useBets, useIncomeVaults, useLiquidityVaults, useMarkets, useOptions } from "@/lib/data";
import { compactUsd, price } from "@/lib/format";
import { usePool } from "@/lib/trading";
import { CopyCA } from "./Chrome";
import { Logo, Stock } from "./Stock";

/** Live prices running under the hero. Renders nothing until prices load. */
export function Tape() {
  const { data } = useMarkets();
  const priced = (data ?? []).filter((m) => m.price);
  if (!priced.length) return null;
  const items = [...priced, ...priced];
  return (
    <div className="tape" aria-label="Chainlink prices">
      <div className="tape-in">
        {items.map((m, i) => (
          <span key={i}>
            <Logo ticker={m.ticker} size="sm" />
            <b>{m.ticker}</b>
            {price(m.price)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Live Chainlink prices with a way into Swap and Perps. Renders nothing until prices load. */
export function Ticket() {
  const { data: markets } = useMarkets();
  const top = (markets ?? []).filter((m) => m.price).slice(0, 6);
  if (!top.length) return null;
  return (
    <div className="ticket">
      <p className="eyebrow" style={{ marginBottom: 10 }}>
        Chainlink prices
      </p>
      {top.map((m) => (
        <div className="ticket-row" key={m.ticker}>
          <Stock ticker={m.ticker} name={m.name} size="sm" />
          <b>{price(m.price)}</b>
        </div>
      ))}
      <div className="row" style={{ marginTop: 16 }}>
        <Link className="btn primary" style={{ flex: 1 }} href="/perps/">
          Trade perps
        </Link>
        <Link className="btn ghost" style={{ flex: 1 }} href="/swap/">
          Swap
        </Link>
      </div>
    </div>
  );
}

/** Live protocol figures. Each one appears only when it is above zero. */
export function Stats() {
  const { data: options } = useOptions();
  const { data: bets } = useBets();
  const { data: income } = useIncomeVaults();
  const { data: liquidity } = useLiquidityVaults();
  const { data: markets } = useMarkets();
  const { data: pool } = usePool();
  if (!DEPLOYMENT) return null;

  const px = new Map((markets ?? []).map((m) => [m.token.toLowerCase(), m.price ?? 0n]));
  let openInterest = 0n;
  let premiums = 0n;
  for (const o of options ?? []) {
    if (o.state === OptionState.Active) openInterest += o.kind === 1 ? o.collateral : (o.collateral * (px.get(o.token.toLowerCase()) ?? 0n)) / ONE;
    if (o.state >= OptionState.Active) premiums += o.premium;
  }
  const staked = (bets ?? []).filter((b) => b.state >= 2).reduce((s, b) => s + b.stake * 2n, 0n);
  const vaults =
    (income ?? []).reduce((s, v) => s + ((v.live ? v.roundStartValue : v.totalValue) ?? 0n), 0n) + (liquidity ?? []).reduce((s, v) => s + (v.heldValue ?? 0n), 0n);
  const items = [
    ["In the Pool", pool?.totalAssets ?? 0n],
    ["Perps open interest", pool?.totalNotional ?? 0n],
    ["In vaults", vaults],
    ["Options open interest", openInterest],
    ["Premiums paid to writers", premiums],
    ["Staked in predictions", staked],
  ].filter(([, v]) => (v as bigint) > 0n) as [string, bigint][];
  if (!items.length) return null;
  return (
    <div className="stats">
      {items.map(([label, v]) => (
        <div key={label}>
          <b>{compactUsd(v)}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

export function TokenPanel() {
  const t = BRAND.token;
  if (!t) return null;
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="row between">
        <div>
          <p className="eyebrow">${t.symbol}</p>
          <h3 style={{ marginTop: 8 }}>Protocol fees buy and burn ${t.symbol}</h3>
          <p className="note" style={{ marginTop: 6, maxWidth: 560 }}>
            BuyBurn can only spend what it holds on ${t.symbol}, and burns every token it buys. It has no withdrawal function.
          </p>
        </div>
        <div className="stack" style={{ gap: 10, minWidth: 0, maxWidth: "100%" }}>
          <CopyCA address={t.address} />
          <a className="btn ghost small" href={t.ponsUrl} target="_blank" rel="noopener">
            Trade ${t.symbol} on Pons ↗
          </a>
        </div>
      </div>
    </div>
  );
}
