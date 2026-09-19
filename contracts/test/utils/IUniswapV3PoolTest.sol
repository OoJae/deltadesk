// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IUniswapV3PoolMin} from "../../src/interfaces/external/IUniswapV3PoolMin.sol";

/// @notice The v3 pool actions tests need on top of what the lane reads (hand-written for 0.8).
interface IUniswapV3PoolTest is IUniswapV3PoolMin {
    function initialize(uint160 sqrtPriceX96) external;

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    function feeGrowthGlobal0X128() external view returns (uint256);
    function feeGrowthGlobal1X128() external view returns (uint256);
}
