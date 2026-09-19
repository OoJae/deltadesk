// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

import {IDeskLane} from "../../src/interfaces/IDeskLane.sol";
import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {INonfungiblePositionManagerMin as INPM} from "../../src/interfaces/external/INonfungiblePositionManagerMin.sol";
import {DeskFixture} from "../utils/DeskFixture.sol";
import {MockToken} from "../utils/MockToken.sol";

/// @notice The whole lane lifecycle against the real Uniswap v3 factory + NPM artifacts: create, fund, first mint,
/// swaps that earn fees, collect, reduce, rerange (straddle and two single-sided ranges), exitAll, withdrawAll and
/// withdrawPosition, plus exits with a paused or blocklisted token.
contract LifecycleTest is DeskFixture {
    bytes32 internal constant ERC20_TRANSFER = keccak256("Transfer(address,address,uint256)");

    function _balances() internal view returns (uint256, uint256) {
        return (usdg.balanceOf(address(lane)), nvda.balanceOf(address(lane)));
    }

    function _assertNoAllowances() internal view {
        assertEq(usdg.allowance(address(lane), address(npm)), 0, "USDG allowance");
        assertEq(nvda.allowance(address(lane), address(npm)), 0, "NVDA allowance");
    }

    /// @dev Swap back and forth through the lane's range so it earns fees in both tokens.
    function _churn(uint256 rounds) internal {
        for (uint256 i; i < rounds; ++i) {
            mover.swapExactIn(true, 20_000e6); // sell USDG
            mover.swapExactIn(false, 90e18); // sell NVDA
        }
    }

    function test_fullLifecycle() public {
        uint256 first = _stageFirstMint();
        _stageCollect(first);
        _stageReduce(first);
        _stageTwoRanges();
        _stageStraddleAgain();
        _stageExitAndWithdraw();
    }

    function _stageFirstMint() internal returns (uint256 tokenId) {
        // create + fund (fixture): $25 USDG + 0.11 NVDA idle, no positions
        assertEq(lane.positions()[0], 0);
        (uint256 b0, uint256 b1) = _balances();
        assertEq(b0, 25e6);
        assertEq(b1, 0.11e18);
        // first mint: straddle +-100 ticks from the whole balance
        (uint256[] memory ids, uint128[] memory liq, uint256 used0, uint256 used1) = _rerange(_straddle(100));
        tokenId = ids[0];
        assertEq(npm.ownerOf(tokenId), address(lane));
        assertEq(npm.balanceOf(address(lane)), 1);
        assertGt(liq[0], 0);
        assertGt(used0, 0);
        assertGt(used1, 0);
        (b0, b1) = _balances();
        assertEq(b0, 25e6 - used0);
        assertEq(b1, 0.11e18 - used1);
        _assertNoAllowances();
    }

    function _stageCollect(uint256 tokenId) internal {
        (uint256 b0, uint256 b1) = _balances();
        _churn(5); // swaps earn fees
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        (uint256 fee0, uint256 fee1) = lane.collect(m);
        assertGt(fee0, 0, "USDG fees");
        assertGt(fee1, 0, "NVDA fees");
        (uint256 c0, uint256 c1) = _balances();
        assertEq(c0, b0 + fee0);
        assertEq(c1, b1 + fee1);
        assertEq(npm.ownerOf(tokenId), address(lane)); // collect keeps the position
    }

    function _stageReduce(uint256 tokenId) internal {
        uint128 posLiq = _positionLiquidity(tokenId);
        IDeskTypes.Meta memory m = _meta();
        vm.prank(guardian); // the watchdog may reduce
        (uint256 r0, uint256 r1) = lane.reduce(m, 0, posLiq / 2);
        assertGt(r0 + r1, 0);
        assertEq(_positionLiquidity(tokenId), posLiq - posLiq / 2);
        m = _meta();
        vm.prank(operator);
        lane.reduce(m, 0, type(uint128).max); // clamped to the rest: burned, slot freed
        assertEq(lane.positions()[0], 0);
        vm.expectRevert("ERC721: owner query for nonexistent token");
        npm.ownerOf(tokenId);
    }

    function _stageTwoRanges() internal {
        _warpFresh(301);
        int24 t = _tick();
        IDeskTypes.RangeSpec[] memory two = new IDeskTypes.RangeSpec[](2);
        two[0] = IDeskTypes.RangeSpec(_ceil(t + 1), _ceil(t + 1) + 60, 10_000, 0); // USDG above the price
        two[1] = IDeskTypes.RangeSpec(_floor(t) - 60, _floor(t), 0, 10_000); // NVDA below the price
        (uint256[] memory ids,, uint256 used0, uint256 used1) = _rerange(two);
        assertEq(ids.length, 2);
        uint256[2] memory pos = lane.positions();
        assertEq(pos[0], ids[0]);
        assertEq(pos[1], ids[1]);
        assertGt(used0, 0);
        assertGt(used1, 0);
        _assertNoAllowances();
    }

    function _stageStraddleAgain() internal {
        _warpFresh(301);
        (uint256[] memory ids,,,) = _rerange(_straddle(200)); // unwinds both, mints one
        uint256[2] memory pos = lane.positions();
        assertEq(pos[0], ids[0]);
        assertEq(pos[1], 0);
        assertEq(npm.balanceOf(address(lane)), 1);
    }

    function _stageExitAndWithdraw() internal {
        _churn(2);
        IDeskTypes.Meta memory m = _meta();
        vm.recordLogs();
        vm.prank(operator);
        lane.exitAll(m);
        _assertNoOutflows(vm.getRecordedLogs()); // exitAll keeps everything idle in the lane
        assertEq(lane.positions()[0], 0);
        assertEq(npm.balanceOf(address(lane)), 0);

        (uint256 b0, uint256 b1) = _balances();
        vm.prank(owner);
        lane.withdrawAll();
        assertEq(usdg.balanceOf(owner), b0);
        assertEq(nvda.balanceOf(owner), b1);
        (b0, b1) = _balances();
        assertEq(b0 + b1, 0);
    }

    /// @dev The NFT escape hatch: the owner takes the position NFT and manages it directly on the NPM.
    function test_withdrawPosition() public {
        (uint256[] memory ids,,,) = _rerange(_straddle(100));
        vm.prank(owner);
        vm.expectEmit(address(lane));
        emit IDeskLane.PositionWithdrawn(0, ids[0]);
        lane.withdrawPosition(0);
        assertEq(npm.ownerOf(ids[0]), owner);
        assertEq(lane.positions()[0], 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.BadSlot.selector, 0));
        lane.withdrawPosition(0);

        uint128 liq = _positionLiquidity(ids[0]);
        vm.startPrank(owner);
        npm.decreaseLiquidity(INPM.DecreaseLiquidityParams(ids[0], liq, 0, 0, block.timestamp));
        npm.collect(INPM.CollectParams(ids[0], owner, type(uint128).max, type(uint128).max));
        vm.stopPrank();
        assertGt(usdg.balanceOf(owner) + nvda.balanceOf(owner), 0);
    }

    function test_withdrawSingleTokenAndDonations() public {
        MockToken junk = new MockToken("Junk", "JNK", 18);
        junk.mint(address(lane), 5e18); // a donation must not get stuck
        vm.startPrank(owner);
        lane.withdraw(address(junk), 5e18);
        lane.withdraw(address(usdg), 1e6);
        vm.stopPrank();
        assertEq(junk.balanceOf(owner), 5e18);
        assertEq(usdg.balanceOf(owner), 1e6);
    }

    // ------------------------------------------------------------------ paused / blocklisted token exits (N6)

    function test_exitAllWithNvdaPaused() public {
        (uint256[] memory ids,,,) = _rerange(_straddle(100));
        _churn(3);
        uint256 usdgBefore = usdg.balanceOf(address(lane));
        nvda.setPaused(true);

        IDeskTypes.Meta memory m = _meta();
        vm.recordLogs();
        vm.prank(guardian);
        lane.exitAll(m); // must not revert
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(_hasCollectFailed(logs, ids[0]), "CollectFailed emitted");
        _assertNoOutflows(logs);

        // Liquidity is out of the pool, the USDG side was salvaged, the slot (owing NVDA) is kept.
        assertEq(_positionLiquidity(ids[0]), 0);
        assertGt(usdg.balanceOf(address(lane)), usdgBefore, "USDG salvaged");
        assertEq(lane.positions()[0], ids[0]);
        uint128 owed1 = _owed1(ids[0]);
        assertGt(owed1, 0, "NVDA still owed to the position");

        // withdrawAll moves the USDG and skips the paused NVDA instead of reverting.
        uint256 laneUsdg = usdg.balanceOf(address(lane));
        vm.prank(owner);
        lane.withdrawAll();
        assertEq(usdg.balanceOf(owner), laneUsdg);
        assertGt(nvda.balanceOf(address(lane)), 0);

        // The NFT escape hatch works while NVDA is paused.
        vm.prank(owner);
        lane.withdrawPosition(0);
        assertEq(npm.ownerOf(ids[0]), owner);

        // After the issuer unpauses, the owner collects the NVDA owed.
        nvda.setPaused(false);
        vm.prank(owner);
        npm.collect(INPM.CollectParams(ids[0], owner, type(uint128).max, type(uint128).max));
        assertEq(nvda.balanceOf(owner), owed1);
    }

    function test_exitAllThenRecoverAfterUnpause() public {
        (uint256[] memory ids,,,) = _rerange(_straddle(100));
        nvda.setPaused(true);
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        lane.exitAll(m);
        assertEq(lane.positions()[0], ids[0]);
        nvda.setPaused(false);
        m = _meta();
        vm.prank(operator);
        lane.exitAll(m); // the kept slot now closes
        assertEq(lane.positions()[0], 0);
        assertEq(npm.balanceOf(address(lane)), 0);
    }

    function test_exitAllWithLaneBlocklistedByUsdg() public {
        (uint256[] memory ids,,,) = _rerange(_straddle(100));
        usdg.setBlocked(address(lane), true);
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        lane.exitAll(m);
        assertEq(_positionLiquidity(ids[0]), 0);
        assertGt(nvda.balanceOf(address(lane)), 0.1e18, "NVDA side salvaged");
        vm.prank(owner);
        lane.withdrawAll(); // skips USDG
        assertGt(nvda.balanceOf(owner), 0.1e18);
    }

    /// @dev rerange's unwind tolerates a failed collect but then keeps the slot; with both tokens paused nothing can
    /// be minted either, so the rerange reverts as a whole and exitAll remains the way out.
    function test_rerangeWithPausedTokenReverts() public {
        _rerange(_straddle(100));
        _warpFresh(301);
        nvda.setPaused(true);
        IDeskTypes.RangeSpec[] memory r = _straddle(100);
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        vm.prank(operator);
        vm.expectRevert();
        lane.rerange(m, r, t, 10);
        m = _meta();
        vm.prank(operator);
        lane.exitAll(m);
    }

    // ------------------------------------------------------------------ helpers

    function _owed1(uint256 tokenId) internal view returns (uint128 owed) {
        (,,,,,,,,,,, owed) = npm.positions(tokenId);
    }

    function _hasCollectFailed(Vm.Log[] memory logs, uint256 tokenId) internal view returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(lane) && logs[i].topics[0] == IDeskLane.CollectFailed.selector
                    && uint256(logs[i].topics[1]) == tokenId
            ) return true;
        }
        return false;
    }

    /// @dev No ERC-20 leaves the lane during a risk-reducing call.
    function _assertNoOutflows(Vm.Log[] memory logs) internal view {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 3 && logs[i].topics[0] == ERC20_TRANSFER) {
                address from = address(uint160(uint256(logs[i].topics[1])));
                assertTrue(from != address(lane), "value left the lane");
            }
        }
    }
}
