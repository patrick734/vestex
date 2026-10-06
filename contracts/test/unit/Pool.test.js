const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { marketsFixture, fill, refresh, openPos, HOUR, DAY, USDG, EQ, time } = require("./markets.fixtures");

describe("VestexPool", function () {
  describe("LP flows", function () {
    it("keeps a small fee on the way in and out, and holds shares for minHold", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { pool, usdg, alice } = ctx;
      const assetsBefore = await pool.totalAssets();
      await pool.connect(alice).deposit(USDG(10_000), alice.address);
      expect((await pool.totalAssets()) - assetsBefore).to.equal(USDG(10_000));
      const shares = await pool.balanceOf(alice);

      expect(await pool.maxWithdraw(alice)).to.equal(0);
      await expect(pool.connect(alice).redeem(shares, alice.address, alice.address)).to.be.revertedWithCustomError(pool, "ERC4626ExceededMaxRedeem");

      await time.increase(DAY);
      await refresh(ctx);
      const before = await usdg.balanceOf(alice);
      await pool.connect(alice).redeem(shares, alice.address, alice.address);
      const back = (await usdg.balanceOf(alice)) - before;
      // 0.1% kept on the way in and again on the way out, part of it back through the share price.
      expect(back).to.be.closeTo(USDG(9_980), USDG(2));
      expect(back).to.be.lt(USDG(10_000));
    });

    it("refuses share transfers and deposits for someone else", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { pool, alice, bob } = ctx;
      await pool.connect(alice).deposit(USDG(1_000), alice.address);
      await expect(pool.connect(alice).transfer(bob, 1)).to.be.revertedWithCustomError(pool, "NotTransferable");
      await expect(pool.connect(alice).deposit(USDG(1_000), bob.address)).to.be.revertedWithCustomError(pool, "NotTransferable");
    });

    it("closes to LPs while a market it is exposed to has no fresh price", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { pool, alice, dave } = ctx;
      // No exposure yet: stale feeds do not matter.
      await time.increase(2 * HOUR);
      await pool.connect(alice).deposit(USDG(1_000), alice.address);

      await refresh(ctx);
      const id = await openPos(ctx, alice);
      await fill(ctx.perps, id, ctx.tsla.feed, 400);
      await time.increase(DAY);
      await expect(pool.connect(alice).deposit(USDG(1_000), alice.address)).to.be.revertedWithCustomError(pool, "MarketsClosed");
      await expect(pool.connect(dave).withdraw(USDG(1), dave.address, dave.address)).to.be.revertedWithCustomError(pool, "MarketsClosed");
      await refresh(ctx);
      await pool.connect(dave).withdraw(USDG(1), dave.address, dave.address);
    });

    it("keeps enough value in the Pool to back open positions", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { pool, perps, alice, dave } = ctx;
      const id = await openPos(ctx, alice, { collateral: USDG(20_000), notional: USDG(200_000) });
      await fill(perps, id, ctx.tsla.feed, 400);
      await time.increase(DAY);
      await refresh(ctx);
      // 200k of notional at 50% utilization needs 400k of Pool value.
      const max = await pool.maxWithdraw(dave);
      const assets = await pool.totalAssets();
      expect(max).to.be.closeTo(assets - USDG(400_000), USDG(1));
      await expect(pool.connect(dave).withdraw(max + USDG(1), dave.address, dave.address)).to.be.revertedWithCustomError(pool, "ERC4626ExceededMaxWithdraw");
      await pool.connect(dave).withdraw(max, dave.address, dave.address);
    });

    it("values traders' open profit and loss into the share price", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { pool, perps, alice } = ctx;
      const id = await openPos(ctx, alice);
      await fill(perps, id, ctx.tsla.feed, 400);
      const flat = await pool.totalAssets();
      await refresh(ctx, { tsla: 440 });
      expect(flat - (await pool.totalAssets())).to.be.closeTo(USDG(500), USDG("0.1"));
      await refresh(ctx, { tsla: 360 });
      expect((await pool.totalAssets()) - flat).to.be.closeTo(USDG(500), USDG("0.1"));
    });

    it("lets the guardian pause deposits and lower the cap, but not raise it", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { pool, guardian, admin, alice, dave } = ctx;
      await expect(pool.connect(guardian).lowerDepositCap(USDG(20_000_000))).to.be.revertedWithCustomError(pool, "InvalidConfig");
      await pool.connect(guardian).lowerDepositCap(USDG(501_000));
      await expect(pool.connect(alice).deposit(USDG(2_000), alice.address)).to.be.revertedWithCustomError(pool, "ERC4626ExceededMaxDeposit");
      await pool.connect(admin).setDepositCap(USDG(10_000_000));
      await pool.connect(guardian).pause();
      await expect(pool.connect(alice).deposit(USDG(1_000), alice.address)).to.be.revertedWithCustomError(pool, "ERC4626ExceededMaxDeposit");
      await time.increase(DAY);
      await refresh(ctx);
      await pool.connect(dave).withdraw(USDG(1_000), dave.address, dave.address);
    });
  });

  describe("payments", function () {
    it("books a payment it cannot make as owed and pays it on claim", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { pool, perps, usdg, alice } = ctx;
      const id = await openPos(ctx, alice);
      await fill(perps, id, ctx.tsla.feed, 400);
      const close = await perps.orderCount();
      await perps.connect(alice).closePosition(0, 1);
      await usdg.setBlocked(alice, true);
      await fill(perps, close, ctx.tsla.feed, 420);
      const due = await pool.owed(usdg, alice);
      expect(due).to.be.gt(USDG(1_000));
      expect(await pool.totalOwed(usdg)).to.equal(due);
      await usdg.setBlocked(alice, false);
      const before = await usdg.balanceOf(alice);
      await pool.connect(alice).claim(usdg);
      expect((await usdg.balanceOf(alice)) - before).to.equal(due);
      await expect(pool.connect(alice).claim(usdg)).to.be.revertedWithCustomError(pool, "NothingOwed");
    });

    it("only lets Perps and Swap pay out", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { pool, usdg, alice } = ctx;
      await expect(pool.connect(alice).pay(usdg, alice.address, 1)).to.be.reverted;
    });
  });

  describe("inventory", function () {
    it("caps what the keeper can turn over in a day", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { pool, keeper, admin, tsla } = ctx;
      await pool.connect(admin).setMaxDailyTurnover(USDG(5_000));
      await pool.connect(keeper).restock(tsla.stock, USDG(4_000), 0, "0x");
      await expect(pool.connect(keeper).destock(tsla.stock, EQ(5), 0, "0x")).to.be.revertedWithCustomError(pool, "OverTurnover");
      await time.increase(DAY);
      await refresh(ctx);
      await pool.connect(keeper).destock(tsla.stock, EQ(5), 0, "0x");
    });

    it("ignores dust when deciding whether LPs can come and go, and lets governance excuse a dead market", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { pool, admin, alice, dave, nvda } = ctx;
      await nvda.stock.mint(alice, 1n);
      await nvda.stock.connect(alice).transfer(pool, 1n);
      await nvda.stock.setOraclePaused(true);
      await refresh(ctx);
      await time.increase(DAY);
      await refresh(ctx);
      await pool.connect(dave).withdraw(USDG(1), dave.address, dave.address);
      await nvda.stock.mint(pool, EQ(100));
      await expect(pool.connect(dave).withdraw(USDG(1), dave.address, dave.address)).to.be.revertedWithCustomError(pool, "MarketsClosed");
      await pool.connect(admin).setGateExempt(nvda.stock, true);
      await pool.connect(dave).withdraw(USDG(1), dave.address, dave.address);
    });

    it("counts a payment it owes but cannot yet cover against its value", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { pool, perps, usdg, admin, keeper, alice, nvda, tsla } = ctx;
      await pool.connect(admin).listToken(nvda.stock, USDG(400_000));
      await pool.connect(keeper).restock(nvda.stock, USDG(400_000), 0, "0x");
      const id = await openPos(ctx, alice, { collateral: USDG(25_000), notional: USDG(240_000) });
      await fill(perps, id, tsla.feed, 400);
      for (const p of [460, 520, 580, 640, 700, 760]) await refresh(ctx, { tsla: p });
      const close = await perps.orderCount();
      await perps.connect(alice).closePosition(0, 1);
      await fill(perps, close, tsla.feed, 760);
      const held = await usdg.balanceOf(pool);
      const due = await pool.totalOwed(usdg);
      expect(due).to.be.gt(held);
      const inv = await ctx.oracle.markValue(nvda.stock, await nvda.stock.balanceOf(pool));
      expect(await pool.totalAssets()).to.be.closeTo(inv + held - due, USDG(1));
    });

    it("restocks and destocks through the swap adapter within the loss bound and the cap", async function () {
      const ctx = await loadFixture(marketsFixture);
      const { pool, keeper, alice, tsla, usdg, admin } = ctx;
      await expect(pool.connect(alice).restock(tsla.stock, USDG(4_000), 0, "0x")).to.be.reverted;
      await pool.connect(keeper).restock(tsla.stock, USDG(4_000), 0, "0x");
      expect(await pool.inventory(tsla.stock)).to.equal(EQ(10));

      await pool.connect(admin).listToken(tsla.stock, USDG(5_000));
      await expect(pool.connect(keeper).restock(tsla.stock, USDG(2_000), 0, "0x")).to.be.revertedWithCustomError(pool, "OverCap");

      // A venue paying 2% under Chainlink is refused.
      await ctx.swap.setRate(tsla.stock, usdg, ethers.parseUnits("392", 6) * 10n ** 18n / 10n ** 18n);
      await expect(pool.connect(keeper).destock(tsla.stock, EQ(10), 0, "0x")).to.be.reverted;
      await ctx.swap.setRate(tsla.stock, usdg, ethers.parseUnits("400", 6) * 10n ** 18n / 10n ** 18n);
      const cash = await pool.freeCash();
      await pool.connect(keeper).destock(tsla.stock, EQ(10), 0, "0x");
      expect((await pool.freeCash()) - cash).to.equal(USDG(4_000));
    });
  });
});
