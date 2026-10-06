// Perps, Swap and Pool upkeep. Anyone could do all of it; the keeper does it so nobody waits:
//   - fill orders at the Chainlink round after the one current when they were placed, and refund those no price
//     arrived for in time
//   - liquidate positions past the loss limit, and close positions whose profit reached the cap
//   - keep the Pool's corporate-action record in step with each token's flag
//   - keep the Pool stocked with Stock Tokens for Swap, within its cap
const { ethers } = require("ethers");
const abis = require("../abis");
const { exec, reason, blockTime } = require("../chain");
const { logger } = require("../log");
const { buildRoute } = require("../routes");

const PENDING = 1n;
const PAGE = 50;

/** Fills or refunds every pending order on Perps or Swap, oldest first. */
async function runOrders(ctx, kind) {
  const address = kind === "perps" ? ctx.dep.perps : ctx.dep.swap;
  const cfg = ctx.cfg.orders;
  if (!address || !cfg.fill) return;
  const log = logger(kind);
  const c = new ethers.Contract(address, kind === "perps" ? abis.Perps : abis.Swap, ctx.runner);
  const state = (ctx.state[kind] ||= { cursor: 0 });
  const [count, now, window] = await Promise.all([c.orderCount(), blockTime(ctx.provider), c.orderWindow()]);
  const feeds = {};
  let sent = 0;
  let cursor = state.cursor;
  let donePrefix = true;
  for (let id = state.cursor; id < Number(count) && sent < cfg.maxPerCycle; id++) {
    const o = await c.getOrder(id);
    let pending = o.status === PENDING;
    if (pending) {
      const olog = logger(kind, `#${id}`);
      try {
        if (!feeds[o.token]) {
          const m = await c.market(o.token);
          feeds[o.token] = new ethers.Contract(m.feed, abis.Aggregator, ctx.provider);
        }
        const reported = await feeds[o.token].getRoundData(o.baseRound + 1n).then(
          (rd) => rd[3] !== 0n,
          () => false,
        );
        let r = null;
        if (reported) r = await exec(ctx, olog, c, "execute", [id], "fill", ["CorporateAction"]);
        else if (now > o.createdAt + window) r = await exec(ctx, olog, c, "expire", [id], "refund");
        if (r && r.ok) {
          sent++;
          if (!r.simulated) pending = false;
        }
      } catch (e) {
        olog.warn("could not process", { reason: reason(e) });
      }
    }
    if (pending) donePrefix = false;
    if (donePrefix) cursor = id + 1;
  }
  if (!ctx.dryRun) state.cursor = cursor;
  log.info("orders checked", { orders: Number(count), from: state.cursor, actions: sent });
}

/** Liquidates open positions past the loss limit, and closes those whose profit reached the cap. */
async function runLiquidations(ctx) {
  if (!ctx.dep.perps || !ctx.cfg.orders.liquidate) return;
  const log = logger("liquidations");
  const perps = new ethers.Contract(ctx.dep.perps, abis.Perps, ctx.runner);
  const oracle = new ethers.Contract(ctx.dep.oracle, abis.Oracle, ctx.provider);
  const ids = await perps.openPositionIds();
  const maxProfitBps = await perps.maxProfitBps();
  const prices = {};
  let sent = 0;
  let capped = 0;
  for (const id of ids) {
    const p = await perps.getPosition(id);
    if (!(p.token in prices)) {
      const fresh = await oracle.isFresh(p.token);
      const unit = 10n ** BigInt(await new ethers.Contract(p.token, abis.ERC20, ctx.provider).decimals());
      prices[p.token] = fresh ? await oracle.usdgValue(p.token, unit) : null;
    }
    if (prices[p.token] === null) continue;
    const [pnl, , , liquidatable] = await perps.preview(id, prices[p.token]);
    if (liquidatable) {
      const r = await exec(ctx, logger("liquidations", `#${id}`), perps, "liquidate", [id], "liquidate", ["Healthy", "MarketClosed"]);
      if (r.ok) sent++;
    } else if (pnl >= (p.collateral * maxProfitBps) / 10_000n) {
      const r = await exec(ctx, logger("liquidations", `#${id}`), perps, "closeAtCap", [id], "close at the profit cap", ["BelowCap", "MarketClosed"]);
      if (r.ok) capped++;
    }
  }
  log.info("positions checked", { open: ids.length, liquidated: sent, closedAtCap: capped });
}

/** Mirrors each Stock Token's `oraclePaused` flag into the PauseLog used by Perps and Swap. */
async function notePoolPauses(ctx) {
  if (!ctx.dep.pauseLog) return;
  const pauseLog = new ethers.Contract(ctx.dep.pauseLog, abis.PauseLog, ctx.runner);
  for (const ticker of ctx.dep.perpsMarkets || []) {
    const token = ctx.dep.markets[ticker].token;
    const [flagged, windows] = await Promise.all([pauseLog.flagged(token), pauseLog.windows(token)]);
    const open = windows.length > 0 && windows[windows.length - 1].end === 0n;
    if (flagged && !open) await exec(ctx, logger("pauselog", ticker), pauseLog, "notePause", [token], "notePause");
    else if (!flagged && open) await exec(ctx, logger("pauselog", ticker), pauseLog, "noteResume", [token], "noteResume");
  }
}

/**
 * Keeps each Swap market's Stock Token inventory near `targetPct` of its cap: buys when it falls under `lowPct`,
 * sells down when it rises over `highPct`. Only while the market has a fresh price.
 */
async function runInventory(ctx) {
  const cfg = ctx.cfg.inventory;
  if (!ctx.dep.pool || !cfg.enabled) return;
  const pool = new ethers.Contract(ctx.dep.pool, abis.Pool, ctx.runner);
  const oracle = new ethers.Contract(ctx.dep.oracle, abis.Oracle, ctx.provider);
  const minTrade = ethers.parseUnits(cfg.minTradeUsdg, 6);
  for (const ticker of ctx.dep.swapMarkets || []) {
    const token = ctx.dep.markets[ticker].token;
    const log = logger("inventory", ticker);
    if (!(await oracle.isFresh(token))) {
      log.debug("no fresh price; skipping");
      continue;
    }
    const [held, cap, cash] = await Promise.all([pool.inventory(token), pool.inventoryCap(token), pool.freeCash()]);
    if (cap === 0n) continue;
    const value = held === 0n ? 0n : await oracle.usdgValue(token, held);
    const target = (cap * BigInt(cfg.targetPct)) / 100n;
    if (value * 100n < cap * BigInt(cfg.lowPct)) {
      let spend = target - value;
      const spare = (cash * BigInt(cfg.maxCashPct)) / 100n;
      if (spend > spare) spend = spare;
      if (spend < minTrade) continue;
      const route = buildRoute(ctx, ctx.cfg.rebalance.routes[ticker] || "default", ctx.dep.usdg, token).route;
      await exec(ctx, log, pool, "restock", [token, spend, 0, route], `restock ${ethers.formatUnits(spend, 6)} USDG`);
    } else if (value * 100n > cap * BigInt(cfg.highPct)) {
      const sellValue = value - target;
      if (sellValue < minTrade) continue;
      const amount = await oracle.fromUsdgValue(token, sellValue);
      const route = buildRoute(ctx, ctx.cfg.rebalance.routes[ticker] || "default", token, ctx.dep.usdg).route;
      await exec(ctx, log, pool, "destock", [token, amount, 0, route], `destock ${ethers.formatUnits(sellValue, 6)} USDG worth`);
    }
  }
}

module.exports = { runOrders, runLiquidations, notePoolPauses, runInventory };
