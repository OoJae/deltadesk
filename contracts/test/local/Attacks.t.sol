// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Vm} from "forge-std/Vm.sol";

import {ChainlinkFence} from "../../src/ChainlinkFence.sol";
import {DeskLaneV3} from "../../src/DeskLaneV3.sol";
import {IDeskLane} from "../../src/interfaces/IDeskLane.sol";
import {IDeskLaneFactory} from "../../src/interfaces/IDeskLaneFactory.sol";
import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {INonfungiblePositionManagerMin as INPM} from "../../src/interfaces/external/INonfungiblePositionManagerMin.sol";
import {PriceMath} from "../../src/libraries/PriceMath.sol";
import {DeskDefaults} from "../../script/DeskDefaults.sol";
import {DeskFixture} from "../utils/DeskFixture.sol";
import {HookToken} from "../utils/HookToken.sol";
import {IUniswapV3PoolTest} from "../utils/IUniswapV3PoolTest.sol";
import {MockAggregator} from "../utils/MockAggregator.sol";
import {MockToken} from "../utils/MockToken.sol";
import {PoolMover} from "../utils/PoolMover.sol";

/// @dev Claims to be the NVDA/USDG pool (same tokens, fee and spacing) but is not the v3 factory's pool (N4).
contract SpoofPool {
    address public immutable token0;
    address public immutable token1;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }

    function fee() external pure returns (uint24) {
        return 500;
    }

    function tickSpacing() external pure returns (int24) {
        return 10;
    }

    function slot0() external pure returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, 0, 0, 0, 0, 0, true);
    }
}

/// @dev An NPM look-alike that mints into another v3 factory's pools (N4).
contract SpoofNpm {
    function factory() external pure returns (address) {
        return address(0xBAD);
    }
}

