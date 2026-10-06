# Vestex

Swap, trade and earn on Robinhood Stock Tokens, on Robinhood Chain (chain id 4663), in USDG.

- **VestexPool**: one USDG pool (vxLP) that is the other side of every Perps position and holds the Stock Tokens Swap
  sells. LPs earn 70% of Perps and Swap fees and carry traders' results.
- **VestexPerps**: long and short positions up to 10x with USDG margin. **VestexSwap**: Stock Tokens at the Chainlink
  price less a flat fee. Both work in two steps: an order fills at the next Chainlink round after the one current when
  it was placed, so no one can trade a stale price against the Pool, and everything an order needs from the Pool is set
  aside when it is placed, so that price alone decides the outcome. **VestexPauseLog** records corporate actions.
- **VestexOptions**: peer-to-peer covered calls and cash-secured puts. Writers lock the full collateral; buyers pay the
  premium and can exercise until expiry. Physically settled, so no price feed decides who gets paid.
- **VestexBinaries**: two traders stake the same amount on opposite sides of a strike; the winner takes both stakes on
  the Chainlink round that was current at expiry. No house and no pool.
- **VestexIncomeVault**: deposit USDG; the vault runs the wheel on one stock through the options desk in weekly rounds
  (cash-secured puts below the market, covered calls on assigned stock) inside limits written into the contract.
- **VestexLiquidityVault** and **VestexCreditDesk** (based on the MIT-licensed Stonkwell): managed Uniswap v4
  liquidity in one stock's pool, valued at Chainlink, and an isolated lending market against its shares.
- **VestexOracle**, **VestexFeeRouter**, **VestexBuyBurn**, **VestexSwapAdapter**, **VestexRegistry** and
  **VestexTimelock** (48 hours) around them. Every fee ends up buying and burning the Vestex token.

| Folder | Contents |
|---|---|
| `contracts/` | Hardhat project: the contracts, their tests and the deploy, verify and governance scripts |
| `keeper/` | The keeper bot: fills and refunds Perps and Swap orders, liquidations, Pool inventory, Income Vault rounds, binaries settlement, vault upkeep, buy and burn |
| `web/` | Next.js site (static export): Swap, Perps, Pool, Earn, options desk, Predict, Borrow, docs |
| `tools/` | Wallet tools: encrypted keystores, the keeper key straight into a GitHub secret |

## Tests

```bash
cd contracts && npm install && npx hardhat test
cd ../keeper && npm install && npm test
```

The keeper also has an end-to-end smoke test against a local node; see `keeper/README.md`.

## Running the site locally

```bash
cd contracts && npx hardhat node                                  # terminal 1
npx hardhat run scripts/deploy.js --network localhost && npm run export-abis
cd ../web && npm install && NEXT_PUBLIC_ENABLE_LOCAL=1 npm run dev  # seeded local demo
```

Not independently audited. Nothing here is investment advice.
