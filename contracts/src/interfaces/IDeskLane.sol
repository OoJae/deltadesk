// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDeskTypes} from "./IDeskTypes.sol";

/// @title A DeltaDesk lane (FROZEN interface, M2).
/// @notice Roles:
///  - owner (immutable clone arg): the user's Vault wallet. The ONLY recipient of any value leaving the lane.
///  - operator: the agent's wallet (a separate Dynamic delegated embedded wallet). owner != operator, always.
///  - guardian (optional): a watchdog key that can only reduce risk (pause, exitAll, extend closedUntil).
/// Security properties the implementation must guarantee:
///  - Funds leave only to the owner, or into the lane's own pool via NPM mints of positions the lane owns.
///  - Risk-reducing paths (reduce, collect, exitAll, pause, withdraw*) never read the price fence and work while paused.
///  - No swaps in M2. No arbitrary calls. Approvals only to the NPM, exact amount, reset to 0 in the same call.
///  - Time limits use block.timestamp only (Arbitrum Orbit block.number is an L1 estimate).
interface IDeskLane is IDeskTypes {
    // ------------------------------------------------------------------ events
    /// @param ticks For RERANGE: [tickLower0, tickUpper0, tickLower1, tickUpper1, ...]; otherwise empty.
    /// @param refPxE18 Fence reference price (quote per base, 1e18) used for the placement fence; 0 if not read.
    event LaneAction(
        uint8 indexed lane,
        bytes32 indexed decisionId,
        Action indexed action,
        int24[] ticks,
        uint256 refPxE18,
        uint8 regime,
        uint16 gatesMask,
        bytes32 reasonHash,
        address caller
    );
    event PositionMinted(
        bytes32 indexed decisionId,
        uint8 slot,
        uint256 tokenId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );
    event PositionClosed(bytes32 indexed decisionId, uint8 slot, uint256 tokenId, uint256 amount0, uint256 amount1);
    event CollectFailed(uint256 indexed tokenId, bytes reason);
    event Withdrawn(address indexed token, uint256 amount);
    event PositionWithdrawn(uint8 slot, uint256 indexed tokenId);
    event Paused(address indexed by);
    event Unpaused();
    event OperatorProposed(address indexed operator, uint64 eta);
    event OperatorChanged(address indexed operator);
    event OperatorRevoked();
    event CapsProposed(Caps caps, uint64 eta);
    event CapsChanged(Caps caps);
    event GuardianChanged(address indexed guardian);
    event ClosedUntilSet(uint64 until, address indexed by);

    // ------------------------------------------------------------------ errors
    error NotOwner();
    error NotAuthorized();
    error NotFactory();
    error AlreadyInitialized();
    error IsPaused();
    error ZeroDecision();
    error DecisionUsed(bytes32 decisionId);
    error Expired(uint64 deadline);
    error DeadlineTooFar(uint64 deadline);
    error TooSoon(uint64 nextAllowedAt);
    /// @param kind 0 turnover, 1 reranges1h, 2 reranges24h
    error BucketEmpty(uint8 kind, uint256 need, uint256 have);
    error TooManyRanges(uint256 count);
    error BadRange(uint8 index);
    error SharesExceed();
    error RangeOutsideFence(uint8 index, int24 tickLower, int24 tickUpper, int24 refTick, int24 bandTicks);
    error PoolTickMoved(int24 tick, int24 expectedTick, uint24 maxTickDelta);
    error TickDeltaAboveCap(uint24 maxTickDelta, uint24 cap);
    /// @param code IPriceFence status code of the first failing token
    error MarketClosed(uint8 code);
    error ClosedUntilActive(uint64 until);
    error DeployCapExceeded(uint256 usd6, uint256 cap);
    error TimelockActive(uint64 eta);
    error NoPending();
    error InvalidConfig(uint8 code);
    error BadSlot(uint8 slot);
    error OperatorIsOwner();

    // ------------------------------------------------------------------ init (factory only)
    function initialize(address operator, address guardian, Caps calldata caps) external;

