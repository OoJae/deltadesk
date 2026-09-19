// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The subset of the Uniswap v3 factory used to validate pools. Hand-written for 0.8.
interface IUniswapV3FactoryMin {
    function owner() external view returns (address);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}
