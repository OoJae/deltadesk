// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IDeskLane} from "../../src/interfaces/IDeskLane.sol";
import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {AggregatorV3Interface} from "../../src/interfaces/external/AggregatorV3Interface.sol";
import {IERC8056} from "../../src/interfaces/external/IERC8056.sol";
import {INonfungiblePositionManagerMin as INPM} from "../../src/interfaces/external/INonfungiblePositionManagerMin.sol";
import {Addresses4663} from "../../script/Addresses4663.sol";
import {DeskDefaults} from "../../script/DeskDefaults.sol";
import {ForkBase} from "../utils/ForkBase.sol";
import {LaneMath} from "../utils/LaneMath.sol";

interface INPMCallback {
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external;
}

/// @notice The negative tests that matter most, against the real pool, NPM, tokens and feeds: sandwiches around a
/// rerange, off-market placement, every fence failure mode (adds revert, exits work), a paused stock token during an
/// exit, foreign NFTs and direct NPM calls, and a compromised operator reaching for owner powers.
contract ForkAdversarialTest is ForkBase {
    function setUp() public {
        if (!_fork(WEEKDAY_BLOCK)) return;
        _deployDesk();
        lane = _createLane(DeskDefaults.laneCaps());
        mover = _mover();
        if (_openMarket()) emit log("weekend or stale block: feeds re-stamped at the live answers");
        _fundUsd(address(lane), 25e6);
    }

    // ------------------------------------------------------------------ sandwiches (N2)

    /// @dev The attacker moves the pool after the agent read it: the execution tick guard reverts.
    function test_sandwichAfterReadReverts() public {
        IDeskTypes.RangeSpec[] memory r = _fenceSafeRanges(100, 10_000);
        int24 t = _tick();
        mover.moveTo(t + 30);
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.PoolTickMoved.selector, _tick(), t, 10));
        lane.rerange(m, r, t, 10);
    }

    /// @dev The attacker parks the pool beyond the band: a straddle is refused, the sides the fence allows still work.
    function test_offMarketBeyondBandRefused() public {
        (int24 ref, int24 band) = _refTick();
        mover.moveTo(ref + band + 50);
        int24 t = _tick();
        IDeskTypes.RangeSpec[] memory r = new IDeskTypes.RangeSpec[](1);
        r[0] = IDeskTypes.RangeSpec(LaneMath.floorTick(t - 100, 10), LaneMath.ceilTick(t + 100, 10), 10_000, 10_000);
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        vm.expectPartialRevert(IDeskLane.RangeOutsideFence.selector);
        lane.rerange(m, r, t, 10);
        (uint256[] memory ids,,,) = _rerange(_fenceSafeRanges(100, 10_000));
        assertEq(ids.length, 2);
    }

    /// @dev Within the band the rerange goes through at the manipulated price; after the attacker arbitrages back to
    /// the fence price the fence-valued loss stays under band x deployed notional.
    function test_withinBandSandwichLossBounded() public {
        (int24 ref, int24 band) = _refTick();
        mover.moveTo(ref);
        uint256 nav0 = _navUsd6();
        mover.moveTo(ref + band - 3);
        (,, uint256 u0, uint256 u1) = _rerange(_fenceSafeRanges(100, 10_000));
        (uint256 p0,,) = fence.usdPrice(address(USDG));
        (uint256 p1,,) = fence.usdPrice(address(NVDA));
        uint256 deployed = LaneMath.usd6Up(u0, p0, 6) + LaneMath.usd6Up(u1, p1, 18);
        mover.moveTo(ref);
        _exitAll(operator);
        uint256 nav1 = _navUsd6();
        uint256 loss = nav0 > nav1 ? nav0 - nav1 : 0;
        uint256 bound = deployed * LaneMath.tickFactorE18(band + 1) / 1e18 + 4;
        emit log_named_decimal_uint("deployed (USD)", deployed, 6);
        emit log_named_decimal_uint("fence-valued loss (USD)", loss, 6);
        emit log_named_decimal_uint("band x deployed (USD)", bound, 6);
        assertLe(loss, bound);
    }

    // ------------------------------------------------------------------ fence failure modes (N7): adds revert, exits work

    function test_oraclePausedBlocksAddsNotExits() public {
        _withLivePosition();
        vm.mockCall(address(NVDA), abi.encodeWithSelector(IERC8056.oraclePaused.selector), abi.encode(true));
        _addsBlockedExitsWork(3);
    }

    function test_corporateActionWindowBlocksAddsNotExits() public {
        _withLivePosition();
        vm.mockCall(
            address(NVDA), abi.encodeWithSelector(IERC8056.effectiveAt.selector), abi.encode(block.timestamp + 1 hours)
        );
        _addsBlockedExitsWork(4);
    }

    function test_staleFeedBlocksAddsNotExits() public {
        _withLivePosition();
        _mockRound(Addresses4663.CL_NVDA_USD, _answer(Addresses4663.CL_NVDA_USD), block.timestamp - 27 hours);
        _addsBlockedExitsWork(2);
    }

    function test_nonPositiveOrFutureAnswerBlocksAddsNotExits() public {
        _withLivePosition();
        uint256 snap = vm.snapshotState();
        _mockRound(Addresses4663.CL_NVDA_USD, 0, block.timestamp);
        _addsBlockedExitsWork(2);
        vm.revertToState(snap);
        _mockRound(Addresses4663.CL_NVDA_USD, -1, block.timestamp);
        _addsBlockedExitsWork(2);
        vm.revertToState(snap);
        _mockRound(Addresses4663.CL_NVDA_USD, _answer(Addresses4663.CL_NVDA_USD), block.timestamp + 60);
        _addsBlockedExitsWork(2);
    }

    function test_revertingFeedBlocksAddsNotExits() public {
        _withLivePosition();
        vm.mockCallRevert(
            Addresses4663.CL_NVDA_USD,
            abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector),
            bytes("feed down")
        );
        _addsBlockedExitsWork(7);
    }

    function test_usdgDepegBlocksAddsNotExits() public {
        _withLivePosition();
        _mockRound(Addresses4663.CL_USDG_USD, 0.99e8, block.timestamp);
        _addsBlockedExitsWork(6);
    }

    // ------------------------------------------------------------------ paused stock token during an exit (N6)

    /// @dev The issuer pauses NVDA (every transfer reverts): exitAll still succeeds, USDG comes out, the NFT escape
    /// hatch hands the owner the rest, which the owner collects once NVDA resumes.
    function test_pausedNvdaDuringExit() public {
        uint256[] memory ids = _withLivePosition();
        for (uint256 i; i < 2; ++i) {
            mover.moveTo(_tick() + 40);
            mover.moveTo(_tick() - 80);
        }
        vm.mockCallRevert(address(NVDA), abi.encodeWithSelector(IERC20.transfer.selector), bytes("paused"));
        vm.mockCallRevert(address(NVDA), abi.encodeWithSelector(IERC20.transferFrom.selector), bytes("paused"));
        uint256 usdgBefore = USDG.balanceOf(address(lane));
        _exitAll(guardian);
        assertGt(USDG.balanceOf(address(lane)), usdgBefore, "USDG salvaged");
        assertEq(_positionLiquidity(ids[0]), 0);
        assertEq(lane.positions()[0], ids[0], "the slot owing NVDA is kept");
        (, uint128 owed1) = _positionOwed(ids[0]);
        assertGt(owed1, 0);
        vm.startPrank(owner);
        lane.withdrawAll(); // USDG out, NVDA skipped
        lane.withdrawPosition(0);
        vm.stopPrank();
        assertEq(USDG.balanceOf(address(lane)), 0);
        assertEq(NPM.ownerOf(ids[0]), owner);
        _unpauseNvda();
        vm.prank(owner);
        NPM.collect(INPM.CollectParams(ids[0], owner, type(uint128).max, type(uint128).max));
        assertEq(NVDA.balanceOf(owner), owed1);
    }

    // ------------------------------------------------------------------ foreign NFTs and the NPM (N5)

    function test_foreignNftsAndDirectNpmCalls() public {
        uint256[] memory ids = _withLivePosition();
        _fund(address(USDG), attacker, 100e6);
        _fund(address(NVDA), attacker, 1e18);
        int24 t = _tick();
        vm.startPrank(attacker);
        USDG.approve(address(NPM), type(uint256).max);
        NVDA.approve(address(NPM), type(uint256).max);
        (uint256 junkId,,,) = NPM.mint(
            INPM.MintParams(
                address(USDG),
                address(NVDA),
                500,
                LaneMath.floorTick(t - 300, 10),
                LaneMath.ceilTick(t + 300, 10),
                10e6,
                0.05e18,
                0,
                0,
                attacker,
                block.timestamp
            )
        );
        vm.expectRevert();
        NPM.safeTransferFrom(attacker, address(lane), junkId); // no onERC721Received
        NPM.transferFrom(attacker, address(lane), junkId); // lands, never tracked
        vm.expectRevert("Not approved");
        NPM.decreaseLiquidity(INPM.DecreaseLiquidityParams(ids[0], 1, 0, 0, block.timestamp));
        vm.expectRevert("Not approved");
        NPM.collect(INPM.CollectParams(ids[0], attacker, type(uint128).max, type(uint128).max));
        vm.expectRevert();
        NPM.transferFrom(address(lane), attacker, ids[0]);
        vm.expectRevert();
        INPMCallback(address(NPM))
            .uniswapV3MintCallback(1e6, 1e15, abi.encode(address(USDG), address(NVDA), uint24(500), address(lane)));
        vm.stopPrank();
        uint256[2] memory pos = lane.positions();
        assertTrue(pos[0] != junkId && pos[1] != junkId);
        _exitAll(operator);
        assertEq(NPM.ownerOf(junkId), address(lane), "exitAll leaves foreign NFTs alone");
        assertEq(NPM.balanceOf(address(lane)), 1);
    }

    // ------------------------------------------------------------------ a compromised operator (N3)

    function test_compromisedOperatorCannotDrain() public {
        uint256[] memory ids = _withLivePosition();
        uint256 b0 = USDG.balanceOf(address(lane));
        uint256 b1 = NVDA.balanceOf(address(lane));
        vm.startPrank(operator);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.withdraw(address(USDG), b0);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.withdrawAll();
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.withdrawPosition(0);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.proposeOperator(attacker);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.setCaps(DeskDefaults.ceilings());
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.setGuardian(attacker);
        vm.expectRevert(IDeskLane.NotOwner.selector);
        lane.unpause();
        vm.stopPrank();
        assertEq(USDG.balanceOf(address(lane)), b0);
        assertEq(NVDA.balanceOf(address(lane)), b1);
        assertEq(NPM.ownerOf(ids[0]), address(lane));
        _assertNoAllowances();
    }

    // ------------------------------------------------------------------ helpers

    /// @dev One full-balance straddle (slot 0), with the pool first brought to the fence price.
    function _withLivePosition() internal returns (uint256[] memory ids) {
        (int24 ref,) = _refTick();
        mover.moveTo(ref);
        (ids,,,) = _rerange(_fenceSafeRanges(100, 10_000));
        assertEq(ids.length, 1);
        _warpFresh(301);
    }

    /// @dev With the fence failing with `code`: every risk-adding rerange reverts MarketClosed(code); reduce,
    /// collect, unwind-and-hold, exitAll, withdrawAll and withdrawPosition all work and pay only the owner.
    function _addsBlockedExitsWork(uint8 code) internal {
        (bool open, uint8 c) = lane.riskAddingOpen();
        assertFalse(open);
        assertEq(c, code, "riskAddingOpen code");
        IDeskTypes.RangeSpec[] memory r = new IDeskTypes.RangeSpec[](1);
        int24 t = _tick();
        r[0] = IDeskTypes.RangeSpec(LaneMath.floorTick(t - 100, 10), LaneMath.ceilTick(t + 100, 10), 10_000, 10_000);
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.MarketClosed.selector, code));
        lane.rerange(m, r, t, 10);

        uint256 id = lane.positions()[0];
        uint128 liq = _positionLiquidity(id);
        m = _meta();
        vm.prank(guardian);
        lane.reduce(m, 0, liq / 3);
        m = _meta();
        vm.prank(operator);
        lane.collect(m);
        m = _meta();
        vm.prank(operator);
        lane.rerange(m, new IDeskTypes.RangeSpec[](0), 0, 0); // unwind-and-hold needs no fence
        assertEq(lane.positions()[0], 0);
        _exitAll(operator);
        uint256 b0 = USDG.balanceOf(address(lane));
        uint256 b1 = NVDA.balanceOf(address(lane));
        vm.prank(owner);
        lane.withdrawAll();
        assertEq(USDG.balanceOf(owner), b0);
        assertEq(NVDA.balanceOf(owner), b1);
    }

    function _mockRound(address feed, int256 answer, uint256 updatedAt) internal {
        vm.mockCall(
            feed,
            abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector),
            abi.encode(uint80(1), answer, updatedAt, updatedAt, uint80(1))
        );
    }

    /// @dev Undo the NVDA pause mocks (and re-apply any feed mocks, which clearMockedCalls also drops).
    function _unpauseNvda() internal {
        vm.clearMockedCalls();
        if (feedsMocked) _restampFeeds();
    }
}
