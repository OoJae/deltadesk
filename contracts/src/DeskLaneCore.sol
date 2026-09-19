// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IDeskLane} from "./interfaces/IDeskLane.sol";
import {IDeskLaneFactory} from "./interfaces/IDeskLaneFactory.sol";
import {IPriceFence} from "./interfaces/IPriceFence.sol";
import {CapsLib} from "./libraries/CapsLib.sol";
import {CloneArgs} from "./libraries/CloneArgs.sol";
import {PriceMath} from "./libraries/PriceMath.sol";
import {TokenBucket} from "./libraries/TokenBucket.sol";

/// @title Venue-independent part of a DeltaDesk lane: roles, timelocks, decisionIds, budgets, pause and owner exits.
/// @notice Deployed as an EIP-1167 clone with immutable args (see CloneArgs); the args are re-read from the clone's
/// code once per call. The implementation contract itself is locked: initialize() reverts and every function that
/// needs the clone args reverts with NotAuthorized.
/// Venue implementations (DeskLaneV3) add the position lifecycle: rerange, reduce, collect, exitAll and
/// withdrawPosition. Time limits use block.timestamp only.
abstract contract DeskLaneCore is IDeskLane, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using TokenBucket for TokenBucket.Bucket;

    /// @notice Position slots per lane (the IDeskLane.positions() array length).
    uint256 internal constant MAX_SLOTS = 2;
    uint256 internal constant TIMELOCK = 24 hours;
    uint256 internal constant BPS = 10_000;

    // riskAddingOpen() codes beyond the IPriceFence range.
    uint8 internal constant CODE_PAUSED = 100;
    uint8 internal constant CODE_CLOSED_UNTIL = 101;
    uint8 internal constant CODE_FEED_DEAD = 2; // IPriceFence FEED_DEAD, used when the fence price has no pool tick

    // InvalidConfig codes.
    uint8 internal constant CFG_ZERO_ADDRESS = 1;
    uint8 internal constant CFG_CAPS_SHAPE = 2; // maxRanges > MAX_SLOTS or minWidthTicks > maxWidthTicks
    uint8 internal constant CFG_ABOVE_CEILING = 3; // some field looser than the implementation's CEILINGS
    uint8 internal constant CFG_TOKEN_DECIMALS = 4;
    uint8 internal constant CFG_NPM_MISMATCH = 5;

    /// @notice The only caller of initialize().
    address public immutable FACTORY;
    IPriceFence public immutable FENCE;
    address private immutable _SELF;

    // Absolute caps ceiling, copied from the factory when the implementation is deployed (CapsLib.pack words).
    uint256 private immutable _CEIL0;
    uint256 private immutable _CEIL1;
    uint256 private immutable _CEIL2;

    // ------------------------------------------------------------------ storage (per clone)
    address internal _operator;
    bool internal _paused;
    uint64 internal _closedUntil;
    bool internal _initialized;

    address internal _pendingOperator;
    uint64 internal _pendingOperatorEta;

    address internal _guardian;
    uint64 internal _lastRerangeAt;

    uint256[3] internal _caps; // CapsLib.pack words
    uint256[3] internal _pendingCaps; // CapsLib.pack words
    uint64 internal _pendingCapsEta;

    TokenBucket.Bucket internal _turnover; // usd6, 24 h
    TokenBucket.Bucket internal _rr1h; // reranges, 1 h
    TokenBucket.Bucket internal _rr24h; // reranges, 24 h

    uint256[2] internal _tokenIds;
    mapping(bytes32 decisionId => uint64 usedAt) internal _decisionUsedAt;

    constructor(address factory, address priceFence) {
        if (factory == address(0) || priceFence == address(0)) revert InvalidConfig(CFG_ZERO_ADDRESS);
        FACTORY = factory;
        FENCE = IPriceFence(priceFence);
        _SELF = address(this);
        uint256[3] memory ceil = CapsLib.pack(IDeskLaneFactory(factory).ceilings());
        (_CEIL0, _CEIL1, _CEIL2) = (ceil[0], ceil[1], ceil[2]);
        _initialized = true; // lock the implementation
    }

    // ------------------------------------------------------------------ init

    /// @inheritdoc IDeskLane
    function initialize(address operator_, address guardian_, Caps memory caps_) external {
        if (msg.sender != FACTORY) revert NotFactory();
        if (_initialized) revert AlreadyInitialized();
        CloneArgs.Args memory a = _args();
        if (operator_ == address(0) || a.owner == address(0)) revert InvalidConfig(CFG_ZERO_ADDRESS);
        if (operator_ == a.owner) revert OperatorIsOwner();
        if (a.dec0 > PriceMath.MAX_DECIMALS || a.dec1 > PriceMath.MAX_DECIMALS) {
            revert InvalidConfig(CFG_TOKEN_DECIMALS);
        }
        _checkCaps(caps_);
        _initialized = true;
        _operator = operator_;
        _guardian = guardian_;
        _writeCaps(caps_);
        _turnover.fill(caps_.turnoverUsd6PerDay, block.timestamp);
        _rr1h.fill(caps_.reranges1h, block.timestamp);
        _rr24h.fill(caps_.reranges24h, block.timestamp);
        emit OperatorChanged(operator_);
        if (guardian_ != address(0)) emit GuardianChanged(guardian_);
        emit CapsChanged(caps_);
    }

    // ------------------------------------------------------------------ operator | owner

    /// @inheritdoc IDeskLane
    function signal(Meta calldata m) external {
        CloneArgs.Args memory a = _args();
        _requireOperatorOrOwner(a.owner);
        _spend(m);
        _emitAction(a.laneId, m, Action.SIGNAL, new int24[](0), 0);
    }

    // ------------------------------------------------------------------ operator | owner | guardian

    /// @inheritdoc IDeskLane
    function pause() external {
        CloneArgs.Args memory a = _args();
        _requireReducer(a.owner);
        _paused = true;
        emit Paused(msg.sender);
        _emitOwnerAction(a.laneId, Action.PAUSE);
    }

    // ------------------------------------------------------------------ owner | guardian

    /// @inheritdoc IDeskLane
    function setClosedUntil(uint64 until) external {
        CloneArgs.Args memory a = _args();
        if (msg.sender != a.owner) {
            // The guardian may only extend the closure.
            if (msg.sender != _guardian || until < _closedUntil) revert NotAuthorized();
        }
        _closedUntil = until;
        emit ClosedUntilSet(until, msg.sender);
        _emitOwnerAction(a.laneId, Action.SET_CLOSED_UNTIL);
    }

    // ------------------------------------------------------------------ owner only

    /// @inheritdoc IDeskLane
    function unpause() external {
        CloneArgs.Args memory a = _args();
        _requireOwner(a.owner);
        _paused = false;
        emit Unpaused();
        _emitOwnerAction(a.laneId, Action.UNPAUSE);
    }

    /// @inheritdoc IDeskLane
    function withdraw(address token, uint256 amount) external nonReentrant {
        CloneArgs.Args memory a = _args();
        _requireOwner(a.owner);
        IERC20(token).safeTransfer(a.owner, amount);
        emit Withdrawn(token, amount);
        _emitOwnerAction(a.laneId, Action.WITHDRAW);
    }

    /// @inheritdoc IDeskLane
    function withdrawAll() external nonReentrant {
        CloneArgs.Args memory a = _args();
        _requireOwner(a.owner);
        _tryWithdrawAll(a.token0, a.owner);
        _tryWithdrawAll(a.token1, a.owner);
        _emitOwnerAction(a.laneId, Action.WITHDRAW);
    }

    /// @inheritdoc IDeskLane
    function proposeOperator(address operator_) external {
        CloneArgs.Args memory a = _args();
        _requireOwner(a.owner);
        if (operator_ == address(0)) revert InvalidConfig(CFG_ZERO_ADDRESS);
        if (operator_ == a.owner) revert OperatorIsOwner();
        uint64 eta = uint64(block.timestamp + TIMELOCK);
        _pendingOperator = operator_;
        _pendingOperatorEta = eta;
        emit OperatorProposed(operator_, eta);
        _emitOwnerAction(a.laneId, Action.SET_OPERATOR);
    }

    /// @inheritdoc IDeskLane
    function applyOperator() external {
        CloneArgs.Args memory a = _args();
        _requireOwner(a.owner);
        address next = _pendingOperator;
        if (next == address(0)) revert NoPending();
        if (block.timestamp < _pendingOperatorEta) revert TimelockActive(_pendingOperatorEta);
        _operator = next;
        delete _pendingOperator;
        delete _pendingOperatorEta;
        emit OperatorChanged(next);
        _emitOwnerAction(a.laneId, Action.SET_OPERATOR);
    }

    /// @inheritdoc IDeskLane
    /// @dev Also cancels a pending operator proposal.
    function revokeOperator() external {
        CloneArgs.Args memory a = _args();
        _requireOwner(a.owner);
        delete _operator;
        delete _pendingOperator;
        delete _pendingOperatorEta;
        emit OperatorRevoked();
        _emitOwnerAction(a.laneId, Action.SET_OPERATOR);
    }

    /// @inheritdoc IDeskLane
    /// @dev `target` is the full desired Caps. Fields tighter than the current caps apply now; if any field is looser,
    /// the whole `target` becomes the pending proposal (eta now + 24 h). Every call supersedes any earlier pending
    /// proposal, so a tighten-only call also cancels a pending loosening. `target` must be well-formed and within the
    /// implementation's CEILINGS. The immediately applied caps may transiently have minWidthTicks > maxWidthTicks
    /// (no range fits), which only blocks risk-adding.
    function setCaps(Caps memory target) external {
        CloneArgs.Args memory a = _args();
        _requireOwner(a.owner);
        _checkCaps(target);
        Caps memory cur = _loadCaps(_caps);
        (Caps memory now_, bool looser) = CapsLib.tighterOf(cur, target);
        if (!CapsLib.eq(now_, cur)) {
            _writeCaps(now_);
            emit CapsChanged(now_);
        }
        if (looser) {
            uint64 eta = uint64(block.timestamp + TIMELOCK);
            _writePendingCaps(target, eta);
            emit CapsProposed(target, eta);
        } else if (_pendingCapsEta != 0) {
            _writePendingCaps(_zeroCaps(), 0);
        }
        _emitOwnerAction(a.laneId, Action.SET_CAPS);
    }

    /// @inheritdoc IDeskLane
    function applyCaps() external {
        CloneArgs.Args memory a = _args();
        _requireOwner(a.owner);
        uint64 eta = _pendingCapsEta;
        if (eta == 0) revert NoPending();
        if (block.timestamp < eta) revert TimelockActive(eta);
        Caps memory next = _loadCaps(_pendingCaps);
        _writeCaps(next);
        _writePendingCaps(_zeroCaps(), 0);
        emit CapsChanged(next);
        _emitOwnerAction(a.laneId, Action.SET_CAPS);
    }

    /// @inheritdoc IDeskLane
    function cancelCaps() external {
        CloneArgs.Args memory a = _args();
        _requireOwner(a.owner);
        if (_pendingCapsEta == 0) revert NoPending();
        _writePendingCaps(_zeroCaps(), 0);
        _emitOwnerAction(a.laneId, Action.SET_CAPS);
    }

    /// @inheritdoc IDeskLane
    function setGuardian(address guardian_) external {
        CloneArgs.Args memory a = _args();
        _requireOwner(a.owner);
        _guardian = guardian_;
        emit GuardianChanged(guardian_);
        _emitOwnerAction(a.laneId, Action.SET_GUARDIAN);
    }

    // ------------------------------------------------------------------ views

    function owner() external view returns (address) {
        return _args().owner;
    }

    function operator() external view returns (address) {
        return _operator;
    }

    function guardian() external view returns (address) {
        return _guardian;
    }

    function laneId() external view returns (uint8) {
        return _args().laneId;
    }

    function pool() external view returns (address) {
        return _args().pool;
    }

    function token0() external view returns (address) {
        return _args().token0;
    }

    function token1() external view returns (address) {
        return _args().token1;
    }

    function fence() external view returns (address) {
        return address(FENCE);
    }

    function paused() external view returns (bool) {
        return _paused;
    }

    function closedUntil() external view returns (uint64) {
        return _closedUntil;
    }

    function caps() external view returns (Caps memory) {
        return _loadCaps(_caps);
    }

    function pendingOperator() external view returns (address operator_, uint64 eta) {
        return (_pendingOperator, _pendingOperatorEta);
    }

    function pendingCaps() external view returns (Caps memory caps_, uint64 eta) {
        return (_loadCaps(_pendingCaps), _pendingCapsEta);
    }

    function decisionUsedAt(bytes32 decisionId) external view returns (uint64) {
        return _decisionUsedAt[decisionId];
    }

    function positions() external view returns (uint256[2] memory tokenIds) {
        return _tokenIds;
    }

    /// @notice The clone's pool args in one read: (fee, tickSpacing, dec0, dec1).
    function poolParams() external view returns (uint24 fee, int24 tickSpacing, uint8 dec0, uint8 dec1) {
        CloneArgs.Args memory a = _args();
        return (a.fee, a.tickSpacing, a.dec0, a.dec1);
    }

    /// @notice The absolute caps ceiling of this implementation (setCaps and initialize enforce it).
    function CEILINGS() external view returns (Caps memory) {
        return _ceilings();
    }

    /// @notice Block timestamp of the last risk-adding rerange (0 if none).
    function lastRerangeAt() external view returns (uint64) {
        return _lastRerangeAt;
    }

    /// @inheritdoc IDeskLane
    /// @dev nextRerangeAt is 0 before the first risk-adding rerange.
    function budgets()
        external
        view
        returns (uint256 turnoverAvailableUsd6, uint256 reranges1hLeft, uint256 reranges24hLeft, uint64 nextRerangeAt)
    {
        Caps memory c = _loadCaps(_caps);
        turnoverAvailableUsd6 = TokenBucket.available(_turnover, c.turnoverUsd6PerDay, 1 days, block.timestamp);
        reranges1hLeft = TokenBucket.available(_rr1h, c.reranges1h, 1 hours, block.timestamp);
        reranges24hLeft = TokenBucket.available(_rr24h, c.reranges24h, 1 days, block.timestamp);
        uint64 last = _lastRerangeAt;
        nextRerangeAt = last == 0 ? 0 : last + c.minRerangeInterval;
    }

    /// @inheritdoc IDeskLane
    function riskAddingOpen() external view returns (bool open, uint8 code) {
        CloneArgs.Args memory a = _args();
        if (_paused) return (false, CODE_PAUSED);
        if (_closedUntil > block.timestamp) return (false, CODE_CLOSED_UNTIL);
        (, code) = _fencePrice(a.token0);
        if (code == 0) (, code) = _fencePrice(a.token1);
        open = code == 0;
    }

    /// @inheritdoc IDeskLane
    /// @dev For fence codes 3-6 the feeds are sound, so the tick is still computed and returned with the code.
    function refTick() external view returns (int24 tick, int24 bandTicks, uint8 code) {
        CloneArgs.Args memory a = _args();
        bandTicks = PriceMath.bandTicks(uint16(CapsLib.packedField(_caps[0], 2)));
        (uint256 p0, uint8 c0) = _fencePrice(a.token0);
        (uint256 p1, uint8 c1) = _fencePrice(a.token1);
        code = c0 != 0 ? c0 : c1;
        bool ok;
        (tick, ok) = PriceMath.refTick(p0, p1, a.dec0, a.dec1);
        if (!ok && code == 0) code = CODE_FEED_DEAD;
    }

    // ------------------------------------------------------------------ internal

    /// @dev The clone's immutable args. Reverts on the implementation itself and on anything that is not a lane clone.
    function _args() internal view returns (CloneArgs.Args memory) {
        if (address(this) == _SELF) revert NotAuthorized();
        bytes memory b = Clones.fetchCloneArgs(address(this));
        if (b.length != CloneArgs.LENGTH) revert NotAuthorized();
        return CloneArgs.decode(b);
    }

    function _requireOwner(address owner_) internal view {
        if (msg.sender != owner_) revert NotOwner();
    }

    function _requireOperatorOrOwner(address owner_) internal view {
        if (msg.sender != _operator && msg.sender != owner_) revert NotAuthorized();
    }

    /// @dev Risk-reducing callers: operator, owner or guardian (msg.sender is never address(0), so an unset role
    /// matches nobody).
    function _requireReducer(address owner_) internal view {
        if (msg.sender != _operator && msg.sender != owner_ && msg.sender != _guardian) revert NotAuthorized();
    }

    /// @dev Spend the decisionId (before any external call) and check the deadline window. A reverted call rolls the
    /// write back, so it spends nothing.
    function _spend(Meta calldata m) internal {
        bytes32 id = m.decisionId;
        if (id == bytes32(0)) revert ZeroDecision();
        if (_decisionUsedAt[id] != 0) revert DecisionUsed(id);
        _decisionUsedAt[id] = uint64(block.timestamp);
        if (block.timestamp > m.deadline) revert Expired(m.deadline);
        // maxDeadlineAhead is field 9 (word 2).
        if (m.deadline > block.timestamp + CapsLib.packedField(_caps[2], 9)) revert DeadlineTooFar(m.deadline);
    }

    /// @dev Risk-adding admission: closedUntil passed, fence open for both tokens, min interval, and one unit from
    /// each rerange bucket. Returns the fence prices (USD per whole token, 1e18).
    function _admitRiskAdding(CloneArgs.Args memory a, Caps memory c) internal returns (uint256 p0, uint256 p1) {
        uint64 until = _closedUntil;
        if (until > block.timestamp) revert ClosedUntilActive(until);
        uint8 code;
        (p0, code) = _fencePrice(a.token0);
        if (code != 0) revert MarketClosed(code);
        (p1, code) = _fencePrice(a.token1);
        if (code != 0) revert MarketClosed(code);
        uint256 next = uint256(_lastRerangeAt) + c.minRerangeInterval;
        if (block.timestamp < next) revert TooSoon(uint64(next));
        (bool ok, uint256 have) = _rr1h.consume(c.reranges1h, 1 hours, 1, block.timestamp);
        if (!ok) revert BucketEmpty(1, 1, have);
        (ok, have) = _rr24h.consume(c.reranges24h, 1 days, 1, block.timestamp);
        if (!ok) revert BucketEmpty(2, 1, have);
    }

    function _fencePrice(address token) internal view returns (uint256 priceE18, uint8 code) {
        (priceE18,, code) = FENCE.usdPrice(token);
    }

    /// @dev Debit the fence-valued notional of a rerange from the per-rerange cap and the turnover bucket.
    function _chargeNotional(CloneArgs.Args memory a, Caps memory c, uint256 p0, uint256 p1, uint256 u0, uint256 u1)
        internal
    {
        uint256 usd6 = PriceMath.usd6(u0, p0, a.dec0) + PriceMath.usd6(u1, p1, a.dec1);
        if (usd6 > c.maxDeployUsd6) revert DeployCapExceeded(usd6, c.maxDeployUsd6);
        (bool ok, uint256 have) = _turnover.consume(c.turnoverUsd6PerDay, 1 days, usd6, block.timestamp);
        if (!ok) revert BucketEmpty(0, usd6, have);
    }

    function _checkCaps(Caps memory c) internal view {
        if (c.maxRanges > MAX_SLOTS || c.minWidthTicks > c.maxWidthTicks) revert InvalidConfig(CFG_CAPS_SHAPE);
        if (CapsLib.firstAboveCeiling(c, _ceilings()) != CapsLib.NONE) revert InvalidConfig(CFG_ABOVE_CEILING);
    }

    function _loadCaps(uint256[3] storage src) internal pure returns (Caps memory) {
        return CapsLib.unpack(src);
    }

    function _writeCaps(Caps memory c) internal {
        _caps = CapsLib.pack(c);
    }

    function _writePendingCaps(Caps memory c, uint64 eta) internal {
        _pendingCaps = CapsLib.pack(c);
        _pendingCapsEta = eta;
    }

    function _zeroCaps() internal pure returns (Caps memory z) {}

    function _ceilings() internal view returns (Caps memory) {
        return CapsLib.unpack([_CEIL0, _CEIL1, _CEIL2]);
    }

    /// @dev Send the whole balance of `token` to the owner; a paused/blocklisted token is skipped, never reverts.
    function _tryWithdrawAll(address token, address to) private {
        uint256 bal;
        try IERC20(token).balanceOf(address(this)) returns (uint256 b) {
            bal = b;
        } catch {
            return;
        }
        if (bal != 0 && IERC20(token).trySafeTransfer(to, bal)) emit Withdrawn(token, bal);
    }

    function _emitAction(uint8 laneId_, Meta calldata m, Action action, int24[] memory ticks, uint256 refPxE18)
        internal
    {
        emit LaneAction(laneId_, m.decisionId, action, ticks, refPxE18, m.regime, m.gatesMask, m.reasonHash, msg.sender);
    }

    /// @dev LaneAction for calls without a Meta (owner/guardian config, pause, withdrawals): decisionId 0.
    function _emitOwnerAction(uint8 laneId_, Action action) internal {
        emit LaneAction(laneId_, bytes32(0), action, new int24[](0), 0, 0, 0, bytes32(0), msg.sender);
    }
}
