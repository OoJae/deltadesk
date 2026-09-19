// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @title Range shape rules and the placement fence.
/// @notice Placement fence. With the pool at tick tc and price P in [1.0001^tc, 1.0001^(tc+1)) (token1 per token0), a
/// range [tl, tu) holds token0 on [max(tl, tc), tu) (it SELLS token0 as the price rises through it; asks start at P)
/// and, whenever tl <= tc, token1 on [tl, min(tu, tc + 1)) (it BUYS token0 as the price falls through it; bids reach
/// P). v3 counts tc == tl as in range, so when tl <= tc < tu the current tick's bucket holds BOTH tokens, tl == tc
/// included. The fence never lets the lane offer either token more than `band` ticks worse than the reference:
///  - if tu > tc: the cheapest token0 offer, max(tl, tc), must be >= refTick - band;
///  - if tl <= tc: the dearest token0 bid, min(tu, tc), must be <= refTick + band.
/// A straddle (tl <= tc < tu) therefore needs |tc - refTick| <= band. The current bucket's token1 bids up to
/// P < 1.0001^(tc+1), a one-tick slack that the rounded-up band absorbs. Swapping the token order negates the ticks
/// and exchanges the two conditions, so the rule is orientation-independent up to that slack.
library RangeRules {
    /// @notice tl < tu, both multiples of `spacing` inside [MIN_TICK, MAX_TICK], width within [minWidth, maxWidth].
    function shapeOk(int24 tl, int24 tu, int24 spacing, uint24 minWidth, uint24 maxWidth) internal pure returns (bool) {
        if (tl >= tu || spacing <= 0) return false;
        if (tl < TickMath.MIN_TICK || tu > TickMath.MAX_TICK) return false;
        if (tl % spacing != 0 || tu % spacing != 0) return false;
        uint256 width = uint256(int256(tu) - int256(tl));
        return width >= minWidth && width <= maxWidth;
    }

    /// @notice The placement fence (see the library notice). Arithmetic is in int256, so no band can overflow.
    function check(int24 tl, int24 tu, int24 tc, int24 refTick, int24 band) internal pure returns (bool) {
        if (tu > tc) {
            int256 cheapestAsk = tl > tc ? tl : tc;
            if (cheapestAsk < int256(refTick) - band) return false;
        }
        // tl == tc bids too (token1 on [1.0001^tc, P)); skipping it let a pool pushed far above the band be bid at.
        if (tl <= tc) {
            int256 dearestBid = tu < tc ? tu : tc;
            if (dearestBid > int256(refTick) + band) return false;
        }
        return true;
    }
}
