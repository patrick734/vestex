"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { swapAbi } from "@/generated/abis";
import { CHAIN_ID, DEPLOYMENT } from "@/lib/config";
import { ONE, marketOf, useBalances, useMarkets, useNow, type Market } from "@/lib/data";
import { amount, bps, countdown, parse, price, usdg } from "@/lib/format";
import { reportedAt } from "@/lib/rounds";
import { OrderStatus, useMySwaps, useSwapMarkets, type SwapFacts, type SwapMarket, type SwapOrder } from "@/lib/trading";
import { TxStatus, useTx } from "@/lib/tx";
import { Connect } from "./Chrome";
import { MarketStrip, Stock } from "./Stock";
import { Empty, Field, KV, NotLive, NumberInput, Seg } from "./ui";

const BPS = 10_000n;
const SLIPPAGE_BPS = 100n;

export function Swap() {
  const d = DEPLOYMENT;
  const { data: all } = useMarkets();
  const { data: book } = useSwapMarkets();
  const [ticker, setTicker] = useState("");
  const markets = (all ?? []).filter((m) => d?.swapMarkets?.includes(m.ticker));
  useEffect(() => {
    if (!ticker && markets.length) setTicker(markets[0].ticker);
  }, [ticker, markets]);

  if (!d?.swap) return <NotLive />;
  const market = markets.find((m) => m.ticker === ticker);
  const sm = book?.markets.find((m) => m.ticker === ticker);

  return (
    <div className="split">
      <div className="card">
        <div className="card-h">
          <h3>Swap</h3>
          <span className="note">Chainlink price, flat fee, no slippage</span>
        </div>
        {markets.length > 0 && <MarketStrip markets={markets} value={ticker} onChange={setTicker} />}
        {market && sm && book && <NewSwap market={market} sm={sm} facts={book.facts} />}
      </div>
      <div className="card">
        <div className="card-h">
          <h3>Your swaps</h3>
        </div>
        <MySwaps window={book?.facts.orderWindow ?? 3600} feeds={book?.markets ?? []} />
      </div>
    </div>
  );
}

function NewSwap({ market, sm, facts }: { market: Market; sm: SwapMarket; facts: SwapFacts }) {
  const d = DEPLOYMENT!;
  const { address } = useAccount();
  const { data: balances } = useBalances();
  const tx = useTx();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [input, setInput] = useState("");
  const sell = side === "sell";
  const amountIn = parse(input, sell ? 18 : 6);
  const spot = market.price;

  let out = 0n;
  let fee = 0n;
  if (amountIn && spot) {
    if (sell) {
      const gross = (amountIn * spot) / ONE;
      fee = (gross * BigInt(facts.feeBps)) / BPS;
      out = gross - fee;
    } else {
      fee = (amountIn * BigInt(facts.feeBps)) / BPS;
      out = ((amountIn - fee) * ONE) / spot;
    }
  }
  const minOut = (out * (BPS - SLIPPAGE_BPS)) / BPS;
  const value = sell ? (amountIn && spot ? (amountIn * spot) / ONE : 0n) : amountIn ?? 0n;
  const inventoryValue = spot ? (sm.inventory * spot) / ONE : 0n;
  const held = balances?.[sell ? market.ticker : "USDG"];

  let problem = "";
  if (!amountIn) problem = "Enter an amount.";
  else if (!market.fresh) problem = `${market.ticker}'s Chainlink price is stale (market closed), so swaps wait until it updates.`;
  else if (facts.paused || !sm.enabled) problem = "Swaps are paused on this market.";
  else if (value > sm.maxOrder) problem = `The largest single swap is ${usdg(sm.maxOrder, 0)}.`;
  else if (!sell && out > sm.inventory) problem = `The Pool holds ${amount(sm.inventory, 18, 4)} ${market.ticker} right now.`;
  else if (sell && out > facts.freeCash) problem = "The Pool does not have that much free USDG right now.";
  else if (held !== undefined && amountIn > held) problem = `Not enough ${sell ? market.ticker : "USDG"} in your wallet.`;

  const submit = () =>
    tx.run(sell ? `Selling ${market.ticker}` : `Buying ${market.ticker}`, async ({ approve, call }) => {
      await approve(sell ? market.token : d.usdg, d.swap, amountIn!);
      return call({ address: d.swap, abi: swapAbi, functionName: "placeOrder", args: [market.token, sell, amountIn!, minOut] });
    });

  return (
    <div className="stack" style={{ marginTop: 10 }}>
      <Seg
        value={side}
        onChange={(v) => {
          setSide(v);
          setInput("");
        }}
        options={[
          ["buy", `Buy ${market.ticker}`, "above"],
          ["sell", `Sell ${market.ticker}`, "below"],
        ]}
      />
      <Field label={sell ? `${market.ticker} to sell` : "USDG to spend"} hint={held ? <span className="note"> · wallet {sell ? amount(held, 18, 4) : usdg(held)}</span> : null}>
        <NumberInput value={input} onChange={setInput} unit={sell ? market.ticker : "USDG"} />
      </Field>
      <div className="summary">
        <KV
          rows={[
            ["You receive about", out ? (sell ? usdg(out) : `${amount(out, 18, 4)} ${market.ticker}`) : "—"],
            ["Chainlink price now", price(spot)],
            ["Fee", fee ? `${usdg(fee)} (${bps(facts.feeBps)})` : bps(facts.feeBps)],
            ["Accepts no less than", minOut ? (sell ? usdg(minOut) : `${amount(minOut, 18, 4)} ${market.ticker}`) : "—"],
            [`Pool's ${market.ticker}`, sm.inventory ? `${amount(sm.inventory, 18, 4)} · ${usdg(inventoryValue, 0)}` : "—"],
          ]}
        />
      </div>
      {address ? (
        <button className="btn primary wide" disabled={Boolean(problem) || tx.busy} onClick={submit}>
          {sell ? "Sell" : "Buy"} {market.ticker}
        </button>
      ) : (
        <Connect wide />
      )}
      {problem && address && <p className="note">{problem}</p>}
      <TxStatus {...tx} />
      <p className="note">
        Your swap fills at the next Chainlink price after the one showing now, so nobody can trade on a price that is already out of
        date. If no price arrives within {Math.round(facts.orderWindow / 60)} minutes everything comes back; if the price would give you
        less than the minimum, it comes back less the fee.
      </p>
    </div>
  );
}

