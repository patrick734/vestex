// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPriceOracle} from "./IPriceOracle.sol";

/// @notice The oracle as Pool, Perps and Swap use it.
interface IMarkOracle is IPriceOracle {
    /// @notice USDG value of `amount` at the latest answer, however old. Zero when unpriced. Never reverts.
    function markValue(address token, uint256 amount) external view returns (uint256);

    /// @notice A USD price at `decimals` as USDG per whole token. Reverts while the USDG feed is stale.
    function usdToUsdg(uint256 usdPrice, uint8 decimals) external view returns (uint256);

    /// @notice `usdToUsdg` at the USDG feed's latest answer however old. Zero when unusable. Never reverts.
    function usdToUsdgMark(uint256 usdPrice, uint8 decimals) external view returns (uint256);
}
