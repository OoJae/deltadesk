// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDeskLane} from "../../src/interfaces/IDeskLane.sol";
import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {DeskDefaults} from "../../script/DeskDefaults.sol";
import {DeskFixture} from "../utils/DeskFixture.sol";

/// @notice Role x function matrix (owner, operator, guardian, stranger) over every mutating lane function.
/// An entry of bytes4(0) means the call must succeed; otherwise it must revert with exactly that error. Entries
/// that pass auth but fail later (e.g. NoPending) prove the role was admitted.
contract DeskLaneRolesTest is DeskFixture {
    bytes4 internal constant OK = bytes4(0);
    bytes4 internal immutable NOT_OWNER = IDeskLane.NotOwner.selector;
    bytes4 internal immutable NOT_AUTH = IDeskLane.NotAuthorized.selector;
    bytes4 internal immutable NOT_FACTORY = IDeskLane.NotFactory.selector;
    bytes4 internal immutable NO_PENDING = IDeskLane.NoPending.selector;

    uint256 internal tokenId;

    function setUp() public override {
        super.setUp();
        (uint256[] memory ids,,,) = _rerange(_straddle(100));
        tokenId = ids[0];
        _warpFresh(301); // past minRerangeInterval
    }

    function _roles() internal view returns (address[4] memory) {
        return [owner, operator, guardian, stranger];
    }

    function _matrix(string memory name, bytes memory data, bytes4[4] memory expected) internal {
        address[4] memory who = _roles();
        for (uint256 i; i < 4; ++i) {
            uint256 snap = vm.snapshotState();
            vm.prank(who[i]);
            (bool ok, bytes memory ret) = address(lane).call(data);
            string memory label = string.concat(name, " as ", vm.getLabel(who[i]));
            if (expected[i] == OK) {
                assertTrue(ok, string.concat(label, ": expected success"));
            } else {
                assertFalse(ok, string.concat(label, ": expected revert"));
                assertEq(bytes4(ret), expected[i], string.concat(label, ": wrong error"));
            }
            vm.revertToState(snap);
        }
    }

    function _m() internal returns (IDeskTypes.Meta memory) {
        return _meta();
    }

    // ------------------------------------------------------------------ operator | owner

    function test_rerange() public {
        bytes memory data = abi.encodeCall(IDeskLane.rerange, (_m(), _straddle(100), _tick(), 10));
        _matrix("rerange", data, [OK, OK, NOT_AUTH, NOT_AUTH]);
    }

    function test_rerangeUnwindAndHold() public {
        bytes memory data = abi.encodeCall(IDeskLane.rerange, (_m(), new IDeskTypes.RangeSpec[](0), 0, 0));
        _matrix("rerange(hold)", data, [OK, OK, NOT_AUTH, NOT_AUTH]);
    }

    function test_collect() public {
        _matrix("collect", abi.encodeCall(IDeskLane.collect, (_m())), [OK, OK, NOT_AUTH, NOT_AUTH]);
    }

    function test_signal() public {
        _matrix("signal", abi.encodeCall(IDeskLane.signal, (_m())), [OK, OK, NOT_AUTH, NOT_AUTH]);
    }

    // ------------------------------------------------------------------ operator | owner | guardian

    function test_reduce() public {
        uint128 half = _positionLiquidity(tokenId) / 2;
        _matrix("reduce", abi.encodeCall(IDeskLane.reduce, (_m(), 0, half)), [OK, OK, OK, NOT_AUTH]);
    }

    function test_exitAll() public {
        _matrix("exitAll", abi.encodeCall(IDeskLane.exitAll, (_m())), [OK, OK, OK, NOT_AUTH]);
    }

    function test_pause() public {
        _matrix("pause", abi.encodeCall(IDeskLane.pause, ()), [OK, OK, OK, NOT_AUTH]);
    }

    // ------------------------------------------------------------------ owner | guardian

    function test_setClosedUntil() public {
        uint64 until = uint64(block.timestamp + 1 days);
        _matrix("setClosedUntil", abi.encodeCall(IDeskLane.setClosedUntil, (until)), [OK, NOT_AUTH, OK, NOT_AUTH]);
    }

    // ------------------------------------------------------------------ owner only

    function test_unpause() public {
        vm.prank(guardian);
        lane.pause();
        _matrix("unpause", abi.encodeCall(IDeskLane.unpause, ()), [OK, NOT_OWNER, NOT_OWNER, NOT_OWNER]);
    }

    function test_withdraw() public {
        _matrix(
            "withdraw", abi.encodeCall(IDeskLane.withdraw, (address(usdg), 1)), [OK, NOT_OWNER, NOT_OWNER, NOT_OWNER]
        );
    }

    function test_withdrawAll() public {
        _matrix("withdrawAll", abi.encodeCall(IDeskLane.withdrawAll, ()), [OK, NOT_OWNER, NOT_OWNER, NOT_OWNER]);
    }

    function test_withdrawPosition() public {
        _matrix(
            "withdrawPosition", abi.encodeCall(IDeskLane.withdrawPosition, (0)), [OK, NOT_OWNER, NOT_OWNER, NOT_OWNER]
        );
    }

    function test_proposeOperator() public {
        _matrix(
            "proposeOperator",
            abi.encodeCall(IDeskLane.proposeOperator, (makeAddr("newOperator"))),
            [OK, NOT_OWNER, NOT_OWNER, NOT_OWNER]
        );
    }

    function test_applyOperator() public {
        _matrix(
            "applyOperator", abi.encodeCall(IDeskLane.applyOperator, ()), [NO_PENDING, NOT_OWNER, NOT_OWNER, NOT_OWNER]
        );
        vm.prank(owner);
        lane.proposeOperator(makeAddr("newOperator"));
        vm.warp(block.timestamp + 24 hours);
        _matrix("applyOperator", abi.encodeCall(IDeskLane.applyOperator, ()), [OK, NOT_OWNER, NOT_OWNER, NOT_OWNER]);
    }

    function test_revokeOperator() public {
        _matrix("revokeOperator", abi.encodeCall(IDeskLane.revokeOperator, ()), [OK, NOT_OWNER, NOT_OWNER, NOT_OWNER]);
    }

    function test_setCaps() public {
        IDeskTypes.Caps memory c = DeskDefaults.laneCaps();
        c.maxDeployUsd6 = 10e6; // tighter
        _matrix("setCaps", abi.encodeCall(IDeskLane.setCaps, (c)), [OK, NOT_OWNER, NOT_OWNER, NOT_OWNER]);
        c.maxDeployUsd6 = 100e6; // looser -> pending
        _matrix("setCaps(loosen)", abi.encodeCall(IDeskLane.setCaps, (c)), [OK, NOT_OWNER, NOT_OWNER, NOT_OWNER]);
    }

    function test_applyAndCancelCaps() public {
        _matrix("applyCaps", abi.encodeCall(IDeskLane.applyCaps, ()), [NO_PENDING, NOT_OWNER, NOT_OWNER, NOT_OWNER]);
        _matrix("cancelCaps", abi.encodeCall(IDeskLane.cancelCaps, ()), [NO_PENDING, NOT_OWNER, NOT_OWNER, NOT_OWNER]);
        IDeskTypes.Caps memory c = DeskDefaults.laneCaps();
        c.maxDeployUsd6 = 100e6;
        vm.prank(owner);
        lane.setCaps(c);
        _matrix("cancelCaps", abi.encodeCall(IDeskLane.cancelCaps, ()), [OK, NOT_OWNER, NOT_OWNER, NOT_OWNER]);
        vm.warp(block.timestamp + 24 hours);
        _matrix("applyCaps", abi.encodeCall(IDeskLane.applyCaps, ()), [OK, NOT_OWNER, NOT_OWNER, NOT_OWNER]);
    }

    function test_setGuardian() public {
        _matrix(
            "setGuardian",
            abi.encodeCall(IDeskLane.setGuardian, (makeAddr("newGuardian"))),
            [OK, NOT_OWNER, NOT_OWNER, NOT_OWNER]
        );
    }

    // ------------------------------------------------------------------ factory only

    function test_initialize() public {
        bytes memory data = abi.encodeCall(IDeskLane.initialize, (stranger, address(0), DeskDefaults.laneCaps()));
        _matrix("initialize", data, [NOT_FACTORY, NOT_FACTORY, NOT_FACTORY, NOT_FACTORY]);
    }

    // ------------------------------------------------------------------ role edges

    /// @dev I8: the operator can never move value, change roles or caps, or unpause, whatever the state.
    function test_operatorCannotReachOwnerPowers() public {
        vm.startPrank(operator);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.withdraw(address(nvda), 1);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.withdrawAll();
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.withdrawPosition(0);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.proposeOperator(stranger);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.setGuardian(operator);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.setCaps(DeskDefaults.laneCaps());
        lane.pause();
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.unpause();
        vm.stopPrank();
    }

    function test_guardianCanOnlyExtendClosedUntil() public {
        uint64 t = uint64(block.timestamp + 1 days);
        vm.prank(guardian);
        lane.setClosedUntil(t);
        vm.prank(guardian);
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        lane.setClosedUntil(t - 1);
        vm.prank(guardian);
        lane.setClosedUntil(t + 1);
        // The owner may shorten it.
        vm.prank(owner);
        lane.setClosedUntil(0);
        assertEq(lane.closedUntil(), 0);
    }

    function test_revokedOperatorLosesEverything() public {
        vm.prank(owner);
        lane.revokeOperator();
        assertEq(lane.operator(), address(0));
        IDeskTypes.Meta memory m = _meta();
        vm.startPrank(operator);
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        lane.exitAll(m);
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        lane.pause();
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        lane.signal(m);
        vm.stopPrank();
    }

    function test_noGuardianMeansNobody() public {
        vm.prank(owner);
        lane.setGuardian(address(0));
        vm.prank(guardian);
        vm.expectRevert(IDeskLane.NotAuthorized.selector);
        lane.pause();
    }
}
