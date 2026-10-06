// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The Pool as Perps and Swap use it.
interface IVestexPool {
    /// @notice Pays `amount` of `token` (USDG or a listed Stock Token) out of the Pool. Whatever cannot be paid
    ///         now is booked as owed to `to` and claimable later.
    function pay(address token, address to, uint256 amount) external;

    /// @notice Sets `amount` of `token` aside for a pending order, so nothing else can spend it before the order fills.
    function reserve(address token, uint256 amount) external;

    /// @notice Returns an amount set aside by `reserve`.
    function release(address token, uint256 amount) external;

    function listed(address token) external view returns (bool);

    /// @notice USDG the Pool holds beyond what it already owes or has set aside.
    function freeCash() external view returns (uint256);

    /// @notice Stock Tokens of `token` the Pool holds beyond what it already owes or has set aside.
    function inventory(address token) external view returns (uint256);

    /// @notice Most USDG value of `token` the Pool may hold.
    function inventoryCap(address token) external view returns (uint256);

    /// @notice Most open notional Perps may carry across all markets.
    function capacity() external view returns (uint256);
}
