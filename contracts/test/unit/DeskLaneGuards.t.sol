// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDeskLane} from "../../src/interfaces/IDeskLane.sol";
import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {DeskDefaults} from "../../script/DeskDefaults.sol";
import {DeskFixture} from "../utils/DeskFixture.sol";

/// @notice Every rerange guard: decisionId and deadline, interval and buckets, fence gating, execution tick guard,
/// range shape and the placement fence, deploy cap and turnover.
contract DeskLaneGuardsTest is DeskFixture {
    // Sat 2026-09-19 00:00:00 UTC
    uint256 internal constant SAT_0000 = 1_789_776_000;

    function _expectRerangeRevert(IDeskTypes.RangeSpec[] memory r, int24 expected, uint24 delta, bytes memory err)
        internal
    {
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        vm.expectRevert(err);
        lane.rerange(m, r, expected, delta);
        assertEq(lane.decisionUsedAt(m.decisionId), 0, "a reverted call spends nothing");
    }

    function _range(int24 tl, int24 tu) internal pure returns (IDeskTypes.RangeSpec[] memory r) {
        r = new IDeskTypes.RangeSpec[](1);
        r[0] = IDeskTypes.RangeSpec(tl, tu, 10_000, 10_000);
    }

    // ------------------------------------------------------------------ decisionId and deadline

    function test_zeroDecision() public {
        IDeskTypes.Meta memory m = _meta();
        m.decisionId = bytes32(0);
        vm.prank(operator);
        vm.expectRevert(IDeskLane.ZeroDecision.selector);
        lane.signal(m);
    }

    function test_decisionIdIsSingleUseAcrossFunctions() public {
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        vm.expectEmit(address(lane));
        emit IDeskLane.LaneAction(
            0, m.decisionId, IDeskTypes.Action.SIGNAL, new int24[](0), 0, 1, 0, m.reasonHash, operator
        );
        lane.signal(m);
        assertEq(lane.decisionUsedAt(m.decisionId), block.timestamp);
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.DecisionUsed.selector, m.decisionId));
        lane.signal(m);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.DecisionUsed.selector, m.decisionId));
        lane.exitAll(m);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.DecisionUsed.selector, m.decisionId));
        lane.collect(m);
        vm.stopPrank();
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        int24 t = _tick();
        vm.prank(owner); // the owner shares the same namespace
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.DecisionUsed.selector, m.decisionId));
        lane.rerange(m, r, t, 10);
    }

    function test_deadlineWindow() public {
        IDeskTypes.Meta memory m = _metaWithDeadline(uint64(block.timestamp - 1));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.Expired.selector, m.deadline));
        lane.signal(m);

        m = _metaWithDeadline(uint64(block.timestamp + 121)); // maxDeadlineAhead = 120
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.DeadlineTooFar.selector, m.deadline));
        lane.signal(m);

        m = _metaWithDeadline(uint64(block.timestamp + 1 days));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.DeadlineTooFar.selector, m.deadline));
        lane.signal(m);

        vm.startPrank(operator);
        lane.signal(_metaWithDeadline(uint64(block.timestamp))); // == now is fine
        lane.signal(_metaWithDeadline(uint64(block.timestamp + 120)));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ interval and rerange buckets

    /// @dev reranges1h = 4 is a linear bucket (burst 4, refill 1 per 900 s). With the 300 s minimum interval each
    /// rerange nets -2/3 unit, so five back-to-back reranges fit and the sixth finds 0.67 units.
    function test_minIntervalAndBuckets() public {
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        r[0].share0Bps = 1000; // ~$5 per rerange keeps the $150/day turnover bucket out of the way
        r[0].share1Bps = 1000;
        _rerange(r);
        (,,, uint64 next) = lane.budgets();
        assertEq(next, block.timestamp + 300);
        _expectRerangeRevert(r, _tick(), 10, abi.encodeWithSelector(IDeskLane.TooSoon.selector, next));
        _warpFresh(299);
        _expectRerangeRevert(r, _tick(), 10, abi.encodeWithSelector(IDeskLane.TooSoon.selector, next));
        _warpFresh(1);
        _rerange(r);
        for (uint256 i; i < 3; ++i) {
            _warpFresh(300);
            _rerange(r);
        }
        _warpFresh(300);
        (, uint256 left1h, uint256 left24h,) = lane.budgets();
        assertEq(left1h, 0);
        assertEq(left24h, 19); // 24 - 5 + 1500 s * 24 / 86400
        _expectRerangeRevert(r, _tick(), 10, abi.encodeWithSelector(IDeskLane.BucketEmpty.selector, 1, 1, 0));
        _warpFresh(300); // 0.67 + 0.33 = 1 unit, minus the 1e-18 floors of five refills: still short
        _expectRerangeRevert(r, _tick(), 10, abi.encodeWithSelector(IDeskLane.BucketEmpty.selector, 1, 1, 0));
        _warpFresh(1);
        _rerange(r);
    }

    function test_dailyRerangeBucket() public {
        IDeskTypes.Caps memory c = DeskDefaults.laneCaps();
        c.reranges24h = 2;
        vm.prank(owner);
        lane.setCaps(c);
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        _rerange(r);
        _warpFresh(900);
        _rerange(r);
        _warpFresh(900);
        _expectRerangeRevert(r, _tick(), 10, abi.encodeWithSelector(IDeskLane.BucketEmpty.selector, 2, 1, 0));
    }

    function test_unwindAndHoldSpendsNoBudget() public {
        _rerange(_straddle(100));
        (uint256 t0, uint256 a0, uint256 b0,) = lane.budgets();
        uint64 last = lane.lastRerangeAt();
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        (uint256[] memory ids,,,) = lane.rerange(m, new IDeskTypes.RangeSpec[](0), 0, 0);
        assertEq(ids.length, 0);
        (uint256 t1, uint256 a1, uint256 b1,) = lane.budgets();
        assertEq(t1, t0);
        assertEq(a1, a0);
        assertEq(b1, b0);
        assertEq(lane.lastRerangeAt(), last);
        assertEq(lane.positions()[0], 0);
    }

    // ------------------------------------------------------------------ fence gating

    function test_weekendClosesRiskAdding() public {
        vm.warp(SAT_0000);
        usdgFeed.setUpdatedAt(block.timestamp);
        nvdaFeed.setUpdatedAt(block.timestamp);
        (bool open, uint8 code) = lane.riskAddingOpen();
        assertFalse(open);
        assertEq(code, 5);
        _expectRerangeRevert(_straddle(100), _tick(), 10, abi.encodeWithSelector(IDeskLane.MarketClosed.selector, 5));
        // Unwind-and-hold still works on the weekend.
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        lane.rerange(m, new IDeskTypes.RangeSpec[](0), 0, 0);
    }

    function test_fenceCodesBlockRiskAdding() public {
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        int24 t = _tick();
        uint256 snap = vm.snapshotState();

        nvda.setOraclePaused(true);
        _expectRerangeRevert(r, t, 10, abi.encodeWithSelector(IDeskLane.MarketClosed.selector, 3));
        vm.revertToState(snap);

        nvda.setNewUIMultiplier(1.000775e18, block.timestamp + 1 hours);
        _expectRerangeRevert(r, t, 10, abi.encodeWithSelector(IDeskLane.MarketClosed.selector, 4));
        vm.revertToState(snap);

        nvdaFeed.set(0, block.timestamp);
        _expectRerangeRevert(r, t, 10, abi.encodeWithSelector(IDeskLane.MarketClosed.selector, 2));
        vm.revertToState(snap);

        nvdaFeed.setReverting(true);
        _expectRerangeRevert(r, t, 10, abi.encodeWithSelector(IDeskLane.MarketClosed.selector, 7));
        (int24 rt,, uint8 code) = lane.refTick();
        assertEq(code, 7);
        assertEq(rt, 0);
        vm.revertToState(snap);

        usdgFeed.setAnswer(0.99e8);
        _expectRerangeRevert(r, t, 10, abi.encodeWithSelector(IDeskLane.MarketClosed.selector, 6));
        vm.revertToState(snap);

        vm.warp(block.timestamp + 27 hours); // both feeds stale
        _expectRerangeRevert(r, t, 10, abi.encodeWithSelector(IDeskLane.MarketClosed.selector, 2));
    }

    function test_refTickView() public {
        (int24 t, int24 band, uint8 code) = lane.refTick();
        assertEq(t, 222_267);
        assertEq(band, 100);
        assertEq(code, 0);
        // Market closed: the feeds are sound, so the tick is still reported with code 5.
        vm.warp(SAT_0000);
        usdgFeed.setUpdatedAt(block.timestamp);
        nvdaFeed.setUpdatedAt(block.timestamp);
        (t,, code) = lane.refTick();
        assertEq(t, 222_267);
        assertEq(code, 5);
    }

    // ------------------------------------------------------------------ execution tick guard

    function test_tickGuard() public {
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        int24 t = _tick();
        _expectRerangeRevert(r, t, 11, abi.encodeWithSelector(IDeskLane.TickDeltaAboveCap.selector, 11, 10));
        _expectRerangeRevert(r, t + 11, 10, abi.encodeWithSelector(IDeskLane.PoolTickMoved.selector, t, t + 11, 10));
        _expectRerangeRevert(r, t - 1, 0, abi.encodeWithSelector(IDeskLane.PoolTickMoved.selector, t, t - 1, 0));
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        lane.rerange(m, r, t + 10, 10); // |delta| == maxTickDelta is fine
    }

    // ------------------------------------------------------------------ range shape and shares

    function test_rangeShape() public {
        int24 t = _tick();
        int24 lo = _floor(t - 100);
        _expectRerangeRevert(_range(lo + 5, lo + 200), t, 10, abi.encodeWithSelector(IDeskLane.BadRange.selector, 0));
        _expectRerangeRevert(_range(lo + 200, lo), t, 10, abi.encodeWithSelector(IDeskLane.BadRange.selector, 0));
        _expectRerangeRevert(_range(lo, lo + 10), t, 10, abi.encodeWithSelector(IDeskLane.BadRange.selector, 0));
        _expectRerangeRevert(_range(lo, lo + 2010), t, 10, abi.encodeWithSelector(IDeskLane.BadRange.selector, 0));

        IDeskTypes.RangeSpec[] memory zero = _range(lo, lo + 200);
        zero[0].share0Bps = 0;
        zero[0].share1Bps = 0;
        _expectRerangeRevert(zero, t, 10, abi.encodeWithSelector(IDeskLane.BadRange.selector, 0));

        IDeskTypes.RangeSpec[] memory dup = new IDeskTypes.RangeSpec[](2);
        dup[0] = IDeskTypes.RangeSpec(lo, lo + 200, 5000, 5000);
        dup[1] = IDeskTypes.RangeSpec(lo, lo + 200, 5000, 5000);
        _expectRerangeRevert(dup, t, 10, abi.encodeWithSelector(IDeskLane.BadRange.selector, 1));

        IDeskTypes.RangeSpec[] memory over = new IDeskTypes.RangeSpec[](2);
        over[0] = IDeskTypes.RangeSpec(lo, lo + 200, 6000, 5000);
        over[1] = IDeskTypes.RangeSpec(lo - 20, lo + 220, 5000, 5000);
        _expectRerangeRevert(over, t, 10, abi.encodeWithSelector(IDeskLane.SharesExceed.selector));

        IDeskTypes.RangeSpec[] memory three = new IDeskTypes.RangeSpec[](3);
        _expectRerangeRevert(three, t, 10, abi.encodeWithSelector(IDeskLane.TooManyRanges.selector, 3));
    }

    /// @dev caps.maxRanges binds below MAX_SLOTS: at maxRanges 1 two single-sided ranges revert TooManyRanges(2)
    /// (three ranges would be refused by the slot count alone), and one still mints.
    function test_maxRangesCapBelowSlots() public {
        IDeskTypes.Caps memory c = DeskDefaults.laneCaps();
        c.maxRanges = 1;
        vm.prank(owner);
        lane.setCaps(c); // tighter: applies now
        int24 t = _tick();
        IDeskTypes.RangeSpec[] memory two = new IDeskTypes.RangeSpec[](2);
        two[0] = IDeskTypes.RangeSpec(_ceil(t + 1), _ceil(t + 1) + 200, 10_000, 0); // token0 above the pool
        two[1] = IDeskTypes.RangeSpec(_floor(t) - 200, _floor(t), 0, 10_000); // token1 below the pool
        _expectRerangeRevert(two, t, 10, abi.encodeWithSelector(IDeskLane.TooManyRanges.selector, 2));
        IDeskTypes.RangeSpec[] memory one = new IDeskTypes.RangeSpec[](1);
        one[0] = two[0];
        _rerange(one);
        assertTrue(lane.positions()[0] != 0 && lane.positions()[1] == 0);
    }

    // ------------------------------------------------------------------ placement fence

    function test_placementFence() public {
        // Pool == ref (222267), band 100.
        int24 t = _tick();
        // Straddle wider than the band is fine (only the current tick matters for a straddle).
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        lane.rerange(m, _range(222_000, 222_600), t, 10);
        _warpFresh(301);

        // Token0 offered below ref - band: [ref-110, ref-60) sits above the pool only if the pool is lower.
        mover.moveTo(222_267 - 150);
        t = _tick();
        _expectRerangeRevert(
            _range(222_150, 222_200),
            t,
            10,
            abi.encodeWithSelector(IDeskLane.RangeOutsideFence.selector, 0, 222_150, 222_200, 222_267, 100)
        );
        // A straddle with the pool 150 ticks below ref is off-market.
        _expectRerangeRevert(
            _range(222_000, 222_300),
            t,
            10,
            abi.encodeWithSelector(IDeskLane.RangeOutsideFence.selector, 0, 222_000, 222_300, 222_267, 100)
        );
        // Token0 offered at or above ref - band is fine even though the pool is below.
        m = _meta();
        vm.prank(operator);
        lane.rerange(m, _range(222_170, 222_400), t, 10);
        _warpFresh(301);

        // Pool pushed above ref: token1 bids above ref + band are rejected; bids at or below are fine.
        mover.moveTo(222_267 + 150);
        t = _tick();
        _expectRerangeRevert(
            _range(222_300, 222_380),
            t,
            10,
            abi.encodeWithSelector(IDeskLane.RangeOutsideFence.selector, 0, 222_300, 222_380, 222_267, 100)
        );
        m = _meta();
        vm.prank(operator);
        lane.rerange(m, _range(222_100, 222_360), t, 10);
    }

    // ------------------------------------------------------------------ notional cap and turnover

    function test_deployCap() public {
        _fundLane(40e6, 0.2e18); // ~$114 idle in total
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        vm.prank(operator);
        vm.expectPartialRevert(IDeskLane.DeployCapExceeded.selector);
        lane.rerange(m, r, t, 10);
        // 40% of the balances fits under $60.
        r[0].share0Bps = 4000;
        r[0].share1Bps = 4000;
        _rerange(r);
    }

    function test_turnoverBucket() public {
        // $150/day at ~$48 per full rerange: the 4th full redeploy within minutes exceeds the bucket.
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        (,, uint256 u0, uint256 u1) = _rerange(r);
        assertGt(u0 + u1, 0);
        (uint256 left,,,) = lane.budgets();
        assertLt(left, 150e6 - 45e6);
        for (uint256 i; i < 2; ++i) {
            _warpFresh(300);
            _rerange(r);
        }
        _warpFresh(300);
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        vm.prank(operator);
        vm.expectPartialRevert(IDeskLane.BucketEmpty.selector);
        lane.rerange(m, r, t, 10);
    }

    // ------------------------------------------------------------------ bookkeeping

    function test_rerangeEffects() public {
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        int24[] memory ticks = new int24[](2);
        ticks[0] = r[0].tickLower;
        ticks[1] = r[0].tickUpper;
        vm.expectEmit(address(lane));
        emit IDeskLane.LaneAction(
            0, m.decisionId, IDeskTypes.Action.RERANGE, ticks, 222.6e18, 1, 0, m.reasonHash, operator
        );
        vm.prank(operator);
        (uint256[] memory ids, uint128[] memory liq, uint256 u0, uint256 u1) = lane.rerange(m, r, t, 10);
        assertEq(ids.length, 1);
        assertEq(npm.ownerOf(ids[0]), address(lane));
        assertEq(_positionLiquidity(ids[0]), liq[0]);
        assertEq(lane.positions()[0], ids[0]);
        assertEq(usdg.allowance(address(lane), address(npm)), 0);
        assertEq(nvda.allowance(address(lane), address(npm)), 0);
        (uint256 left,,, uint64 next) = lane.budgets();
        // usd6 = ceil(u0 * $1 / 1e6 * 1e6) + ceil(u1 * $222.60 / 1e18 * 1e6)
        uint256 usd6 = u0 + (u1 * 222.6e18 + 1e30 - 1) / 1e30;
        assertEq(left, 150e6 - usd6);
        assertEq(next, block.timestamp + 300);
        assertEq(lane.lastRerangeAt(), block.timestamp);
    }
}
