"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { perpsAbi, poolAbi, swapAbi } from "@/generated/abis";
import { CHAIN_ID, DEPLOYMENT } from "./config";
import { readAll } from "./data";

const REFRESH = 15_000;

export const OrderStatus = { None: 0, Pending: 1, Filled: 2, Refunded: 3 } as const;
export const OrderKind = { OpenLong: 0, OpenShort: 1, Close: 2 } as const;

function useClient() {
  return usePublicClient({ chainId: CHAIN_ID });
}

export type PoolState = {
  totalAssets: bigint;
  totalSupply: bigint;
  freeCash: bigint;
  capacity: bigint;
  depositCap: bigint;
  paused: boolean;
  marketsOpen: boolean;
  lpFeeBps: number;
  minHold: number;
  maxUtilizationBps: number;
  totalNotional: bigint;
  netOwedToTraders: bigint;
  sharePrice: bigint;
};

/** The Pool's headline numbers. Share price is USDG per 1e12 share units (one whole share has 12 decimals). */
export function usePool() {
  const client = useClient();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["pool", CHAIN_ID],
    enabled: Boolean(client && d?.pool),
    refetchInterval: REFRESH,
    queryFn: async (): Promise<PoolState> => {
      const p = { address: d!.pool, abi: poolAbi } as const;
      const r = await readAll(client!, [
          { ...p, functionName: "totalAssets" },
          { ...p, functionName: "totalSupply" },
          { ...p, functionName: "freeCash" },
          { ...p, functionName: "capacity" },
          { ...p, functionName: "depositCap" },
          { ...p, functionName: "paused" },
          { ...p, functionName: "marketsOpen" },
          { ...p, functionName: "lpFeeBps" },
          { ...p, functionName: "minHold" },
          { ...p, functionName: "maxUtilizationBps" },
          { address: d!.perps, abi: perpsAbi, functionName: "totalNotional" },
          { address: d!.perps, abi: perpsAbi, functionName: "netOwedToTraders" },
          { ...p, functionName: "convertToAssets", args: [10n ** 12n] },
        ]);
      return {
        totalAssets: r[0] as bigint,
        totalSupply: r[1] as bigint,
        freeCash: r[2] as bigint,
        capacity: r[3] as bigint,
        depositCap: r[4] as bigint,
        paused: r[5] as boolean,
        marketsOpen: r[6] as boolean,
        lpFeeBps: Number(r[7]),
        minHold: Number(r[8]),
        maxUtilizationBps: Number(r[9]),
        totalNotional: r[10] as bigint,
        netOwedToTraders: r[11] as bigint,
        sharePrice: r[12] as bigint,
      };
    },
  });
}

export type PoolPosition = { shares: bigint; value: bigint; maxWithdraw: bigint; lastDeposit: number; owed: bigint; usdgBalance: bigint };

export function usePoolPosition() {
  const client = useClient();
  const { address } = useAccount();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["poolPosition", CHAIN_ID, address],
    enabled: Boolean(client && d?.pool && address),
    refetchInterval: REFRESH,
    queryFn: async (): Promise<PoolPosition> => {
      const p = { address: d!.pool, abi: poolAbi } as const;
      const [shares, maxWithdraw, lastDeposit, owed, usdgBalance] = (await readAll(client!, [
          { ...p, functionName: "balanceOf", args: [address!] },
          { ...p, functionName: "maxWithdraw", args: [address!] },
          { ...p, functionName: "lastDeposit", args: [address!] },
          { ...p, functionName: "owed", args: [d!.usdg, address!] },
          { address: d!.usdg, abi: erc20Abi, functionName: "balanceOf", args: [address!] },
        ])) as [bigint, bigint, bigint, bigint, bigint];
      const value = shares === 0n ? 0n : await client!.readContract({ ...p, functionName: "previewRedeem", args: [shares] });
      return { shares, value, maxWithdraw, lastDeposit: Number(lastDeposit), owed, usdgBalance };
    },
  });
}

