const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { marketsFixture, fill, refresh, Status, HOUR, USDG, EQ, FEED, time } = require("./markets.fixtures");

async function stocked() {
  const ctx = await marketsFixture();
  await ctx.pool.connect(ctx.keeper).restock(ctx.tsla.stock, USDG(40_000), 0, "0x");
  await ctx.tsla.stock.mint(ctx.bob, EQ(1_000));
  await ctx.tsla.stock.connect(ctx.bob).approve(ctx.market, ethers.MaxUint256);
  return ctx;
}

async function place(ctx, user, sell, amountIn, minOut = 0n, stock = ctx.tsla.stock) {
  const id = await ctx.market.orderCount();
  await ctx.market.connect(user).placeOrder(stock, sell, amountIn, minOut);
  return id;
}

describe("VestexSwap", function () {
  it("sells the Pool's Stock Tokens at the next Chainlink price less the fee", async function () {
    const ctx = await loadFixture(stocked);
    const { market, pool, usdg, alice, feeRouter, tsla } = ctx;
    const id = await place(ctx, alice, false, USDG(4_000));
    const poolUsdg = await usdg.balanceOf(pool);
    await expect(fill(market, id, tsla.feed, 400)).to.emit(market, "Filled");
    // 0.3% fee on 4,000 is 12: 3.6 to the protocol, 8.4 stays with LPs.
    expect(await tsla.stock.balanceOf(alice)).to.equal(EQ("9.97"));
    expect(await usdg.balanceOf(feeRouter)).to.equal(USDG("3.6"));
    expect((await usdg.balanceOf(pool)) - poolUsdg).to.equal(USDG("3996.4"));
    expect(await pool.inventory(tsla.stock)).to.equal(EQ(100) - EQ("9.97"));
  });

  it("buys Stock Tokens into the Pool for USDG", async function () {
    const ctx = await loadFixture(stocked);
    const { market, pool, usdg, bob, feeRouter, tsla } = ctx;
    const id = await place(ctx, bob, true, EQ(10));
    const before = await usdg.balanceOf(bob);
    await fill(market, id, tsla.feed, 400);
    expect((await usdg.balanceOf(bob)) - before).to.equal(USDG(3_988));
    expect(await usdg.balanceOf(feeRouter)).to.equal(USDG("3.6"));
    expect(await pool.inventory(tsla.stock)).to.equal(EQ(110));
  });

  it("sets the Pool's side aside when the order is placed, and refunds below the minimum", async function () {
    const ctx = await loadFixture(stocked);
    const { market, pool, admin, usdg, alice, bob, tsla } = ctx;
    // 100 TSLA in the Pool: a 48,000 USDG buy could need more than that at the worst fillable price.
    await expect(place(ctx, alice, false, USDG(48_000))).to.be.revertedWithCustomError(market, "PoolLimit");
    const id = await place(ctx, alice, false, USDG(20_000));
    // 20,000 at up to 21% under the price is about 63 TSLA set aside, so a second order cannot use them.
    expect(await pool.inventory(tsla.stock)).to.be.lt(EQ(40));
    await expect(place(ctx, bob, false, USDG(20_000))).to.be.revertedWithCustomError(market, "PoolLimit");
    await fill(market, id, tsla.feed, 400);
    expect(await pool.reserved(tsla.stock)).to.equal(0);

    const aliceBefore = await usdg.balanceOf(alice);
    const low = await place(ctx, alice, false, USDG(400), EQ(1));
    await expect(fill(market, low, tsla.feed, 400)).to.emit(market, "OrderRefunded").withArgs(low, "below minimum");
    expect(aliceBefore - (await usdg.balanceOf(alice))).to.equal(USDG("1.2"));

    await pool.connect(admin).listToken(tsla.stock, USDG(42_000));
    await expect(place(ctx, bob, true, EQ(50))).to.be.revertedWithCustomError(market, "PoolLimit");
  });

  it("only fills at a round reported after the order", async function () {
    const ctx = await loadFixture(stocked);
    const { market, alice, tsla } = ctx;
    const id = await place(ctx, alice, false, USDG(400));
    await expect(market.execute(id)).to.be.revertedWithCustomError(market, "NoPriceYet");
    await time.increase(HOUR + 1);
    await expect(market.expire(id)).to.emit(market, "OrderRefunded").withArgs(id, "no price in time");
    expect((await market.getOrder(id)).status).to.equal(Status.Refunded);
  });

  it("rejects orders over the market limit, on stale prices and during corporate actions", async function () {
    const ctx = await loadFixture(stocked);
    const { market, alice, tsla } = ctx;
    await expect(place(ctx, alice, false, USDG(50_001))).to.be.revertedWithCustomError(market, "BadTerms");
    await expect(place(ctx, alice, false, 0n)).to.be.revertedWithCustomError(market, "BadTerms");
    await tsla.stock.setOraclePaused(true);
    await expect(place(ctx, alice, false, USDG(100))).to.be.revertedWithCustomError(market, "CorporateAction");
    await tsla.stock.setOraclePaused(false);
    await time.increase(HOUR + 1);
    await expect(place(ctx, alice, false, USDG(100))).to.be.revertedWithCustomError(market, "MarketClosed");
  });

  it("refunds pending orders once paused, and limits settings to their roles", async function () {
    const ctx = await loadFixture(stocked);
    const { market, guardian, admin, alice, tsla } = ctx;
    const id = await place(ctx, alice, false, USDG(400));
    await market.connect(guardian).pause();
    await expect(fill(market, id, tsla.feed, 400)).to.emit(market, "OrderRefunded").withArgs(id, "market closed");
    await expect(market.connect(guardian).unpause()).to.be.reverted;
    await expect(market.connect(alice).setParams(30, 3000, 3600, 2000)).to.be.reverted;
    await expect(market.connect(admin).setParams(101, 3000, 3600, 2000)).to.be.revertedWithCustomError(market, "InvalidConfig");
    await market.connect(admin).unpause();
    await refresh(ctx);
    await place(ctx, alice, false, USDG(400));
  });
});
