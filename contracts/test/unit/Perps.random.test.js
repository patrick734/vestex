// Random sequences of opens, closes, top-ups, liquidations and price moves, checking after every step that
// no USDG appears or disappears and that Perps holds exactly the collateral it owes.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { marketsFixture, refresh, USDG, FEED, time } = require("./markets.fixtures");

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("VestexPerps (random sequences)", function () {
  for (const seed of [1, 7, 42, 99]) {
    it(`conserves USDG and keeps the books exact, seed ${seed}`, async function () {
      const ctx = await loadFixture(marketsFixture);
      const { perps, pool, usdg, alice, bob, carol, feeRouter, tsla, nvda } = ctx;
      const r = rng(seed);
      const traders = [alice, bob, carol];
      const markets = [
        { m: tsla, price: 400, key: "tsla" },
        { m: nvda, price: 200, key: "nvda" },
      ];
      const holders = [pool.target, perps.target, feeRouter.target, ...traders.map((t) => t.address)];
      const total = async () => {
        let sum = 0n;
        for (const h of holders) sum += await usdg.balanceOf(h);
        return sum;
      };
      const start = await total();

      const prices = () => ({ tsla: markets[0].price, nvda: markets[1].price });
      for (let step = 0; step < 60; step++) {
        const k = markets[Math.floor(r() * 2)];
        const who = traders[Math.floor(r() * 3)];
        const action = r();
        if (action < 0.4) {
          const collateral = USDG(100 + Math.floor(r() * 2_000));
          const lev = 1 + Math.floor(r() * 10);
          const id = await perps.orderCount();
          await perps.connect(who).openPosition(k.m.stock, r() < 0.5, collateral, collateral * BigInt(lev), r() < 0.5 ? 1n : USDG(10_000));
          k.price = Math.max(10, Math.round(k.price * (0.97 + r() * 0.06)));
          await k.m.feed.setAnswer(FEED(k.price));
          await perps.execute(id);
        } else if (action < 0.65) {
          const ids = await perps.openPositionIds();
          if (ids.length === 0) continue;
          const pid = ids[Math.floor(r() * ids.length)];
          const p = await perps.getPosition(pid);
          if (p.closeOrder !== 0n) continue;
          const owner = traders.find((t) => t.address === p.owner);
          const feed = markets.find((x) => x.m.stock.target === p.token);
          const id = await perps.orderCount();
          await perps.connect(owner).closePosition(pid, p.isLong ? 1n : USDG(10_000));
          feed.price = Math.max(10, Math.round(feed.price * (0.97 + r() * 0.06)));
          await feed.m.feed.setAnswer(FEED(feed.price));
          await perps.execute(id);
        } else if (action < 0.75) {
          const ids = await perps.openPositionIds();
          if (ids.length === 0) continue;
          const pid = ids[Math.floor(r() * ids.length)];
          const p = await perps.getPosition(pid);
          const owner = traders.find((t) => t.address === p.owner);
          await perps.connect(owner).addCollateral(pid, USDG(50));
        } else {
          k.price = Math.max(10, Math.round(k.price * (0.85 + r() * 0.3)));
          await time.increase(Math.floor(r() * 3 * 3600));
          await refresh(ctx, prices());
          for (const pid of await perps.openPositionIds()) {
            const p = await perps.getPosition(pid);
            const feed = markets.find((x) => x.m.stock.target === p.token);
            const [, , , liq] = await perps.preview(pid, USDG(feed.price));
            if (liq) await perps.connect(carol).liquidate(pid);
          }
        }

        expect(await total()).to.equal(start);
        let collateral = 0n;
        for (const pid of await perps.openPositionIds()) collateral += (await perps.getPosition(pid)).collateral;
        expect(await usdg.balanceOf(perps)).to.equal(collateral);
        expect(await pool.totalOwed(usdg)).to.equal(0);
      }

      // Close everything: the books must come back to zero.
      await refresh(ctx, prices());
      for (const pid of await perps.openPositionIds()) {
        const p = await perps.getPosition(pid);
        const owner = traders.find((t) => t.address === p.owner);
        const feed = markets.find((x) => x.m.stock.target === p.token);
        const id = await perps.orderCount();
        await perps.connect(owner).closePosition(pid, p.isLong ? 1n : USDG(10_000));
        await feed.m.feed.setAnswer(FEED(feed.price));
        await perps.execute(id);
      }
      expect(await perps.positionCount()).to.be.gt(5);
      expect(await perps.totalNotional()).to.equal(0);
      expect(await perps.netOwedToTraders()).to.equal(0);
      expect(await usdg.balanceOf(perps)).to.equal(0);
      expect(await total()).to.equal(start);
      for (const k of markets) {
        const m = await perps.market(k.m.stock);
        expect(m.longSize + m.shortSize + m.longNotional + m.shortNotional).to.equal(0);
      }
    });
  }
});
