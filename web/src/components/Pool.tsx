"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { poolAbi } from "@/generated/abis";
import { DEPLOYMENT, addressUrl } from "@/lib/config";
import { useNow } from "@/lib/data";
import { bps, countdown, parse, price, usdg } from "@/lib/format";
import { usePool, usePoolPosition } from "@/lib/trading";
import { TxStatus, useTx } from "@/lib/tx";
import { Connect } from "./Chrome";
import { Empty, Field, KV, NotLive, NumberInput, Seg } from "./ui";

export function Pool() {
  const d = DEPLOYMENT;
  const { data: pool } = usePool();
  if (!d?.pool) return <NotLive />;
  const util = pool && pool.totalAssets > 0n ? Number((pool.totalNotional * 10_000n) / pool.totalAssets) / 100 : 0;
  // Under a dollar either way reads as flat.
  const traders = pool?.netOwedToTraders === undefined ? undefined : pool.netOwedToTraders > -1_000_000n && pool.netOwedToTraders < 1_000_000n ? 0n : pool.netOwedToTraders;

  return (
    <div className="stack">
      <div className="card">
        <div className="vault-stats">
          <div className="stat">
            <span>Pool value</span>
            <b>{usdg(pool?.totalAssets, 0)}</b>
          </div>
          <div className="stat">
            <span>Share price</span>
            <b>{pool ? price(pool.sharePrice) : "…"}</b>
          </div>
          <div className="stat">
            <span>Perps open interest</span>
            <b>{usdg(pool?.totalNotional, 0)}</b>
          </div>
          <div className="stat">
            <span>Utilization</span>
            <b>{util ? `${util.toFixed(1)}% of ${bps(pool?.maxUtilizationBps)}` : "—"}</b>
          </div>
          <div className="stat">
            <span>Traders&apos; open result</span>
            <b className={traders === undefined || traders === 0n ? undefined : traders > 0n ? "down" : "up"}>
              {traders === undefined ? "…" : traders === 0n ? "—" : traders > 0n ? `up ${usdg(traders, 0)}` : `down ${usdg(-traders, 0)}`}
            </b>
          </div>
        </div>
        <p className="note" style={{ marginTop: 14 }}>
          The Pool is the other side of every Perps position and the inventory behind every Swap. LPs earn the Pool&apos;s share of trading,
          borrow and swap fees and gain when traders lose; when traders win, the Pool pays them. Open positions are valued into the share
          price at the latest Chainlink prices.{" "}
          <a href={addressUrl(d.pool)} target="_blank" rel="noopener">
            Contract ↗
          </a>
        </p>
      </div>
      <div className="split">
        <div className="card">
          <div className="card-h">
            <h3>Provide liquidity</h3>
            <span className="note">USDG in, vxLP shares out</span>
          </div>
          <LpForm />
        </div>
        <div className="card">
          <div className="card-h">
            <h3>How the Pool is protected</h3>
          </div>
          <ul className="checks" style={{ gridTemplateColumns: "1fr" }}>
            <li>Perps and Swap orders fill at the first Chainlink price after they are placed, so a stale price can never be traded against the Pool.</li>
            <li>Perps open interest is capped per market and at {bps(pool?.maxUtilizationBps)} of the Pool&apos;s value, and a single position&apos;s profit is capped.</li>
            <li>Positions are liquidated at the latest fresh Chainlink price once losses reach the limit. Moving a Uniswap pool cannot trigger it.</li>
            <li>Deposits and withdrawals only go through while every market the Pool is exposed to has a fresh price, never at a weekend&apos;s stale value.</li>
            <li>Shares are held for {pool ? Math.round(pool.minHold / 3600) : "…"} hours after a deposit, and {bps(pool?.lpFeeBps)} stays in the Pool on the way in and out.</li>
            <li>Unaudited. Deposits start capped at {usdg(pool?.depositCap, 0)}.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function LpForm() {
  const d = DEPLOYMENT!;
  const { address } = useAccount();
  const { data: pool } = usePool();
  const { data: me } = usePoolPosition();
  const now = useNow();
  const tx = useTx();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [input, setInput] = useState("");
  const value = parse(input, 6);
  const unlock = me ? me.lastDeposit + (pool?.minHold ?? 0) : 0;
  const holding = me && me.lastDeposit > 0 && now < unlock;
  const room = pool && pool.depositCap > pool.totalAssets ? pool.depositCap - pool.totalAssets : 0n;

  let problem = "";
  if (!value) problem = "Enter an amount.";
  else if (pool && !pool.marketsOpen) problem = "A market the Pool backs has no fresh price right now (market closed). Deposits and withdrawals reopen when it updates.";
  else if (mode === "deposit" && pool?.paused) problem = "Deposits are paused by the guardian. Withdrawals still work.";
  else if (mode === "deposit" && value > room) problem = `The Pool can take ${usdg(room, 0)} more right now.`;
  else if (mode === "deposit" && me && value > me.usdgBalance) problem = "Not enough USDG in your wallet.";
  else if (mode === "withdraw" && holding) problem = `Your shares unlock in ${countdown(unlock, now)}.`;
  else if (mode === "withdraw" && me && value > me.maxWithdraw) problem = `You can withdraw up to ${usdg(me.maxWithdraw)} right now.`;

  const submit = () =>
    mode === "deposit"
      ? tx.run("Depositing", async ({ approve, call }) => {
          await approve(d.usdg, d.pool, value!);
          return call({ address: d.pool, abi: poolAbi, functionName: "deposit", args: [value!, address!] });
        })
      : tx.run("Withdrawing", ({ call }) => call({ address: d.pool, abi: poolAbi, functionName: "withdraw", args: [value!, address!, address!] }));

  return (
    <div className="stack" style={{ marginTop: 10 }}>
      <Seg
        value={mode}
        onChange={(v) => {
          setMode(v);
          setInput("");
        }}
        options={[
          ["deposit", "Deposit"],
          ["withdraw", "Withdraw"],
        ]}
      />
      <Field label="USDG" hint={me ? <span className="note"> · {mode === "deposit" ? `wallet ${usdg(me.usdgBalance)}` : `available ${usdg(me.maxWithdraw)}`}</span> : null}>
        <NumberInput value={input} onChange={setInput} unit="USDG" />
      </Field>
      {address && me ? (
        <div className="summary">
          <KV
            rows={[
              ["Your position", usdg(me.value)],
              ["Unlocks", holding ? countdown(unlock, now) : me.shares ? "now" : "—"],
              ["Fee in and out", bps(pool?.lpFeeBps)],
            ]}
          />
        </div>
      ) : null}
      {address ? (
        <button className="btn primary wide" disabled={Boolean(problem) || tx.busy} onClick={submit}>
          {mode === "deposit" ? "Deposit" : "Withdraw"}
        </button>
      ) : (
        <Connect wide />
      )}
      {problem && address && <p className="note">{problem}</p>}
      {me && me.owed > 0n && (
        <div className="callout">
          {usdg(me.owed)} could not be delivered to your wallet earlier.{" "}
          <button className="btn ghost small" disabled={tx.busy} onClick={() => tx.run("Claiming", ({ call }) => call({ address: d.pool, abi: poolAbi, functionName: "claim", args: [d.usdg] }))}>
            Claim
          </button>
        </div>
      )}
      <TxStatus {...tx} />
      {!address && <Empty title="Connect a wallet to provide liquidity.">{null}</Empty>}
    </div>
  );
}
