// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Reference math for the invariant and fork suites, written independently of src/libraries: the fence tick is
/// found by bisection over TickMath.getSqrtPriceAtTick (not getTickAtSqrtPrice), position amounts come from v4-core
/// SqrtPriceMath exactly as a v3 pool burns them, and usd6 values use OpenZeppelin Math.mulDiv.
/// Prices are USD per ONE WHOLE token, 1e18 (the IPriceFence convention); pool prices are token1 per token0 in base
/// units.
library LaneMath {
    uint256 internal constant Q128 = 1 << 128;
    uint256 internal constant Q192 = 1 << 192;

    /// @notice floor(sqrt(P) * 2^96) for P = p0 * 10^dec1 / (p1 * 10^dec0); 0 outside the v3 price domain.
    function sqrtPriceX96(uint256 p0E18, uint256 p1E18, uint8 dec0, uint8 dec1) internal pure returns (uint256) {
        if (p0E18 == 0 || p1E18 == 0 || dec0 > 36 || dec1 > 36) return 0;
        uint256 num = p0E18 * 10 ** dec1;
        uint256 den = p1E18 * 10 ** dec0;
        uint256 whole = num / den;
        uint256 s;
        if (whole < (1 << 64)) s = Math.sqrt(Math.mulDiv(num, Q192, den));
        else if (whole < Q128) s = Math.sqrt(Math.mulDiv(num, Q128, den)) << 32;
        else return 0;
        return s >= TickMath.MIN_SQRT_PRICE && s < TickMath.MAX_SQRT_PRICE ? s : 0;
    }

    /// @notice The greatest tick whose sqrt price is <= `sqrtP` (bisection; `sqrtP` must be in the v3 domain).
    function tickAtSqrt(uint256 sqrtP) internal pure returns (int24) {
        int256 lo = TickMath.MIN_TICK;
        int256 hi = TickMath.MAX_TICK;
        while (lo < hi) {
            int256 mid = lo + (hi - lo + 1) / 2;
            if (TickMath.getSqrtPriceAtTick(int24(mid)) <= sqrtP) lo = mid;
            else hi = mid - 1;
        }
        return int24(lo);
    }

    /// @notice floor(log_1.0001(P)) of the fence prices; `ok` false when P is outside the v3 domain.
    function refTick(uint256 p0E18, uint256 p1E18, uint8 dec0, uint8 dec1) internal pure returns (int24 tick, bool ok) {
        uint256 s = sqrtPriceX96(p0E18, p1E18, dec0, dec1);
        if (s == 0) return (0, false);
        return (tickAtSqrt(s), true);
    }

    /// @notice Token amounts of `liquidity` on [tl, tu) at pool sqrt price `sqrtP`, rounded down (what a burn returns).
    function amounts(uint160 sqrtP, int24 tl, int24 tu, uint128 liquidity)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        uint160 sa = TickMath.getSqrtPriceAtTick(tl);
        uint160 sb = TickMath.getSqrtPriceAtTick(tu);
        if (sqrtP <= sa) {
            amount0 = SqrtPriceMath.getAmount0Delta(sa, sb, liquidity, false);
        } else if (sqrtP < sb) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtP, sb, liquidity, false);
            amount1 = SqrtPriceMath.getAmount1Delta(sa, sqrtP, liquidity, false);
        } else {
            amount1 = SqrtPriceMath.getAmount1Delta(sa, sb, liquidity, false);
        }
    }

    /// @notice The sqrt price in [sqrtAt(tl), sqrtAt(tu)] closest to `sqrtRef`. A position valued at the reference
    /// price is worth least when the pool trades exactly there, so this is where an arbitrageur leaves it.
    function clampSqrt(uint256 sqrtRef, int24 tl, int24 tu) internal pure returns (uint160) {
        uint256 sa = TickMath.getSqrtPriceAtTick(tl);
        uint256 sb = TickMath.getSqrtPriceAtTick(tu);
        return uint160(sqrtRef < sa ? sa : sqrtRef > sb ? sb : sqrtRef);
    }

    /// @notice usd6 value of `amount` base units (rounded down).
    function usd6(uint256 amount, uint256 priceE18, uint8 dec) internal pure returns (uint256) {
        return Math.mulDiv(amount, priceE18, 10 ** (uint256(dec) + 12));
    }

    /// @notice usd6 value of `amount` base units (rounded up, as the lane charges notional).
    function usd6Up(uint256 amount, uint256 priceE18, uint8 dec) internal pure returns (uint256) {
        return Math.mulDiv(amount, priceE18, 10 ** (uint256(dec) + 12), Math.Rounding.Ceil);
    }

    /// @notice (1.0001^ticks - 1) scaled 1e18, rounded up: the worst relative price concession `ticks` allows.
    function tickFactorE18(int24 ticks) internal pure returns (uint256) {
        uint256 s = TickMath.getSqrtPriceAtTick(ticks);
        return Math.mulDiv(s * 1e18, s, Q192, Math.Rounding.Ceil) - 1e18;
    }

    /// @notice Unix time -> ISO weekday with Monday = 0 (1970-01-05 was a Monday).
    function weekdayMon0(uint256 ts) internal pure returns (uint256) {
        return (ts / 1 days + 3) % 7;
    }

    /// @notice The stock weekend window: Saturday 00:00 UTC to Monday 01:00 UTC.
    function stockWeekend(uint256 ts) internal pure returns (bool) {
        uint256 d = weekdayMon0(ts);
        return d == 5 || d == 6 || (d == 0 && ts % 1 days < 1 hours);
    }

    function floorTick(int24 t, int24 spacing) internal pure returns (int24) {
        int24 r = t % spacing;
        return r < 0 ? t - r - spacing : t - r;
    }

    function ceilTick(int24 t, int24 spacing) internal pure returns (int24) {
        int24 f = floorTick(t, spacing);
        return f == t ? t : f + spacing;
    }
}
