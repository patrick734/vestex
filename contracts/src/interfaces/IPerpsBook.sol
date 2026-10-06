// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice What the Pool reads from Perps to value itself.
interface IPerpsBook {
    /// @notice What the Pool would owe traders if every position closed at the latest prices: their unrealized
    ///         profit minus the Pool's share of the borrow fees they have accrued. Negative when traders are down.
    function netOwedToTraders() external view returns (int256);

    /// @notice Open notional on `token`, longs plus shorts, in USDG at entry.
    function openInterest(address token) external view returns (uint256);

    /// @notice Notional of open positions across every market.
    function openNotional() external view returns (uint256);

    /// @notice Open notional plus notional set aside for opens waiting to fill.
    function totalNotional() external view returns (uint256);
}
