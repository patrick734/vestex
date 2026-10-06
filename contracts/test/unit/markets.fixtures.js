const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { baseFixture, USDG, EQ, FEED, rate } = require("./fixtures");

const HOUR = 3600;
const DAY = 86400;
const Kind = { OpenLong: 0n, OpenShort: 1n, Close: 2n };
const Status = { None: 0n, Pending: 1n, Filled: 2n, Refunded: 3n };

async function listStock(ctx, ticker, price) {
  const stock = await ethers.deployContract("MockStockToken", [`${ticker} Stock Token`, ticker]);
  const feed = await ethers.deployContract("MockAggregator", [8, FEED(price)]);
  await ctx.oracle.connect(ctx.admin).setFeed(stock, feed, HOUR);
  await ctx.swap.setRate(stock, ctx.usdg, rate(price, 18, 6));
  await ctx.swap.setRate(ctx.usdg, stock, rate(1 / price, 6, 18));
  await stock.mint(ctx.swap, EQ(1_000_000));
  return { stock, feed };
}

async function marketsFixture() {
  const ctx = await baseFixture();
  const { admin, guardian, keeper, usdg, oracle, swap, feeRouter } = ctx;

  const tsla = await listStock(ctx, "TSLA", 400);
  const nvda = await listStock(ctx, "NVDA", 200);
  // The AMD feed from the base fixture would otherwise go stale and close the Pool to LPs.
  await ctx.amd.feed.setAnswer(FEED(150));

  const pauseLog = await ethers.deployContract("VestexPauseLog");
  const pool = await ethers.deployContract("VestexPool", [usdg, oracle, swap, admin.address, guardian.address, keeper.address, USDG(10_000_000)]);
  const perps = await ethers.deployContract("VestexPerps", [usdg, pool, oracle, pauseLog, feeRouter, admin.address, guardian.address, USDG(10)]);
  const market = await ethers.deployContract("VestexSwap", [usdg, pool, oracle, pauseLog, feeRouter, admin.address, guardian.address]);

  const MARKET = await pool.MARKET_ROLE();
  await pool.connect(admin).grantRole(MARKET, perps);
  await pool.connect(admin).grantRole(MARKET, market);
  await pool.connect(admin).setBook(perps);
  await pool.connect(admin).setMaxDailyTurnover(USDG(10_000_000));
  for (const m of [tsla, nvda]) {
    await pool.connect(admin).listToken(m.stock, USDG(200_000));
    await perps.connect(admin).setMarket(m.stock, true, 10, USDG(500_000), ethers.parseUnits("0.1", 18));
    await market.connect(admin).setMarket(m.stock, true, USDG(50_000));
  }

  const [, , , alice, bob, carol, dave] = await ethers.getSigners();
  await usdg.mint(dave, USDG(1_000_000));
  for (const u of [alice, bob, carol, dave]) {
    await usdg.connect(u).approve(pool, ethers.MaxUint256);
    await usdg.connect(u).approve(perps, ethers.MaxUint256);
    await usdg.connect(u).approve(market, ethers.MaxUint256);
  }
  // Dave is the LP.
  await pool.connect(dave).deposit(USDG(500_000), dave.address);

  return { ...ctx, tsla, nvda, pauseLog, pool, perps, market, dave };
}

/** Reports a new Chainlink round and fills the order at it. */
async function fill(target, id, feed, price) {
  await feed.setAnswer(FEED(price));
  return target.execute(id);
}

/** Keeps every feed fresh, as live Chainlink feeds are during market hours. */
async function refresh(ctx, prices = {}) {
  const p = { tsla: 400, nvda: 200, amd: 150, ...prices };
  await ctx.tsla.feed.setAnswer(FEED(p.tsla));
  await ctx.nvda.feed.setAnswer(FEED(p.nvda));
  await ctx.amd.feed.setAnswer(FEED(p.amd));
  await ctx.usdgFeed.setAnswer(FEED(1));
}

async function openPos(ctx, user, o = {}) {
  const a = { stock: ctx.tsla.stock, isLong: true, collateral: USDG(1_000), notional: USDG(5_000), limit: o.isLong === false ? 1n : USDG(1_000_000), ...o };
  const id = await ctx.perps.orderCount();
  await ctx.perps.connect(user).openPosition(a.stock, a.isLong, a.collateral, a.notional, a.limit);
  return id;
}

module.exports = { marketsFixture, fill, refresh, openPos, Kind, Status, HOUR, DAY, USDG, EQ, FEED, time };
