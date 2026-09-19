// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {INonfungiblePositionManagerMin as INPM} from "../../src/interfaces/external/INonfungiblePositionManagerMin.sol";
import {DeskDefaults} from "../../script/DeskDefaults.sol";
import {ForkBase} from "../utils/ForkBase.sol";

/// @notice The whole lane lifecycle on 4663 against the real pool, NPM, USDG, NVDA and Chainlink feeds: create, fund
/// ~$50, first mint, whale swaps that earn fees, collect, reduce, rerange, exitAll, withdrawAll; plus the NFT escape
/// hatch. On a weekend block the test moves to Monday 02:00 UTC and re-stamps the live feed rounds (logged).
contract ForkLifecycleTest is ForkBase {
    bytes32 internal constant ERC20_TRANSFER = keccak256("Transfer(address,address,uint256)");

    function setUp() public {
        if (!_fork(WEEKDAY_BLOCK)) return;
        _deployDesk();
        lane = _createLane(DeskDefaults.laneCaps());
        mover = _mover();
        if (_openMarket()) emit log("weekend or stale block: feeds re-stamped at the live answers");
        _fundUsd(address(lane), 25e6);
        assertEq(fence.status(address(USDG)), 0, "USDG fence");
        assertEq(fence.status(address(NVDA)), 0, "NVDA fence");
    }

    function test_lifecycle() public {
        // first mint: the whole balance, fence-safe around the pool
        uint256 nav0 = _navUsd6();
        (uint256[] memory ids,, uint256 used0, uint256 used1) = _rerange(_fenceSafeRanges(100, 10_000));
        assertGt(used0 + used1, 0);
        for (uint256 i; i < ids.length; ++i) {
            assertEq(NPM.ownerOf(ids[i]), address(lane));
        }
        assertEq(NPM.balanceOf(address(lane)), ids.length);
        _assertNoAllowances();
        (uint256 turnLeft,,,) = lane.budgets();
        assertLt(turnLeft, 150e6);
        emit log_named_decimal_uint("NAV before (USD)", nav0, 6);
        emit log_named_decimal_uint("turnover left (USD)", turnLeft, 6);

        // a whale trades through the range both ways: fees for the lane
        int24 t0 = _tick();
        for (uint256 i; i < 3; ++i) {
            mover.moveTo(t0 + 60);
            mover.moveTo(t0 - 60);
        }
        mover.moveTo(t0);
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        (uint256 fee0, uint256 fee1) = lane.collect(m);
        assertGt(fee0 + fee1, 0, "fees earned");
        emit log_named_uint("fees USDG (base units)", fee0);
        emit log_named_uint("fees NVDA (wei)", fee1);

        // the watchdog halves the first position
        uint128 liq = _positionLiquidity(ids[0]);
        m = _meta();
        vm.prank(guardian);
        lane.reduce(m, 0, liq / 2);
        assertEq(_positionLiquidity(ids[0]), liq - liq / 2);

        // a later rerange unwinds everything and places again
        _warpFresh(301);
        (uint256[] memory ids2,,,) = _rerange(_fenceSafeRanges(150, 10_000));
        for (uint256 i; i < ids.length; ++i) {
            vm.expectRevert("ERC721: owner query for nonexistent token");
            NPM.ownerOf(ids[i]);
        }
        assertEq(NPM.balanceOf(address(lane)), ids2.length);
        _assertNoAllowances();

        // exit: everything idle in the lane, nothing leaves it
        vm.recordLogs();
        _exitAll(operator);
        _assertNothingLeft(vm.getRecordedLogs());
        assertEq(NPM.balanceOf(address(lane)), 0);
        uint256[2] memory pos = lane.positions();
        assertEq(pos[0] + pos[1], 0);

        // withdraw: the owner gets it all
        uint256 b0 = USDG.balanceOf(address(lane));
        uint256 b1 = NVDA.balanceOf(address(lane));
        vm.prank(owner);
        lane.withdrawAll();
        assertEq(USDG.balanceOf(owner), b0);
        assertEq(NVDA.balanceOf(owner), b1);
        assertEq(USDG.balanceOf(address(lane)) + NVDA.balanceOf(address(lane)), 0);
        emit log_named_decimal_uint("owner received USDG", b0, 6);
        emit log_named_decimal_uint("owner received NVDA", b1, 18);
        _assertLaneAddressesUnchanged();
    }

    /// @dev The NFT escape hatch on the real NPM: the owner takes the position and manages it directly.
    function test_withdrawPositionEscapeHatch() public {
        (uint256[] memory ids,,,) = _rerange(_fenceSafeRanges(100, 10_000));
        vm.prank(owner);
        lane.withdrawPosition(0);
        assertEq(NPM.ownerOf(ids[0]), owner);
        assertEq(lane.positions()[0], 0);
        uint128 liq = _positionLiquidity(ids[0]);
        vm.startPrank(owner);
        NPM.decreaseLiquidity(INPM.DecreaseLiquidityParams(ids[0], liq, 0, 0, block.timestamp));
        (uint256 a0, uint256 a1) = NPM.collect(INPM.CollectParams(ids[0], owner, type(uint128).max, type(uint128).max));
        vm.stopPrank();
        assertGt(a0 + a1, 0);
    }

    function _assertNothingLeft(Vm.Log[] memory logs) internal view {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 3 && logs[i].topics[0] == ERC20_TRANSFER) {
                assertTrue(address(uint160(uint256(logs[i].topics[1]))) != address(lane), "value left the lane");
            }
        }
    }
}