export type PerpsMarket = {
  ticker: string;
  token: Address;
  feed: Address;
  enabled: boolean;
  maxLeverage: number;
  maxOi: bigint;
  borrowRate: bigint;
  longNotional: bigint;
  shortNotional: bigint;
};

export type PerpsFacts = { feeBps: number; liqLossBps: number; liqRewardBps: number; maxProfitBps: number; orderWindow: number; minCollateral: bigint; paused: boolean };

export function usePerpsMarkets() {
  const client = useClient();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["perpsMarkets", CHAIN_ID],
    enabled: Boolean(client && d?.perps),
    refetchInterval: 30_000,
    queryFn: async (): Promise<{ markets: PerpsMarket[]; facts: PerpsFacts }> => {
      const c = { address: d!.perps, abi: perpsAbi } as const;
      const tickers = d!.perpsMarkets ?? [];
      const reads = await readAll(client!, [
          ...tickers.map((t) => ({ ...c, functionName: "market", args: [d!.markets[t].token] }) as const),
          { ...c, functionName: "feeBps" },
          { ...c, functionName: "liqLossBps" },
          { ...c, functionName: "liqRewardBps" },
          { ...c, functionName: "maxProfitBps" },
          { ...c, functionName: "orderWindow" },
          { ...c, functionName: "minCollateral" },
          { ...c, functionName: "paused" },
        ]);
      const n = tickers.length;
      const markets = tickers.map((ticker, i) => {
        const m = reads[i] as { feed: Address; enabled: boolean; maxLeverage: number; maxOi: bigint; borrowRate: bigint; longNotional: bigint; shortNotional: bigint };
        return {
          ticker,
          token: d!.markets[ticker].token,
          feed: m.feed,
          enabled: m.enabled,
          maxLeverage: Number(m.maxLeverage),
          maxOi: m.maxOi,
          borrowRate: m.borrowRate,
          longNotional: m.longNotional,
          shortNotional: m.shortNotional,
        };
      });
      return {
        markets,
        facts: {
          feeBps: Number(reads[n]),
          liqLossBps: Number(reads[n + 1]),
          liqRewardBps: Number(reads[n + 2]),
          maxProfitBps: Number(reads[n + 3]),
          orderWindow: Number(reads[n + 4]),
          minCollateral: reads[n + 5] as bigint,
          paused: reads[n + 6] as boolean,
        },
      };
    },
  });
}

export type Position = {
  id: number;
  owner: Address;
  isLong: boolean;
  open: boolean;
  openedAt: number;
  token: Address;
  collateral: bigint;
  size: bigint;
  notional: bigint;
  entryPrice: bigint;
  closeOrder: bigint;
};

export type Order = {
  id: number;
  owner: Address;
  kind: number;
  status: number;
  createdAt: number;
  token: Address;
  collateral: bigint;
  fee: bigint;
  notional: bigint;
  limitPrice: bigint;
  baseRound: bigint;
  positionId: bigint;
  fillPrice: bigint;
};

/** The connected wallet's positions (newest first) and its orders on Perps. */
export function useMyPerps() {
  const client = useClient();
  const { address } = useAccount();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["myPerps", CHAIN_ID, address],
    enabled: Boolean(client && d?.perps && address),
    refetchInterval: REFRESH,
    queryFn: async (): Promise<{ positions: Position[]; orders: Order[] }> => {
      const c = { address: d!.perps, abi: perpsAbi } as const;
      const [pids, oids] = await Promise.all([
        client!.readContract({ ...c, functionName: "positionsOf", args: [address!] }),
        client!.readContract({ ...c, functionName: "ordersOf", args: [address!] }),
      ]);
      const recentOrders = oids.slice(-40);
      const reads = await readAll(client!, [
          ...pids.map((id) => ({ ...c, functionName: "getPosition", args: [id] }) as const),
          ...recentOrders.map((id) => ({ ...c, functionName: "getOrder", args: [id] }) as const),
        ]);
      const positions = pids
        .map((id, i) => {
          const p = reads[i] as Omit<Position, "id" | "openedAt"> & { openedAt: number };
          return { ...p, id: Number(id), openedAt: Number(p.openedAt) };
        })
        .reverse();
      const orders = recentOrders
        .map((id, i) => {
          const o = reads[pids.length + i] as Omit<Order, "id" | "kind" | "status" | "createdAt"> & { kind: number; status: number; createdAt: number };
          return { ...o, id: Number(id), kind: Number(o.kind), status: Number(o.status), createdAt: Number(o.createdAt) };
        })
        .reverse();
      return { positions, orders };
    },
  });
}