    // ------------------------------------------------------------------ operator | owner: risk-adding
    /// @notice Atomically: consume decisionId, check deadline/interval/buckets, require the fence open for both
    /// tokens and closedUntil passed, unwind ALL positions (decreaseLiquidity all, collect, burn; mins 0, no fence),
    /// check |slot0.tick - expectedTick| <= maxTickDelta (<= caps.maxTickDelta), check each range against the
    /// placement fence and width/alignment rules, mint each range from the idle balances by shares, check the
    /// minted notional (fence-valued) <= caps.maxDeployUsd6 and debit the turnover bucket, emit LaneAction.
    /// An empty `ranges` array is allowed only as an unwind-and-hold (then no fence read is needed).
    function rerange(Meta calldata m, RangeSpec[] calldata ranges, int24 expectedTick, uint24 maxTickDelta)
        external
        returns (uint256[] memory tokenIds, uint128[] memory liquidities, uint256 amount0Used, uint256 amount1Used);

    // ------------------------------------------------------------------ operator | owner | guardian: risk-reducing
    /// @notice Remove `liquidity` from the position in `slot` and collect it to the lane (try/catch on collect).
    function reduce(Meta calldata m, uint8 slot, uint128 liquidity) external returns (uint256 amount0, uint256 amount1);

    /// @notice Collect fees of all positions to the lane (per-position try/catch).
    function collect(Meta calldata m) external returns (uint256 amount0, uint256 amount1);

    /// @notice Unwind every position to idle tokens held by the lane (per-position/per-token try/catch). Never reverts
    /// because one token is paused or blocklisted.
    function exitAll(Meta calldata m) external;

    /// @notice Event-only: records an off-chain gate change or note under a decisionId.
    function signal(Meta calldata m) external;

    function pause() external; // operator | owner | guardian

    // ------------------------------------------------------------------ owner only
    function unpause() external;

    /// @notice Transfer `amount` of any ERC-20 held by the lane to the owner.
    function withdraw(address token, uint256 amount) external;

    /// @notice Transfer all of token0 and token1 to the owner (per-token try/catch).
    function withdrawAll() external;

    /// @notice Escape hatch: transfer the position NFT in `slot` to the owner (ERC-721 transferFrom, no hooks).
    function withdrawPosition(uint8 slot) external;

    function proposeOperator(address operator) external; // effective after 24 h via applyOperator
    function applyOperator() external;
    function revokeOperator() external; // immediate
    function setCaps(Caps calldata caps) external; // tighter-only fields apply now; any loosening -> pending 24 h
    function applyCaps() external;
    function cancelCaps() external;
    function setGuardian(address guardian) external; // immediate (guardian can only reduce risk)

    /// @notice owner or guardian: block risk-adding until `until` (e.g. a market holiday). Can only be extended by
    /// the guardian; the owner may also shorten it.
    function setClosedUntil(uint64 until) external;

    // ------------------------------------------------------------------ views
    function owner() external view returns (address);
    function operator() external view returns (address);
    function guardian() external view returns (address);
    function laneId() external view returns (uint8);
    function pool() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fence() external view returns (address);
    function paused() external view returns (bool);
    function closedUntil() external view returns (uint64);
    function caps() external view returns (Caps memory);
    function pendingOperator() external view returns (address operator, uint64 eta);
    function pendingCaps() external view returns (Caps memory caps, uint64 eta);
    function decisionUsedAt(bytes32 decisionId) external view returns (uint64);
    /// @return tokenIds position NFT ids by slot (0 = empty); length = maxRanges ceiling of the implementation (2)
    function positions() external view returns (uint256[2] memory tokenIds);
    function budgets()
        external
        view
        returns (uint256 turnoverAvailableUsd6, uint256 reranges1hLeft, uint256 reranges24hLeft, uint64 nextRerangeAt);
    /// @notice Whether risk-adding is open right now, and if not the first failing IPriceFence code (or 100 paused,
    /// 101 closedUntil active).
    function riskAddingOpen() external view returns (bool open, uint8 code);
    /// @notice Fence reference price as a pool tick (token1 per token0 in raw units), and its band in ticks.
    function refTick() external view returns (int24 tick, int24 bandTicks, uint8 code);
}
