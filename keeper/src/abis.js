// ABIs come from the Hardhat build output in contracts/artifacts (run `npx hardhat compile` in contracts/ first), so
// the keeper always matches the Solidity source. KEEPER_ARTIFACTS_DIR overrides the location (the folder that
// contains `src/`).
const fs = require("fs");
const path = require("path");
const { CONTRACTS } = require("./config");

const DIR = process.env.KEEPER_ARTIFACTS_DIR || path.join(CONTRACTS, "artifacts");

const FILES = {
  LiquidityVault: "src/VestexLiquidityVault.sol/VestexLiquidityVault.json",
  IncomeVault: "src/VestexIncomeVault.sol/VestexIncomeVault.json",
  Options: "src/VestexOptions.sol/VestexOptions.json",
  Binaries: "src/VestexBinaries.sol/VestexBinaries.json",
  Oracle: "src/VestexOracle.sol/VestexOracle.json",
  FeeRouter: "src/VestexFeeRouter.sol/VestexFeeRouter.json",
  BuyBurn: "src/VestexBuyBurn.sol/VestexBuyBurn.json",
  CreditDesk: "src/VestexCreditDesk.sol/VestexCreditDesk.json",
  Position: "src/v4/VestexPosition.sol/VestexPosition.json",
  SwapAdapter: "src/v4/VestexSwapAdapter.sol/VestexSwapAdapter.json",
  Pool: "src/VestexPool.sol/VestexPool.json",
  Perps: "src/VestexPerps.sol/VestexPerps.json",
  Swap: "src/VestexSwap.sol/VestexSwap.json",
  PauseLog: "src/VestexPauseLog.sol/VestexPauseLog.json",
};

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const AGGREGATOR = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

const STOCK_TOKEN = [...ERC20, "function oraclePaused() view returns (bool)"];

function load(name) {
  const file = path.join(DIR, FILES[name]);
  if (!fs.existsSync(file)) throw new Error(`Missing ABI artifact ${file}. Run \`npx hardhat compile\` in contracts/ first.`);
  return JSON.parse(fs.readFileSync(file, "utf8")).abi;
}

const abis = Object.fromEntries(Object.keys(FILES).map((n) => [n, load(n)]));
abis.ERC20 = ERC20;
abis.Aggregator = AGGREGATOR;
abis.StockToken = STOCK_TOKEN;

module.exports = abis;
