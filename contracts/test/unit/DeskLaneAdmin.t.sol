// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {DeskLaneV3} from "../../src/DeskLaneV3.sol";
import {IDeskLane} from "../../src/interfaces/IDeskLane.sol";
import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {CloneArgs} from "../../src/libraries/CloneArgs.sol";
import {DeskDefaults} from "../../script/DeskDefaults.sol";
import {DeskFixture} from "../utils/DeskFixture.sol";

/// @notice Timelocks (operator, caps), guardian/closedUntil, initialize-once and the locked implementation.
contract DeskLaneAdminTest is DeskFixture {
    address internal newOperator = makeAddr("newOperator");

    function _caps() internal pure returns (IDeskTypes.Caps memory) {
        return DeskDefaults.laneCaps();
    }

    function _eq(IDeskTypes.Caps memory a, IDeskTypes.Caps memory b) internal pure returns (bool) {
        return keccak256(abi.encode(a)) == keccak256(abi.encode(b));
    }

    // ------------------------------------------------------------------ operator timelock

    function test_operatorTimelock() public {
        vm.prank(owner);
        vm.expectEmit(address(lane));
        emit IDeskLane.OperatorProposed(newOperator, uint64(block.timestamp + 24 hours));
        lane.proposeOperator(newOperator);
        (address pending, uint64 eta) = lane.pendingOperator();
        assertEq(pending, newOperator);
        assertEq(eta, block.timestamp + 24 hours);
        assertEq(lane.operator(), operator); // unchanged until applied

        vm.warp(eta - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.TimelockActive.selector, eta));
        lane.applyOperator();

        vm.warp(eta);
        vm.prank(owner);
        vm.expectEmit(address(lane));
        emit IDeskLane.OperatorChanged(newOperator);
        lane.applyOperator();
        assertEq(lane.operator(), newOperator);
        (pending, eta) = lane.pendingOperator();
        assertEq(pending, address(0));
        assertEq(eta, 0);

        // The old operator is out, the new one is in.
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        lane.signal(m);
        vm.prank(newOperator);
        lane.signal(m);
    }

    function test_proposeOperatorRejectsOwnerAndZero() public {
        vm.startPrank(owner);
        vm.expectRevert(IDeskLane.OperatorIsOwner.selector);
        lane.proposeOperator(owner);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.InvalidConfig.selector, 1));
        lane.proposeOperator(address(0));
        vm.expectRevert(IDeskLane.NoPending.selector);
        lane.applyOperator();
        vm.stopPrank();
    }

    function test_revokeIsInstantAndCancelsPending() public {
        vm.startPrank(owner);
        lane.proposeOperator(newOperator);
        vm.expectEmit(address(lane));
        emit IDeskLane.OperatorRevoked();
        lane.revokeOperator();
        vm.stopPrank();
        assertEq(lane.operator(), address(0));
        (address pending,) = lane.pendingOperator();
        assertEq(pending, address(0));
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        vm.expectRevert(IDeskLane.NoPending.selector);
        lane.applyOperator();
    }

    function test_reproposeRestartsTimelock() public {
        vm.prank(owner);
        lane.proposeOperator(newOperator);
        vm.warp(block.timestamp + 23 hours);
        vm.prank(owner);
        lane.proposeOperator(stranger);
        (, uint64 eta) = lane.pendingOperator();
        assertEq(eta, block.timestamp + 24 hours);
    }

    // ------------------------------------------------------------------ caps timelock

    function test_tightenAppliesImmediately() public {
        IDeskTypes.Caps memory c = _caps();
        c.maxDeployUsd6 = 10e6;
        c.minRerangeInterval = 600; // larger = tighter
        c.minWidthTicks = 40; // larger = tighter
        c.maxDeadlineAhead = 60;
        vm.prank(owner);
        lane.setCaps(c);
        assertTrue(_eq(lane.caps(), c));
        (, uint64 eta) = lane.pendingCaps();
        assertEq(eta, 0);
    }

    function test_loosenIsTimelocked() public {
        IDeskTypes.Caps memory c = _caps();
        c.maxDeployUsd6 = 100e6; // looser
        vm.prank(owner);
        lane.setCaps(c);
        assertTrue(_eq(lane.caps(), _caps())); // nothing applied yet
        (IDeskTypes.Caps memory pending, uint64 eta) = lane.pendingCaps();
        assertTrue(_eq(pending, c));
        assertEq(eta, block.timestamp + 24 hours);

        vm.warp(eta - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.TimelockActive.selector, eta));
        lane.applyCaps();
        vm.warp(eta);
        vm.prank(owner);
        lane.applyCaps();
        assertTrue(_eq(lane.caps(), c));
        (, eta) = lane.pendingCaps();
        assertEq(eta, 0);
    }

    /// @dev Every loosening direction is timelocked, including the lower-bound fields.
    function test_eachLooseFieldGoesPending() public {
        for (uint256 f; f < 11; ++f) {
            uint256 snap = vm.snapshotState();
            IDeskTypes.Caps memory c = _caps();
            if (f == 0) c.maxDeployUsd6 += 1;
            if (f == 1) c.turnoverUsd6PerDay += 1;
            if (f == 2) c.placeBandBps += 1;
            if (f == 3) c.maxTickDelta += 1;
            if (f == 4) c.minWidthTicks -= 1; // smaller min = looser
            if (f == 5) c.maxWidthTicks += 1;
            if (f == 6) c.reranges1h += 1;
            if (f == 7) c.reranges24h += 1;
            if (f == 8) c.minRerangeInterval -= 1; // smaller min = looser
            if (f == 9) c.maxDeadlineAhead += 1;
            if (f == 10) {
                vm.startPrank(owner);
                IDeskTypes.Caps memory t = _caps();
                t.maxRanges = 1;
                lane.setCaps(t); // tighten first so that 2 is a loosening
                vm.stopPrank();
            }
            IDeskTypes.Caps memory before = lane.caps();
            vm.prank(owner);
            lane.setCaps(c);
            assertTrue(_eq(lane.caps(), before), "loose field applied immediately");
            (, uint64 eta) = lane.pendingCaps();
            assertGt(eta, 0, "not pending");
            vm.revertToState(snap);
        }
    }

    function test_mixedTightenNowLoosenLater() public {
        IDeskTypes.Caps memory c = _caps();
        c.maxDeployUsd6 = 10e6; // tighter
        c.reranges1h = 8; // looser
        vm.prank(owner);
        lane.setCaps(c);
        IDeskTypes.Caps memory now_ = lane.caps();
        assertEq(now_.maxDeployUsd6, 10e6);
        assertEq(now_.reranges1h, 4);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(owner);
        lane.applyCaps();
        assertTrue(_eq(lane.caps(), c));
    }

    function test_tightenOnlyCallSupersedesPendingLoosen() public {
        IDeskTypes.Caps memory loose = _caps();
        loose.maxDeployUsd6 = 100e6;
        vm.prank(owner);
        lane.setCaps(loose);
        IDeskTypes.Caps memory tight = _caps();
        tight.placeBandBps = 80;
        vm.prank(owner);
        lane.setCaps(tight);
        (, uint64 eta) = lane.pendingCaps();
        assertEq(eta, 0);
        assertTrue(_eq(lane.caps(), tight));
    }

    function test_cancelCaps() public {
        IDeskTypes.Caps memory c = _caps();
        c.turnoverUsd6PerDay = 300e6;
        vm.startPrank(owner);
        lane.setCaps(c);
        lane.cancelCaps();
        vm.expectRevert(IDeskLane.NoPending.selector);
        lane.cancelCaps();
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(IDeskLane.NoPending.selector);
        lane.applyCaps();
        vm.stopPrank();
        assertTrue(_eq(lane.caps(), _caps()));
    }

    function test_setCapsValidation() public {
        IDeskTypes.Caps memory c = _caps();
        c.maxRanges = 3; // more than the lane's two slots
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.InvalidConfig.selector, 2));
        lane.setCaps(c);
        c = _caps();
        c.minWidthTicks = 3000; // > maxWidthTicks
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.InvalidConfig.selector, 2));
        lane.setCaps(c);
        c = _caps();
        c.maxDeployUsd6 = 5_000e6 + 1; // above the implementation CEILINGS
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.InvalidConfig.selector, 3));
        lane.setCaps(c);
        c = _caps();
        c.minRerangeInterval = 59; // below the lower-bound ceiling
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.InvalidConfig.selector, 3));
        lane.setCaps(c);
    }

    function test_tightenedBudgetsClampImmediately() public {
        IDeskTypes.Caps memory c = _caps();
        c.turnoverUsd6PerDay = 10e6;
        c.reranges1h = 1;
        vm.prank(owner);
        lane.setCaps(c);
        (uint256 turnover, uint256 rr1h,,) = lane.budgets();
        assertEq(turnover, 10e6);
        assertEq(rr1h, 1);
    }

    // ------------------------------------------------------------------ guardian, closedUntil

    function test_setGuardianInstant() public {
        address g2 = makeAddr("g2");
        vm.prank(owner);
        vm.expectEmit(address(lane));
        emit IDeskLane.GuardianChanged(g2);
        lane.setGuardian(g2);
        assertEq(lane.guardian(), g2);
        vm.prank(g2);
        lane.pause();
        assertTrue(lane.paused());
    }

    function test_closedUntilBlocksRiskAdding() public {
        uint64 until = uint64(block.timestamp + 1 hours);
        vm.prank(guardian);
        lane.setClosedUntil(until);
        (bool open, uint8 code) = lane.riskAddingOpen();
        assertFalse(open);
        assertEq(code, 101);
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.ClosedUntilActive.selector, until));
        lane.rerange(m, r, t, 10);
        _warpFresh(1 hours);
        (open,) = lane.riskAddingOpen();
        assertTrue(open);
        _rerange(r);
    }

    function test_pauseUnpause() public {
        vm.prank(operator);
        vm.expectEmit(address(lane));
        emit IDeskLane.Paused(operator);
        lane.pause();
        (bool open, uint8 code) = lane.riskAddingOpen();
        assertFalse(open);
        assertEq(code, 100);
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        vm.prank(operator);
        vm.expectRevert(IDeskLane.IsPaused.selector);
        lane.rerange(m, r, t, 10);
        vm.prank(owner);
        lane.unpause();
        assertFalse(lane.paused());
        _rerange(r);
    }

    // ------------------------------------------------------------------ initialize-once, implementation locked

    function test_initializeOnce() public {
        vm.prank(address(factory));
        vm.expectRevert(IDeskLane.AlreadyInitialized.selector);
        lane.initialize(stranger, address(0), _caps());
    }

    function test_implementationLocked() public {
        vm.prank(address(factory));
        vm.expectRevert(IDeskLane.AlreadyInitialized.selector);
        impl.initialize(stranger, address(0), _caps());
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        impl.owner();
        IDeskTypes.Meta memory m = _meta();
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        impl.exitAll(m);
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        impl.withdrawAll();
        assertEq(impl.operator(), address(0));
        assertTrue(_eq(impl.CEILINGS(), DeskDefaults.ceilings()));
    }

    /// @dev Anyone can deploy a clone of the implementation with arbitrary args, but only FACTORY can initialize
    /// it, and the factory does not list it (isLane false).
    function test_foreignCloneCannotBeInitialized() public {
        bytes memory args = CloneArgs.encode(
            CloneArgs.Args(stranger, 0, address(pool), address(usdg), address(nvda), FEE, SPACING, 6, 18)
        );
        address fake = Clones.cloneWithImmutableArgs(address(impl), args);
        vm.prank(stranger);
        vm.expectRevert(IDeskLane.NotFactory.selector);
        DeskLaneV3(fake).initialize(operator, address(0), _caps());
        assertFalse(factory.isLane(fake));
        assertEq(DeskLaneV3(fake).operator(), address(0));
    }

    function test_cloneArgsRoundTrip() public view {
        assertEq(lane.owner(), owner);
        assertEq(lane.laneId(), 0);
        assertEq(lane.pool(), address(pool));
        assertEq(lane.token0(), address(usdg));
        assertEq(lane.token1(), address(nvda));
        (uint24 fee, int24 spacing, uint8 dec0, uint8 dec1) = lane.poolParams();
        assertEq(fee, FEE);
        assertEq(spacing, SPACING);
        assertEq(dec0, 6);
        assertEq(dec1, 18);
        assertEq(lane.fence(), address(fence));
        assertEq(lane.operator(), operator);
        assertEq(lane.guardian(), guardian);
        assertTrue(_eq(lane.caps(), _caps()));
        assertEq(address(lane).code.length, 45 + CloneArgs.LENGTH);
    }

    function testFuzz_cloneArgsCodec(
        address o,
        uint8 id,
        address p,
        address t0,
        address t1,
        uint24 fee,
        int24 spacing,
        uint8 d0,
        uint8 d1
    ) public pure {
        CloneArgs.Args memory a = CloneArgs.Args(o, id, p, t0, t1, fee, spacing, d0, d1);
        bytes memory enc = CloneArgs.encode(a);
        assertEq(enc.length, CloneArgs.LENGTH);
        CloneArgs.Args memory b = CloneArgs.decode(enc);
        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)));
    }
}
