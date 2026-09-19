// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

import {DeskLaneFactory} from "../../src/DeskLaneFactory.sol";
import {DeskLaneV3} from "../../src/DeskLaneV3.sol";
import {IDeskLane} from "../../src/interfaces/IDeskLane.sol";
import {IDeskLaneFactory} from "../../src/interfaces/IDeskLaneFactory.sol";
import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {CheckDeployment} from "../../script/CheckDeployment.s.sol";
import {DeskDefaults} from "../../script/DeskDefaults.sol";
import {DeskFixture} from "../utils/DeskFixture.sol";

/// @dev A contract that claims to be the NVDA/USDG pool (same tokens and fee) but is not the factory's pool.
contract FakePool {
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
}

/// @dev A malicious "implementation": a no-op initialize and a drain that sends the clone's balance anywhere.
contract DrainerImpl {
    function initialize(address, address, IDeskTypes.Caps calldata) external {}

    function drain(address token, address to) external {
        IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
    }
}

/// @dev Exposes CheckDeployment's clone check (the off-chain pin of a lane to the reviewed implementation).
contract CheckDeploymentHarness is CheckDeployment {
    function cloneTarget(address clone) external view returns (address) {
        return _cloneTarget(clone);
    }
}

/// @dev A look-alike NPM that reports a different v3 factory.
contract LookAlikeNpm {
    function factory() external pure returns (address) {
        return address(0xFAC7);
    }
}