export type SwapMarket = { ticker: string; token: Address; feed: Address; enabled: boolean; maxOrder: bigint; inventory: bigint; inventoryCap: bigint };
export type SwapFacts = { feeBps: number; orderWindow: number; paused: boolean; freeCash: bigint };

export function useSwapMarkets() {
  const client = useClient();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["swapMarkets", CHAIN_ID],
    enabled: Boolean(client && d?.swap),
    refetchInterval: REFRESH,
    queryFn: async (): Promise<{ markets: SwapMarket[]; facts: SwapFacts }> => {
      const s = { address: d!.swap, abi: swapAbi } as const;
      const p = { address: d!.pool, abi: poolAbi } as const;
      const tickers = d!.swapMarkets ?? [];
      const reads = await readAll(client!, [
          ...tickers.flatMap((t) => {
            const token = d!.markets[t].token;
            return [
              { ...s, functionName: "market", args: [token] } as const,
              { ...p, functionName: "inventory", args: [token] } as const,
              { ...p, functionName: "inventoryCap", args: [token] } as const,
            ];
          }),
          { ...s, functionName: "feeBps" },
          { ...s, functionName: "orderWindow" },
          { ...s, functionName: "paused" },
          { ...p, functionName: "freeCash" },
        ]);
      const markets = tickers.map((ticker, i) => {
        const m = reads[3 * i] as { feed: Address; enabled: boolean; maxOrder: bigint };
        return {
          ticker,
          token: d!.markets[ticker].token,
          feed: m.feed,
          enabled: m.enabled,
          maxOrder: m.maxOrder,
          inventory: reads[3 * i + 1] as bigint,
          inventoryCap: reads[3 * i + 2] as bigint,
        };
      });
      const n = 3 * tickers.length;
      return {
        markets,
        facts: { feeBps: Number(reads[n]), orderWindow: Number(reads[n + 1]), paused: reads[n + 2] as boolean, freeCash: reads[n + 3] as bigint },
      };
    },
  });
}

export type SwapOrder = {
  id: number;
  owner: Address;
  sell: boolean;
  status: number;
  createdAt: number;
  token: Address;
  amountIn: bigint;
  minOut: bigint;
  baseRound: bigint;
  amountOut: bigint;
  fillPrice: bigint;
};

export function useMySwaps() {
  const client = useClient();
  const { address } = useAccount();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["mySwaps", CHAIN_ID, address],
    enabled: Boolean(client && d?.swap && address),
    refetchInterval: REFRESH,
    queryFn: async (): Promise<SwapOrder[]> => {
      const s = { address: d!.swap, abi: swapAbi } as const;
      const ids = (await client!.readContract({ ...s, functionName: "ordersOf", args: [address!] })).slice(-30);
      const reads = await readAll(client!, ids.map((id) => ({ ...s, functionName: "getOrder", args: [id] }) as const));
      return ids
        .map((id, i) => {
          const o = reads[i] as Omit<SwapOrder, "id" | "status" | "createdAt"> & { status: number; createdAt: number };
          return { ...o, id: Number(id), status: Number(o.status), createdAt: Number(o.createdAt) };
        })
        .reverse();
    },
  });
}
