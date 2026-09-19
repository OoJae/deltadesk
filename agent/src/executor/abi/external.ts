/**
 * Minimal read ABIs of third-party contracts the agent touches on 4663 (hand-written; the
 * generated DeltaDesk ABIs live next to this file). Read-only: the agent never writes to any of
 * these; its only write target is its own lane.
 */

import { erc20Abi, multicall3Abi, parseAbi } from "viem";

export { erc20Abi, multicall3Abi };

/** Uniswap v3 pool views used by the sensor. */
export const uniswapV3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);

/** NonfungiblePositionManager.positions(tokenId). */
export const npmAbi = parseAbi([
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function ownerOf(uint256 tokenId) view returns (address)",
]);

/** Chainlink AggregatorV3 (decimals are read live: the stock feeds moved from 18 to 8 on Jun 23). */
export const aggregatorV3Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** ERC-8056 stock-token views (verified live on NVDA 2026-09-19). */
export const erc8056Abi = parseAbi([
  "function oraclePaused() view returns (bool)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
]);
