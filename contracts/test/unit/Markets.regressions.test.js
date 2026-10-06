// Regression tests for issues found in review: pending orders cannot be used to hold the Pool hostage, the time of a
// fill call cannot decide its outcome, a refund the token refuses cannot lock anything, and a broken feed is never
// mistaken for dust.
const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { marketsFixture, fill, refresh, openPos, HOUR, DAY, USDG, EQ, FEED, time } = require("./markets.fixtures");

describe("VestexPerps and VestexPool: review regressions", function () {
  it("a never-filling order costs its fee each time and never holds LPs in", async function () {
    const ctx = await loadFixture(marketsFixture);
    const { pool, perps, usdg, alice, dave, tsla } = ctx;
    await time.increase(DAY);
    await refresh(ctx);
    const cap = await pool.capacity();
    const before = await usdg.balanceOf(alice);
    const notional = cap - (await perps.totalNotional());
    const id = await openPos(ctx, alice, { collateral: notional / 10n + 1n, notional, limit: 1n });
    expect(await pool.maxWithdraw(dave)).to.be.gt(USDG(400_000));
    await expect(fill(perps, id, tsla.feed, 400)).to.emit(perps, "OrderRefunded").withArgs(id, "limit");
    expect(before - (await usdg.balanceOf(alice))).to.equal(notional / 1000n);
  });

  it("fills at the same price whenever it is called, even through a sequencer restart", async function () {
    const ctx = await loadFixture(marketsFixture);
    const { perps, sequencer, alice, tsla } = ctx;
    const a = await openPos(ctx, alice);
    const b = await openPos(ctx, alice);
    const now = await time.latest();
    await sequencer.set(1, now, now);
    await sequencer.set(0, now + 1, now + 1);
    await tsla.feed.setAnswer(FEED(420));
    await expect(perps.execute(a)).to.emit(perps, "Opened");
    await time.increase(HOUR + 60);
    await refresh(ctx, { tsla: 380 });
    await expect(perps.execute(b)).to.emit(perps, "Opened");
    expect((await perps.getPosition(0)).entryPrice).to.equal((await perps.getPosition(1)).entryPrice);
  });

  it("holds a refund the token refuses for its owner and frees the reservation", async function () {
    const ctx = await loadFixture(marketsFixture);
    const { perps, usdg, alice, tsla } = ctx;
    const id = await openPos(ctx, alice, { collateral: USDG(10_000), notional: USDG(100_000), limit: USDG(390) });
    await usdg.setBlocked(alice, true);
    await tsla.feed.setAnswer(FEED(400));
    await perps.execute(id);
    expect(await perps.reservedNotional()).to.equal(0);
    expect(await perps.refundOwed(alice)).to.equal(USDG(10_000));
    await usdg.setBlocked(alice, false);
    await perps.connect(alice).claimRefund();
    await expect(perps.connect(alice).claimRefund()).to.be.revertedWithCustomError(perps, "NothingOwed");
  });

  it("treats a balance the oracle cannot value as exposure, closing the Pool to LPs", async function () {
    const ctx = await loadFixture(marketsFixture);
    const { pool, keeper, nvda, usdgFeed } = ctx;
    await pool.connect(keeper).restock(nvda.stock, USDG(100_000), 0, "0x");
    await usdgFeed.setAnswer(0);
    expect(await pool.marketsOpen()).to.equal(false);
  });

  it("keeps the swap fee on an order stopped by its own minimum", async function () {
    const ctx = await loadFixture(marketsFixture);
    const { pool, market, keeper, usdg, alice, tsla } = ctx;
    await pool.connect(keeper).restock(tsla.stock, USDG(4_000), 0, "0x");
    const before = await usdg.balanceOf(alice);
    const id = await market.orderCount();
    await market.connect(alice).placeOrder(tsla.stock, false, USDG(400), EQ(5));
    await expect(fill(market, id, tsla.feed, 400)).to.emit(market, "OrderRefunded").withArgs(id, "below minimum");
    expect(before - (await usdg.balanceOf(alice))).to.equal(USDG("1.2"));
  });

  it("limits pending opens per account and lets an order nobody could fill be refunded after a week", async function () {
    const ctx = await loadFixture(marketsFixture);
    const { perps, usdg, usdgFeed, alice, tsla } = ctx;
    for (let i = 0; i < 3; i++) await openPos(ctx, alice);
    await expect(openPos(ctx, alice)).to.be.revertedWithCustomError(perps, "BadTerms");
    // The USDG feed stops answering: fills wait instead of refunding, but not forever.
    await usdgFeed.setAnswer(0);
    await tsla.feed.setAnswer(FEED(400));
    await expect(perps.execute(0)).to.be.revertedWithCustomError(perps, "MarketClosed");
    await time.increase(HOUR + 1);
    await expect(perps.expire(0)).to.be.revertedWithCustomError(perps, "NoPriceYet");
    await time.increase(7 * DAY);
    const before = await usdg.balanceOf(alice);
    await perps.expire(0);
    expect((await usdg.balanceOf(alice)) - before).to.equal(USDG(1_005));
    expect(await perps.pendingOpens(alice)).to.equal(2);
  });
});
