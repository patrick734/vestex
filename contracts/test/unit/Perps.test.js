const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { marketsFixture, fill, refresh, openPos, Kind, Status, HOUR, DAY, USDG, EQ, FEED, time } = require("./markets.fixtures");

const YEAR = 365n * 86400n;

async function openedLong(ctx, o = {}) {
  const id = await openPos(ctx, ctx.alice, o);
  await fill(ctx.perps, id, ctx.tsla.feed, o.fillAt ?? 400);
  return (await ctx.perps.getOrder(id)).positionId;
}

describe("VestexPerps", function () {
  describe("orders", function () {
    it("escrows collateral and fee, then fills at the next Chainlink round and splits the fee", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, pool, usdg, alice, feeRouter, tsla } = ctx;
      const before = await usdg.balanceOf(alice);
      const id = await openPos(ctx, alice);
      expect(before - (await usdg.balanceOf(alice))).to.equal(USDG(1_005));
      expect((await perps.getOrder(id)).status).to.equal(Status.Pending);

      const poolBefore = await usdg.balanceOf(pool);
      await expect(fill(perps, id, tsla.feed, 400)).to.emit(perps, "Opened");
      const o = await perps.getOrder(id);
      const p = await perps.getPosition(o.positionId);
      expect(o.status).to.equal(Status.Filled);
      expect(p.size).to.equal(EQ("12.5"));
      expect(p.entryPrice).to.equal(USDG(400));
      expect(p.collateral).to.equal(USDG(1_000));
      expect(await usdg.balanceOf(feeRouter)).to.equal(USDG("1.5"));
      expect((await usdg.balanceOf(pool)) - poolBefore).to.equal(USDG("3.5"));
      expect(await perps.totalNotional()).to.equal(USDG(5_000));
      expect(await perps.openInterest(tsla.stock)).to.equal(USDG(5_000));
      expect(await perps.openPositionIds()).to.deep.equal([0n]);
    });

    it("never fills at a price that was already known when the order went in", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, alice, tsla } = ctx;
      // The feed lags: it still says 400 while the market is at 440. Nothing fills until a new round arrives.
      const id = await openPos(ctx, alice);
      await expect(perps.execute(id)).to.be.revertedWithCustomError(perps, "NoPriceYet");
      // The fill is always the next round, however many come after it.
      await tsla.feed.setAnswer(FEED(440));
      await tsla.feed.setAnswer(FEED(380));
      await perps.execute(id);
      expect((await perps.getPosition(0)).entryPrice).to.equal(USDG(440));
    });

    it("refunds at the limit, on a price jump, and after a recorded corporate action", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, pauseLog, usdg, alice, tsla } = ctx;
      const start = await usdg.balanceOf(alice);

      const limited = await openPos(ctx, alice, { limit: USDG(410) });
      await expect(fill(perps, limited, tsla.feed, 411)).to.emit(perps, "OrderRefunded").withArgs(limited, "limit");
      // The trader's own limit keeps the 5 USDG fee; everything else below is refunded in full.

      const jumped = await openPos(ctx, alice);
      await expect(fill(perps, jumped, tsla.feed, 800)).to.emit(perps, "OrderRefunded").withArgs(jumped, "price jump");
      await tsla.feed.setAnswer(FEED(400));

      const split = await openPos(ctx, alice);
      await tsla.stock.setOraclePaused(true);
      await pauseLog.notePause(tsla.stock);
      await tsla.feed.setAnswer(FEED(400));
      await expect(perps.execute(split)).to.be.revertedWithCustomError(perps, "CorporateAction");
      await tsla.stock.setOraclePaused(false);
      await pauseLog.noteResume(tsla.stock);
      await expect(perps.execute(split)).to.emit(perps, "OrderRefunded").withArgs(split, "corporate action");

      expect(start - (await usdg.balanceOf(alice))).to.equal(USDG(5));
      expect((await perps.getOrder(split)).status).to.equal(Status.Refunded);
      await expect(perps.execute(split)).to.be.revertedWithCustomError(perps, "NotPending");
    });

    it("refunds when no price arrives within the window, and only then", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, usdg, alice, bob, tsla } = ctx;
      const id = await openPos(ctx, alice);
      await expect(perps.expire(id)).to.be.revertedWithCustomError(perps, "NoPriceYet");
      await time.increase(HOUR + 1);
      const before = await usdg.balanceOf(alice);
      await expect(perps.connect(bob).expire(id)).to.emit(perps, "OrderRefunded").withArgs(id, "no price in time");
      expect((await usdg.balanceOf(alice)) - before).to.equal(USDG(1_005));

      // A round inside the window must be used: expire refuses and execute fills.
      await refresh(ctx);
      const second = await openPos(ctx, alice);
      await tsla.feed.setAnswer(FEED(401));
      await time.increase(HOUR + 1);
      await tsla.feed.setAnswer(FEED(500));
      await expect(perps.expire(second)).to.be.revertedWithCustomError(perps, "NoPriceYet");
      await perps.execute(second);
      expect((await perps.getOrder(second)).status).to.equal(Status.Filled);

      // The first round after the window refunds.
      await refresh(ctx);
      const third = await openPos(ctx, alice);
      await time.increase(HOUR + 1);
      await expect(fill(perps, third, tsla.feed, 400)).to.emit(perps, "OrderRefunded").withArgs(third, "no price in time");
    });

    it("rejects bad terms, stale markets and corporate actions up front", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, alice, tsla, usdg } = ctx;
      await expect(openPos(ctx, alice, { notional: USDG(10_001) })).to.be.revertedWithCustomError(perps, "BadTerms");
      await expect(openPos(ctx, alice, { collateral: USDG(9), notional: USDG(20) })).to.be.revertedWithCustomError(perps, "BadTerms");
      await expect(openPos(ctx, alice, { notional: USDG(999) })).to.be.revertedWithCustomError(perps, "BadTerms");
      await expect(openPos(ctx, alice, { limit: 0n })).to.be.revertedWithCustomError(perps, "BadTerms");
      await expect(openPos(ctx, alice, { stock: usdg })).to.be.revertedWithCustomError(perps, "UnknownMarket");
      await tsla.stock.setOraclePaused(true);
      await expect(openPos(ctx, alice)).to.be.revertedWithCustomError(perps, "CorporateAction");
      await tsla.stock.setOraclePaused(false);
      await time.increase(HOUR + 1);
      await expect(openPos(ctx, alice)).to.be.revertedWithCustomError(perps, "MarketClosed");
    });

    it("sets open interest and Pool capacity aside when an order is placed", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, admin, alice, bob, tsla } = ctx;
      await perps.connect(admin).setMarket(tsla.stock, true, 10, USDG(6_000), ethers.parseUnits("0.1", 18));
      const first = await openPos(ctx, alice);
      // Still pending, but its 5,000 counts: another 1,001 does not fit under 6,000.
      await expect(openPos(ctx, bob, { notional: USDG(1_001) })).to.be.revertedWithCustomError(perps, "OverCapacity");
      expect(await perps.reservedNotional()).to.equal(USDG(5_000));
      expect(await perps.totalNotional()).to.equal(USDG(5_000));
      // A refund gives the room back.
      await fill(perps, first, tsla.feed, 900);
      expect(await perps.reservedNotional()).to.equal(0);
      await refresh(ctx);
      await openPos(ctx, bob, { notional: USDG(5_000) });
      await perps.connect(admin).setMarket(tsla.stock, true, 10, USDG(10_000_000), ethers.parseUnits("0.1", 18));
      // Pool value about 500k at 50% utilization: 250k of notional at most, pending orders included.
      await expect(openPos(ctx, alice, { collateral: USDG(25_000), notional: USDG(246_000) })).to.be.revertedWithCustomError(perps, "OverCapacity");
      await openPos(ctx, alice, { collateral: USDG(24_000), notional: USDG(240_000) });
    });

    it("decides a fill on its price alone: a delay cannot be used to pick a side", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, alice, tsla } = ctx;
      const long = await openPos(ctx, alice, { collateral: USDG(10_000), notional: USDG(100_000) });
      const short = await openPos(ctx, alice, { isLong: false, collateral: USDG(10_000), notional: USDG(100_000) });
      await tsla.feed.setAnswer(FEED(400));
      await refresh(ctx, { tsla: 440 });
      await perps.execute(long);
      await perps.execute(short);
      expect((await perps.getPosition(0)).entryPrice).to.equal(USDG(400));
      expect((await perps.getPosition(1)).entryPrice).to.equal(USDG(400));
    });
  });

  describe("closing", function () {
    it("pays profit from the Pool, less the borrow fee and the close fee", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, pool, usdg, alice, feeRouter, tsla } = ctx;
      const pid = await openedLong(ctx);
      const openedAt = (await perps.getPosition(pid)).openedAt;
      await time.increase(10 * DAY);
      await refresh(ctx, { tsla: 440 });
      // Unrealized: 12.5 * 40 = 500 owed to the trader, less the LPs' share of accrued borrow.
      expect(await perps.netOwedToTraders()).to.be.closeTo(USDG(500) - USDG("9.6"), USDG("0.1"));

      const id = await perps.orderCount();
      await perps.connect(alice).closePosition(pid, USDG(430));
      const before = await usdg.balanceOf(alice);
      const routerBefore = await usdg.balanceOf(feeRouter);
      const tx = await fill(perps, id, tsla.feed, 440);
      const at = BigInt((await ethers.provider.getBlock(tx.blockNumber)).timestamp);

      const borrow = (USDG(5_000) * (10n ** 17n * (at - BigInt(openedAt)) / YEAR)) / 10n ** 18n;
      const closeFee = USDG("5.5");
      const payout = USDG(1_500) - borrow - closeFee;
      expect((await usdg.balanceOf(alice)) - before).to.be.closeTo(payout, 2n);
      expect((await usdg.balanceOf(feeRouter)) - routerBefore).to.be.closeTo(((borrow + closeFee) * 3000n) / 10000n, 2n);
      const p = await perps.getPosition(pid);
      expect(p.open).to.equal(false);
      expect(await perps.totalNotional()).to.equal(0);
      expect(await perps.netOwedToTraders()).to.equal(0);
      expect(await perps.openPositionIds()).to.deep.equal([]);
      expect(await pool.totalOwed(usdg)).to.equal(0);
    });

    it("takes a short's loss into the Pool and caps profit at maxProfitBps", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, pool, usdg, alice, bob, tsla } = ctx;
      const sid = await openPos(ctx, bob, { isLong: false });
      await fill(perps, sid, tsla.feed, 400);
      const short = (await perps.getOrder(sid)).positionId;

      const assetsBefore = await pool.totalAssets();
      const cid = await perps.orderCount();
      await perps.connect(bob).closePosition(short, USDG(1_000));
      const before = await usdg.balanceOf(bob);
      await fill(perps, cid, tsla.feed, 420);
      // Loss 12.5 * 20 = 250, close fee 5.25, borrow a few cents.
      const got = (await usdg.balanceOf(bob)) - before;
      expect(got).to.be.closeTo(USDG(1_000) - USDG(250) - USDG("5.25"), USDG("0.05"));
      expect(await pool.totalAssets()).to.be.gt(assetsBefore);

      // A 10x long that doubles is capped at 9x its collateral.
      await refresh(ctx);
      const lid = await openPos(ctx, alice, { collateral: USDG(1_000), notional: USDG(10_000) });
      await fill(perps, lid, tsla.feed, 400);
      const long = (await perps.getOrder(lid)).positionId;
      await refresh(ctx, { tsla: 480 });
      await refresh(ctx, { tsla: 560 });
      await refresh(ctx, { tsla: 640 });
      await refresh(ctx, { tsla: 700 });
      await refresh(ctx, { tsla: 800 });
      const [pnl] = await perps.preview(long, USDG(800));
      expect(pnl).to.equal(USDG(9_000));
    });

    it("lets a trader add collateral and keeps one close pending at a time", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, alice, bob } = ctx;
      const pid = await openedLong(ctx);
      await expect(perps.connect(bob).addCollateral(pid, USDG(1))).to.be.revertedWithCustomError(perps, "NotOwner");
      await perps.connect(alice).addCollateral(pid, USDG(500));
      expect((await perps.getPosition(pid)).collateral).to.equal(USDG(1_500));
      await expect(perps.connect(bob).closePosition(pid, 1)).to.be.revertedWithCustomError(perps, "NotOwner");
      await perps.connect(alice).closePosition(pid, 1);
      await expect(perps.connect(alice).closePosition(pid, 1)).to.be.revertedWithCustomError(perps, "CloseAlreadyPending");
    });

    it("refunds a close at its limit and lets the trader try again", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, alice, tsla } = ctx;
      const pid = await openedLong(ctx);
      const id = await perps.orderCount();
      await perps.connect(alice).closePosition(pid, USDG(420));
      await expect(fill(perps, id, tsla.feed, 410)).to.emit(perps, "OrderRefunded").withArgs(id, "limit");
      expect((await perps.getPosition(pid)).open).to.equal(true);
      const again = await perps.orderCount();
      await perps.connect(alice).closePosition(pid, USDG(400));
      await fill(perps, again, tsla.feed, 410);
      expect((await perps.getPosition(pid)).open).to.equal(false);
    });

    it("keeps closes, fills of closes and collateral top-ups working while paused, and refunds pending opens", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, guardian, admin, alice, tsla } = ctx;
      const pid = await openedLong(ctx);
      const pending = await openPos(ctx, alice);
      await perps.connect(guardian).pause();
      await expect(openPos(ctx, alice)).to.be.revertedWithCustomError(perps, "EnforcedPause");
      await expect(fill(perps, pending, tsla.feed, 400)).to.emit(perps, "OrderRefunded").withArgs(pending, "market closed");
      await perps.connect(alice).addCollateral(pid, USDG(1));
      const id = await perps.orderCount();
      await perps.connect(alice).closePosition(pid, 1);
      await fill(perps, id, tsla.feed, 400);
      expect((await perps.getPosition(pid)).open).to.equal(false);
      await expect(perps.connect(guardian).unpause()).to.be.reverted;
      await perps.connect(admin).unpause();
    });
  });

  describe("liquidation", function () {
    it("liquidates at 80% loss, pays the liquidator 5% of collateral and returns the rest to the trader", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, usdg, alice, carol, tsla } = ctx;
      const pid = await openedLong(ctx, { collateral: USDG(1_000), notional: USDG(10_000) });
      const pending = await perps.orderCount();
      await perps.connect(alice).closePosition(pid, USDG(1));

      await refresh(ctx, { tsla: 372 });
      await expect(perps.connect(carol).liquidate(pid)).to.be.revertedWithCustomError(perps, "Healthy");

      // 25 tokens: at 368 the loss is 800 and fees push equity just under 20% of collateral.
      await refresh(ctx, { tsla: 368 });
      const aliceBefore = await usdg.balanceOf(alice);
      const carolBefore = await usdg.balanceOf(carol);
      await expect(perps.connect(carol).liquidate(pid)).to.emit(perps, "Liquidated");
      const reward = (await usdg.balanceOf(carol)) - carolBefore;
      const rest = (await usdg.balanceOf(alice)) - aliceBefore;
      expect(reward).to.equal(USDG(50));
      // Equity 1000 - 800 - 9.2 close fee - a cent of borrow, less the reward.
      expect(rest).to.be.closeTo(USDG(1_000) - USDG(800) - USDG("9.2") - USDG(50), USDG("0.05"));
      expect((await perps.getOrder(pending)).status).to.equal(Status.Refunded);
      await expect(perps.connect(carol).liquidate(pid)).to.be.revertedWithCustomError(perps, "PositionClosed");
    });

    it("absorbs a position that is underwater beyond its collateral", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, pool, usdg, alice, carol, feeRouter } = ctx;
      const pid = await openedLong(ctx, { collateral: USDG(1_000), notional: USDG(10_000) });
      await refresh(ctx, { tsla: 340 });
      const assetsBefore = await pool.totalAssets();
      const aliceBefore = await usdg.balanceOf(alice);
      const routerBefore = await usdg.balanceOf(feeRouter);
      await perps.connect(carol).liquidate(pid);
      expect(await usdg.balanceOf(alice)).to.equal(aliceBefore);
      expect(await usdg.balanceOf(feeRouter)).to.equal(routerBefore);
      // The Pool had valued the full 1,500 loss; liquidating collects only the 1,000 of collateral, and still pays
      // the liquidator 50 so that underwater positions get closed too.
      expect(assetsBefore - (await pool.totalAssets())).to.be.closeTo(USDG(550), USDG("0.1"));
    });

    it("cannot liquidate on a stale price or during a corporate action", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, carol, tsla } = ctx;
      const pid = await openedLong(ctx, { collateral: USDG(1_000), notional: USDG(10_000) });
      await refresh(ctx, { tsla: 300 });
      await tsla.stock.setOraclePaused(true);
      await expect(perps.connect(carol).liquidate(pid)).to.be.revertedWithCustomError(perps, "MarketClosed");
      await tsla.stock.setOraclePaused(false);
      await time.increase(26 * HOUR + 1);
      await expect(perps.connect(carol).liquidate(pid)).to.be.revertedWithCustomError(perps, "MarketClosed");
    });
  });

  describe("closing at the cap", function () {
    it("lets anyone close a position whose profit reached the cap, and only then", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, usdg, alice, carol } = ctx;
      const pid = await openedLong(ctx, { collateral: USDG(1_000), notional: USDG(10_000) });
      await refresh(ctx, { tsla: 700 });
      await expect(perps.connect(carol).closeAtCap(pid)).to.be.revertedWithCustomError(perps, "BelowCap");
      await refresh(ctx, { tsla: 760 });
      const before = await usdg.balanceOf(alice);
      await expect(perps.connect(carol).closeAtCap(pid)).to.emit(perps, "ClosedAtCap");
      // Capped profit 9,000 plus 1,000 margin, less the close fee on 19,000 of value and a little borrow.
      expect((await usdg.balanceOf(alice)) - before).to.be.closeTo(USDG(10_000) - USDG(19), USDG("0.05"));
      expect((await perps.getPosition(pid)).open).to.equal(false);
    });
  });

  describe("feed phases", function () {
    it("refunds an order whose feed moved to a new phase before its next round", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, usdg, alice, tsla } = ctx;
      const before = await usdg.balanceOf(alice);
      const id = await openPos(ctx, alice);
      await tsla.feed.newPhase(FEED(402));
      await expect(perps.execute(id)).to.be.revertedWithCustomError(perps, "NoPriceYet");
      await time.increase(HOUR + 1);
      await perps.expire(id);
      expect(await usdg.balanceOf(alice)).to.equal(before);
      // Orders placed after the change fill on the new phase.
      await refresh(ctx);
      const next = await openPos(ctx, alice);
      await fill(perps, next, tsla.feed, 405);
      expect((await perps.getPosition(0)).entryPrice).to.equal(USDG(405));
    });
  });

  describe("governance", function () {
    it("limits settings to the admin and within bounds, and copies a market's feed once", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, admin, alice, oracle, tsla } = ctx;
      await expect(perps.connect(alice).setParams(10, 3000, 8000, 500, 90_000)).to.be.reverted;
      await expect(perps.connect(admin).setParams(51, 3000, 8000, 500, 90_000)).to.be.revertedWithCustomError(perps, "InvalidConfig");
      await expect(perps.connect(admin).setParams(10, 3000, 8000, 2001, 90_000)).to.be.revertedWithCustomError(perps, "InvalidConfig");
      await expect(perps.connect(admin).setMarket(tsla.stock, true, 11, 1, 0)).to.be.revertedWithCustomError(perps, "InvalidConfig");
      await expect(perps.connect(admin).setOrderParams(60, 2000, 0)).to.be.revertedWithCustomError(perps, "InvalidConfig");

      const feedBefore = (await perps.market(tsla.stock)).feed;
      const other = await ethers.deployContract("MockAggregator", [8, FEED(1)]);
      await oracle.connect(admin).setFeed(tsla.stock, other, HOUR);
      await perps.connect(admin).setMarket(tsla.stock, true, 5, USDG(1), 0);
      expect((await perps.market(tsla.stock)).feed).to.equal(feedBefore);
    });
  });
});
