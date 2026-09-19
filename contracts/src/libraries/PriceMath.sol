// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @title Fence prices -> pool ticks and usd6 notionals.
/// @notice Fence prices are USD per ONE WHOLE token, scaled 1e18 (IPriceFence.usdPrice). A v3 pool's raw price is
/// token1 base units per token0 base unit:  P = (p0 / 10^dec0) / (p1 / 10^dec1) = p0 * 10^dec1 / (p1 * 10^dec0).
/// The reference tick is floor(log_1.0001(P)), computed exactly via sqrtPriceX96 = floor(sqrt(P * 2^192)) and
/// TickMath.getTickAtSqrtPrice (which returns the greatest tick whose sqrt price is <= the input).
library PriceMath {
    /// @dev Prices above this are treated as unusable (keeps every intermediate far from uint256 overflow).
    uint256 internal constant MAX_PRICE_E18 = type(uint128).max;
    /// @dev Token decimals above this are treated as unusable.
    uint8 internal constant MAX_DECIMALS = 36;

    uint256 private constant Q64 = 1 << 64;
    uint256 private constant Q128 = 1 << 128;
    uint256 private constant Q192 = 1 << 192;

    /// @notice floor(sqrt(P) * 2^96) for the pool orientation (token0, token1). `ok` is false (and the value 0) when
    /// an input is zero/out of bounds or P lies outside the v3 price domain [2^-128, 2^128).
    function sqrtPriceX96(uint256 p0E18, uint256 p1E18, uint8 dec0, uint8 dec1)
        internal
        pure
        returns (uint256 sqrtP, bool ok)
    {
        if (p0E18 == 0 || p1E18 == 0 || p0E18 > MAX_PRICE_E18 || p1E18 > MAX_PRICE_E18) return (0, false);
        if (dec0 > MAX_DECIMALS || dec1 > MAX_DECIMALS) return (0, false);
        uint256 num = p0E18 * 10 ** dec1; // < 2^128 * 10^36 < 2^248
        uint256 den = p1E18 * 10 ** dec0;
        uint256 whole = num / den; // floor(P)
        if (whole >= Q128) return (0, false);
        if (whole < Q64) {
            // P < 2^64, so P * 2^192 < 2^256.
            sqrtP = Math.sqrt(FullMath.mulDiv(num, Q192, den));
        } else {
            // 2^64 <= P < 2^128: sqrt(P * 2^128) = sqrt(P) * 2^64 carries >= 96 significant bits; shift to Q96.
            sqrtP = Math.sqrt(FullMath.mulDiv(num, Q128, den)) << 32;
        }
        ok = sqrtP >= TickMath.MIN_SQRT_PRICE && sqrtP < TickMath.MAX_SQRT_PRICE;
        if (!ok) sqrtP = 0;
    }

    /// @notice floor(log_1.0001(P)) for the pool orientation (token0, token1); `ok` as in sqrtPriceX96.
    function refTick(uint256 p0E18, uint256 p1E18, uint8 dec0, uint8 dec1) internal pure returns (int24 tick, bool ok) {
        uint256 sqrtP;
        (sqrtP, ok) = sqrtPriceX96(p0E18, p1E18, dec0, dec1);
        if (ok) tick = TickMath.getTickAtSqrtPrice(uint160(sqrtP));
    }

    /// @notice Placement band in ticks for a band in bps. One tick is a factor of 1.0001 (exactly 1 bp), and
    /// log_1.0001(1 + b/1e4) <= b for every b >= 1, so b ticks is the bps band rounded up to whole ticks.
    function bandTicks(uint16 bandBps) internal pure returns (int24) {
        return int24(uint24(bandBps));
    }

    /// @notice Fence value in usd6 of `amount` base units of a token with `decimals` priced at `priceE18`, rounded up.
    function usd6(uint256 amount, uint256 priceE18, uint8 decimals) internal pure returns (uint256) {
        if (amount == 0) return 0;
        return FullMath.mulDivRoundingUp(amount, priceE18, 10 ** (uint256(decimals) + 12));
    }

    /// @notice Whole token1 priced in whole token0 units, 1e18 (USDG per NVDA for the NVDA/USDG pool).
    function refPxE18(uint256 p0E18, uint256 p1E18) internal pure returns (uint256) {
        if (p0E18 == 0) return 0;
        return FullMath.mulDiv(p1E18, 1e18, p0E18);
    }
}
