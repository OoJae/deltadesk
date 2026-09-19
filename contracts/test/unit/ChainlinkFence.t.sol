// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {ChainlinkFence} from "../../src/ChainlinkFence.sol";
import {MockAggregator} from "../utils/MockAggregator.sol";
import {MockStockToken, MockToken} from "../utils/MockToken.sol";

/// @dev A feed that returns fewer than five words.
contract ShortFeed {
    function latestRoundData() external pure returns (uint256, int256) {
        return (1, 1e8);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

contract ChainlinkFenceTest is Test {
    // Wed 2026-09-16 15:00:00 UTC
    uint256 internal constant WED_1500 = 1_789_570_800;
    uint256 internal constant FRI_235959 = 1_789_775_999;
    uint256 internal constant SAT_0000 = 1_789_776_000;
    uint256 internal constant SUN_1200 = 1_789_905_600;
    uint256 internal constant MON_005959 = 1_789_952_399;
    uint256 internal constant MON_0100 = 1_789_952_400;

    MockToken internal usdg;
    MockStockToken internal nvda;
    MockAggregator internal usdgFeed;
    MockAggregator internal nvdaFeed;
    ChainlinkFence internal fence;

    function setUp() public {
        vm.warp(WED_1500);
        usdg = new MockToken("Global Dollar", "USDG", 6);
        nvda = new MockStockToken("NVIDIA", "NVDA", 18);
        usdgFeed = new MockAggregator(8, 1e8);
        nvdaFeed = new MockAggregator(8, 222.6e8);
        ChainlinkFence.TokenConfig[] memory c = new ChainlinkFence.TokenConfig[](2);
        c[0] = ChainlinkFence.TokenConfig(address(usdg), address(usdgFeed), ChainlinkFence.Kind.STABLE, 26 hours);
        c[1] = ChainlinkFence.TokenConfig(address(nvda), address(nvdaFeed), ChainlinkFence.Kind.STOCK, 26 hours);
        fence = new ChainlinkFence(c);
    }

    function _at(uint256 ts) internal {
        vm.warp(ts);
        usdgFeed.setUpdatedAt(ts);
        nvdaFeed.setUpdatedAt(ts);
    }

    function _assertCode(address token, uint8 code) internal view {
        assertEq(fence.status(token), code, "status");
        (,, uint8 c) = fence.usdPrice(token);
        assertEq(c, code, "usdPrice code");
    }

    // ------------------------------------------------------------------ happy path and decimals

    function test_openOnWeekday() public view {
        _assertCode(address(usdg), 0);
        _assertCode(address(nvda), 0);
        (uint256 px, uint64 at, uint8 code) = fence.usdPrice(address(nvda));
        assertEq(px, 222.6e18);
        assertEq(at, WED_1500);
        assertEq(code, 0);
    }

    /// @dev The 4663 proxies moved from 18 to 8 decimals on 2026-06-23; decimals are read live.
    function test_decimals18vs8SamePrice() public {
        (uint256 px8,,) = fence.usdPrice(address(nvda));
        nvdaFeed.setDecimalsKeepPrice(18);
        assertEq(nvdaFeed.answer(), 222.6e18);
        (uint256 px18,, uint8 code) = fence.usdPrice(address(nvda));
        assertEq(px18, px8);
        assertEq(code, 0);
        // A decimals change without the answer rescaled is visible immediately (off by 1e10: the depeg check fires
        // for the stable; the stock is 1e10 cheaper).
        usdgFeed.setDecimals(18);
        _assertCode(address(usdg), 6);
    }

    function test_feedDecimalsAbove36IsDead() public {
        nvdaFeed.setDecimals(37);
        _assertCode(address(nvda), 2);
    }

    // ------------------------------------------------------------------ code 1

    function test_unknownToken() public view {
        _assertCode(address(0xBEEF), 1);
        (uint256 px, uint64 at,) = fence.usdPrice(address(0xBEEF));
        assertEq(px, 0);
        assertEq(at, 0);
    }

    // ------------------------------------------------------------------ code 2 (feed dead)

    function test_answerZeroOrNegative() public {
        nvdaFeed.set(0, block.timestamp);
        _assertCode(address(nvda), 2);
        nvdaFeed.set(-1, block.timestamp);
        _assertCode(address(nvda), 2);
        (uint256 px,,) = fence.usdPrice(address(nvda));
        assertEq(px, 0);
    }

    function test_updatedAtInFuture() public {
        nvdaFeed.set(222.6e8, block.timestamp + 1);
        _assertCode(address(nvda), 2);
    }

    function test_maxAgeBoundary() public {
        nvdaFeed.set(222.6e8, block.timestamp - 26 hours);
        _assertCode(address(nvda), 0);
        nvdaFeed.set(222.6e8, block.timestamp - 26 hours - 1);
        _assertCode(address(nvda), 2);
    }

    // ------------------------------------------------------------------ code 7 (feed reverted)

    function test_feedReverts() public {
        nvdaFeed.setReverting(true);
        _assertCode(address(nvda), 7);
        (uint256 px,,) = fence.usdPrice(address(nvda));
        assertEq(px, 0);
    }

    function test_malformedOrMissingFeed() public {
        ChainlinkFence.TokenConfig[] memory c = new ChainlinkFence.TokenConfig[](2);
        c[0] = ChainlinkFence.TokenConfig(address(usdg), address(new ShortFeed()), ChainlinkFence.Kind.STABLE, 1 days);
        c[1] = ChainlinkFence.TokenConfig(address(nvda), address(0xFEED), ChainlinkFence.Kind.STOCK, 1 days); // no code
        ChainlinkFence f = new ChainlinkFence(c);
        assertEq(f.status(address(usdg)), 7);
        assertEq(f.status(address(nvda)), 7);
    }

    // ------------------------------------------------------------------ code 3 / 4 (ERC-8056)

    function test_oraclePaused() public {
        nvda.setOraclePaused(true);
        _assertCode(address(nvda), 3);
        // The feed is sound, so the price is still reported with the code.
        (uint256 px,,) = fence.usdPrice(address(nvda));
        assertEq(px, 222.6e18);
    }

    function test_missingErc8056FailsClosed() public {
        nvda.setErc8056Reverts(true);
        _assertCode(address(nvda), 3);
        // A STOCK configured on an address without code also fails closed.
        ChainlinkFence.TokenConfig[] memory c = new ChainlinkFence.TokenConfig[](1);
        c[0] = ChainlinkFence.TokenConfig(address(0x5170C), address(nvdaFeed), ChainlinkFence.Kind.STOCK, 1 days);
        assertEq(new ChainlinkFence(c).status(address(0x5170C)), 3);
    }

    function test_effectiveAtWindow() public {
        uint256 g = 2 hours;
        nvda.setNewUIMultiplier(1.000775e18, block.timestamp + g); // exactly 2 h ahead: outside
        _assertCode(address(nvda), 0);
        nvda.setNewUIMultiplier(1.000775e18, block.timestamp + g - 1);
        _assertCode(address(nvda), 4);
        nvda.setNewUIMultiplier(1.000775e18, block.timestamp);
        _assertCode(address(nvda), 4);
        nvda.setNewUIMultiplier(1.000775e18, block.timestamp - g + 1);
        _assertCode(address(nvda), 4);
        nvda.setNewUIMultiplier(1.000775e18, block.timestamp - g);
        _assertCode(address(nvda), 0);
        // Time passing clears the window.
        nvda.setNewUIMultiplier(1.000775e18, block.timestamp + 10 minutes);
        _assertCode(address(nvda), 4);
        _at(block.timestamp + 10 minutes + g);
        _assertCode(address(nvda), 0);
    }

    // ------------------------------------------------------------------ code 5 (UTC weekend window)

    function test_closedWindowBoundaries() public {
        _at(FRI_235959);
        _assertCode(address(nvda), 0);
        _at(SAT_0000);
        _assertCode(address(nvda), 5);
        _at(SUN_1200);
        _assertCode(address(nvda), 5);
        _at(MON_005959);
        _assertCode(address(nvda), 5);
        _at(MON_0100);
        _assertCode(address(nvda), 0);
    }

    function test_stableIgnoresWeekend() public {
        _at(SAT_0000);
        _assertCode(address(usdg), 0);
    }

    function test_isClosedWindowPure() public view {
        assertFalse(fence.isClosedWindow(WED_1500));
        assertFalse(fence.isClosedWindow(FRI_235959));
        assertTrue(fence.isClosedWindow(SAT_0000));
        assertTrue(fence.isClosedWindow(SUN_1200));
        assertTrue(fence.isClosedWindow(MON_005959));
        assertFalse(fence.isClosedWindow(MON_0100));
        assertFalse(fence.isClosedWindow(0)); // 1970-01-01 was a Thursday
        assertTrue(fence.isClosedWindow(2 days)); // Saturday 1970-01-03
    }

    function testFuzz_closedWindowMatchesCalendar(uint32 ts) public view {
        uint256 day = uint256(ts) / 1 days;
        uint256 sod = uint256(ts) % 1 days;
        uint256 dowMon0 = (day + 3) % 7; // 0 = Monday
        bool expected = dowMon0 == 5 || dowMon0 == 6 || (dowMon0 == 0 && sod < 1 hours);
        assertEq(fence.isClosedWindow(ts), expected);
    }

    // ------------------------------------------------------------------ code 6 (depeg)

    function test_depegBoundaries() public {
        usdgFeed.setAnswer(0.995e8); // exactly -50 bp
        _assertCode(address(usdg), 0);
        usdgFeed.setAnswer(1.005e8); // exactly +50 bp
        _assertCode(address(usdg), 0);
        usdgFeed.setAnswer(99_499_999);
        _assertCode(address(usdg), 6);
        usdgFeed.setAnswer(100_500_001);
        _assertCode(address(usdg), 6);
        (uint256 px,,) = fence.usdPrice(address(usdg));
        assertEq(px, 1.00500001e18);
    }

    // ------------------------------------------------------------------ priority

    function test_priorityOrder() public {
        _at(SAT_0000);
        nvda.setNewUIMultiplier(2e18, block.timestamp);
        nvda.setOraclePaused(true);
        _assertCode(address(nvda), 3); // 3 before 4 before 5
        nvda.setOraclePaused(false);
        _assertCode(address(nvda), 4);
        nvdaFeed.setReverting(true);
        _assertCode(address(nvda), 7); // feed before ERC-8056
        nvdaFeed.setReverting(false);
        nvdaFeed.set(0, block.timestamp);
        _assertCode(address(nvda), 2);
    }

    // ------------------------------------------------------------------ never reverts

    function testFuzz_neverReverts(int256 answer, uint256 updatedAt, uint8 dec, bool rev, bool paused) public {
        nvdaFeed.set(answer, updatedAt);
        nvdaFeed.setDecimals(dec);
        nvdaFeed.setReverting(rev);
        nvda.setOraclePaused(paused);
        uint8 s = fence.status(address(nvda));
        (uint256 px,, uint8 c) = fence.usdPrice(address(nvda));
        assertEq(s, c);
        assertLe(c, 7);
        if (c == 1 || c == 2 || c == 7) assertEq(px, 0);
        else assertGt(px, 0);
    }

    // ------------------------------------------------------------------ constructor

    function test_constructorRejectsBadConfig() public {
        ChainlinkFence.TokenConfig[] memory c = new ChainlinkFence.TokenConfig[](1);
        c[0] = ChainlinkFence.TokenConfig(address(0), address(nvdaFeed), ChainlinkFence.Kind.STOCK, 1);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkFence.BadConfig.selector, 0));
        new ChainlinkFence(c);
        c[0] = ChainlinkFence.TokenConfig(address(nvda), address(0), ChainlinkFence.Kind.STOCK, 1);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkFence.BadConfig.selector, 0));
        new ChainlinkFence(c);
        c[0] = ChainlinkFence.TokenConfig(address(nvda), address(nvdaFeed), ChainlinkFence.Kind.NONE, 1);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkFence.BadConfig.selector, 0));
        new ChainlinkFence(c);
        c[0] = ChainlinkFence.TokenConfig(address(nvda), address(nvdaFeed), ChainlinkFence.Kind.STOCK, 0);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkFence.BadConfig.selector, 0));
        new ChainlinkFence(c);

        ChainlinkFence.TokenConfig[] memory d = new ChainlinkFence.TokenConfig[](2);
        d[0] = ChainlinkFence.TokenConfig(address(nvda), address(nvdaFeed), ChainlinkFence.Kind.STOCK, 1);
        d[1] = ChainlinkFence.TokenConfig(address(nvda), address(usdgFeed), ChainlinkFence.Kind.STABLE, 1);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkFence.BadConfig.selector, 1));
        new ChainlinkFence(d);
    }

    function test_configViews() public view {
        address[] memory t = fence.tokens();
        assertEq(t.length, 2);
        assertEq(t[0], address(usdg));
        assertEq(t[1], address(nvda));
        ChainlinkFence.TokenConfig memory c = fence.config(address(nvda));
        assertEq(c.feed, address(nvdaFeed));
        assertEq(uint8(c.kind), uint8(ChainlinkFence.Kind.STOCK));
        assertEq(c.maxAge, 26 hours);
    }
}
