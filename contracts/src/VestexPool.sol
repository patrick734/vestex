// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMarkOracle} from "./interfaces/IMarkOracle.sol";
import {IPerpsBook} from "./interfaces/IPerpsBook.sol";
import {IVestexPool} from "./interfaces/IVestexPool.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {Payouts} from "./libraries/Payouts.sol";

/// @title VestexPool
/// @notice One USDG pool that takes the other side of every Perps trade and fills Swap orders from the Stock Tokens
///         it holds. LPs earn the Pool's share of trading, borrow and swap fees, and carry the result of traders'
///         positions: the Pool gains when traders lose and pays out when they win.
///
///         The share price counts USDG held, Stock Tokens held at their latest Chainlink price, and the profit or
///         loss of every open position, less anything already owed. Deposits and withdrawals only go through while
///         every market the Pool is exposed to has a fresh price, so nobody can enter or leave at a weekend's stale
///         value. Both pay a small fee that stays in the Pool, and shares must be held for `minHold` before they can
///         be withdrawn, so timing the next price update does not pay.
///
/// @dev Shares cannot be transferred: a transfer could otherwise restart someone else's holding period.
contract VestexPool is ERC4626, AccessControl, Pausable, ReentrancyGuard, IVestexPool {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    /// @notice Perps and Swap.
    bytes32 public constant MARKET_ROLE = keccak256("MARKET_ROLE");

    uint256 private constant BPS = 10_000;
    uint16 public constant MAX_LP_FEE_BPS = 100;
    uint32 public constant MAX_HOLD = 7 days;
    uint16 public constant MAX_SWAP_LOSS_BPS = 300;

    IMarkOracle public immutable oracle;
    ISwapAdapter public immutable swapAdapter;

    /// @notice Perps, set once.
    IPerpsBook public book;

    uint256 public depositCap;
    uint16 public lpFeeBps = 10;
    uint32 public minHold = 1 days;
    /// @notice Perps open notional may reach this share of the Pool's value.
    uint16 public maxUtilizationBps = 5_000;
    uint16 public maxSwapLossBps = 100;
    /// @notice Most USDG value the keeper may restock and destock in a day, which bounds what swap losses can cost.
    uint256 public maxDailyTurnover = 25_000e6;
    uint256 public turnoverToday;
    uint64 public turnoverDay;
    /// @notice Exposure worth less than this does not close the Pool to LPs, so dust cannot be used to freeze it.
    uint256 public dustValue = 1e6;

    address[] private _tokens;
    mapping(address token => bool) public listed;
    mapping(address token => uint256) public inventoryCap;
    /// @notice Tokens governance has excused from the fresh-price check, for a market that will never price again.
    mapping(address token => bool) public gateExempt;
    mapping(address token => uint256) public reserved;

    mapping(address account => uint64) public lastDeposit;
    mapping(address token => mapping(address account => uint256)) public owed;
    mapping(address token => uint256) public totalOwed;

    event BookSet(address indexed book);
    event TokenListed(address indexed token, uint256 inventoryCap);
    event DepositCapSet(uint256 cap);
    event LpFeeSet(uint16 bps);
    event MinHoldSet(uint32 seconds_);
    event MaxUtilizationSet(uint16 bps);
    event MaxSwapLossSet(uint16 bps);
    event Paid(address indexed token, address indexed to, uint256 amount);
    event Owed(address indexed token, address indexed to, uint256 amount);
    event Claimed(address indexed token, address indexed to, uint256 amount);
    event Restocked(address indexed token, uint256 usdgIn, uint256 received);
    event Destocked(address indexed token, uint256 amountIn, uint256 usdgOut);
    event TurnoverSet(uint256 maxDaily);
    event DustValueSet(uint256 value);
    event GateExemptSet(address indexed token, bool exempt);

    error InvalidConfig();
    error MarketsClosed();
    error StillHolding();
    error NotTransferable();
    error NotListed();
    error OverCap();
    error InsufficientCash();
    error SwapLoss();
    error NothingOwed();
    error OverTurnover();

    constructor(IERC20 usdg, IMarkOracle oracle_, ISwapAdapter swapAdapter_, address admin, address guardian, address keeper, uint256 depositCap_)
        ERC20("Vestex Pool", "vxLP")
        ERC4626(usdg)
    {
        if (
            address(usdg) == address(0) || address(oracle_) == address(0) || address(swapAdapter_) == address(0)
                || admin == address(0) || guardian == address(0) || keeper == address(0)
        ) revert InvalidConfig();
        oracle = oracle_;
        swapAdapter = swapAdapter_;
        depositCap = depositCap_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        _grantRole(KEEPER_ROLE, keeper);
    }

    /*//////////////////////////////////////////////////////////////
                                VALUATION
    //////////////////////////////////////////////////////////////*/

    /// @dev Everything held, less everything owed, token by token: an owed amount the Pool cannot cover yet still
    ///      counts against it. Amounts set aside for pending orders are still the Pool's and count in full.
    function totalAssets() public view override returns (uint256) {
        int256 value = int256(IERC20(asset()).balanceOf(address(this))) - int256(totalOwed[asset()]);
        for (uint256 i; i < _tokens.length; ++i) {
            address t = _tokens[i];
            value += int256(oracle.markValue(t, IERC20(t).balanceOf(address(this))));
            value -= int256(oracle.markValue(t, totalOwed[t]));
        }
        if (address(book) != address(0)) value -= book.netOwedToTraders();
        return value > 0 ? uint256(value) : 0;
    }

    function freeCash() public view returns (uint256) {
        return _free(asset());
    }

    function inventory(address token) public view returns (uint256) {
        return _free(token);
    }

    function capacity() public view returns (uint256) {
        return Math.mulDiv(totalAssets(), maxUtilizationBps, BPS);
    }

    /// @notice False while any market the Pool holds or backs positions in lacks a fresh price.
    function marketsOpen() public view returns (bool) {
        for (uint256 i; i < _tokens.length; ++i) {
            address t = _tokens[i];
            if (gateExempt[t]) continue;
            uint256 held = IERC20(t).balanceOf(address(this));
            // A balance the oracle cannot value at all is exposure, not dust.
            bool exposed = (held != 0 && (oracle.markValue(t, held) >= dustValue || oracle.markValue(t, _unit(t)) == 0))
                || (address(book) != address(0) && book.openInterest(t) != 0);
            if (exposed && !oracle.isFresh(t)) return false;
        }
        return true;
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    /*//////////////////////////////////////////////////////////////
                              LP FLOWS
    //////////////////////////////////////////////////////////////*/

    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 assets = totalAssets();
        return assets >= depositCap ? 0 : depositCap - assets;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assets = maxDeposit(receiver);
        return assets == 0 ? 0 : previewDeposit(assets);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (block.timestamp < uint256(lastDeposit[owner]) + minHold) return 0;
        return Math.min(previewRedeem(balanceOf(owner)), _withdrawable());
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (block.timestamp < uint256(lastDeposit[owner]) + minHold) return 0;
        uint256 shares = balanceOf(owner);
        uint256 limit = _withdrawable();
        if (previewRedeem(shares) <= limit) return shares;
        return limit == 0 ? 0 : previewWithdraw(limit);
    }

    function previewDeposit(uint256 assets) public view override returns (uint256) {
        return super.previewDeposit(assets - _feeOnTotal(assets));
    }

    function previewMint(uint256 shares) public view override returns (uint256) {
        uint256 assets = super.previewMint(shares);
        return assets + _feeOnRaw(assets);
    }

    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        return super.previewWithdraw(assets + _feeOnRaw(assets));
    }

    function previewRedeem(uint256 shares) public view override returns (uint256) {
        uint256 assets = super.previewRedeem(shares);
        return assets - _feeOnTotal(assets);
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }

    /*//////////////////////////////////////////////////////////////
                           MARKETS (PERPS, SWAP)
    //////////////////////////////////////////////////////////////*/

    function pay(address token, address to, uint256 amount) external onlyRole(MARKET_ROLE) nonReentrant {
        if (amount == 0) return;
        if (token != asset() && !listed[token]) revert NotListed();
        uint256 free = token == asset() ? freeCash() : inventory(token);
        uint256 now_ = Math.min(free, amount);
        if (now_ != 0 && !Payouts.tryTransfer(IERC20(token), to, now_)) now_ = 0;
        if (now_ != 0) emit Paid(token, to, now_);
        uint256 rest = amount - now_;
        if (rest != 0) {
            owed[token][to] += rest;
            totalOwed[token] += rest;
            emit Owed(token, to, rest);
        }
    }

    function reserve(address token, uint256 amount) external onlyRole(MARKET_ROLE) {
        if (amount > _free(token)) revert InsufficientCash();
        reserved[token] += amount;
    }

    function release(address token, uint256 amount) external onlyRole(MARKET_ROLE) {
        reserved[token] -= amount;
    }

    /// @notice Collects a payment the Pool could not make at the time.
    function claim(address token) external nonReentrant {
        uint256 amount = owed[token][msg.sender];
        if (amount == 0) revert NothingOwed();
        uint256 held = IERC20(token).balanceOf(address(this));
        // Never out of amounts set aside for pending orders.
        if (held < amount + reserved[token]) revert InsufficientCash();
        owed[token][msg.sender] = 0;
        totalOwed[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Claimed(token, msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 KEEPER
    //////////////////////////////////////////////////////////////*/

    /// @notice Buys Stock Tokens for Swap to sell, through the swap adapter, at no worse than `maxSwapLossBps`
    ///         under Chainlink and up to the token's inventory cap.
    function restock(address token, uint256 usdgIn, uint256 minOut, bytes calldata route)
        external
        onlyRole(KEEPER_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (!listed[token]) revert NotListed();
        if (usdgIn > freeCash()) revert InsufficientCash();
        _turnover(usdgIn);
        uint256 fair = oracle.fromUsdgValue(token, usdgIn);
        uint256 floor = Math.mulDiv(fair, BPS - maxSwapLossBps, BPS);
        if (minOut < floor) minOut = floor;
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(asset()).forceApprove(address(swapAdapter), usdgIn);
        swapAdapter.swap(asset(), token, usdgIn, minOut, address(this), route);
        IERC20(asset()).forceApprove(address(swapAdapter), 0);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received < minOut) revert SwapLoss();
        if (oracle.usdgValue(token, inventory(token)) > inventoryCap[token]) revert OverCap();
        emit Restocked(token, usdgIn, received);
    }

    /// @notice Sells Stock Tokens back to USDG, at no worse than `maxSwapLossBps` under Chainlink.
    function destock(address token, uint256 amountIn, uint256 minOut, bytes calldata route)
        external
        onlyRole(KEEPER_ROLE)
        nonReentrant
    {
        if (!listed[token]) revert NotListed();
        if (amountIn > inventory(token)) revert InsufficientCash();
        uint256 value = oracle.usdgValue(token, amountIn);
        _turnover(value);
        uint256 floor = Math.mulDiv(value, BPS - maxSwapLossBps, BPS);
        if (minOut < floor) minOut = floor;
        uint256 before = IERC20(asset()).balanceOf(address(this));
        IERC20(token).forceApprove(address(swapAdapter), amountIn);
        swapAdapter.swap(token, asset(), amountIn, minOut, address(this), route);
        IERC20(token).forceApprove(address(swapAdapter), 0);
        uint256 received = IERC20(asset()).balanceOf(address(this)) - before;
        if (received < minOut) revert SwapLoss();
        emit Destocked(token, amountIn, received);
    }

    /*//////////////////////////////////////////////////////////////
                               GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function setBook(IPerpsBook book_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(book) != address(0) || address(book_) == address(0)) revert InvalidConfig();
        book = book_;
        emit BookSet(address(book_));
    }

    function listToken(address token, uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0) || token == asset() || oracle.feedOf(token) == address(0)) revert InvalidConfig();
        if (!listed[token]) {
            listed[token] = true;
            _tokens.push(token);
        }
        inventoryCap[token] = cap;
        emit TokenListed(token, cap);
    }

    function setDepositCap(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        depositCap = cap;
        emit DepositCapSet(cap);
    }

    /// @notice The guardian may only lower the cap.
    function lowerDepositCap(uint256 cap) external onlyRole(GUARDIAN_ROLE) {
        if (cap > depositCap) revert InvalidConfig();
        depositCap = cap;
        emit DepositCapSet(cap);
    }

    function setLpFee(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_LP_FEE_BPS) revert InvalidConfig();
        lpFeeBps = bps;
        emit LpFeeSet(bps);
    }

    function setMinHold(uint32 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (seconds_ > MAX_HOLD) revert InvalidConfig();
        minHold = seconds_;
        emit MinHoldSet(seconds_);
    }

    function setMaxUtilization(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps == 0 || bps > BPS) revert InvalidConfig();
        maxUtilizationBps = bps;
        emit MaxUtilizationSet(bps);
    }

    function setMaxSwapLoss(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_SWAP_LOSS_BPS) revert InvalidConfig();
        maxSwapLossBps = bps;
        emit MaxSwapLossSet(bps);
    }

    function setMaxDailyTurnover(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxDailyTurnover = amount;
        emit TurnoverSet(amount);
    }

    function setDustValue(uint256 value) external onlyRole(DEFAULT_ADMIN_ROLE) {
        dustValue = value;
        emit DustValueSet(value);
    }

    /// @notice For a market that will never price again (a delisted stock), lets LPs in and out regardless.
    function setGateExempt(address token, bool exempt) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!listed[token]) revert NotListed();
        gateExempt[token] = exempt;
        emit GateExemptSet(token, exempt);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override whenNotPaused {
        if (caller != receiver) revert NotTransferable();
        if (!marketsOpen()) revert MarketsClosed();
        lastDeposit[receiver] = uint64(block.timestamp);
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        if (!marketsOpen()) revert MarketsClosed();
        if (block.timestamp < uint256(lastDeposit[owner]) + minHold) revert StillHolding();
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) revert NotTransferable();
        super._update(from, to, value);
    }

    /// @dev What may leave the Pool without breaching the Perps utilization limit or touching owed payments.
    function _withdrawable() private view returns (uint256) {
        uint256 assets = totalAssets();
        // Open positions only: an order waiting to fill does not hold LPs in.
        uint256 notional = address(book) == address(0) ? 0 : book.openNotional();
        uint256 needed = Math.mulDiv(notional, BPS, maxUtilizationBps, Math.Rounding.Ceil);
        uint256 headroom = assets > needed ? assets - needed : 0;
        return Math.min(headroom, freeCash());
    }

    function _unit(address token) private view returns (uint256) {
        return 10 ** IERC20Metadata(token).decimals();
    }

    function _free(address token) private view returns (uint256) {
        uint256 held = IERC20(token).balanceOf(address(this));
        uint256 tied = totalOwed[token] + reserved[token];
        return held > tied ? held - tied : 0;
    }

    function _turnover(uint256 value) private {
        uint64 day = uint64(block.timestamp / 1 days);
        if (day != turnoverDay) {
            turnoverDay = day;
            turnoverToday = 0;
        }
        turnoverToday += value;
        if (turnoverToday > maxDailyTurnover) revert OverTurnover();
    }

    function _feeOnRaw(uint256 assets) private view returns (uint256) {
        return Math.mulDiv(assets, lpFeeBps, BPS, Math.Rounding.Ceil);
    }

    function _feeOnTotal(uint256 assets) private view returns (uint256) {
        return Math.mulDiv(assets, lpFeeBps, lpFeeBps + BPS, Math.Rounding.Ceil);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
