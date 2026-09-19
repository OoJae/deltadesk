// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {PriceMath} from "../../src/libraries/PriceMath.sol";

contract PriceMathTest is Test {
    uint256 internal constant Q192 = 1 << 192;

    // ------------------------------------------------------------------ fixtures
    // Expected ticks are floor(ln(P) / ln(1.0001)) computed with 80-digit decimals (python `decimal`).

    /// @dev The live NVDA/USDG pool orientation: token0 USDG (6 dec), token1 NVDA (18 dec), at $222.60 / $1.00.
    function test_liveNvdaPool_222_60() public pure {
        (int24 tick, bool ok) = PriceMath.refTick(1e18, 222.6e18, 6, 18);
        assertTrue(ok);
        assertEq(tick, 222_267);
    }

    /// @dev Chainlink on 4663, 2026-09-19 (cast call latestRoundData, 8 decimals): USDG/USD 99995090,
    /// NVDA/USD 22244729849. The pool's slot0 tick at the same time was 222276 (3 bp away).
    function test_liveChainlinkFixture() public pure {
        (int24 tick, bool ok) = PriceMath.refTick(0.9999509e18, 222.44729849e18, 6, 18);
        assertTrue(ok);
        assertEq(tick, 222_273);
    }

    /// @dev The same markets with the token order swapped (token0 NVDA 18 dec, token1 USDG 6 dec).
    function test_reversedOrientation() public pure {
        (int24 tick, bool ok) = PriceMath.refTick(222.6e18, 1e18, 18, 6);
        assertTrue(ok);
        assertEq(tick, -222_268);
        (tick, ok) = PriceMath.refTick(222.44729849e18, 0.9999509e18, 18, 6);
        assertTrue(ok);
        assertEq(tick, -222_274);
    }

    function test_exactTicks() public pure {
        (int24 tick,) = PriceMath.refTick(1e18, 1e18, 18, 18); // P = 1
        assertEq(tick, 0);
        (tick,) = PriceMath.refTick(1e18, 1e18, 6, 18); // P = 1e12
        assertEq(tick, 276_324);
        (tick,) = PriceMath.refTick(1e18, 1e18, 18, 6); // P = 1e-12
        assertEq(tick, -276_325);
    }

    /// @dev N1: a 1e12 decimals slip (treating USDG as 18 decimals) moves the reference by ~276k ticks, far outside
    /// any band, so the placement fence rejects every range near the real pool price.
    function test_decimalsSlipIsHuge() public pure {
        (int24 right,) = PriceMath.refTick(1e18, 222.6e18, 6, 18);
        (int24 slipped,) = PriceMath.refTick(1e18, 222.6e18, 18, 18);
        assertGt(right - slipped, 270_000);
    }

    function test_invalidInputs() public pure {
        bool ok;
        (, ok) = PriceMath.refTick(0, 1e18, 6, 18);
        assertFalse(ok);
        (, ok) = PriceMath.refTick(1e18, 0, 6, 18);
        assertFalse(ok);
        (, ok) = PriceMath.refTick(uint256(type(uint128).max) + 1, 1e18, 6, 18);
        assertFalse(ok);
        (, ok) = PriceMath.refTick(1e18, 1e18, 37, 18);
        assertFalse(ok);
        // P >= 2^128 (above MAX_TICK) and P < 2^-128 (below MIN_TICK)
        (, ok) = PriceMath.refTick(type(uint128).max, 1, 0, 36);
        assertFalse(ok);
        (, ok) = PriceMath.refTick(1, type(uint128).max, 36, 0);
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ properties

    /// @dev sqrtPriceX96 is floor(sqrt(P * 2^192)) exactly when P < 2^64, and within 2^32 below it otherwise.
    function testFuzz_sqrtPriceBounds(uint256 p0, uint256 p1, uint8 d0, uint8 d1) public pure {
        p0 = bound(p0, 1, PriceMath.MAX_PRICE_E18);
        p1 = bound(p1, 1, PriceMath.MAX_PRICE_E18);
        d0 = uint8(bound(d0, 0, 36));
        d1 = uint8(bound(d1, 0, 36));
        (uint256 s, bool ok) = PriceMath.sqrtPriceX96(p0, p1, d0, d1);
        if (!ok) return;
        uint256 num = p0 * 10 ** d1;
        uint256 den = p1 * 10 ** d0;
        // s^2 <= P * 2^192  <=>  s^2 * den <= num * 2^192
        assertTrue(_le512(s, s, den, num, Q192), "s^2 <= P*2^192");
        uint256 up = num / den < (1 << 64) ? s + 1 : s + (1 << 32);
        assertFalse(_le512(up, up, den, num, Q192), "(s+eps)^2 > P*2^192");
    }

    /// @dev The tick brackets the sqrt price, and the tick's price brackets P up to TickMath rounding.
    function testFuzz_tickBracketsPrice(uint256 p0, uint256 p1, uint8 d0, uint8 d1) public pure {
        p0 = bound(p0, 1, PriceMath.MAX_PRICE_E18);
        p1 = bound(p1, 1, PriceMath.MAX_PRICE_E18);
        d0 = uint8(bound(d0, 0, 36));
        d1 = uint8(bound(d1, 0, 36));
        (uint256 s, bool ok) = PriceMath.sqrtPriceX96(p0, p1, d0, d1);
        (int24 tick, bool ok2) = PriceMath.refTick(p0, p1, d0, d1);
        assertEq(ok, ok2);
        if (!ok) return;
        assertLe(TickMath.getSqrtPriceAtTick(tick), s);
        if (tick < TickMath.MAX_TICK) assertGt(TickMath.getSqrtPriceAtTick(tick + 1), s);
    }

    /// @dev Swapping the token order negates the tick: floor(-L) = -floor(L) - 1 for non-integer L, give or take the
    /// one-unit rounding of each side's integer sqrt.
    function testFuzz_bothTokenOrders(uint256 p0, uint256 p1, uint8 d0, uint8 d1) public pure {
        p0 = bound(p0, 1e6, 1e30);
        p1 = bound(p1, 1e6, 1e30);
        d0 = uint8(bound(d0, 0, 24));
        d1 = uint8(bound(d1, 0, 24));
        (int24 t, bool ok) = PriceMath.refTick(p0, p1, d0, d1);
        (int24 r, bool okr) = PriceMath.refTick(p1, p0, d1, d0);
        if (!ok || !okr) return;
        int256 sum = int256(t) + int256(r);
        assertTrue(sum >= -2 && sum <= 0, "orientation symmetry");
    }

    /// @dev Round trip: pricing token0 at the price of tick k (token1 at $1, equal decimals) gives back k
    /// (or k - 1 when the fence price rounds just below the tick boundary). k is bounded so the 1e18-scaled price
    /// keeps >= 12 significant digits (P >= 1e-6) and stays <= MAX_PRICE_E18.
    function testFuzz_roundTrip(int24 k) public pure {
        k = int24(bound(k, -138_000, 470_000));
        uint256 sqrtK = TickMath.getSqrtPriceAtTick(k);
        uint256 p0 = FullMath.mulDivRoundingUp(FullMath.mulDiv(sqrtK, sqrtK, 1 << 96), 1e18, 1 << 96);
        (int24 tick, bool ok) = PriceMath.refTick(p0, 1e18, 18, 18);
        assertTrue(ok);
        assertTrue(tick == k || tick == k - 1, "round trip");
    }

    // ------------------------------------------------------------------ usd6, refPx, band

    function test_usd6RoundsUp() public pure {
        assertEq(PriceMath.usd6(0, 222.6e18, 18), 0);
        assertEq(PriceMath.usd6(1, 1e18, 6), 1); // 1 base unit of a $1 6-dec token = 1 usd6
        assertEq(PriceMath.usd6(1, 1e18, 18), 1); // 1e-12 usd6 rounds up to 1
        assertEq(PriceMath.usd6(0.11e18, 222.6e18, 18), 24_486_000); // 0.11 NVDA at $222.60 = $24.486
        assertEq(PriceMath.usd6(25e6, 0.9999509e18, 6), 24_998_773); // 24.9987725 rounded up
    }

    function testFuzz_usd6NeverUnderstates(uint256 amount, uint256 price, uint8 dec) public pure {
        amount = bound(amount, 0, type(uint128).max);
        price = bound(price, 0, PriceMath.MAX_PRICE_E18);
        dec = uint8(bound(dec, 0, 36));
        uint256 v = PriceMath.usd6(amount, price, dec);
        // v * 10^(dec+12) >= amount * price, and v is the smallest such value.
        uint256 scale = 10 ** (uint256(dec) + 12);
        assertEq(v, FullMath.mulDivRoundingUp(amount, price, scale));
        if (v > 0) assertLt(FullMath.mulDiv(v - 1, scale, 1), FullMath.mulDivRoundingUp(amount, price, 1));
    }

    function test_refPxE18() public pure {
        assertEq(PriceMath.refPxE18(1e18, 222.6e18), 222.6e18); // USDG per NVDA
        assertEq(PriceMath.refPxE18(0.9999509e18, 222.44729849e18), 222_458_221_188_660_363_223); // 222.4582...e18
        assertEq(PriceMath.refPxE18(0, 1e18), 0);
    }

    /// @dev b ticks is never tighter than b bps: 1.0001^b >= 1 + b / 1e4 for every band in the ceiling range.
    function test_bandTicksRoundUp() public pure {
        for (uint16 b = 0; b <= 300; ++b) {
            int24 t = PriceMath.bandTicks(b);
            assertEq(t, int24(uint24(b)));
            uint256 s = TickMath.getSqrtPriceAtTick(t);
            // s^2 / 2^192 >= (1e4 + b) / 1e4  <=>  2^192 * (1e4 + b) <= s^2 * 1e4   (s^2 < 2^256 for b <= 300)
            assertTrue(_le512(1 << 96, 1 << 96, 10_000 + uint256(b), s * s, 1e4), "band rounds up");
        }
    }

    // ------------------------------------------------------------------ helpers

    /// @dev a * b * c <= d * e, in 512-bit arithmetic (all inputs < 2^256, products < 2^512).
    function _le512(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e) internal pure returns (bool) {
        (uint256 lhsHi, uint256 lhsLo) = _mul512(a, b);
        // (lhs) * c: lhs = hi*2^256 + lo; require hi*c to stay below 2^256 (true for the ranges used here)
        (uint256 m1Hi, uint256 m1Lo) = _mul512(lhsLo, c);
        uint256 hi = m1Hi + lhsHi * c;
        (uint256 rHi, uint256 rLo) = _mul512(d, e);
        return hi < rHi || (hi == rHi && m1Lo <= rLo);
    }

    function _mul512(uint256 a, uint256 b) internal pure returns (uint256 hi, uint256 lo) {
        assembly ("memory-safe") {
            let mm := mulmod(a, b, not(0))
            lo := mul(a, b)
            hi := sub(sub(mm, lo), lt(mm, lo))
        }
    }
}
