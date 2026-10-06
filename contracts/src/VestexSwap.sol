// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IMarkOracle} from "./interfaces/IMarkOracle.sol";
import {IVestexPool} from "./interfaces/IVestexPool.sol";
import {VestexPauseLog} from "./VestexPauseLog.sol";
import {Payouts} from "./libraries/Payouts.sol";

/// @title VestexSwap
/// @notice Buys and sells Stock Tokens against the Pool at the Chainlink price, less a flat fee and with no other
///         slippage. Like Perps, a swap is an order that fills at the next Chainlink round after the one current
///         when it was placed, so nobody can trade a price that was already known. The Pool's Stock Tokens (for a
///         buy) or USDG (for a sell) are set aside when the order is placed, enough for any price the order could
///         fill at, so whether it fills depends on that price and the trader's minimum alone. An order below its
///         minimum keeps the swap fee, which goes to the Pool, and is otherwise refunded; one that cannot fill for any
///         reason outside the trader's control is refunded in full.
/// @dev The fee is split between the Pool's LPs and the FeeRouter by `protocolShareBps`.
contract VestexSwap is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 private constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 100;
    uint16 public constant MAX_PROTOCOL_SHARE_BPS = 5_000;
    uint32 public constant MIN_WINDOW = 5 minutes;
    uint32 public constant MAX_WINDOW = 1 days;
    /// @notice An order still pending this long after its window can be refunded whatever happened.
    uint32 public constant ABANDON_AFTER = 7 days;
    /// @notice Orders one account may have waiting at once.
    uint8 public constant MAX_PENDING = 3;

    enum Status {
        None,
        Pending,
        Filled,
        Refunded
    }

    struct Market {
        address feed;
        uint8 feedDecimals;
        bool enabled;
        uint256 unit;
        uint256 maxOrder;
    }

    struct Order {
        address owner;
        bool sell;
        Status status;
        uint40 createdAt;
        address token;
        uint256 amountIn;
        uint256 minOut;
        uint256 refAnswer;
        uint80 baseRound;
        uint256 held;
        uint256 amountOut;
        uint256 fillPrice;
    }

    IERC20 public immutable usdg;
    IVestexPool public immutable pool;
    IMarkOracle public immutable oracle;
    VestexPauseLog public immutable pauseLog;
    address public immutable feeRouter;

    uint16 public feeBps = 30;
    uint16 public protocolShareBps = 3_000;
    uint32 public orderWindow = 1 hours;
    uint16 public maxMoveBps = 2_000;

    mapping(address token => Market) private _markets;
    address[] private _tokens;
    Order[] private _orders;
    mapping(address account => uint256[]) private _ordersOf;
    /// @notice Stock Tokens in pending sells, which will join the Pool's inventory if they fill.
    mapping(address token => uint256) public pendingIn;
    /// @notice Refunds a token would not deliver at the time, claimable with `claimRefund`.
    mapping(address token => mapping(address account => uint256)) public refundOwed;
    mapping(address account => uint256) public pending;

    event MarketSet(address indexed token, bool enabled, uint256 maxOrder);
    event ParamsSet(uint16 feeBps, uint16 protocolShareBps, uint32 orderWindow, uint16 maxMoveBps);
    event OrderPlaced(uint256 indexed id, address indexed owner, address indexed token, bool sell, uint256 amountIn, uint256 minOut);
    event Filled(uint256 indexed id, uint256 price, uint256 amountOut, uint256 fee);
    event OrderRefunded(uint256 indexed id, string reason);
    event RefundOwed(address indexed token, address indexed account, uint256 amount);
    event RefundClaimed(address indexed token, address indexed account, uint256 amount);

    error InvalidConfig();
    error UnknownMarket();
    error MarketClosed();
    error CorporateAction();
    error BadTerms();
    error NotPending();
    error NoPriceYet();
    error PoolLimit();
    error NothingOwed();

    constructor(
        IERC20 usdg_,
        IVestexPool pool_,
        IMarkOracle oracle_,
        VestexPauseLog pauseLog_,
        address feeRouter_,
        address admin,
        address guardian
    ) {
        if (
            address(usdg_) == address(0) || address(pool_) == address(0) || address(oracle_) == address(0)
                || address(pauseLog_) == address(0) || feeRouter_ == address(0) || admin == address(0) || guardian == address(0)
        ) revert InvalidConfig();
        usdg = usdg_;
        pool = pool_;
        oracle = oracle_;
        pauseLog = pauseLog_;
        feeRouter = feeRouter_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /// @param sell True to sell `amountIn` Stock Tokens for USDG, false to spend `amountIn` USDG on Stock Tokens.
    /// @param minOut Least the order accepts; below it the order is refunded.
    function placeOrder(address token, bool sell, uint256 amountIn, uint256 minOut)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 id)
    {
        Market storage m = _markets[token];
        if (!m.enabled) revert UnknownMarket();
        if (pauseLog.flagged(token)) revert CorporateAction();
        if (!oracle.isFresh(token)) revert MarketClosed();
        if (amountIn == 0 || pending[msg.sender] >= MAX_PENDING) revert BadTerms();
        ++pending[msg.sender];

        IERC20 tokenIn = sell ? IERC20(token) : usdg;
        uint256 before = tokenIn.balanceOf(address(this));
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 received = tokenIn.balanceOf(address(this)) - before;
        uint256 value = sell ? oracle.usdgValue(token, received) : received;
        if (received == 0 || value > m.maxOrder) revert BadTerms();

        // Set aside what the order could need at the worst price it can still fill at (anything further away is
        // refunded as a price jump), with 1% more for the USDG rate.
        uint256 unitPrice = oracle.usdgValue(token, m.unit);
        uint256 band = uint256(maxMoveBps) + 100;
        uint256 held;
        if (sell) {
            held = Math.mulDiv(received, unitPrice * (BPS + band), m.unit * BPS);
            uint256 inventoryAfter = Math.mulDiv(pool.inventory(token) + pendingIn[token] + received, unitPrice * (BPS + band), m.unit * BPS);
            if (held > pool.freeCash() || inventoryAfter > pool.inventoryCap(token)) revert PoolLimit();
            pool.reserve(address(usdg), held);
            pendingIn[token] += received;
        } else {
            held = Math.mulDiv(received, m.unit * BPS, unitPrice * (BPS - band));
            if (held > pool.inventory(token)) revert PoolLimit();
            pool.reserve(token, held);
        }

        (uint80 base, int256 answer,,,) = AggregatorV3Interface(m.feed).latestRoundData();
        id = _orders.length;
        _orders.push(
            Order({
                owner: msg.sender,
                sell: sell,
                status: Status.Pending,
                createdAt: uint40(block.timestamp),
                token: token,
                amountIn: received,
                minOut: minOut,
                refAnswer: uint256(answer),
                baseRound: base,
                held: held,
                amountOut: 0,
                fillPrice: 0
            })
        );
        _ordersOf[msg.sender].push(id);
        emit OrderPlaced(id, msg.sender, token, sell, received, minOut);
    }

    /// @notice Fills an order at the round after the one current when it was placed. Anyone can call; the keeper does.
    function execute(uint256 id) external nonReentrant {
        Order storage o = _order(id);
        if (o.status != Status.Pending) revert NotPending();
        Market storage m = _markets[o.token];
        if (pauseLog.flagged(o.token)) revert CorporateAction();

        (bool reported, int256 answer, uint256 at) = _round(m.feed, o.baseRound + 1);
        if (!reported) revert NoPriceYet();
        if (at <= o.createdAt) return _refund(id, o, "price in the same block");
        if (at > uint256(o.createdAt) + orderWindow) return _refund(id, o, "no price in time");
        if (answer <= 0) return _refund(id, o, "bad price");
        if (pauseLog.touched(o.token, o.createdAt, at)) return _refund(id, o, "corporate action");
        uint256 diff = uint256(answer) > o.refAnswer ? uint256(answer) - o.refAnswer : o.refAnswer - uint256(answer);
        if (diff * BPS > o.refAnswer * maxMoveBps) return _refund(id, o, "price jump");
        if (paused() || !m.enabled) return _refund(id, o, "market closed");

        uint256 price = oracle.usdToUsdgMark(uint256(answer), m.feedDecimals);
        if (price == 0) revert MarketClosed();
        if (o.sell) _fillSell(id, o, price);
        else _fillBuy(id, o, price);
    }

    /// @notice Refunds an order no new price arrived for within `orderWindow`. Anyone can call.
    function expire(uint256 id) external nonReentrant {
        Order storage o = _order(id);
        if (o.status != Status.Pending) revert NotPending();
        if (block.timestamp <= uint256(o.createdAt) + orderWindow) revert NoPriceYet();
        (bool reported,,) = _round(_markets[o.token].feed, o.baseRound + 1);
        if (reported && block.timestamp <= uint256(o.createdAt) + orderWindow + ABANDON_AFTER) revert NoPriceYet();
        _refund(id, o, "no price in time");
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function market(address token) external view returns (Market memory) {
        return _markets[token];
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    function getOrder(uint256 id) external view returns (Order memory) {
        return _order(id);
    }

    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    function ordersOf(address account) external view returns (uint256[] memory) {
        return _ordersOf[account];
    }

    /// @notice What an order of `amountIn` would receive at `price` (USDG per whole token), before limits.
    function quote(address token, bool sell, uint256 amountIn, uint256 price) public view returns (uint256 out, uint256 fee) {
        Market storage m = _markets[token];
        if (sell) {
            uint256 gross = Math.mulDiv(amountIn, price, m.unit);
            fee = Math.mulDiv(gross, feeBps, BPS);
            out = gross - fee;
        } else {
            fee = Math.mulDiv(amountIn, feeBps, BPS);
            out = Math.mulDiv(amountIn - fee, m.unit, price);
        }
    }

    /*//////////////////////////////////////////////////////////////
                               GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function setMarket(address token, bool enabled, uint256 maxOrder) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Market storage m = _markets[token];
        if (m.feed == address(0)) {
            address feed = oracle.feedOf(token);
            if (feed == address(0) || !pool.listed(token)) revert InvalidConfig();
            m.feed = feed;
            m.feedDecimals = AggregatorV3Interface(feed).decimals();
            m.unit = 10 ** IERC20Metadata(token).decimals();
            _tokens.push(token);
        }
        m.enabled = enabled;
        m.maxOrder = maxOrder;
        emit MarketSet(token, enabled, maxOrder);
    }

    function setParams(uint16 feeBps_, uint16 protocolShareBps_, uint32 window, uint16 moveBps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (
            feeBps_ > MAX_FEE_BPS || protocolShareBps_ > MAX_PROTOCOL_SHARE_BPS || window < MIN_WINDOW
                || window > MAX_WINDOW || moveBps == 0 || moveBps > 5_000
        ) revert InvalidConfig();
        feeBps = feeBps_;
        protocolShareBps = protocolShareBps_;
        orderWindow = window;
        maxMoveBps = moveBps;
        emit ParamsSet(feeBps_, protocolShareBps_, window, moveBps);
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

    function _fillBuy(uint256 id, Order storage o, uint256 price) private {
        (uint256 out, uint256 fee) = quote(o.token, false, o.amountIn, price);
        if (out == 0 || out < o.minOut) return _refundKeepingFee(id, o);
        if (out > o.held) return _refund(id, o, "pool inventory");

        pool.release(o.token, o.held);
        _fill(id, o, price, out, fee);
        uint256 protocolFee = Math.mulDiv(fee, protocolShareBps, BPS);
        if (protocolFee != 0) usdg.safeTransfer(feeRouter, protocolFee);
        usdg.safeTransfer(address(pool), o.amountIn - protocolFee);
        pool.pay(o.token, o.owner, out);
    }

    function _fillSell(uint256 id, Order storage o, uint256 price) private {
        (uint256 out, uint256 fee) = quote(o.token, true, o.amountIn, price);
        uint256 protocolFee = Math.mulDiv(fee, protocolShareBps, BPS);
        if (out == 0 || out < o.minOut) return _refundKeepingFee(id, o);
        if (out + protocolFee > o.held) return _refund(id, o, "pool cash");

        pool.release(address(usdg), o.held);
        pendingIn[o.token] -= o.amountIn;
        _fill(id, o, price, out, fee);
        IERC20(o.token).safeTransfer(address(pool), o.amountIn);
        pool.pay(address(usdg), o.owner, out);
        pool.pay(address(usdg), feeRouter, protocolFee);
    }

    function _fill(uint256 id, Order storage o, uint256 price, uint256 out, uint256 fee) private {
        o.status = Status.Filled;
        --pending[o.owner];
        o.amountOut = out;
        o.fillPrice = price;
        emit Filled(id, price, out, fee);
    }

    function _refund(uint256 id, Order storage o, string memory reason) private {
        _unhold(o);
        _sendRefund(o.sell ? o.token : address(usdg), o.owner, o.amountIn);
        emit OrderRefunded(id, reason);
    }

    /// @dev An order the trader's own minimum stopped: it held the Pool's side, so the fee goes to the Pool.
    function _refundKeepingFee(uint256 id, Order storage o) private {
        _unhold(o);
        address tokenIn = o.sell ? o.token : address(usdg);
        uint256 fee = Math.mulDiv(o.amountIn, feeBps, BPS);
        if (fee != 0) IERC20(tokenIn).safeTransfer(address(pool), fee);
        _sendRefund(tokenIn, o.owner, o.amountIn - fee);
        emit OrderRefunded(id, "below minimum");
    }

    function _unhold(Order storage o) private {
        o.status = Status.Refunded;
        --pending[o.owner];
        if (o.sell) {
            pool.release(address(usdg), o.held);
            pendingIn[o.token] -= o.amountIn;
        } else {
            pool.release(o.token, o.held);
        }
    }

    function _sendRefund(address token, address to, uint256 amount) private {
        if (amount == 0 || Payouts.tryTransfer(IERC20(token), to, amount)) return;
        refundOwed[token][to] += amount;
        emit RefundOwed(token, to, amount);
    }

    /// @notice Collects a refund that could not be delivered when the order was refunded.
    function claimRefund(address token) external nonReentrant {
        uint256 amount = refundOwed[token][msg.sender];
        if (amount == 0) revert NothingOwed();
        refundOwed[token][msg.sender] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit RefundClaimed(token, msg.sender, amount);
    }

    function _round(address feed, uint80 id) private view returns (bool, int256, uint256) {
        try AggregatorV3Interface(feed).getRoundData(id) returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            return (updatedAt != 0, answer, updatedAt);
        } catch {
            return (false, 0, 0);
        }
    }

    function _order(uint256 id) private view returns (Order storage) {
        if (id >= _orders.length) revert NotPending();
        return _orders[id];
    }
}
