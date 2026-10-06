// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title VestexTimelock
/// @notice Governance timelock for Vestex. Every settings change is scheduled in public and can run only
///         after the minimum delay (48 hours at launch).
/// @dev OpenZeppelin's TimelockController, unmodified.
contract VestexTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