/// @notice Negative tests N1-N11 of docs/m2-design-contracts.md: each attack either reverts or its effect is bounded.
/// (The unit role matrix, factory tests and Lifecycle.t.sol cover some of the same ground from the builder's side.)
contract AttacksTest is DeskFixture {
    address internal attacker = makeAddr("attacker");

    function _range(int24 tl, int24 tu) internal pure returns (IDeskTypes.RangeSpec[] memory r) {
        r = new IDeskTypes.RangeSpec[](1);
        r[0] = IDeskTypes.RangeSpec(tl, tu, 10_000, 10_000);
    }

    /// @dev Fence-valued NAV of the lane's idle balances, usd6 (USDG $1, NVDA $222.60).
    function _idleNavUsd6() internal view returns (uint256) {
        return usdg.balanceOf(address(lane)) + nvda.balanceOf(address(lane)) * 222.6e6 / 1e18;
    }

    function _exitAll() internal {
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        lane.exitAll(m);
    }

    // ------------------------------------------------------------------ N1 unit bugs

    /// @dev A feed that silently switches to 18 decimals without rescaling (a 1e10 slip) moves the fence reference
    /// ~230k ticks: every near-market placement is rejected.
    function test_N1_decimalsSlipInFenceReverts() public {
        nvdaFeed.setDecimals(18); // answer still 8-dec scaled: NVDA looks like $2.2e-8
        (int24 ref,, uint8 code) = lane.refTick();
        assertEq(code, 0);
        assertGt(ref, 222_267 + 200_000); // NVDA looks 1e10x cheaper: token1 per token0 jumps ~230k ticks
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        vm.prank(operator);
        vm.expectPartialRevert(IDeskLane.RangeOutsideFence.selector);
        lane.rerange(m, r, t, 10);
    }

    /// @dev An agent that inverts the tick (token order bug) fails the execution tick guard.
    function test_N1_invertedTickReverts() public {
        int24 t = _tick();
        IDeskTypes.RangeSpec[] memory r = _range(_floor(-t - 100), _ceil(-t + 100));
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.PoolTickMoved.selector, t, -t, 10));
        lane.rerange(m, r, -t, 10);
    }

    // ------------------------------------------------------------------ N2 sandwich around a rerange

    /// @dev The attacker moves the pool after the operator read it: the tick guard reverts.
    function test_N2_sandwichAfterReadReverts() public {
        int24 t = _tick();
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        mover.moveTo(t + 50);
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.PoolTickMoved.selector, t + 50, t, 10));
        lane.rerange(m, r, t, 10);
    }

    /// @dev The attacker moves the pool beyond the band before the operator reads it: the placement fence reverts.
    function test_N2_offMarketBeyondBandReverts() public {
        mover.moveTo(222_267 + 150);
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        vm.prank(operator);
        vm.expectPartialRevert(IDeskLane.RangeOutsideFence.selector);
        lane.rerange(m, r, t, 10);
    }

    /// @dev Within the band the rerange goes through at the manipulated price; after the attacker swaps back the
    /// fence-valued loss stays below band x deployed notional.
    function test_N2_withinBandLossBounded() public {
        uint256 nav0 = _idleNavUsd6();
        mover.moveTo(222_267 + 95);
        (,, uint256 u0, uint256 u1) = _rerange(_straddle(100));
        uint256 deployedUsd6 = u0 + u1 * 222.6e6 / 1e18;
        mover.moveTo(222_267);
        _exitAll();
        uint256 nav1 = _idleNavUsd6();
        uint256 loss = nav0 > nav1 ? nav0 - nav1 : 0;
        emit log_named_uint("deployed usd6", deployedUsd6);
        emit log_named_uint("fence-valued loss usd6", loss);
        assertLe(loss, deployedUsd6 * 100 / 10_000, "loss <= band x deployed");
    }

    /// @dev The attacker parks the pool at the top of an aligned tick far above the band and the evil operator mints
    /// [tc, tc + 20). v3 counts tc == tickLower as in range, so the position bids token1 inside the current bucket at
    /// the manipulated price; swapping back would buy token0 from the lane's NVDA at ~1.5x the fence price (a loss of
    /// ~2.4x band x deployed before the fix). The fence checks the bid side whenever tl <= tc. The mirror case, a
    /// range ending one tick above a pool parked far below, is rejected on the ask side.
    function test_N2_parkedFarAboveBidAtPoolTickReverts() public {
        int24 ref = 222_267;
        int24 tc = _floor(ref + 4000);
        mover.moveTo(tc + 50);
        mover.moveTo(tc); // just below the upper edge of tick tc
        assertEq(_tick(), tc);
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.RangeOutsideFence.selector, 0, tc, tc + 20, ref, 100));
        lane.rerange(m, _range(tc, tc + 20), tc, 10);
        // Token0 alone, one spacing above the pool, is fine: it sells far above the reference.
        m = _meta();
        vm.prank(operator);
        lane.rerange(m, _range(tc + 10, tc + 30), tc, 10);

        _warpFresh(301);
        int24 tu = _floor(ref - 4000);
        mover.moveTo(tu - 1); // pool in the bucket just under tu, far below the reference
        m = _meta();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.RangeOutsideFence.selector, 0, tu - 20, tu, ref, 100));
        lane.rerange(m, _range(tu - 20, tu), tu - 1, 10);
    }

    /// @dev The fence is evaluated at the EXECUTED slot0 tick, not at the caller's expectedTick: with the pool
    /// moved to ref + 105 (inside maxTickDelta of the plan's tick ref + 95), a straddle that would pass at the
    /// expected tick bids above the band at the real one and reverts.
    function test_N2_fenceUsesTheExecutedTick() public {
        int24 ref = 222_267;
        mover.moveTo(ref + 105);
        int24 t = _tick();
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IDeskLane.RangeOutsideFence.selector, 0, r[0].tickLower, r[0].tickUpper, ref, 100)
        );
        lane.rerange(m, r, t - 10, 10);
        mover.moveTo(ref + 95);
        vm.prank(operator);
        lane.rerange(m, r, t - 10, 10); // at the expected tick the same plan is inside the fence
    }

    // ------------------------------------------------------------------ N3 the operator reaches for owner powers

    /// @dev A compromised operator key holding a live position tries every owner-only path: all revert, nothing moves.
    function test_N3_operatorCannotReachOwnerPowers() public {
        (uint256[] memory ids,,,) = _rerange(_straddle(100));
        uint256 b0 = usdg.balanceOf(address(lane));
        uint256 b1 = nvda.balanceOf(address(lane));
        IDeskTypes.Caps memory loose = DeskDefaults.ceilings();
        vm.startPrank(operator);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.withdraw(address(usdg), b0);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.withdrawAll();
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.withdrawPosition(0);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.proposeOperator(attacker);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.applyOperator();
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.revokeOperator();
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.setCaps(loose);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.applyCaps();
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.cancelCaps();
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.setGuardian(operator);
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        lane.setClosedUntil(0);
        vm.expectRevert(IDeskLane.NotFactory.selector);
        lane.initialize(operator, operator, loose);
        lane.pause(); // allowed: risk-reducing
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.unpause();
        vm.stopPrank();
        assertEq(lane.owner(), owner);
        assertEq(lane.operator(), operator);
        assertEq(lane.guardian(), guardian);
        assertTrue(lane.paused());
        assertEq(keccak256(abi.encode(lane.caps())), keccak256(abi.encode(DeskDefaults.laneCaps())));
        assertEq(usdg.balanceOf(address(lane)), b0);
        assertEq(nvda.balanceOf(address(lane)), b1);
        assertEq(npm.ownerOf(ids[0]), address(lane));
        // Paused, the operator can still only reduce risk; the value stays in the lane.
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        lane.exitAll(m);
        assertEq(usdg.balanceOf(operator) + nvda.balanceOf(operator), 0);
    }

    /// @dev The guardian can pause, reduce, exit and extend closedUntil, and nothing else.
    function test_N3_guardianCannotAddRiskOrMoveValue() public {
        _rerange(_straddle(100));
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        vm.startPrank(guardian);
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        lane.rerange(m, r, t, 10);
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        lane.collect(m);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.withdrawAll();
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.unpause();
        lane.setClosedUntil(uint64(block.timestamp + 1 days));
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        lane.setClosedUntil(uint64(block.timestamp)); // shortening is the owner's call
        lane.exitAll(m);
        vm.stopPrank();
        assertEq(lane.positions()[0], 0);
        assertEq(usdg.balanceOf(guardian) + nvda.balanceOf(guardian), 0);
    }

    // ------------------------------------------------------------------ N4 fake pool, look-alike NPM

    /// @dev A pool impersonator (same tokens, fee, spacing), even allowlisted by a careless admin, is not the v3
    /// factory's pool: createLane refuses it. The factory's real pool at another fee is refused unless allowlisted.
    function test_N4_fakePoolRejected() public {
        SpoofPool spoof = new SpoofPool(address(usdg), address(nvda));
        vm.prank(admin);
        factory.setPoolAllowed(address(spoof), DeskDefaults.KIND_V3_LP, true);
        IDeskLaneFactory.CreateParams memory p = _params(owner, operator, guardian, bytes32("spoof"));
        p.pool = address(spoof);
        vm.expectRevert(abi.encodeWithSelector(IDeskLaneFactory.PoolMismatch.selector, address(spoof)));
        factory.createLane(p);

        address other = v3Factory.createPool(address(usdg), address(nvda), 3000);
        p.pool = other;
        vm.expectRevert(abi.encodeWithSelector(IDeskLaneFactory.PoolNotAllowed.selector, other));
        factory.createLane(p);
    }

    /// @dev An implementation wired to an NPM of another v3 factory cannot be deployed.
    function test_N4_lookAlikeNpmRejected() public {
        SpoofNpm fake = new SpoofNpm();
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.InvalidConfig.selector, 5));
        new DeskLaneV3(address(factory), address(fake), address(fence));
    }

    /// @dev Every mint lands in the lane's own pool: the only pool Mint event of a rerange is emitted by it, and the
    /// NPM position carries its tokens and fee.
    function test_N4_mintsOnlyIntoTheLanePool() public {
        vm.recordLogs();
        (uint256[] memory ids,,,) = _rerange(_straddle(100));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 poolMint = keccak256("Mint(address,address,int24,int24,uint128,uint256,uint256)");
        uint256 mintsSeen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == poolMint) {
                assertEq(logs[i].emitter, address(pool));
                mintsSeen++;
            }
        }
        assertEq(mintsSeen, 1);
        (,, address t0, address t1, uint24 f,,,,,,,) = npm.positions(ids[0]);
        assertEq(t0, address(usdg));
        assertEq(t1, address(nvda));
        assertEq(f, FEE);
    }

    // ------------------------------------------------------------------ N5 foreign NFTs, direct NPM calls

    function test_N5_foreignNftSafeTransferReverts() public {
        uint256 lpId = npm.tokenOfOwnerByIndex(lp, 0);
        vm.prank(lp);
        vm.expectRevert();
        npm.safeTransferFrom(lp, address(lane), lpId);
        assertEq(npm.ownerOf(lpId), lp);
    }

    function test_N5_foreignNftPlainTransferIsIgnored() public {
        (uint256[] memory ids,,,) = _rerange(_straddle(100));
        uint256 lpId = npm.tokenOfOwnerByIndex(lp, 0);
        vm.prank(lp);
        npm.transferFrom(lp, address(lane), lpId); // no hook: lands, but the lane never tracks it
        uint256[2] memory pos = lane.positions();
        assertEq(pos[0], ids[0]);
        assertEq(pos[1], 0);
        _exitAll();
        assertEq(lane.positions()[0], 0);
        assertEq(npm.ownerOf(lpId), address(lane)); // untouched by exitAll
    }

    function test_N5_attackerCannotTouchLanePositionsOnNpm() public {
        (uint256[] memory ids,,,) = _rerange(_straddle(100));
        uint128 liq = _positionLiquidity(ids[0]);
        vm.startPrank(attacker);
        vm.expectRevert("Not approved");
        npm.decreaseLiquidity(INPM.DecreaseLiquidityParams(ids[0], liq, 0, 0, block.timestamp));
        vm.expectRevert("Not approved");
        npm.collect(INPM.CollectParams(ids[0], attacker, type(uint128).max, type(uint128).max));
        vm.expectRevert("ERC721: transfer caller is not owner nor approved");
        npm.transferFrom(address(lane), attacker, ids[0]);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ N6 NVDA paused during exitAll

    /// @dev The issuer pauses NVDA while the lane holds a position: exitAll still succeeds, the USDG side comes out,
    /// a rerange cannot add risk but can still unwind-and-hold, and the NFT escape hatch hands the owner the rest.
    function test_N6_nvdaPausedDuringExit() public {
        (uint256[] memory ids,,,) = _rerange(_straddle(100));
        mover.swapExactIn(true, 20_000e6);
        mover.swapExactIn(false, 90e18);
        nvda.setPaused(true);
        _warpFresh(301);

        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        vm.prank(operator);
        vm.expectRevert(); // the mint cannot pull NVDA
        lane.rerange(m, r, t, 10);

        m = _meta();
        vm.prank(operator);
        lane.rerange(m, new IDeskTypes.RangeSpec[](0), 0, 0); // unwind-and-hold tolerates the failed NVDA collect
        assertEq(_positionLiquidity(ids[0]), 0);
        assertEq(lane.positions()[0], ids[0], "slot kept while NVDA is owed");

        m = _meta();
        vm.prank(guardian);
        lane.exitAll(m);
        uint256 laneUsdg = usdg.balanceOf(address(lane));
        assertGt(laneUsdg, 0);
        vm.startPrank(owner);
        lane.withdrawAll(); // USDG out, NVDA skipped
        lane.withdrawPosition(0);
        vm.stopPrank();
        assertEq(usdg.balanceOf(owner), laneUsdg);
        assertEq(usdg.balanceOf(address(lane)), 0);
        assertEq(npm.ownerOf(ids[0]), owner);

        nvda.setPaused(false);
        uint256 idle1 = nvda.balanceOf(address(lane));
        vm.startPrank(owner);
        lane.withdrawAll();
        npm.collect(INPM.CollectParams(ids[0], owner, type(uint128).max, type(uint128).max));
        vm.stopPrank();
        assertGt(nvda.balanceOf(owner), idle1);
        assertEq(nvda.balanceOf(address(lane)), 0);
    }

    /// @dev exitAll tolerates EVERY per-slot NPM failure, not only a failed collect (all a paused or blocklisted token
    /// can cause): a position read, a decreaseLiquidity or a burn that reverts keeps that slot (CollectFailed with the
    /// NPM's revert data) while the other slot still closes. The strict path, reduce, bubbles the same failure. Once
    /// the NPM recovers, exitAll closes the kept slot.
    function test_N6_exitAllToleratesEveryNpmFailure() public {
        bytes memory boom = abi.encodeWithSignature("Error(string)", "npm: boom");
        for (uint256 k; k < 3; ++k) {
            uint256 snap = vm.snapshotState();
            IDeskTypes.RangeSpec[] memory r = new IDeskTypes.RangeSpec[](2);
            int24 t = _tick();
            r[0] = IDeskTypes.RangeSpec(_floor(t - 100), _ceil(t + 100), 5000, 5000);
            r[1] = IDeskTypes.RangeSpec(_floor(t - 200), _ceil(t + 200), 5000, 5000);
            (uint256[] memory ids,,,) = _rerange(r);
            uint256 id = ids[0];
            assertEq(lane.positions()[0], id);
            bytes memory failing = k == 0
                ? abi.encodeCall(INPM.positions, (id))
                : k == 1 ? abi.encodePacked(INPM.decreaseLiquidity.selector, id) : abi.encodeCall(INPM.burn, (id));
            vm.mockCallRevert(address(npm), failing, boom);

            IDeskTypes.Meta memory m = _meta();
            vm.prank(operator);
            vm.expectRevert(bytes("npm: boom"));
            lane.reduce(m, 0, type(uint128).max);

            m = _meta();
            vm.expectEmit(address(lane));
            emit IDeskLane.CollectFailed(id, boom);
            vm.prank(operator);
            lane.exitAll(m);
            assertEq(lane.positions()[0], id, "the failing slot is kept");
            assertEq(lane.positions()[1], 0, "the healthy slot closed");

            vm.clearMockedCalls();
            _exitAll();
            assertEq(lane.positions()[0], 0, "the kept slot closes once the NPM recovers");
            vm.revertToState(snap);
        }
    }

    // ------------------------------------------------------------------ N7 broken oracle: exits work, adds revert

    function test_N7_brokenOracleExitsWork() public {
        (uint256[] memory ids,,,) = _rerange(_straddle(100));
        _warpFresh(301);
        int256[3] memory bad = [int256(0), int256(-1), int256(222.6e8)];
        for (uint256 i; i < 4; ++i) {
            uint256 snap = vm.snapshotState();
            if (i < 3) nvdaFeed.set(bad[i], i == 2 ? block.timestamp + 1 : block.timestamp); // 0, <0, future
            else nvdaFeed.setReverting(true);

            IDeskTypes.RangeSpec[] memory r = _straddle(100);
            IDeskTypes.Meta memory m = _meta();
            int24 t = _tick();
            vm.prank(operator);
            vm.expectPartialRevert(IDeskLane.MarketClosed.selector);
            lane.rerange(m, r, t, 10);

            uint128 liq = _positionLiquidity(ids[0]);
            m = _meta();
            vm.prank(guardian);
            lane.reduce(m, 0, liq / 3);
            m = _meta();
            vm.prank(operator);
            lane.collect(m);
            m = _meta();
            vm.prank(operator);
            lane.exitAll(m);
            assertEq(lane.positions()[0], 0);
            vm.prank(owner);
            lane.withdrawAll();
            assertEq(usdg.balanceOf(address(lane)) + nvda.balanceOf(address(lane)), 0);
            vm.revertToState(snap);
        }
    }

    function test_N7_brokenOracleWithdrawPositionWorks() public {
        (uint256[] memory ids,,,) = _rerange(_straddle(100));
        nvdaFeed.setReverting(true);
        usdgFeed.setReverting(true);
        vm.prank(owner);
        lane.withdrawPosition(0);
        assertEq(npm.ownerOf(ids[0]), owner);
    }

    // ------------------------------------------------------------------ N8 replays and deadlines

    /// @dev A decision is single-use across every Meta function and across operator and owner; a call that reverted
    /// spent nothing, so the agent may retry the same decision.
    function test_N8_decisionReplay() public {
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        mover.moveTo(t + 30); // the first attempt hits a moved pool
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.PoolTickMoved.selector, t + 30, t, 10));
        lane.rerange(m, r, t, 10);
        assertEq(lane.decisionUsedAt(m.decisionId), 0, "a reverted call spends nothing");

        t = _tick();
        r = _straddle(100);
        vm.prank(operator);
        lane.rerange(m, r, t, 10); // the retry with the same decision goes through
        assertEq(lane.decisionUsedAt(m.decisionId), block.timestamp);

        _warpFresh(301);
        t = _tick();
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.DecisionUsed.selector, m.decisionId));
        lane.rerange(m, r, t, 10);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.DecisionUsed.selector, m.decisionId));
        lane.exitAll(m);
        vm.stopPrank();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.DecisionUsed.selector, m.decisionId));
        lane.signal(m);
    }

    /// @dev A transaction held back past its deadline is dead; one signed with a deadline beyond maxDeadlineAhead (120 s)
    /// never goes through; the edges now and now + 120 do.
    function test_N8_deadlines() public {
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        IDeskTypes.Meta memory m = _meta(); // deadline now + 60
        int24 t = _tick();
        vm.warp(block.timestamp + 61);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.Expired.selector, m.deadline));
        lane.rerange(m, r, t, 10);

        m = _metaWithDeadline(uint64(block.timestamp + 1 days));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.DeadlineTooFar.selector, m.deadline));
        lane.exitAll(m);
        m = _metaWithDeadline(uint64(block.timestamp + 121));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.DeadlineTooFar.selector, m.deadline));
        lane.signal(m);

        vm.startPrank(operator);
        lane.signal(_metaWithDeadline(uint64(block.timestamp)));
        lane.signal(_metaWithDeadline(uint64(block.timestamp + 120)));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ N9 rerange spam at the rate-limit edges

    /// @dev An operator retrying every 10 s for 25 minutes lands a rerange at most every minRerangeInterval (300 s),
    /// and the 1 h bucket (4 per hour, refilling one per 900 s) stops the burst at five (0, 300, ..., 1200 s).
    /// Rolling block.number changes nothing (limits are timestamps only). Then the interval edge: 299 s fails, 300 s
    /// passes.
    function test_N9_intervalEdgeUnderSpam() public {
        IDeskTypes.RangeSpec[] memory r = _small(_straddle(100));
        _rerange(r);
        uint256 last = block.timestamp;
        uint256 ok = 1;
        for (uint256 i; i < 150; ++i) {
            _warpFresh(10);
            vm.roll(block.number + 1_000_000); // an L1-estimate jump must not unlock anything
            (bool success,) = _tryRerange(r);
            if (success) {
                assertGe(block.timestamp - last, 300, "rerange inside the interval");
                last = block.timestamp;
                ok++;
            }
        }
        assertEq(ok, 5);
        _warpFresh(1 hours); // buckets refill
        _rerange(r);
        _warpFresh(299);
        (bool s1, bytes memory ret) = _tryRerange(r);
        assertFalse(s1, "299 s after the last rerange");
        assertEq(bytes4(ret), IDeskLane.TooSoon.selector);
        _warpFresh(1);
        (bool s2,) = _tryRerange(r);
        assertTrue(s2, "300 s after the last rerange");
    }

    /// @dev The 1 h bucket (4 per hour) and the 24 h bucket bound the burst; the owner shares them with the operator.
    function test_N9_rerangeBuckets() public {
        IDeskTypes.RangeSpec[] memory r = _small(_straddle(100));
        IDeskTypes.Caps memory c = DeskDefaults.laneCaps();
        c.minRerangeInterval = 300;
        c.reranges24h = 7;
        vm.prank(owner);
        lane.setCaps(c); // tighter: applies now
        for (uint256 i; i < 5; ++i) {
            _rerangeAs(i % 2 == 0 ? operator : owner, r);
            _warpFresh(300);
        }
        (, uint256 left1h,,) = lane.budgets();
        assertEq(left1h, 0);
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.BucketEmpty.selector, 1, 1, 0));
        lane.rerange(m, r, t, 10);
        _warpFresh(301);
        _rerange(r); // refilled
        _warpFresh(900);
        _rerange(r);
        _warpFresh(900);
        // 7 used of the 24 h bucket (refill 7/day = 1 per 3.4 h): empty.
        m = _meta();
        t = _tick();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.BucketEmpty.selector, 2, 1, 0));
        lane.rerange(m, r, t, 10);
        // Risk-reducing calls are never rate limited.
        m = _meta();
        vm.prank(operator);
        lane.exitAll(m);
    }

    /// @dev Notional limits at their edges: the turnover bucket and the per-rerange deploy cap.
    function test_N9_turnoverAndDeployCapEdges() public {
        IDeskTypes.Caps memory c = DeskDefaults.laneCaps();
        c.turnoverUsd6PerDay = 60e6;
        vm.prank(owner);
        lane.setCaps(c);
        (,, uint256 used0, uint256 used1) = _rerange(_straddle(100)); // ~$49 of the $60
        uint256 usd6 = used0 + used1 * 222.6e6 / 1e18;
        _warpFresh(300);
        (uint256 left,,,) = lane.budgets();
        assertLt(left, 60e6 - usd6 + uint256(300 * 60e6) / 1 days + 2);
        IDeskTypes.Meta memory m = _meta();
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        int24 t = _tick();
        vm.prank(operator);
        vm.expectPartialRevert(IDeskLane.BucketEmpty.selector);
        lane.rerange(m, r, t, 10);
        _rerange(_small(_straddle(100))); // ~$5 fits

        c.maxDeployUsd6 = 20e6;
        vm.prank(owner);
        lane.setCaps(c);
        _warpFresh(1 days);
        m = _meta();
        r = _straddle(100);
        t = _tick();
        vm.prank(operator);
        vm.expectPartialRevert(IDeskLane.DeployCapExceeded.selector);
        lane.rerange(m, r, t, 10);
    }

    // ------------------------------------------------------------------ N10 round-trip leakage

    /// @dev 50 unwind+mint cycles with no swaps leak at most a few base units per token per cycle.
    function test_N10_fiftyCycleLeakage() public {
        IDeskTypes.Caps memory c = DeskDefaults.laneCaps();
        c.turnoverUsd6PerDay = 20_000e6;
        c.reranges1h = 12;
        c.reranges24h = 96;
        vm.prank(owner);
        lane.setCaps(c);
        _warpFresh(24 hours);
        vm.prank(owner);
        lane.applyCaps();

        uint256 start0 = usdg.balanceOf(address(lane));
        uint256 start1 = nvda.balanceOf(address(lane));
        for (uint256 i; i < 50; ++i) {
            _rerange(_straddle(100 + int24(int256(i % 5)) * 20));
            _warpFresh(301);
        }
        _exitAll();
        uint256 end0 = usdg.balanceOf(address(lane));
        uint256 end1 = nvda.balanceOf(address(lane));
        emit log_named_uint("USDG leaked over 50 cycles (base units)", start0 - end0);
        emit log_named_uint("NVDA leaked over 50 cycles (wei)", start1 - end1);
        assertLe(start0 - end0, 50 * 3, "USDG leak");
        assertLe(start1 - end1, 50 * 3, "NVDA leak");
    }

    // ------------------------------------------------------------------ N11 reentrancy through a hook token

    /// @dev The hook token is the hook lane's operator, so its callbacks pass auth and only the reentrancy guard can
    /// stop them. Each nonReentrant entry point that moves the hook token is the OUTER call once (rerange's mint,
    /// reduce's and collect's NPM collects, the owner's withdraw and withdrawAll), each time with a guarded inner call
    /// (signal and pause are not nonReentrant, so they cannot probe the guard). An inner call that ran would have
    /// spent its decisionId even where the pool's own lock refused its work, so the inner Meta must stay unspent.
    function test_N11_reentrancyThroughHookToken() public {
        HookToken hook = new HookToken();
        (DeskLaneV3 hookLane, address hookPool) = _hookLane(hook);

        // rerange -> exitAll
        (, int24 t,,,,,) = IUniswapV3PoolTest(hookPool).slot0();
        IDeskTypes.RangeSpec[] memory r = new IDeskTypes.RangeSpec[](1);
        r[0] = IDeskTypes.RangeSpec(_floor(t - 100), _ceil(t + 100), 10_000, 10_000);
        IDeskTypes.Meta memory m = _meta();
        IDeskTypes.Meta memory inner = _armInner(hook, hookLane, true);
        vm.prank(address(hook));
        hookLane.rerange(m, r, t, 10);
        _assertReentryBlocked(hook, hookLane, inner, 1);
        uint256 id = hookLane.positions()[0];
        assertTrue(id != 0);

        // reduce -> collect
        uint128 half = _positionLiquidity(id) / 2;
        inner = _armInner(hook, hookLane, false);
        m = _meta();
        vm.prank(owner);
        hookLane.reduce(m, 0, half);
        _assertReentryBlocked(hook, hookLane, inner, 2);

        // collect (of swap fees in both tokens) -> exitAll
        PoolMover hookMover = new PoolMover(hookPool);
        hookMover.swapExactIn(true, 10 ** uint256(MockToken(hookMover.token0()).decimals()));
        hookMover.swapExactIn(false, 10 ** uint256(MockToken(hookMover.token1()).decimals()));
        inner = _armInner(hook, hookLane, true);
        m = _meta();
        vm.prank(owner);
        hookLane.collect(m);
        _assertReentryBlocked(hook, hookLane, inner, 3);

        // withdraw -> collect (the guard stops the callback before any auth check runs)
        inner = _armInner(hook, hookLane, false);
        vm.prank(owner);
        hookLane.withdraw(address(hook), 1);
        _assertReentryBlocked(hook, hookLane, inner, 4);

        // withdrawAll -> exitAll
        inner = _armInner(hook, hookLane, true);
        vm.prank(owner);
        hookLane.withdrawAll();
        _assertReentryBlocked(hook, hookLane, inner, 5);
        assertEq(hook.balanceOf(address(hookLane)), 0);
    }

    function _armInner(HookToken hook, DeskLaneV3 hookLane, bool exit) internal returns (IDeskTypes.Meta memory inner) {
        inner = _meta();
        hook.arm(
            address(hookLane),
            exit ? abi.encodeCall(IDeskLane.exitAll, (inner)) : abi.encodeCall(IDeskLane.collect, (inner))
        );
    }

    function _assertReentryBlocked(HookToken hook, DeskLaneV3 hookLane, IDeskTypes.Meta memory inner, uint256 attempts)
        internal
        view
    {
        assertEq(hook.attempts(), attempts, "the callback did not fire");
        assertFalse(hook.lastOk(), "the reentrant call succeeded");
        assertEq(bytes4(hook.lastRevert()), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        assertEq(hookLane.decisionUsedAt(inner.decisionId), 0, "the reentrant call spent its decision");
    }

    function _small(IDeskTypes.RangeSpec[] memory r) internal pure returns (IDeskTypes.RangeSpec[] memory) {
        r[0].share0Bps = 1000; // ~$5 keeps the turnover bucket out of the way
        r[0].share1Bps = 1000;
        return r;
    }

    function _tryRerange(IDeskTypes.RangeSpec[] memory r) internal returns (bool ok, bytes memory ret) {
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        vm.prank(operator);
        (ok, ret) = address(lane).call(abi.encodeCall(IDeskLane.rerange, (m, r, t, 10)));
    }

    /// @dev A second implementation (kind 2) whose fence knows the hook token, and a lane on a USDG/HOOK pool.
    function _hookLane(HookToken hook) internal returns (DeskLaneV3 hookLane, address hookPool) {
        MockAggregator hookFeed = new MockAggregator(8, 1e8);
        ChainlinkFence.TokenConfig[] memory c = new ChainlinkFence.TokenConfig[](2);
        c[0] = ChainlinkFence.TokenConfig(address(usdg), address(usdgFeed), ChainlinkFence.Kind.STABLE, 26 hours);
        c[1] = ChainlinkFence.TokenConfig(address(hook), address(hookFeed), ChainlinkFence.Kind.STABLE, 26 hours);
        ChainlinkFence fence2 = new ChainlinkFence(c);
        DeskLaneV3 impl2 = new DeskLaneV3(address(factory), address(npm), address(fence2));

        hookPool = v3Factory.createPool(address(usdg), address(hook), FEE);
        IUniswapV3PoolTest p = IUniswapV3PoolTest(hookPool);
        bool usdgIs0 = p.token0() == address(usdg);
        (uint256 sqrtP,) = PriceMath.sqrtPriceX96(1e18, 1e18, usdgIs0 ? 6 : 18, usdgIs0 ? 18 : 6);
        p.initialize(uint160(sqrtP));

        vm.startPrank(admin);
        factory.setImplementation(2, address(impl2));
        factory.setPoolAllowed(hookPool, 2, true);
        vm.stopPrank();

        IDeskLaneFactory.CreateParams memory params = IDeskLaneFactory.CreateParams({
            owner: owner,
            operator: address(hook),
            guardian: address(0),
            laneId: 1,
            kind: 2,
            pool: hookPool,
            caps: DeskDefaults.laneCaps(),
            salt: bytes32("hook")
        });
        hookLane = DeskLaneV3(factory.createLane(params));
        usdg.mint(address(hookLane), 20e6);
        hook.mint(address(hookLane), 20e18);
    }
}
