// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {DeskLaneCore} from "./DeskLaneCore.sol";
import {IDeskLane} from "./interfaces/IDeskLane.sol";
import {IDeskLaneFactory} from "./interfaces/IDeskLaneFactory.sol";
import {INonfungiblePositionManagerMin as INPM} from "./interfaces/external/INonfungiblePositionManagerMin.sol";
import {IUniswapV3PoolMin} from "./interfaces/external/IUniswapV3PoolMin.sol";
import {CloneArgs} from "./libraries/CloneArgs.sol";
import {PriceMath} from "./libraries/PriceMath.sol";
import {RangeRules} from "./libraries/RangeRules.sol";

/// @title DeltaDesk lane on a Uniswap v3 pool, holding liquidity as NonfungiblePositionManager positions.
/// @notice No swaps, no arbitrary calls, no receive(), no onERC721Received (so a safeTransferFrom of any NFT to the
/// lane reverts; the NPM mints with _mint and needs no hook). Approvals go only to the NPM, for the exact mint
/// amounts, and are reset to 0 in the same call. Every collect targets the lane itself; value leaves only through
/// the owner-only withdraw paths.
contract DeskLaneV3 is DeskLaneCore {
    using SafeERC20 for IERC20;

    INPM public immutable NPM;
    address public immutable V3_FACTORY;

    /// @dev Pool state and fence reference for one rerange.
    struct Placement {
        uint256 p0; // fence USD price of token0 (1e18)
        uint256 p1; // fence USD price of token1 (1e18)
        int24 tick; // pool slot0 tick
        int24 ref; // fence reference tick
        int24 band; // placement band, ticks
    }

    struct Minted {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0;
        uint256 amount1;
    }

    constructor(address factory, address npm, address priceFence) DeskLaneCore(factory, priceFence) {
        if (npm == address(0)) revert InvalidConfig(CFG_ZERO_ADDRESS);
        address v3Factory = IDeskLaneFactory(factory).V3_FACTORY();
        // The NPM must mint into pools of the same v3 factory the lane factory validates pools against.
        if (INPM(npm).factory() != v3Factory) revert InvalidConfig(CFG_NPM_MISMATCH);
        NPM = INPM(npm);
        V3_FACTORY = v3Factory;
    }

    // ------------------------------------------------------------------ operator | owner: risk-adding

    /// @inheritdoc IDeskLane
    function rerange(Meta calldata m, RangeSpec[] memory ranges, int24 expectedTick, uint24 maxTickDelta)
        external
        nonReentrant
        returns (uint256[] memory tokenIds, uint128[] memory liquidities, uint256 amount0Used, uint256 amount1Used)
    {
        CloneArgs.Args memory a = _args();
        _requireOperatorOrOwner(a.owner);
        if (_paused) revert IsPaused();
        _spend(m);
        Caps memory c = _loadCaps(_caps);
        if (ranges.length > c.maxRanges) revert TooManyRanges(ranges.length);

        Placement memory pl;
        if (ranges.length != 0) (pl.p0, pl.p1) = _admitRiskAdding(a, c);

        for (uint8 slot; slot < MAX_SLOTS; ++slot) {
            uint256 tokenId = _tokenIds[slot];
            if (tokenId != 0) _remove(slot, tokenId, m.decisionId, type(uint128).max, false);
        }
        if (ranges.length == 0) {
            // Unwind-and-hold: risk-reducing, reads no fence and spends no budget.
            _emitAction(a.laneId, m, Action.RERANGE, new int24[](0), 0);
            return (tokenIds, liquidities, 0, 0);
        }

        _placement(a, c, pl, expectedTick, maxTickDelta);
        int24[] memory ticks = _checkRanges(a, c, pl, ranges);
        (tokenIds, liquidities, amount0Used, amount1Used) = _mintAll(a, m.decisionId, ranges);
        _chargeNotional(a, c, pl.p0, pl.p1, amount0Used, amount1Used);
        _lastRerangeAt = uint64(block.timestamp);
        _emitAction(a.laneId, m, Action.RERANGE, ticks, PriceMath.refPxE18(pl.p0, pl.p1));
    }

    // ------------------------------------------------------------------ risk-reducing (no fence, allowed while paused)

    /// @inheritdoc IDeskLane
    /// @dev `liquidity` above the position's liquidity is clamped to it; 0 only collects. The position is burned and
    /// its slot freed once its liquidity is 0 and the collect succeeded.
    function reduce(Meta calldata m, uint8 slot, uint128 liquidity)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        CloneArgs.Args memory a = _args();
        _requireReducer(a.owner);
        _spend(m);
        (amount0, amount1) = _remove(slot, _slotToken(slot), m.decisionId, liquidity, false);
        _emitAction(a.laneId, m, Action.REDUCE, new int24[](0), 0);
    }

    /// @inheritdoc IDeskLane
    function collect(Meta calldata m) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        CloneArgs.Args memory a = _args();
        _requireOperatorOrOwner(a.owner);
        _spend(m);
        for (uint256 slot; slot < MAX_SLOTS; ++slot) {
            uint256 tokenId = _tokenIds[slot];
            if (tokenId == 0) continue;
            (, uint256 x0, uint256 x1) = _tryCollect(tokenId);
            amount0 += x0;
            amount1 += x1;
        }
        _emitAction(a.laneId, m, Action.COLLECT, new int24[](0), 0);
    }

    /// @inheritdoc IDeskLane
    /// @dev Every NPM call is checked per slot: a failing slot (e.g. a paused token makes the collect transfer revert)
    /// is kept and emits CollectFailed; tokens stay idle in the lane.
    function exitAll(Meta calldata m) external nonReentrant {
        CloneArgs.Args memory a = _args();
        _requireReducer(a.owner);
        _spend(m);
        for (uint8 slot; slot < MAX_SLOTS; ++slot) {
            uint256 tokenId = _tokenIds[slot];
            if (tokenId != 0) _remove(slot, tokenId, m.decisionId, type(uint128).max, true);
        }
        _emitAction(a.laneId, m, Action.EXIT_ALL, new int24[](0), 0);
    }

    // ------------------------------------------------------------------ owner only

    /// @inheritdoc IDeskLane
    function withdrawPosition(uint8 slot) external nonReentrant {
        CloneArgs.Args memory a = _args();
        _requireOwner(a.owner);
        uint256 tokenId = _slotToken(slot);
        _tokenIds[slot] = 0;
        NPM.transferFrom(address(this), a.owner, tokenId);
        emit PositionWithdrawn(slot, tokenId);
        _emitOwnerAction(a.laneId, Action.WITHDRAW_POSITION);
    }

    // ------------------------------------------------------------------ internal: placement

    /// @dev Execution-time tick guard and the fence reference tick.
    function _placement(
        CloneArgs.Args memory a,
        Caps memory c,
        Placement memory pl,
        int24 expectedTick,
        uint24 maxTickDelta
    ) internal view {
        if (maxTickDelta > c.maxTickDelta) revert TickDeltaAboveCap(maxTickDelta, c.maxTickDelta);
        (bool success, bytes memory ret) = a.pool.staticcall(abi.encodeCall(IUniswapV3PoolMin.slot0, ()));
        if (!success || ret.length < 64) revert PoolTickMoved(0, expectedTick, maxTickDelta);
        int24 tick = int24(int256(_word(ret, 1)));
        int256 diff = int256(tick) - int256(expectedTick);
        if (diff < 0) diff = -diff;
        if (uint256(diff) > maxTickDelta) revert PoolTickMoved(tick, expectedTick, maxTickDelta);
        (int24 ref, bool ok) = PriceMath.refTick(pl.p0, pl.p1, a.dec0, a.dec1);
        if (!ok) revert MarketClosed(CODE_FEED_DEAD);
        pl.tick = tick;
        pl.ref = ref;
        pl.band = PriceMath.bandTicks(c.placeBandBps);
    }

    /// @dev Shape, uniqueness, share sums and the placement fence. Returns [tl0, tu0, tl1, tu1, ...] for LaneAction.
    function _checkRanges(CloneArgs.Args memory a, Caps memory c, Placement memory pl, RangeSpec[] memory ranges)
        internal
        pure
        returns (int24[] memory ticks)
    {
        uint256 n = ranges.length;
        ticks = new int24[](2 * n);
        uint256 sum0;
        uint256 sum1;
        for (uint256 i; i < n; ++i) {
            RangeSpec memory r = ranges[i];
            if (
                !RangeRules.shapeOk(r.tickLower, r.tickUpper, a.tickSpacing, c.minWidthTicks, c.maxWidthTicks)
                    || (r.share0Bps == 0 && r.share1Bps == 0)
            ) revert BadRange(uint8(i));
            for (uint256 j; j < i; ++j) {
                if (ranges[j].tickLower == r.tickLower && ranges[j].tickUpper == r.tickUpper) {
                    revert BadRange(uint8(i));
                }
            }
            sum0 += r.share0Bps;
            sum1 += r.share1Bps;
            if (!RangeRules.check(r.tickLower, r.tickUpper, pl.tick, pl.ref, pl.band)) {
                revert RangeOutsideFence(uint8(i), r.tickLower, r.tickUpper, pl.ref, pl.band);
            }
            ticks[2 * i] = r.tickLower;
            ticks[2 * i + 1] = r.tickUpper;
        }
        if (sum0 > BPS || sum1 > BPS) revert SharesExceed();
    }

    // ------------------------------------------------------------------ internal: mint

    /// @dev Mint every range from the idle balances after the unwind, by shares.
    function _mintAll(CloneArgs.Args memory a, bytes32 decisionId, RangeSpec[] memory ranges)
        internal
        returns (uint256[] memory tokenIds, uint128[] memory liquidities, uint256 used0, uint256 used1)
    {
        uint256 n = ranges.length;
        tokenIds = new uint256[](n);
        liquidities = new uint128[](n);
        uint256 bal0 = IERC20(a.token0).balanceOf(address(this));
        uint256 bal1 = IERC20(a.token1).balanceOf(address(this));
        for (uint256 i; i < n; ++i) {
            RangeSpec memory r = ranges[i];
            Minted memory mt =
                _mintRange(a, r.tickLower, r.tickUpper, bal0 * r.share0Bps / BPS, bal1 * r.share1Bps / BPS);
            uint8 slot = _freeSlot(n);
            _tokenIds[slot] = mt.tokenId;
            emit PositionMinted(
                decisionId, slot, mt.tokenId, r.tickLower, r.tickUpper, mt.liquidity, mt.amount0, mt.amount1
            );
            tokenIds[i] = mt.tokenId;
            liquidities[i] = mt.liquidity;
            used0 += mt.amount0;
            used1 += mt.amount1;
        }
    }

    /// @dev Exact approvals to the NPM, mint to the lane, then reset both approvals to 0.
    function _mintRange(CloneArgs.Args memory a, int24 tl, int24 tu, uint256 amt0, uint256 amt1)
        internal
        returns (Minted memory mt)
    {
        if (amt0 != 0) IERC20(a.token0).forceApprove(address(NPM), amt0);
        if (amt1 != 0) IERC20(a.token1).forceApprove(address(NPM), amt1);
        (mt.tokenId, mt.liquidity, mt.amount0, mt.amount1) = NPM.mint(
            INPM.MintParams({
                token0: a.token0,
                token1: a.token1,
                fee: a.fee,
                tickLower: tl,
                tickUpper: tu,
                amount0Desired: amt0,
                amount1Desired: amt1,
                amount0Min: 0, // the tick guard and placement fence checked the price in this transaction
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        if (amt0 != 0) IERC20(a.token0).forceApprove(address(NPM), 0);
        if (amt1 != 0) IERC20(a.token1).forceApprove(address(NPM), 0);
    }

    function _freeSlot(uint256 wanted) internal view returns (uint8) {
        for (uint8 s; s < MAX_SLOTS; ++s) {
            if (_tokenIds[s] == 0) return s;
        }
        revert TooManyRanges(wanted); // a slot kept by a failed unwind leaves too few free slots
    }

    // ------------------------------------------------------------------ internal: remove

    /// @dev Remove min(want, liquidity) from the position (mins 0), collect everything owed to the lane, and burn the
    /// NFT and free the slot once its liquidity is 0 and the full collect succeeded. A failed collect is always
    /// tolerated (CollectFailed; the slot is kept; see _tryCollect). With `tolerant` (exitAll) a failed position read, decrease or burn is
    /// tolerated too, so exits never revert on one bad slot; otherwise those failures revert the call.
    function _remove(uint8 slot, uint256 tokenId, bytes32 decisionId, uint128 want, bool tolerant)
        internal
        returns (uint256 amount0, uint256 amount1)
    {
        (bool ok, bytes memory ret) = address(NPM).staticcall(abi.encodeCall(INPM.positions, (tokenId)));
        if (!ok || ret.length < 384) return _failed(tokenId, ret, tolerant);
        uint128 liquidity = uint128(_word(ret, 7));
        uint128 take = want < liquidity ? want : liquidity;
        if (take != 0) {
            (ok, ret) = address(NPM)
                .call(
                    abi.encodeCall(
                        INPM.decreaseLiquidity,
                        (INPM.DecreaseLiquidityParams({
                                tokenId: tokenId,
                                liquidity: take,
                                amount0Min: 0,
                                amount1Min: 0,
                                deadline: block.timestamp
                            }))
                    )
                );
            if (!ok) return _failed(tokenId, ret, tolerant);
        }
        (ok, amount0, amount1) = _tryCollect(tokenId);
        if (!ok || take != liquidity) return (amount0, amount1);
        (ok, ret) = address(NPM).call(abi.encodeCall(INPM.burn, (tokenId)));
        if (!ok) {
            _failed(tokenId, ret, tolerant);
            return (amount0, amount1);
        }
        _tokenIds[slot] = 0;
        emit PositionClosed(decisionId, slot, tokenId, amount0, amount1);
    }

    /// @dev Collect everything owed to the lane; never reverts. If the full collect fails (e.g. one token is paused or
    /// blocklisted, so its transfer reverts), each side is collected on its own so the healthy token still comes out;
    /// `ok` is then false and the slot must be kept (the failing side stays owed to the position).
    function _tryCollect(uint256 tokenId) internal returns (bool ok, uint256 amount0, uint256 amount1) {
        (ok, amount0, amount1) = _collect(tokenId, type(uint128).max, type(uint128).max);
        if (ok) return (true, amount0, amount1);
        (, amount0,) = _collect(tokenId, type(uint128).max, 0);
        (,, amount1) = _collect(tokenId, 0, type(uint128).max);
    }

    function _collect(uint256 tokenId, uint128 max0, uint128 max1)
        internal
        returns (bool ok, uint256 amount0, uint256 amount1)
    {
        bytes memory ret;
        (ok, ret) = address(NPM)
            .call(
                abi.encodeCall(
                    INPM.collect,
                    (INPM.CollectParams({
                            tokenId: tokenId, recipient: address(this), amount0Max: max0, amount1Max: max1
                        }))
                )
            );
        if (!ok || ret.length < 64) {
            emit CollectFailed(tokenId, ret);
            return (false, 0, 0);
        }
        return (true, _word(ret, 0), _word(ret, 1));
    }

    /// @dev Tolerant: emit CollectFailed and keep the slot. Strict: bubble the NPM's revert data.
    function _failed(uint256 tokenId, bytes memory reason, bool tolerant) internal returns (uint256, uint256) {
        if (!tolerant) {
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
        emit CollectFailed(tokenId, reason);
        return (0, 0);
    }

    function _slotToken(uint8 slot) internal view returns (uint256 tokenId) {
        if (slot < MAX_SLOTS) tokenId = _tokenIds[slot];
        if (tokenId == 0) revert BadSlot(slot);
    }

    /// @dev The `i`-th 32-byte word of ABI return data (the caller checked the length).
    function _word(bytes memory data, uint256 i) internal pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := mload(add(add(data, 32), mul(i, 32)))
        }
    }
}
