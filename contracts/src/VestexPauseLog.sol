// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title VestexPauseLog
/// @notice Records when each Stock Token reported a corporate action (`oraclePaused`), so Perps and Swap can refuse
///         a price reported while a split or dividend multiplier was being applied. Anyone may record a change of
///         the flag; the keeper does so every cycle and the site does so whenever it sees one.
contract VestexPauseLog {
    struct Window {
        uint40 start;
        uint40 end;
    }

    mapping(address token => Window[]) private _windows;

    event PauseNoted(address indexed token, uint256 start);
    event ResumeNoted(address indexed token, uint256 end);

    error FlagNotRaised();
    error FlagRaised();
    error NothingOpen();

    function notePause(address token) external {
        if (!flagged(token)) revert FlagNotRaised();
        Window[] storage w = _windows[token];
        if (w.length != 0 && w[w.length - 1].end == 0) return;
        w.push(Window(uint40(block.timestamp), 0));
        emit PauseNoted(token, block.timestamp);
    }

    function noteResume(address token) external {
        if (flagged(token)) revert FlagRaised();
        Window[] storage w = _windows[token];
        if (w.length == 0 || w[w.length - 1].end != 0) revert NothingOpen();
        w[w.length - 1].end = uint40(block.timestamp);
        emit ResumeNoted(token, block.timestamp);
    }

    /// @notice True if a recorded corporate action on `token` overlaps [from, to], or the flag is up right now.
    function touched(address token, uint256 from, uint256 to) external view returns (bool) {
        if (flagged(token)) return true;
        Window[] storage w = _windows[token];
        for (uint256 i = w.length; i > 0; --i) {
            Window memory x = w[i - 1];
            if (x.end != 0 && x.end < from) break;
            if (x.start <= to) return true;
        }
        return false;
    }

    function windows(address token) external view returns (Window[] memory) {
        return _windows[token];
    }

    /// @dev Tokens without `oraclePaused()` are treated as never paused.
    function flagged(address token) public view returns (bool) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("oraclePaused()"));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }
}
