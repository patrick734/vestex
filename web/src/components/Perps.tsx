"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { perpsAbi } from "@/generated/abis";
import { CHAIN_ID, DEPLOYMENT } from "@/lib/config";
import { marketOf, useBalances, useMarkets, useNow, type Market } from "@/lib/data";
import { amount, bps, countdown, parse, percent, price, usdg } from "@/lib/format";
import { reportedAt } from "@/lib/rounds";
import { OrderKind, OrderStatus, useMyPerps, usePerpsMarkets, usePool, type Order, type PerpsFacts, type PerpsMarket, type Position } from "@/lib/trading";
import { TxStatus, useTx } from "@/lib/tx";
import { Connect } from "./Chrome";
import { MarketStrip, Stock } from "./Stock";
import { Empty, Field, KV, NotLive, NumberInput, Seg } from "./ui";

const BPS = 10_000n;
const LEVERAGES = [1, 2, 3, 5, 10];
const SLIPPAGE_BPS = 100n;

export function Perps() {
  const d = DEPLOYMENT;
  const { data: all } = useMarkets();
  const { data: book } = usePerpsMarkets();
  const [ticker, setTicker] = useState("");
  const markets = (all ?? []).filter((m) => d?.perpsMarkets?.includes(m.ticker));
  useEffect(() => {
    if (!ticker && markets.length) setTicker(markets[0].ticker);
  }, [ticker, markets]);

  if (!d?.perps) return <NotLive />;
  const market = markets.find((m) => m.ticker === ticker);
  const pm = book?.markets.find((m) => m.ticker === ticker);

  return (
    <div className="split form-last">
      <div className="card">
        <div className="card-h">
          <h3>Your positions</h3>
          <span className="note">Fills at the next Chainlink price</span>
        </div>
        <MyPositions markets={all ?? []} facts={book?.facts} />
      </div>
      <div className="card">
        <div className="card-h">
          <h3>Open a position</h3>
          <span className="note">Up to {pm?.maxLeverage ?? 10}x · USDG margin</span>
        </div>
        {markets.length > 0 && <MarketStrip markets={markets} value={ticker} onChange={setTicker} />}
        {market && pm && book && <NewPosition market={market} pm={pm} facts={book.facts} />}
      </div>
    </div>
  );
}

