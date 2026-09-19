// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The subset of a Uniswap v3 pool that DeskLane reads. Hand-written for 0.8 (v3-core sources are 0.7).
interface IUniswapV3PoolMin {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}
