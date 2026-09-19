// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {RangeRules} from "../../src/libraries/RangeRules.sol";
import {LaneMath} from "../utils/LaneMath.sol";

contract RangeRulesTest is Test {
    // ------------------------------------------------------------------ placement fence vs brute force

    /// @dev Brute-force per-tick holdings model. With the pool at price P inside tick tc, tick bucket [t, t+1) of a
    /// range holds token1 when t < tc (it buys token0 at prices up to 1.0001^(t+1)), token0 when t > tc (it sells
    /// token0 at prices >= 1.0001^t), and BOTH when t == tc (token0 on [P, 1.0001^(tc+1)), token1 on [1.0001^tc, P)),
    /// tl == tc included. No bucket may offer token0 below refTick - band or bid above refTick + band; the current
    /// bucket's bids get a one-tick slack (they reach P < 1.0001^(tc+1)), so its token1 needs tc <= refTick + band.
    function _bruteForce(int24 tl, int24 tu, int24 tc, int24 ref, int24 band) internal pure returns (bool) {
        for (int256 t = tl; t < tu; ++t) {
            if (t >= tc && t < int256(ref) - band) return false; // token0 offered too cheap
            if (t < tc && t + 1 > int256(ref) + band) return false; // token1 bid too high
            if (t == tc && t > int256(ref) + band) return false; // the current bucket's token1 bid too high
        }
        return true;
    }

    /// @dev Every fifth case puts the pool exactly at the range's lower tick (tl == tc, the in-range edge).
    function testFuzz_fenceMatchesBruteForce(int24 ref, int16 dl, uint16 w, int16 dc, uint16 band) public pure {
        ref = int24(bound(ref, -800_000, 800_000));
        int24 tl = ref + int24(bound(dl, -700, 700));
        int24 tu = tl + int24(uint24(bound(w, 1, 500)));
        int24 tc = dc % 5 == 0 ? tl : ref + int24(bound(dc, -800, 800));
        int24 b = int24(uint24(bound(band, 0, 400)));
        assertEq(RangeRules.check(tl, tu, tc, ref, b), _bruteForce(tl, tu, tc, ref, b));
    }

    /// @dev Same property concentrated on the edges (ranges and prices that touch the band exactly).
    function testFuzz_fenceEdges(uint8 a, uint8 c, uint8 d, uint8 e) public pure {
        int24 ref = 222_267;
        int24 band = 100;
        int24 tl = ref - 110 + int24(uint24(a % 221));
        int24 tu = tl + 1 + int24(uint24(c % 220));
        int24 tc = ref - 105 + int24(uint24(d % 211));
        band = int24(uint24(e % 3)) + 99;
        assertEq(RangeRules.check(tl, tu, tc, ref, band), _bruteForce(tl, tu, tc, ref, band));
    }

    function test_fenceExamples() public pure {
        int24 ref = 1000;
        int24 band = 100;
        // Straddle: needs |tc - ref| <= band.
        assertTrue(RangeRules.check(900, 1100, 1000, ref, band));
        assertTrue(RangeRules.check(800, 1200, 1100, ref, band));
        assertFalse(RangeRules.check(800, 1200, 1101, ref, band)); // bids above ref + band
        assertTrue(RangeRules.check(800, 1200, 900, ref, band));
        assertFalse(RangeRules.check(800, 1200, 899, ref, band)); // asks below ref - band
        // Token0-only (range above the price): must start at or above ref - band.
        assertTrue(RangeRules.check(900, 950, 850, ref, band));
        assertFalse(RangeRules.check(890, 950, 850, ref, band));
        // Token1-only (range below the price): must end at or below ref + band.
        assertTrue(RangeRules.check(1050, 1100, 1200, ref, band));
        assertFalse(RangeRules.check(1050, 1110, 1200, ref, band));
        // A range entirely on the far side of the reference is always fine.
        assertTrue(RangeRules.check(2000, 3000, 1000, ref, band)); // selling token0 far above ref
        assertTrue(RangeRules.check(-3000, -2000, 1000, ref, band)); // buying token0 far below ref
        // Off-market placement: pool pushed 500 ticks above ref, token1 bids near the pool are rejected.
        assertFalse(RangeRules.check(1400, 1500, 1500, ref, band));
        // ... including a range starting exactly at the pool tick: its token1 bids inside the current bucket.
        assertFalse(RangeRules.check(1500, 1520, 1500, ref, band));
        assertTrue(RangeRules.check(1510, 1530, 1500, ref, band)); // token0 only, just above the pool
        // tl == tc inside the band is a (one-sided) straddle: fine up to tc == ref + band.
        assertTrue(RangeRules.check(1100, 1120, 1100, ref, band));
        assertFalse(RangeRules.check(1101, 1121, 1101, ref, band));
    }

    /// @dev Soundness against EXACT v3 holdings (LaneMath.amounts, i.e. v4-core SqrtPriceMath, not the rule's tick
    /// algebra): whatever the rule admits, a position at any price inside tick tc offers token0 no cheaper than
    /// 1.0001^(ref - band) and bids no higher than 1.0001^(ref + band + 1) (the current bucket's one-tick slack).
    /// Every third case starts the range at the pool tick (tl == tc), where the rule once skipped the bid side.
    function testFuzz_fenceSoundAgainstExactHoldings(int24 ref, int16 dl, uint16 w, int16 dc, uint16 band, uint256 frac)
        public
        pure
    {
        ref = int24(bound(ref, -800_000, 800_000));
        int24 tc = ref + int24(bound(dc, -3000, 3000));
        int24 tl = dl % 3 == 0 ? tc : tc + int24(bound(dl, -600, 600));
        int24 tu = tl + int24(uint24(bound(w, 1, 500)));
        int24 b = int24(uint24(bound(band, 0, 400)));
        if (!RangeRules.check(tl, tu, tc, ref, b)) return;
        uint160 lo = TickMath.getSqrtPriceAtTick(tc);
        uint160 s = uint160(lo + bound(frac, 0, TickMath.getSqrtPriceAtTick(tc + 1) - lo - 1));
        _assertHoldingsInFence(s, tl, tu, ref, b);
    }

    function _assertHoldingsInFence(uint160 s, int24 tl, int24 tu, int24 ref, int24 b) internal pure {
        (uint256 a0, uint256 a1) = LaneMath.amounts(s, tl, tu, 1e24);
        uint160 sa = TickMath.getSqrtPriceAtTick(tl);
        uint160 sb = TickMath.getSqrtPriceAtTick(tu);
        if (a0 != 0) {
            assertGe(s > sa ? s : sa, TickMath.getSqrtPriceAtTick(ref - b), "token0 offered below ref - band");
        }
        if (a1 != 0) {
            assertLe(s < sb ? s : sb, TickMath.getSqrtPriceAtTick(ref + b + 1), "token1 bid above ref + band");
        }
    }

    // ------------------------------------------------------------------ shape

    function test_shapeExamples() public pure {
        assertTrue(RangeRules.shapeOk(222_160, 222_370, 10, 20, 2000));
        assertFalse(RangeRules.shapeOk(222_165, 222_370, 10, 20, 2000)); // misaligned lower
        assertFalse(RangeRules.shapeOk(222_160, 222_375, 10, 20, 2000)); // misaligned upper
        assertFalse(RangeRules.shapeOk(222_370, 222_160, 10, 20, 2000)); // inverted
        assertFalse(RangeRules.shapeOk(222_160, 222_160, 10, 20, 2000)); // empty
        assertFalse(RangeRules.shapeOk(222_160, 222_170, 10, 20, 2000)); // width 10 < 20
        assertTrue(RangeRules.shapeOk(222_160, 222_180, 10, 20, 2000)); // width 20
        assertTrue(RangeRules.shapeOk(222_000, 224_000, 10, 20, 2000)); // width 2000
        assertFalse(RangeRules.shapeOk(222_000, 224_010, 10, 20, 2000)); // width 2010
        assertTrue(RangeRules.shapeOk(-30, -10, 10, 20, 2000)); // negative ticks
        assertFalse(RangeRules.shapeOk(-35, -10, 10, 20, 2000));
        int24 maxUsable = TickMath.maxUsableTick(10);
        assertTrue(RangeRules.shapeOk(maxUsable - 20, maxUsable, 10, 20, 2000));
        assertFalse(RangeRules.shapeOk(TickMath.MIN_TICK - 8, TickMath.MIN_TICK + 12, 10, 0, type(uint24).max));
        assertFalse(RangeRules.shapeOk(0, 20, 0, 0, 100)); // zero spacing
    }

    function testFuzz_shape(int24 tl, int24 tu, uint8 sp, uint24 minW, uint24 maxW) public pure {
        int24 spacing = int24(uint24(bound(sp, 1, 200)));
        bool expected = tl < tu && tl >= TickMath.MIN_TICK && tu <= TickMath.MAX_TICK && tl % spacing == 0
            && tu % spacing == 0 && int256(tu) - int256(tl) >= int256(uint256(minW))
            && int256(tu) - int256(tl) <= int256(uint256(maxW));
        assertEq(RangeRules.shapeOk(tl, tu, spacing, minW, maxW), expected);
    }
}