function NewPosition({ market, pm, facts }: { market: Market; pm: PerpsMarket; facts: PerpsFacts }) {
  const d = DEPLOYMENT!;
  const { address } = useAccount();
  const { data: balances } = useBalances();
  const { data: pool } = usePool();
  const tx = useTx();
  const [side, setSide] = useState<"long" | "short">("long");
  const [margin, setMargin] = useState("100");
  const [lev, setLev] = useState(3);
  const leverage = Math.min(lev, pm.maxLeverage);

  const collateral = parse(margin, 6);
  const notional = collateral ? collateral * BigInt(leverage) : 0n;
  const fee = (notional * BigInt(facts.feeBps)) / BPS;
  const spot = market.price;
  const size = spot && notional ? (notional * 10n ** 18n) / spot : 0n;
  const limit = spot ? (side === "long" ? (spot * (BPS + SLIPPAGE_BPS)) / BPS : (spot * (BPS - SLIPPAGE_BPS)) / BPS) : 0n;
  const liq = spot && collateral ? liquidationPrice(side === "long", collateral, notional, spot, facts) : null;
  const sideOi = side === "long" ? pm.longNotional : pm.shortNotional;

  let problem = "";
  if (!collateral) problem = "Enter your margin.";
  else if (collateral < facts.minCollateral) problem = `The smallest margin is ${usdg(facts.minCollateral, 0)}.`;
  else if (!market.fresh) problem = `${market.ticker}'s Chainlink price is stale (market closed), so new orders wait until it updates.`;
  else if (facts.paused || !pm.enabled) problem = "New positions are paused on this market.";
  else if (sideOi + notional > pm.maxOi) problem = `Open interest on this side is near its cap of ${usdg(pm.maxOi, 0)}.`;
  else if (pool && pool.totalNotional + notional > pool.capacity) problem = "The Pool cannot back a position this large right now.";
  else if (balances && collateral + fee > balances.USDG) problem = "Not enough USDG in your wallet.";

  const submit = () =>
    tx.run(`Placing the ${side} order`, async ({ approve, call }) => {
      await approve(d.usdg, d.perps, collateral! + fee);
      return call({ address: d.perps, abi: perpsAbi, functionName: "openPosition", args: [market.token, side === "long", collateral!, notional, limit] });
    });

  return (
    <div className="stack" style={{ marginTop: 10 }}>
      <Seg
        value={side}
        onChange={setSide}
        options={[
          ["long", "Long", "above"],
          ["short", "Short", "below"],
        ]}
      />
      <Field label="Margin">
        <NumberInput value={margin} onChange={setMargin} unit="USDG" />
      </Field>
      <Field label="Leverage">
        <div className="chips">
          {LEVERAGES.filter((l) => l <= pm.maxLeverage).map((l) => (
            <button key={l} type="button" className={l === leverage ? "on" : ""} onClick={() => setLev(l)}>
              {l}x
            </button>
          ))}
        </div>
      </Field>
      <div className="summary">
        <KV
          rows={[
            ["Position size", notional ? `${usdg(notional)} · ${amount(size, 18, 4)} ${market.ticker}` : "—"],
            ["Chainlink price now", price(spot)],
            ["Fills no worse than", limit ? price(limit) : "—"],
            ["Estimated liquidation", liq ? price(liq) : "—"],
            ["Trading fee", fee ? `${usdg(fee)} (${bps(facts.feeBps)})` : bps(facts.feeBps)],
            ["Borrow fee", pm.borrowRate ? `${percent(Number(formatUnits(pm.borrowRate, 18)))} a year on size` : "—"],
          ]}
        />
      </div>
      {address ? (
        <button className={`btn primary wide`} disabled={Boolean(problem) || tx.busy} onClick={submit}>
          {side === "long" ? "Long" : "Short"} {market.ticker} · {leverage}x
        </button>
      ) : (
        <Connect wide />
      )}
      {problem && address && <p className="note">{problem}</p>}
      <TxStatus {...tx} />
      <p className="note">
        Your order fills at the next Chainlink price after the one showing now, usually within minutes in market hours. If no price
        arrives within {Math.round(facts.orderWindow / 60)} minutes, margin and fee come back in full; if the price is past your limit,
        the margin comes back and the fee is kept. Liquidation happens once losses reach {bps(facts.liqLossBps)} of margin; profit is capped at {facts.maxProfitBps / 10_000}x margin.
      </p>
    </div>
  );
}

/** Price at which equity falls to the liquidation floor, ignoring borrow fees still to accrue. */
function liquidationPrice(isLong: boolean, collateral: bigint, notional: bigint, entry: bigint, facts: PerpsFacts): bigint | null {
  const c = Number(collateral);
  const n = Number(notional);
  const size = n / Number(entry);
  const floor = (c * (10_000 - facts.liqLossBps)) / 10_000;
  const f = facts.feeBps / 10_000;
  const p = isLong ? (floor - c + n) / (size * (1 - f)) : (c + n - floor) / (size * (1 + f));
  return p > 0 && Number.isFinite(p) ? BigInt(Math.round(p)) : null;
}

