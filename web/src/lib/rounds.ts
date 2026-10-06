import type { Address, PublicClient } from "viem";

// Chainlink round lookups, matching what the contracts accept (see contracts/src/libraries/ChainlinkRounds.sol and
// keeper/src/rounds.js). Round ids are `phase << 64 | n`, with n counting up from 1 inside each phase.

const FEED_ABI = [
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
  { type: "function", name: "getRoundData", stateMutability: "view", inputs: [{ type: "uint80" }], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
] as const;

const MASK = (1n << 64n) - 1n;

async function roundAt(client: PublicClient, feed: Address, id: bigint): Promise<bigint | null> {
  try {
    const r = await client.readContract({ address: feed, abi: FEED_ABI, functionName: "getRoundData", args: [id] });
    return r[3] === 0n ? null : r[3];
  } catch {
    return null;
  }
}

/** The round that was current at `time`: 0n if that is still the latest, null if none existed yet. */
export async function roundHint(client: PublicClient, feed: Address, time: number): Promise<bigint | null> {
  const t = BigInt(time);
  const latest = await client.readContract({ address: feed, abi: FEED_ABI, functionName: "latestRoundData" });
  if (latest[3] !== 0n && latest[3] <= t) return 0n;
  const latestPhase = latest[0] >> 64n;
  for (let phase = latestPhase; phase >= 1n; phase--) {
    const base = phase << 64n;
    const first = await roundAt(client, feed, base | 1n);
    if (first === null || first > t) continue;
    let lo = 1n;
    let hi = latest[0] & MASK;
    if (phase !== latestPhase) {
      hi = 2n;
      while ((await roundAt(client, feed, base | hi)) !== null) hi *= 2n;
    }
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      const u = await roundAt(client, feed, base | mid);
      if (u !== null && u <= t) lo = mid;
      else hi = mid - 1n;
    }
    return base | lo;
  }
  return null;
}

/** When round `id` was reported, or null if it has not been yet. Perps and Swap orders fill at the round after the
 *  one that was current when they were placed. */
export async function reportedAt(client: PublicClient, feed: Address, id: bigint): Promise<number | null> {
  const at = await roundAt(client, feed, id);
  return at === null ? null : Number(at);
}