contract DeskLaneFactoryTest is DeskFixture {
    function _p() internal view returns (IDeskLaneFactory.CreateParams memory) {
        return _params(owner, operator, guardian, bytes32("salt-1"));
    }

    // ------------------------------------------------------------------ createLane / predictLane

    function test_predictMatchesCreate() public {
        IDeskLaneFactory.CreateParams memory p = _p();
        address predicted = factory.predictLane(p);
        assertEq(predicted.code.length, 0);
        vm.expectEmit(address(factory));
        emit IDeskLaneFactory.LaneCreated(owner, predicted, 0, 1, address(pool), operator);
        vm.expectEmit(address(factory));
        emit DeskLaneFactory.LaneListed(owner, predicted);
        vm.prank(owner);
        address l = factory.createLane(p);
        assertEq(l, predicted);
        assertTrue(factory.isLane(l));
        assertTrue(factory.listed(l));
        address[] memory mine = factory.lanesOf(owner);
        assertEq(mine.length, 2); // the fixture's lane and this one
        assertEq(mine[1], l);
        IDeskLane lane2 = IDeskLane(l);
        assertEq(lane2.owner(), owner);
        assertEq(lane2.operator(), operator);
        assertEq(lane2.guardian(), guardian);
        assertEq(lane2.pool(), address(pool));
        assertEq(keccak256(abi.encode(lane2.caps())), keccak256(abi.encode(p.caps)));
        assertEq(factory.laneArgs(p).length, 89);
    }

    function testFuzz_predictMatchesCreate(address o, address op, address g, uint8 laneId, bytes32 salt) public {
        vm.assume(o != address(0) && op != address(0) && o != op);
        IDeskLaneFactory.CreateParams memory p = _params(o, op, g, salt);
        p.laneId = laneId;
        address predicted = factory.predictLane(p);
        address l = factory.createLane(p);
        assertEq(l, predicted);
    }

    /// @dev The salt commits to every parameter: changing any field moves the address, so a front-runner can only
    /// deploy exactly what the owner asked for. The front-run is harmless: the owner's own createLane then returns
    /// that lane and lists it; any further repeat reverts LaneExists.
    function test_saltCommitsToEveryParam() public {
        IDeskLaneFactory.CreateParams memory p = _p();
        address base = factory.predictLane(p);
        IDeskLaneFactory.CreateParams memory q = _p();
        q.operator = stranger;
        assertTrue(factory.predictLane(q) != base);
        q = _p();
        q.guardian = address(0);
        assertTrue(factory.predictLane(q) != base);
        q = _p();
        q.caps.maxDeployUsd6 -= 1;
        assertTrue(factory.predictLane(q) != base);
        q = _p();
        q.laneId = 1;
        assertTrue(factory.predictLane(q) != base);
        q = _p();
        q.salt = bytes32("salt-2");
        assertTrue(factory.predictLane(q) != base);

        vm.prank(stranger);
        address l = factory.createLane(p); // a front-runner deploys the owner's exact lane
        assertEq(l, base);
        assertFalse(factory.listed(l));
        vm.prank(owner);
        assertEq(factory.createLane(p), base); // the owner's transaction still lands on the same lane
        assertTrue(factory.listed(l));
        assertEq(factory.lanesOf(owner)[1], l);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(DeskLaneFactory.LaneExists.selector, l));
        factory.createLane(p);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DeskLaneFactory.LaneExists.selector, l));
        factory.createLane(p);
    }

    /// @dev createLane is permissionless, but only the owner can list a lane in lanesOf(owner). A stranger can deploy
    /// a genuine clone naming the victim as owner with an attacker operator and guardian at the ceiling caps (isLane
    /// is true: it only vouches for the code); it never appears among the victim's lanes, emits no LaneListed, and
    /// the stranger cannot list it either. (lanesOf used to list it, and the web offered it to the victim to fund.)
    function test_strangerCannotListALaneForAnOwner() public {
        address evilOp = makeAddr("evilOperator");
        IDeskLaneFactory.CreateParams memory p = _params(owner, evilOp, evilOp, bytes32("evil"));
        p.caps = DeskDefaults.ceilings();
        vm.recordLogs();
        vm.prank(stranger);
        address evil = factory.createLane(p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != DeskLaneFactory.LaneListed.selector, "a stranger's lane was listed");
        }
        assertTrue(factory.isLane(evil));
        assertEq(DeskLaneV3(evil).owner(), owner);
        assertEq(DeskLaneV3(evil).operator(), evilOp);
        assertFalse(factory.listed(evil));
        address[] memory mine = factory.lanesOf(owner);
        assertEq(mine.length, 1);
        assertEq(mine[0], address(lane));
        assertEq(factory.lanesOf(stranger).length, 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DeskLaneFactory.LaneExists.selector, evil));
        factory.createLane(p);
        assertEq(factory.lanesOf(owner).length, 1);
    }

    // ------------------------------------------------------------------ validation

    function test_unknownKind() public {
        IDeskLaneFactory.CreateParams memory p = _p();
        p.kind = 2;
        vm.expectRevert(abi.encodeWithSelector(IDeskLaneFactory.UnknownKind.selector, 2));
        factory.createLane(p);
        vm.expectRevert(abi.encodeWithSelector(IDeskLaneFactory.UnknownKind.selector, 2));
        factory.predictLane(p);
    }

    function test_poolNotAllowed() public {
        address other = v3Factory.createPool(address(usdg), address(nvda), 3000);
        IDeskLaneFactory.CreateParams memory p = _p();
        p.pool = other;
        vm.expectRevert(abi.encodeWithSelector(IDeskLaneFactory.PoolNotAllowed.selector, other));
        factory.createLane(p);
        // Allowed for another kind only: still not allowed for kind 1.
        vm.prank(admin);
        factory.setPoolAllowed(other, 2, true);
        vm.expectRevert(abi.encodeWithSelector(IDeskLaneFactory.PoolNotAllowed.selector, other));
        factory.createLane(p);
    }

    /// @dev N4: an allowlisted contract that mimics the pool (same tokens and fee) is not getPool(t0, t1, fee).
    function test_poolMismatch() public {
        FakePool fake = new FakePool(address(usdg), address(nvda));
        vm.prank(admin);
        factory.setPoolAllowed(address(fake), 1, true);
        IDeskLaneFactory.CreateParams memory p = _p();
        p.pool = address(fake);
        vm.expectRevert(abi.encodeWithSelector(IDeskLaneFactory.PoolMismatch.selector, address(fake)));
        factory.createLane(p);
    }

    /// @dev N4: the implementation refuses an NPM that mints into another v3 factory's pools.
    function test_lookAlikeNpmRejected() public {
        LookAlikeNpm fakeNpm = new LookAlikeNpm();
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.InvalidConfig.selector, 5));
        new DeskLaneV3(address(factory), address(fakeNpm), address(fence));
    }

    function test_operatorInvalid() public {
        IDeskLaneFactory.CreateParams memory p = _p();
        p.operator = owner;
        vm.expectRevert(IDeskLaneFactory.OperatorInvalid.selector);
        factory.createLane(p);
        p.operator = address(0);
        vm.expectRevert(IDeskLaneFactory.OperatorInvalid.selector);
        factory.createLane(p);
        p = _p();
        p.owner = address(0);
        vm.expectRevert(IDeskLaneFactory.OperatorInvalid.selector);
        factory.createLane(p);
    }

    /// @dev Every field above (or, for the two lower-bound fields, below) its ceiling is rejected with its index.
    function test_capsAboveCeiling() public {
        IDeskTypes.Caps memory ceil = factory.ceilings();
        for (uint8 f; f < 11; ++f) {
            IDeskLaneFactory.CreateParams memory p = _p();
            p.salt = bytes32(uint256(f));
            if (f == 0) p.caps.maxDeployUsd6 = ceil.maxDeployUsd6 + 1;
            if (f == 1) p.caps.turnoverUsd6PerDay = ceil.turnoverUsd6PerDay + 1;
            if (f == 2) p.caps.placeBandBps = ceil.placeBandBps + 1;
            if (f == 3) p.caps.maxTickDelta = ceil.maxTickDelta + 1;
            if (f == 4) p.caps.minWidthTicks = ceil.minWidthTicks - 1;
            if (f == 5) p.caps.maxWidthTicks = ceil.maxWidthTicks + 1;
            if (f == 6) p.caps.reranges1h = ceil.reranges1h + 1;
            if (f == 7) p.caps.reranges24h = ceil.reranges24h + 1;
            if (f == 8) p.caps.minRerangeInterval = ceil.minRerangeInterval - 1;
            if (f == 9) p.caps.maxDeadlineAhead = ceil.maxDeadlineAhead + 1;
            if (f == 10) p.caps.maxRanges = ceil.maxRanges + 1;
            vm.expectRevert(abi.encodeWithSelector(IDeskLaneFactory.CapsAboveCeiling.selector, f));
            factory.createLane(p);
        }
        // Exactly at the ceilings is fine.
        IDeskLaneFactory.CreateParams memory q = _p();
        q.caps = ceil;
        q.caps.minWidthTicks = 2;
        factory.createLane(q);
    }

    /// @dev The lane validates its own shape too: minWidthTicks > maxWidthTicks passes the ceilings but not
    /// initialize.
    function test_malformedCapsRejectedByLane() public {
        IDeskLaneFactory.CreateParams memory p = _p();
        p.caps.minWidthTicks = 3000;
        p.caps.maxWidthTicks = 2500;
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.InvalidConfig.selector, 2));
        factory.createLane(p);
    }

    // ------------------------------------------------------------------ admin

    function test_adminOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(IDeskLaneFactory.NotAdmin.selector);
        factory.setImplementation(1, address(impl));
        vm.expectRevert(IDeskLaneFactory.NotAdmin.selector);
        factory.applyImplementation(1);
        vm.expectRevert(IDeskLaneFactory.NotAdmin.selector);
        factory.setPoolAllowed(address(pool), 1, false);
        vm.expectRevert(IDeskLaneFactory.NotAdmin.selector);
        factory.setCeilings(DeskDefaults.ceilings());
        vm.expectRevert(IDeskLaneFactory.NotAdmin.selector);
        factory.proposeAdmin(stranger);
        vm.expectRevert(IDeskLaneFactory.NotAdmin.selector);
        factory.acceptAdmin();
        vm.stopPrank();
    }

    function test_twoStepAdmin() public {
        address next = makeAddr("nextAdmin");
        vm.prank(admin);
        factory.proposeAdmin(next);
        assertEq(factory.admin(), admin);
        assertEq(factory.pendingAdmin(), next);
        vm.prank(stranger);
        vm.expectRevert(IDeskLaneFactory.NotAdmin.selector);
        factory.acceptAdmin();
        vm.prank(next);
        vm.expectEmit(address(factory));
        emit IDeskLaneFactory.AdminChanged(next);
        factory.acceptAdmin();
        assertEq(factory.admin(), next);
        assertEq(factory.pendingAdmin(), address(0));
        vm.prank(admin);
        vm.expectRevert(IDeskLaneFactory.NotAdmin.selector);
        factory.setPoolAllowed(address(pool), 1, false);
    }

    /// @dev Admin changes reach new clones only.
    function test_adminChangesAffectNewClonesOnly() public {
        IDeskTypes.Caps memory tight = DeskDefaults.ceilings();
        tight.maxDeployUsd6 = 10e6;
        vm.startPrank(admin);
        factory.setCeilings(tight);
        factory.setPoolAllowed(address(pool), 1, false);
        factory.setImplementation(1, address(0));
        vm.stopPrank();
        // The existing lane keeps working with its caps.
        _rerange(_straddle(100));
        assertEq(lane.caps().maxDeployUsd6, 60e6);
        // New lanes see the changes.
        vm.expectRevert(abi.encodeWithSelector(IDeskLaneFactory.UnknownKind.selector, 1));
        factory.createLane(_p());
    }

    /// @dev Replacing a registered kind's implementation is timelocked, so an admin (or a stolen admin key) cannot
    /// swap the code under an in-flight createLane: the owner's lane still lands at predictLane with the reviewed
    /// implementation, and the drainer is public for 24 h before any new lane can use it. (Before the timelock the
    /// swap applied at once: the owner's createLane deployed the drainer at another address, isLane vouched for it
    /// and the admin drained the funded lane.)
    function test_implementationReplacementIsTimelocked() public {
        IDeskLaneFactory.CreateParams memory p = _params(owner, operator, guardian, bytes32("fresh"));
        address predicted = factory.predictLane(p);
        DrainerImpl drainer = new DrainerImpl();
        uint64 eta = uint64(block.timestamp + 24 hours);
        vm.expectEmit(address(factory));
        emit DeskLaneFactory.ImplementationProposed(1, address(drainer), eta);
        vm.prank(admin);
        factory.setImplementation(1, address(drainer));
        assertEq(factory.implementations(1), address(impl));
        (address pending, uint64 pendingEta) = factory.pendingImplementation(1);
        assertEq(pending, address(drainer));
        assertEq(pendingEta, eta);

        vm.prank(owner);
        address l = factory.createLane(p);
        assertEq(l, predicted, "the in-flight createLane lands at the prediction");
        usdg.mint(l, 25e6);
        vm.expectRevert();
        DrainerImpl(l).drain(address(usdg), admin);
        assertEq(DeskLaneV3(l).operator(), operator);

        vm.startPrank(admin);
        vm.warp(eta - 1);
        vm.expectRevert(abi.encodeWithSelector(DeskLaneFactory.ImplementationTimelocked.selector, 1, eta));
        factory.applyImplementation(1);
        vm.warp(eta);
        vm.expectEmit(address(factory));
        emit IDeskLaneFactory.ImplementationSet(1, address(drainer));
        factory.applyImplementation(1);
        assertEq(factory.implementations(1), address(drainer));
        (pending, pendingEta) = factory.pendingImplementation(1);
        assertEq(pending, address(0));
        assertEq(pendingEta, 0);
        vm.expectRevert(abi.encodeWithSelector(DeskLaneFactory.NoPendingImplementation.selector, 1));
        factory.applyImplementation(1);
        vm.stopPrank();
    }

    /// @dev What applies at once: a kind's first registration, disabling a kind (which drops a pending replacement)
    /// and re-affirming the current implementation (which cancels one). Re-enabling a disabled kind is a replacement
    /// and waits; a newer proposal supersedes the pending one and restarts the delay.
    function test_setImplementationInstantCases() public {
        DeskLaneV3 other = new DeskLaneV3(address(factory), address(npm), address(fence));
        vm.startPrank(admin);
        assertFalse(factory.kindRegistered(3));
        factory.setImplementation(3, address(other)); // first registration of kind 3
        assertEq(factory.implementations(3), address(other));
        assertTrue(factory.kindRegistered(3));

        factory.setImplementation(1, address(other)); // replacement: pending
        factory.setImplementation(1, address(impl)); // re-affirm: cancels
        (address pending,) = factory.pendingImplementation(1);
        assertEq(pending, address(0));
        assertEq(factory.implementations(1), address(impl));

        factory.setImplementation(1, address(other));
        vm.warp(block.timestamp + 12 hours);
        factory.setImplementation(1, address(other)); // re-proposed: the delay restarts
        (, uint64 eta) = factory.pendingImplementation(1);
        assertEq(eta, block.timestamp + 24 hours);
        factory.setImplementation(1, address(0)); // disable: instant, drops the pending replacement
        assertEq(factory.implementations(1), address(0));
        (pending,) = factory.pendingImplementation(1);
        assertEq(pending, address(0));

        factory.setImplementation(1, address(impl)); // re-enabling waits too
        assertEq(factory.implementations(1), address(0));
        vm.warp(block.timestamp + 24 hours);
        factory.applyImplementation(1);
        assertEq(factory.implementations(1), address(impl));
        vm.stopPrank();
    }

    /// @dev CheckDeployment's LANE check reads the implementation out of the clone's EIP-1167 code, so a lane is
    /// pinned to the reviewed implementation whatever the factory's registry says.
    function test_checkDeploymentReadsTheCloneTarget() public {
        CheckDeploymentHarness c = new CheckDeploymentHarness();
        assertEq(c.cloneTarget(address(lane)), address(impl));
        assertEq(c.cloneTarget(address(impl)), address(0));
        assertEq(c.cloneTarget(owner), address(0));
    }

    function test_setImplementationNeedsCode() public {
        vm.prank(admin);
        vm.expectRevert(DeskLaneFactory.ZeroAddress.selector);
        factory.setImplementation(1, makeAddr("eoa"));
    }

    function test_constructorChecks() public {
        vm.expectRevert(DeskLaneFactory.ZeroAddress.selector);
        new DeskLaneFactory(address(0), address(v3Factory), DeskDefaults.ceilings());
        vm.expectRevert(DeskLaneFactory.ZeroAddress.selector);
        new DeskLaneFactory(admin, address(0), DeskDefaults.ceilings());
        IDeskTypes.Caps memory bad = DeskDefaults.ceilings();
        bad.maxRanges = 0;
        vm.expectRevert(DeskLaneFactory.BadCeilings.selector);
        new DeskLaneFactory(admin, address(v3Factory), bad);
    }

    function test_views() public view {
        assertEq(factory.V3_FACTORY(), address(v3Factory));
        assertEq(factory.admin(), admin);
        assertEq(factory.implementations(1), address(impl));
        assertTrue(factory.poolAllowed(address(pool), 1));
        assertEq(keccak256(abi.encode(factory.ceilings())), keccak256(abi.encode(DeskDefaults.ceilings())));
        assertEq(impl.FACTORY(), address(factory));
        assertEq(address(impl.NPM()), address(npm));
        assertEq(impl.V3_FACTORY(), address(v3Factory));
        assertEq(address(impl.FENCE()), address(fence));
    }
}
