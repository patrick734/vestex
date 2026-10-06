// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IMarkOracle} from "./interfaces/IMarkOracle.sol";
import {IPerpsBook} from "./interfaces/IPerpsBook.sol";
import {IVestexPool} from "./interfaces/IVestexPool.sol";
import {VestexPauseLog} from "./VestexPauseLog.sol";
import {Payouts} from "./libraries/Payouts.sol";

/// @title VestexPerps
/// @notice Leveraged long and short positions on Stock Tokens, margined in USDG, with the Pool on the other side.
///
///         Every open and close is an order that fills at the next Chainlink round after the one that was current
///         when it was placed. Nobody, including the trader, can choose a price that was already known when the order
///         went in, so a stale price cannot be traded against the Pool, and whether an order fills depends on that one
///         price alone: the open-interest and Pool capacity it needs are set aside when it is placed. An order whose
///         price is worse than the trader's limit keeps its trading fee and is otherwise refunded; one that gets no new
///         price within `orderWindow`, or is stopped for any reason outside the trader's control, is refunded in full.
///
///         Positions pay a trading fee on open and on close and a borrow fee over time. A position whose loss
///         reaches `liqLossBps` of its collateral can be liquidated by anyone at the latest fresh price; the
///         liquidator earns `liqRewardBps` of the collateral, paid by the Pool if the position cannot cover it, and the
///         trader keeps whatever is left. A position whose profit reaches the cap can be closed at the cap by anyone.
///
/// @dev Notional and prices are USDG (6 decimals); size is in Stock Token units. Each market's feed is copied in
///      when it is first listed and never changes, so the oracle owner cannot reprice open positions: fills,
///      liquidations and the Pool's valuation all read that copied feed.
contract VestexPerps is AccessControl, Pausable, ReentrancyGuard, IPerpsBook {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 private constant YEAR = 365 days;

    uint16 public constant MAX_FEE_BPS = 50;
    uint16 public constant MAX_PROTOCOL_SHARE_BPS = 5_000;
    uint8 public constant MAX_LEVERAGE = 10;
    uint64 public constant MAX_BORROW_RATE = 1e18;
    uint32 public constant MIN_WINDOW = 5 minutes;
    uint32 public constant MAX_WINDOW = 1 days;
    /// @notice An order still pending this long after its window can be refunded whatever happened, so nothing
    ///         outside the contract (a feed that stops answering) can hold funds forever.
    uint32 public constant ABANDON_AFTER = 7 days;
    /// @notice Opens one account may have waiting at once.
    uint8 public constant MAX_PENDING_OPENS = 3;

    enum Kind {
        OpenLong,
        OpenShort,
        Close
    }

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
        uint8 maxLeverage;
        uint40 lastAccrual;
        uint64 borrowRate;
        uint256 unit;
        uint256 maxOi;
        uint256 borrowIndex;
        uint256 longSize;
        uint256 longNotional;
        uint256 shortSize;
        uint256 shortNotional;
        uint256 indexedNotional;
        uint256 reservedLong;
        uint256 reservedShort;
    }

    struct Position {
        address owner;
        bool isLong;
        bool open;
        uint40 openedAt;
        address token;
        uint128 collateral;
        uint256 size;
        uint256 notional;
        uint256 entryPrice;
        uint256 indexAtOpen;
        uint256 closeOrder;
    }

    struct Order {
        address owner;
        Kind kind;
        Status status;
        uint40 createdAt;
        address token;
        uint128 collateral;
        uint128 fee;
        uint256 notional;
        uint256 limitPrice;
        uint256 refAnswer;
        uint80 baseRound;
        uint256 positionId;
        uint256 fillPrice;
    }

    IERC20 public immutable usdg;
    IVestexPool public immutable pool;
    IMarkOracle public immutable oracle;
    VestexPauseLog public immutable pauseLog;
    address public immutable feeRouter;

    uint16 public feeBps = 10;
    uint16 public protocolShareBps = 3_000;
    uint16 public liqLossBps = 8_000;
    uint16 public liqRewardBps = 500;
    uint32 public maxProfitBps = 90_000;
    uint32 public orderWindow = 1 hours;
    /// @notice An order is refunded if its fill price moved more than this from the price when it was placed,
    ///         which catches a feed caught mid corporate action.
    uint16 public maxMoveBps = 2_000;
    uint256 public minCollateral;
    /// @notice Oldest Chainlink update liquidations and closes at the cap accept.
    uint32 public priceMaxAge = 26 hours;

    mapping(address token => Market) private _markets;
    address[] private _tokens;
    /// @notice Notional of open positions.
    uint256 public openNotional;
    /// @notice Notional set aside for opens waiting to fill.
    uint256 public reservedNotional;

    Position[] private _positions;
    Order[] private _orders;
    uint256[] private _openIds;
    mapping(uint256 id => uint256) private _openSlot;
    mapping(address account => uint256[]) private _positionsOf;
    mapping(address account => uint256[]) private _ordersOf;
    /// @notice Refunds the token would not deliver at the time, claimable with `claimRefund`.
    mapping(address account => uint256) public refundOwed;
    mapping(address account => uint256) public pendingOpens;

    event MarketSet(address indexed token, bool enabled, uint8 maxLeverage, uint256 maxOi, uint64 borrowRate);
    event ParamsSet(uint16 feeBps, uint16 protocolShareBps, uint16 liqLossBps, uint16 liqRewardBps, uint32 maxProfitBps);
    event OrderParamsSet(uint32 orderWindow, uint16 maxMoveBps, uint256 minCollateral);
    event OrderPlaced(uint256 indexed id, address indexed owner, address indexed token, Kind kind, uint256 collateral, uint256 notional, uint256 limitPrice);
    event OrderRefunded(uint256 indexed id, string reason);
    event Opened(uint256 indexed positionId, uint256 indexed orderId, address indexed owner, address token, bool isLong, uint256 collateral, uint256 size, uint256 notional, uint256 price);
    event Closed(uint256 indexed positionId, uint256 price, int256 pnl, uint256 fees, uint256 payout);
    event Liquidated(uint256 indexed positionId, address indexed liquidator, uint256 price, int256 pnl, uint256 reward, uint256 payout);
    event CollateralAdded(uint256 indexed positionId, uint256 amount);
    event ClosedAtCap(uint256 indexed positionId, address indexed caller, uint256 price, uint256 payout);
    event PriceMaxAgeSet(uint32 seconds_);
    event RefundOwed(address indexed account, uint256 amount);
    event RefundClaimed(address indexed account, uint256 amount);

    error InvalidConfig();
    error UnknownMarket();
    error MarketClosed();
    error CorporateAction();
    error BadTerms();
    error NotOwner();
    error NotPending();
    error PositionClosed();
    error CloseAlreadyPending();
    error NoPriceYet();
    error Healthy();
    error BelowCap();
    error OverCapacity();
    error NothingOwed();

    constructor(
        IERC20 usdg_,
        IVestexPool pool_,
        IMarkOracle oracle_,
        VestexPauseLog pauseLog_,
        address feeRouter_,
        address admin,
        address guardian,
        uint256 minCollateral_
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
        minCollateral = minCollateral_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /*//////////////////////////////////////////////////////////////
                                 ORDERS
    //////////////////////////////////////////////////////////////*/

    /// @param notional Position size in USDG; `notional / collateral` is the leverage.
    /// @param limitPrice Worst fill accepted: the highest price for a long, the lowest for a short.
    function openPosition(address token, bool isLong, uint256 collateral, uint256 notional, uint256 limitPrice)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 id)
    {
        Market storage m = _markets[token];
        if (!m.enabled) revert UnknownMarket();
        if (pauseLog.flagged(token)) revert CorporateAction();
        if (!oracle.isFresh(token)) revert MarketClosed();
        if (
            collateral < minCollateral || collateral > type(uint128).max || notional < collateral
                || notional > collateral * m.maxLeverage || limitPrice == 0 || pendingOpens[msg.sender] >= MAX_PENDING_OPENS
        ) revert BadTerms();
        ++pendingOpens[msg.sender];

        // Set the capacity aside now, so the fill depends on its price alone and not on what happens in between.
        if (isLong ? m.longNotional + m.reservedLong + notional > m.maxOi : m.shortNotional + m.reservedShort + notional > m.maxOi) {
            revert OverCapacity();
        }
        if (openNotional + reservedNotional + notional > pool.capacity()) revert OverCapacity();
        if (isLong) m.reservedLong += notional;
        else m.reservedShort += notional;
        reservedNotional += notional;

        uint256 fee = Math.mulDiv(notional, feeBps, BPS);
        usdg.safeTransferFrom(msg.sender, address(this), collateral + fee);
        (uint80 base, uint256 ref) = _latestRound(m.feed);

        id = _orders.length;
        _orders.push(
            Order({
                owner: msg.sender,
                kind: isLong ? Kind.OpenLong : Kind.OpenShort,
                status: Status.Pending,
                createdAt: uint40(block.timestamp),
                token: token,
                collateral: uint128(collateral),
                fee: fee.toUint128(),
                notional: notional,
                limitPrice: limitPrice,
                refAnswer: ref,
                baseRound: base,
                positionId: 0,
                fillPrice: 0
            })
        );
        _ordersOf[msg.sender].push(id);
        emit OrderPlaced(id, msg.sender, token, isLong ? Kind.OpenLong : Kind.OpenShort, collateral, notional, limitPrice);
    }

    /// @param limitPrice Worst fill accepted: the lowest price when closing a long, the highest for a short.
    function closePosition(uint256 positionId, uint256 limitPrice) external nonReentrant returns (uint256 id) {
        Position storage p = _position(positionId);
        if (p.owner != msg.sender) revert NotOwner();
        if (!p.open) revert PositionClosed();
        if (p.closeOrder != 0) revert CloseAlreadyPending();
        if (pauseLog.flagged(p.token)) revert CorporateAction();
        (uint80 base, uint256 ref) = _latestRound(_markets[p.token].feed);

        id = _orders.length;
        _orders.push(
            Order({
                owner: msg.sender,
                kind: Kind.Close,
                status: Status.Pending,
                createdAt: uint40(block.timestamp),
                token: p.token,
                collateral: 0,
                fee: 0,
                notional: p.notional,
                limitPrice: limitPrice,
                refAnswer: ref,
                baseRound: base,
                positionId: positionId,
                fillPrice: 0
            })
        );
        p.closeOrder = id + 1;
        _ordersOf[msg.sender].push(id);
        emit OrderPlaced(id, msg.sender, p.token, Kind.Close, 0, p.notional, limitPrice);
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
        if (_moved(uint256(answer), o.refAnswer)) return _refund(id, o, "price jump");

        // The USDG rate barely moves, so its latest answer is used; an unusable one waits rather than refunds, so the
        // time of the call cannot decide the outcome.
        uint256 price = oracle.usdToUsdgMark(uint256(answer), m.feedDecimals);
        if (price == 0) revert MarketClosed();
        if (o.kind == Kind.Close) _fillClose(id, o, m, price);
        else _fillOpen(id, o, m, price);
    }

    /// @notice Refunds an order no new price arrived for within `orderWindow`, including after a feed phase change
    ///         that ended the round sequence it was waiting on. Anyone can call.
    function expire(uint256 id) external nonReentrant {
        Order storage o = _order(id);
        if (o.status != Status.Pending) revert NotPending();
        if (block.timestamp <= uint256(o.createdAt) + orderWindow) revert NoPriceYet();
        (bool reported,,) = _round(_markets[o.token].feed, o.baseRound + 1);
        // Once that round exists, `execute` decides, unless nobody could for ABANDON_AFTER.
        if (reported && block.timestamp <= uint256(o.createdAt) + orderWindow + ABANDON_AFTER) revert NoPriceYet();
        _refund(id, o, "no price in time");
    }

    /*//////////////////////////////////////////////////////////////
                               POSITIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Collects a refund that could not be delivered when the order was refunded.
    function claimRefund() external nonReentrant {
        uint256 amount = refundOwed[msg.sender];
        if (amount == 0) revert NothingOwed();
        refundOwed[msg.sender] = 0;
        usdg.safeTransfer(msg.sender, amount);
        emit RefundClaimed(msg.sender, amount);
    }

    function addCollateral(uint256 positionId, uint256 amount) external nonReentrant {
        Position storage p = _position(positionId);
        if (p.owner != msg.sender) revert NotOwner();
        if (!p.open) revert PositionClosed();
        if (amount == 0 || uint256(p.collateral) + amount > type(uint128).max) revert BadTerms();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        p.collateral += uint128(amount);
        emit CollateralAdded(positionId, amount);
    }

    /// @notice Liquidates a position whose loss has reached `liqLossBps` of its collateral, at the latest fresh
    ///         Chainlink price. Anyone can call and earns `liqRewardBps` of the collateral.
    function liquidate(uint256 positionId) external nonReentrant {
        Position storage p = _position(positionId);
        if (!p.open) revert PositionClosed();
        Market storage m = _markets[p.token];
        uint256 price = _freshPrice(p.token, m);
        _accrue(m);
        (int256 pnl, uint256 fees, int256 equity) = _settlement(p, m, price);
        int256 floor = int256(Math.mulDiv(p.collateral, BPS - liqLossBps, BPS));
        if (equity > floor) revert Healthy();

        // The reward is paid even when the position is underwater, so the ones that cost the Pool most get closed.
        uint256 left = equity > 0 ? uint256(equity) : 0;
        uint256 reward = Math.mulDiv(p.collateral, liqRewardBps, BPS);
        uint256 payout = left > reward ? left - reward : 0;
        _cancelClose(p);
        _release(positionId, p, m, fees, equity, payout);
        pool.pay(address(usdg), msg.sender, reward);
        emit Liquidated(positionId, msg.sender, price, pnl, reward, payout);
    }

    /// @notice Closes a position whose profit has reached the cap, at the latest fresh Chainlink price. Anyone can
    ///         call. The trader receives exactly what closing would pay: the capped profit, less fees.
    function closeAtCap(uint256 positionId) external nonReentrant {
        Position storage p = _position(positionId);
        if (!p.open) revert PositionClosed();
        Market storage m = _markets[p.token];
        uint256 price = _freshPrice(p.token, m);
        uint256 value = Math.mulDiv(p.size, price, m.unit);
        int256 raw = p.isLong ? int256(value) - int256(p.notional) : int256(p.notional) - int256(value);
        if (raw < int256(Math.mulDiv(p.collateral, maxProfitBps, BPS))) revert BelowCap();
        _accrue(m);
        (, uint256 fees, int256 equity) = _settlement(p, m, price);
        uint256 payout = equity > 0 ? uint256(equity) : 0;
        _cancelClose(p);
        _release(positionId, p, m, fees, equity, payout);
        emit ClosedAtCap(positionId, msg.sender, price, payout);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function netOwedToTraders() external view returns (int256 total) {
        uint256 lpShare = BPS - protocolShareBps;
        for (uint256 i; i < _tokens.length; ++i) {
            Market storage m = _markets[_tokens[i]];
            if (m.longNotional == 0 && m.shortNotional == 0) continue;
            uint256 unitPrice = _markPrice(m);
            int256 longValue = int256(Math.mulDiv(m.longSize, unitPrice, m.unit));
            int256 shortValue = int256(Math.mulDiv(m.shortSize, unitPrice, m.unit));
            total += longValue - int256(m.longNotional) + int256(m.shortNotional) - shortValue;
            total -= int256(Math.mulDiv(_accruedBorrow(m), lpShare, BPS));
        }
    }

    /// @notice Open notional plus notional set aside for opens waiting to fill, which the Pool must be able to back.
    function totalNotional() external view returns (uint256) {
        return openNotional + reservedNotional;
    }

    function openInterest(address token) external view returns (uint256) {
        Market storage m = _markets[token];
        return m.longNotional + m.shortNotional;
    }

    function market(address token) external view returns (Market memory m) {
        m = _markets[token];
        m.borrowIndex = _currentIndex(m);
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    function getPosition(uint256 id) external view returns (Position memory) {
        return _position(id);
    }

    function getOrder(uint256 id) external view returns (Order memory) {
        return _order(id);
    }

    function positionCount() external view returns (uint256) {
        return _positions.length;
    }

    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    function openPositionIds() external view returns (uint256[] memory) {
        return _openIds;
    }

    function positionsOf(address account) external view returns (uint256[] memory) {
        return _positionsOf[account];
    }

    function ordersOf(address account) external view returns (uint256[] memory) {
        return _ordersOf[account];
    }

    /// @notice Profit or loss, fees owed and what the trader would receive closing at `price` (USDG per token).
    function preview(uint256 positionId, uint256 price)
        external
        view
        returns (int256 pnl, uint256 fees, int256 equity, bool liquidatable)
    {
        Position storage p = _position(positionId);
        Market memory m = _markets[p.token];
        m.borrowIndex = _currentIndex(m);
        (pnl, fees, equity) = _settlementAt(p, m, price);
        liquidatable = p.open && equity <= int256(Math.mulDiv(p.collateral, BPS - liqLossBps, BPS));
    }

    /*//////////////////////////////////////////////////////////////
                               GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    /// @notice Lists a market or changes its limits. The feed is copied from the oracle on first listing only.
    function setMarket(address token, bool enabled, uint8 maxLeverage, uint256 maxOi, uint64 borrowRate)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (maxLeverage == 0 || maxLeverage > MAX_LEVERAGE || borrowRate > MAX_BORROW_RATE) revert InvalidConfig();
        Market storage m = _markets[token];
        if (m.feed == address(0)) {
            address feed = oracle.feedOf(token);
            if (feed == address(0) || !pool.listed(token)) revert InvalidConfig();
            m.feed = feed;
            m.feedDecimals = AggregatorV3Interface(feed).decimals();
            m.unit = 10 ** IERC20Metadata(token).decimals();
            m.lastAccrual = uint40(block.timestamp);
            _tokens.push(token);
        } else {
            _accrue(m);
        }
        m.enabled = enabled;
        m.maxLeverage = maxLeverage;
        m.maxOi = maxOi;
        m.borrowRate = borrowRate;
        emit MarketSet(token, enabled, maxLeverage, maxOi, borrowRate);
    }

    function setParams(uint16 feeBps_, uint16 protocolShareBps_, uint16 liqLossBps_, uint16 liqRewardBps_, uint32 maxProfitBps_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (
            feeBps_ > MAX_FEE_BPS || protocolShareBps_ > MAX_PROTOCOL_SHARE_BPS || liqLossBps_ < 5_000 || liqLossBps_ > 9_500
                || liqRewardBps_ > BPS - liqLossBps_ || maxProfitBps_ < BPS
        ) revert InvalidConfig();
        feeBps = feeBps_;
        protocolShareBps = protocolShareBps_;
        liqLossBps = liqLossBps_;
        liqRewardBps = liqRewardBps_;
        maxProfitBps = maxProfitBps_;
        emit ParamsSet(feeBps_, protocolShareBps_, liqLossBps_, liqRewardBps_, maxProfitBps_);
    }

    function setOrderParams(uint32 window, uint16 moveBps, uint256 minCollateral_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (window < MIN_WINDOW || window > MAX_WINDOW || moveBps == 0 || moveBps > 5_000) revert InvalidConfig();
        orderWindow = window;
        maxMoveBps = moveBps;
        minCollateral = minCollateral_;
        emit OrderParamsSet(window, moveBps, minCollateral_);
    }

    function setPriceMaxAge(uint32 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (seconds_ < 1 hours || seconds_ > 4 days) revert InvalidConfig();
        priceMaxAge = seconds_;
        emit PriceMaxAgeSet(seconds_);
    }

    /// @notice Stops new positions. Closing, filling closes, adding collateral and liquidations keep working.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _fillOpen(uint256 id, Order storage o, Market storage m, uint256 price) private {
        bool isLong = o.kind == Kind.OpenLong;
        if (paused() || !m.enabled) return _refund(id, o, "market closed");
        if (isLong ? price > o.limitPrice : price < o.limitPrice) return _refundKeepingFee(id, o);
        uint256 size = Math.mulDiv(o.notional, m.unit, price);
        if (size == 0) return _refund(id, o, "too small");

        _unreserve(o);
        _accrue(m);
        if (isLong) {
            m.longSize += size;
            m.longNotional += o.notional;
        } else {
            m.shortSize += size;
            m.shortNotional += o.notional;
        }
        m.indexedNotional += Math.mulDiv(o.notional, m.borrowIndex, WAD);
        openNotional += o.notional;

        uint256 positionId = _positions.length;
        _positions.push(
            Position({
                owner: o.owner,
                isLong: isLong,
                open: true,
                openedAt: uint40(block.timestamp),
                token: o.token,
                collateral: o.collateral,
                size: size,
                notional: o.notional,
                entryPrice: price,
                indexAtOpen: m.borrowIndex,
                closeOrder: 0
            })
        );
        _openSlot[positionId] = _openIds.length;
        _openIds.push(positionId);
        _positionsOf[o.owner].push(positionId);

        o.status = Status.Filled;
        o.positionId = positionId;
        o.fillPrice = price;

        uint256 protocolFee = Math.mulDiv(o.fee, protocolShareBps, BPS);
        if (protocolFee != 0) usdg.safeTransfer(feeRouter, protocolFee);
        if (o.fee > protocolFee) usdg.safeTransfer(address(pool), o.fee - protocolFee);
        emit Opened(positionId, id, o.owner, o.token, isLong, o.collateral, size, o.notional, price);
    }

    function _fillClose(uint256 id, Order storage o, Market storage m, uint256 price) private {
        Position storage p = _positions[o.positionId];
        p.closeOrder = 0;
        if (!p.open) return _refund(id, o, "position closed");
        if (p.isLong ? price < o.limitPrice : price > o.limitPrice) return _refund(id, o, "limit");

        _accrue(m);
        (int256 pnl, uint256 fees, int256 equity) = _settlement(p, m, price);
        uint256 payout = equity > 0 ? uint256(equity) : 0;
        o.status = Status.Filled;
        o.fillPrice = price;
        _release(o.positionId, p, m, fees, equity, payout);
        emit Closed(o.positionId, price, pnl, fees, payout);
    }

    /// @dev Takes a position off the books: its collateral goes to the Pool, which pays the trader and the
    ///      protocol's share of whatever fees the position could cover.
    function _release(uint256 positionId, Position storage p, Market storage m, uint256 fees, int256 equity, uint256 payout)
        private
    {
        if (p.isLong) {
            m.longSize -= p.size;
            m.longNotional -= p.notional;
        } else {
            m.shortSize -= p.size;
            m.shortNotional -= p.notional;
        }
        uint256 booked = Math.mulDiv(p.notional, p.indexAtOpen, WAD);
        m.indexedNotional = m.indexedNotional > booked ? m.indexedNotional - booked : 0;
        openNotional -= p.notional;
        p.open = false;

        uint256 slot = _openSlot[positionId];
        uint256 last = _openIds[_openIds.length - 1];
        _openIds[slot] = last;
        _openSlot[last] = slot;
        _openIds.pop();
        delete _openSlot[positionId];

        // Fees come out of what the position is worth; a position underwater covers only part of them.
        uint256 covered = equity >= 0 ? fees : (int256(fees) + equity > 0 ? uint256(int256(fees) + equity) : 0);
        usdg.safeTransfer(address(pool), p.collateral);
        pool.pay(address(usdg), feeRouter, Math.mulDiv(covered, protocolShareBps, BPS));
        pool.pay(address(usdg), p.owner, payout);
    }

    function _refund(uint256 id, Order storage o, string memory reason) private {
        o.status = Status.Refunded;
        if (o.kind == Kind.Close) {
            Position storage p = _positions[o.positionId];
            if (p.closeOrder == id + 1) p.closeOrder = 0;
        } else {
            _unreserve(o);
            _sendRefund(o.owner, uint256(o.collateral) + o.fee);
        }
        emit OrderRefunded(id, reason);
    }

    /// @dev An open the trader's own limit stopped: the capacity it held was real, so the trading fee is kept.
    function _refundKeepingFee(uint256 id, Order storage o) private {
        o.status = Status.Refunded;
        _unreserve(o);
        uint256 protocolFee = Math.mulDiv(o.fee, protocolShareBps, BPS);
        if (protocolFee != 0) usdg.safeTransfer(feeRouter, protocolFee);
        if (o.fee > protocolFee) usdg.safeTransfer(address(pool), o.fee - protocolFee);
        _sendRefund(o.owner, o.collateral);
        emit OrderRefunded(id, "limit");
    }

    function _sendRefund(address to, uint256 amount) private {
        if (amount == 0 || Payouts.tryTransfer(usdg, to, amount)) return;
        refundOwed[to] += amount;
        emit RefundOwed(to, amount);
    }

    function _unreserve(Order storage o) private {
        --pendingOpens[o.owner];
        Market storage m = _markets[o.token];
        if (o.kind == Kind.OpenLong) m.reservedLong -= o.notional;
        else m.reservedShort -= o.notional;
        reservedNotional -= o.notional;
    }

    function _cancelClose(Position storage p) private {
        if (p.closeOrder == 0) return;
        Order storage c = _orders[p.closeOrder - 1];
        if (c.status == Status.Pending) {
            c.status = Status.Refunded;
            emit OrderRefunded(p.closeOrder - 1, "position closed");
        }
        p.closeOrder = 0;
    }

    /// @dev The latest answer of the market's own feed, if fresh and not mid corporate action, in USDG per token.
    function _freshPrice(address token, Market storage m) private view returns (uint256) {
        (, int256 answer,, uint256 at,) = AggregatorV3Interface(m.feed).latestRoundData();
        if (answer <= 0 || at > block.timestamp || block.timestamp - at > priceMaxAge || pauseLog.flagged(token)) {
            revert MarketClosed();
        }
        try oracle.usdToUsdg(uint256(answer), m.feedDecimals) returns (uint256 p) {
            return p;
        } catch {
            revert MarketClosed();
        }
    }

    /// @dev The latest answer of the market's own feed, however old, in USDG per token; zero if unusable.
    function _markPrice(Market storage m) private view returns (uint256) {
        try AggregatorV3Interface(m.feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256, uint80) {
            return answer > 0 ? oracle.usdToUsdgMark(uint256(answer), m.feedDecimals) : 0;
        } catch {
            return 0;
        }
    }

    function _round(address feed, uint80 id) private view returns (bool, int256, uint256) {
        try AggregatorV3Interface(feed).getRoundData(id) returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            return (updatedAt != 0, answer, updatedAt);
        } catch {
            return (false, 0, 0);
        }
    }

    function _settlement(Position storage p, Market storage m, uint256 price)
        private
        view
        returns (int256 pnl, uint256 fees, int256 equity)
    {
        return _settlementAt(p, m, price);
    }

    function _settlementAt(Position storage p, Market memory m, uint256 price)
        private
        view
        returns (int256 pnl, uint256 fees, int256 equity)
    {
        uint256 value = Math.mulDiv(p.size, price, m.unit);
        pnl = p.isLong ? int256(value) - int256(p.notional) : int256(p.notional) - int256(value);
        int256 cap = int256(Math.mulDiv(p.collateral, maxProfitBps, BPS));
        if (pnl > cap) pnl = cap;
        uint256 borrow = Math.mulDiv(p.notional, m.borrowIndex - p.indexAtOpen, WAD);
        fees = borrow + Math.mulDiv(value, feeBps, BPS);
        equity = int256(uint256(p.collateral)) + pnl - int256(fees);
    }

    function _accrue(Market storage m) private {
        m.borrowIndex = _currentIndex(m);
        m.lastAccrual = uint40(block.timestamp);
    }

    function _currentIndex(Market memory m) private view returns (uint256) {
        if (block.timestamp <= m.lastAccrual) return m.borrowIndex;
        return m.borrowIndex + uint256(m.borrowRate) * (block.timestamp - m.lastAccrual) / YEAR;
    }

    function _accruedBorrow(Market storage m) private view returns (uint256) {
        uint256 owedNow = Math.mulDiv(m.longNotional + m.shortNotional, _currentIndex(m), WAD);
        return owedNow > m.indexedNotional ? owedNow - m.indexedNotional : 0;
    }

    function _moved(uint256 answer, uint256 ref) private view returns (bool) {
        uint256 diff = answer > ref ? answer - ref : ref - answer;
        return diff * BPS > ref * maxMoveBps;
    }

    function _latestRound(address feed) private view returns (uint80, uint256) {
        (uint80 id, int256 answer,,,) = AggregatorV3Interface(feed).latestRoundData();
        if (answer <= 0) revert MarketClosed();
        return (id, uint256(answer));
    }

    function _position(uint256 id) private view returns (Position storage) {
        if (id >= _positions.length) revert PositionClosed();
        return _positions[id];
    }

    function _order(uint256 id) private view returns (Order storage) {
        if (id >= _orders.length) revert NotPending();
        return _orders[id];
    }
}