function MyPositions({ markets, facts }: { markets: Market[]; facts?: PerpsFacts }) {
  const d = DEPLOYMENT!;
  const { address } = useAccount();
  const { data } = useMyPerps();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const tx = useTx();
  const { data: refund } = useQuery({
    queryKey: ["perpsRefund", CHAIN_ID, address],
    enabled: Boolean(client && address),
    refetchInterval: 30_000,
    queryFn: () => client!.readContract({ address: d.perps, abi: perpsAbi, functionName: "refundOwed", args: [address!] }),
  });
  const now = useNow(5_000);
  if (!address) return <Empty title="Connect a wallet to see your positions.">{null}</Empty>;
  const open = (data?.positions ?? []).filter((p) => p.open);
  const pending = (data?.orders ?? []).filter((o) => o.status === OrderStatus.Pending);
  const history = (data?.orders ?? []).filter((o) => o.status !== OrderStatus.Pending).slice(0, 8);
  if (!data) return <Empty title="Loading…">{null}</Empty>;
  if (!open.length && !pending.length && !history.length) return <Empty title="No positions yet.">Pick a stock on the right, choose long or short, and set your margin.</Empty>;
  return (
    <div className="pos">
      {refund ? (
        <div className="pos-item">
          <div>
            <div className="title">Refund waiting for you</div>
            <div className="meta">{usdg(refund)} could not be delivered when your order was refunded.</div>
            <TxStatus {...tx} />
          </div>
          <div className="acts">
            <button className="btn ghost small" disabled={tx.busy} onClick={() => tx.run("Claiming", ({ call }) => call({ address: d.perps, abi: perpsAbi, functionName: "claimRefund" }))}>
              Claim
            </button>
          </div>
        </div>
      ) : null}
      {pending.map((o) => (
        <PendingOrder key={`o${o.id}`} o={o} now={now} window={facts?.orderWindow ?? 3600} />
      ))}
      {open.map((p) => (
        <OpenPosition key={`p${p.id}`} p={p} market={markets.find((m) => m.token.toLowerCase() === p.token.toLowerCase())} facts={facts} pendingClose={pending.some((o) => o.kind === OrderKind.Close && Number(o.positionId) === p.id)} />
      ))}
      {history.length > 0 && <p className="eyebrow" style={{ marginTop: 18 }}>Recent orders</p>}
      {history.map((o) => {
        const m = marketOf(o.token);
        const label = o.kind === OrderKind.Close ? "Close" : o.kind === OrderKind.OpenLong ? "Long" : "Short";
        return (
          <div className="pos-item" key={`h${o.id}`}>
            <div>
              <div className="title">
                <Stock ticker={m?.ticker ?? "?"} size="sm" />
                <span className={`tag ${o.kind === OrderKind.OpenShort ? "down" : o.kind === OrderKind.OpenLong ? "up" : ""}`}>{label}</span>
                <span className={`tag ${o.status === OrderStatus.Filled ? "" : "warn"}`}>{o.status === OrderStatus.Filled ? `Filled at ${price(o.fillPrice)}` : "Refunded"}</span>
              </div>
              <div className="meta">{o.kind === OrderKind.Close ? `Position #${o.positionId}` : `${usdg(o.notional)} size · ${usdg(o.collateral)} margin`}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function OpenPosition({ p, market, facts, pendingClose }: { p: Position; market?: Market; facts?: PerpsFacts; pendingClose: boolean }) {
  const d = DEPLOYMENT!;
  const client = usePublicClient({ chainId: CHAIN_ID });
  const tx = useTx();
  const [topUp, setTopUp] = useState("");
  const m = marketOf(p.token);
  const spot = market?.price;
  const { data: preview } = useQuery({
    queryKey: ["perpsPreview", CHAIN_ID, p.id, spot?.toString()],
    enabled: Boolean(client && spot),
    queryFn: () => client!.readContract({ address: d.perps, abi: perpsAbi, functionName: "preview", args: [BigInt(p.id), spot!] }),
  });
  const pnl = preview?.[0];
  const equity = preview?.[2];
  const liq = facts ? liquidationPrice(p.isLong, p.collateral, p.notional, p.entryPrice, facts) : null;
  const limit = spot ? (p.isLong ? (spot * (BPS - SLIPPAGE_BPS)) / BPS : (spot * (BPS + SLIPPAGE_BPS)) / BPS) : 0n;
  const add = parse(topUp, 6);

  return (
    <div className="pos-item">
      <div>
        <div className="title">
          <Stock ticker={m?.ticker ?? "?"} size="sm" />
          <span className={`tag ${p.isLong ? "up" : "down"}`}>
            {p.isLong ? "LONG" : "SHORT"} {(Number(p.notional) / Number(p.collateral)).toFixed(1)}x
          </span>
          {pnl !== undefined && (pnl >= 10_000n || pnl <= -10_000n) && <span className={`num ${pnl >= 0n ? "up" : "down"}`}>{pnl >= 0n ? "+" : "−"}{usdg(pnl >= 0n ? pnl : -pnl)}</span>}
        </div>
        <div className="meta">
          {usdg(p.notional)} at {price(p.entryPrice)} · margin {usdg(p.collateral)}
          {equity !== undefined && <> · worth {usdg(equity > 0n ? equity : 0n)}</>}
          {liq && <> · liquidates near {price(liq)}</>}
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <span style={{ width: 170, maxWidth: "100%" }}>
            <NumberInput value={topUp} onChange={setTopUp} unit="USDG" />
          </span>
          <button
            className="btn ghost small"
            disabled={!add || tx.busy}
            onClick={() =>
              tx.run("Adding margin", async ({ approve, call }) => {
                await approve(d.usdg, d.perps, add!);
                return call({ address: d.perps, abi: perpsAbi, functionName: "addCollateral", args: [BigInt(p.id), add!] });
              })
            }
          >
            Add margin
          </button>
        </div>
        <TxStatus {...tx} />
      </div>
      <div className="acts">
        {pendingClose ? (
          <span className="tag">Closing…</span>
        ) : (
          <button
            className="btn primary small"
            disabled={!limit || tx.busy}
            onClick={() => tx.run("Placing the close order", ({ call }) => call({ address: d.perps, abi: perpsAbi, functionName: "closePosition", args: [BigInt(p.id), limit] }))}
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
}

function PendingOrder({ o, now, window }: { o: Order; now: number; window: number }) {
  const d = DEPLOYMENT!;
  const client = usePublicClient({ chainId: CHAIN_ID });
  const tx = useTx();
  const m = marketOf(o.token);
  const { data: market } = usePerpsMarkets();
  const feed = market?.markets.find((x) => x.token.toLowerCase() === o.token.toLowerCase())?.feed;
  const { data: next } = useQuery({
    queryKey: ["nextRound", CHAIN_ID, feed, o.createdAt],
    enabled: Boolean(client && feed),
    refetchInterval: 10_000,
    queryFn: () => reportedAt(client!, feed!, o.baseRound + 1n),
  });
  const expired = now > o.createdAt + window && next === null;
  const label = o.kind === OrderKind.Close ? "Close" : o.kind === OrderKind.OpenLong ? "Long" : "Short";

  return (
    <div className="pos-item">
      <div>
        <div className="title">
          <Stock ticker={m?.ticker ?? "?"} size="sm" />
          <span className={`tag ${o.kind === OrderKind.OpenShort ? "down" : o.kind === OrderKind.OpenLong ? "up" : ""}`}>{label}</span>
          <span className="tag violet">{next ? "New price in, ready to fill" : expired ? "No price in time" : "Waiting for the next Chainlink price"}</span>
        </div>
        <div className="meta">
          {o.kind === OrderKind.Close ? `Position #${o.positionId}` : `${usdg(o.notional)} size · ${usdg(o.collateral)} margin`} · limit {price(o.limitPrice)}
          {!next && !expired && <> · refundable in {countdown(o.createdAt + window, now)}</>}
        </div>
        <TxStatus {...tx} />
      </div>
      <div className="acts">
        {next && (
          <button
            className="btn primary small"
            disabled={tx.busy}
            onClick={() => tx.run("Filling", ({ call }) => call({ address: d.perps, abi: perpsAbi, functionName: "execute", args: [BigInt(o.id)] }))}
          >
            {next > o.createdAt + window ? "Refund" : "Fill now"}
          </button>
        )}
        {expired && (
          <button className="btn ghost small" disabled={tx.busy} onClick={() => tx.run("Refunding", ({ call }) => call({ address: d.perps, abi: perpsAbi, functionName: "expire", args: [BigInt(o.id)] }))}>
            Refund
          </button>
        )}
      </div>
    </div>
  );
}
