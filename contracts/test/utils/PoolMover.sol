// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {IUniswapV3PoolTest} from "./IUniswapV3PoolTest.sol";

/// @notice Swaps a real Uniswap v3 pool, either to a target tick or by an exact input amount.
/// It pays from its own balance; when that is short it tries `mint(address,uint256)` on the token (mock tokens),
/// so fork tests must fund it (deal) instead.
contract PoolMover {
    using SafeERC20 for IERC20;

    IUniswapV3PoolTest public immutable pool;
    address public immutable token0;
    address public immutable token1;

    error NotPool();
    error Underfunded(address token, uint256 need);

    constructor(address pool_) {
        pool = IUniswapV3PoolTest(pool_);
        token0 = pool.token0();
        token1 = pool.token1();
    }

    /// @notice Move the pool so that slot0.tick == target (the price lands inside tick `target`).
    function moveTo(int24 target) external returns (int24 tick) {
        (uint160 sqrtP, int24 cur,,,,,) = pool.slot0();
        uint160 lo = TickMath.getSqrtPriceAtTick(target);
        uint160 hi = TickMath.getSqrtPriceAtTick(target + 1);
        if (sqrtP >= lo && sqrtP < hi) return cur;
        if (sqrtP >= hi) {
            // Price falls: sell token0 down to just below the upper edge of `target`.
            pool.swap(address(this), true, type(int128).max, hi - 1, "");
        } else {
            // Price rises: sell token1 up to the lower edge of `target`.
            pool.swap(address(this), false, type(int128).max, lo, "");
        }
        (, tick,,,,,) = pool.slot0();
    }

    /// @notice Exact-input swap with no price limit (fee generation).
    function swapExactIn(bool zeroForOne, uint256 amountIn) external returns (int256 amount0, int256 amount1) {
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        return pool.swap(address(this), zeroForOne, int256(amountIn), limit, "");
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != address(pool)) revert NotPool();
        if (amount0Delta > 0) _pay(token0, uint256(amount0Delta));
        if (amount1Delta > 0) _pay(token1, uint256(amount1Delta));
    }

    function _pay(address token, uint256 amount) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal < amount) {
            (bool ok,) = token.call(abi.encodeWithSignature("mint(address,uint256)", address(this), amount - bal));
            if (!ok) revert Underfunded(token, amount - bal);
        }
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}