function MySwaps({ window, feeds }: { window: number; feeds: SwapMarket[] }) {
  const { address } = useAccount();
  const { data } = useMySwaps();
  const now = useNow(5_000);
  if (!address) return <Empty title="Connect a wallet to see your swaps.">{null}</Empty>;
  if (!data) return <Empty title="Loading…">{null}</Empty>;
  if (!data.length) return <Empty title="No swaps yet.">Pick a stock, choose buy or sell, and enter an amount.</Empty>;
  return (
    <div className="pos">
      {data.map((o) => (
        <SwapRow key={o.id} o={o} now={now} window={window} feed={feeds.find((f) => f.token.toLowerCase() === o.token.toLowerCase())?.feed} />
      ))}
    </div>
  );
}

function SwapRow({ o, now, window, feed }: { o: SwapOrder; now: number; window: number; feed?: `0x${string}` }) {
  const d = DEPLOYMENT!;
  const client = usePublicClient({ chainId: CHAIN_ID });
  const tx = useTx();
  const m = marketOf(o.token);
  const pending = o.status === OrderStatus.Pending;
  const { data: next } = useQuery({
    queryKey: ["swapNext", CHAIN_ID, o.id, feed],
    enabled: Boolean(client && feed && pending),
    refetchInterval: 10_000,
    queryFn: () => reportedAt(client!, feed!, o.baseRound + 1n),
  });
  const expired = pending && now > o.createdAt + window && next === null;
  const status = pending ? (next ? "Ready to fill" : expired ? "No price in time" : "Waiting for the next price") : o.status === OrderStatus.Filled ? `Filled at ${price(o.fillPrice)}` : "Refunded";
  return (
    <div className="pos-item">
      <div>
        <div className="title">
          <Stock ticker={m?.ticker ?? "?"} size="sm" />
          <span className={`tag ${o.sell ? "down" : "up"}`}>{o.sell ? "SELL" : "BUY"}</span>
          <span className={`tag ${pending ? "violet" : o.status === OrderStatus.Refunded ? "warn" : ""}`}>{status}</span>
        </div>
        <div className="meta">
          {o.sell ? `${amount(o.amountIn, 18, 4)} ${m?.ticker}` : usdg(o.amountIn)}
          {o.status === OrderStatus.Filled && <> → {o.sell ? usdg(o.amountOut) : `${amount(o.amountOut, 18, 4)} ${m?.ticker}`}</>}
          {pending && !next && !expired && <> · refundable in {countdown(o.createdAt + window, now)}</>}
        </div>
        <TxStatus {...tx} />
      </div>
      <div className="acts">
        {pending && next && (
          <button className="btn primary small" disabled={tx.busy} onClick={() => tx.run("Filling", ({ call }) => call({ address: d.swap, abi: swapAbi, functionName: "execute", args: [BigInt(o.id)] }))}>
            {next > o.createdAt + window ? "Refund" : "Fill now"}
          </button>
        )}
        {expired && (
          <button className="btn ghost small" disabled={tx.busy} onClick={() => tx.run("Refunding", ({ call }) => call({ address: d.swap, abi: swapAbi, functionName: "expire", args: [BigInt(o.id)] }))}>
            Refund
          </button>
        )}
      </div>
    </div>
  );
}
