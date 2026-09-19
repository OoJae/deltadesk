/**
 * Robinhood Chain (4663) address book, mirrored from contracts/script/Addresses4663.sol (each verified
 * with read-only cast calls on 2026-09-19). The ONLY legal source of third-party addresses: nothing an
 * LLM writes, and nothing a request body carries, ever becomes a `to`.
 *
 * DeltaDesk's own contracts (factory, fence, lane clones) are per-deployment and come from config.
 * test/unit/addresses.test.ts re-parses the Solidity file so the two copies cannot drift.
 */

import type { Address } from "./types.js";

export const CHAIN_ID_4663 = 4663;

export const ADDRESSES_4663 = {
  // Uniswap v3
  V3_FACTORY: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  NPM: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
  SWAP_ROUTER_02: "0xCaf681a66D020601342297493863E78C959E5cb2", // not used in M2
  QUOTER_V2: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7", // off-chain planning only
  WETH9: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",

  // Pools
  POOL_NVDA_USDG: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3", // fee 500, spacing 10

  // Tokens
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // 6 dec, token0 of the NVDA pool
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", // 18 dec, ERC-8056, token1
  SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  QQQ: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",

  // Chainlink proxies (price per token already includes the uiMultiplier; decimals read live)
  CL_NVDA_USD: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
  CL_SPY_USD: "0x319724394D3A0e3669269846abE664Cd621f9f6A",
  CL_QQQ_USD: "0x80901d846d5D7B030F26B480776EE3b29374C2ae",
  CL_TSLA_USD: "0x4A1166a659A55625345e9515b32adECea5547C38",
  CL_USDG_USD: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2",
  CL_ETH_USD: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",

  // Infra
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const satisfies Record<string, Address>;

export type AddressName = keyof typeof ADDRESSES_4663;

/** Lane A's pool. token0 USDG (6), token1 NVDA (18); base = NVDA, quote = USDG. */
export const NVDA_USDG_POOL = {
  address: ADDRESSES_4663.POOL_NVDA_USDG,
  token0: ADDRESSES_4663.USDG,
  token1: ADDRESSES_4663.NVDA,
  dec0: 6,
  dec1: 18,
  fee: 500,
  tickSpacing: 10,
  baseIsToken0: false,
  baseSymbol: "NVDA",
  quoteSymbol: "USDG",
  chainlinkBase: ADDRESSES_4663.CL_NVDA_USD,
  chainlinkQuote: ADDRESSES_4663.CL_USDG_USD,
} as const;

export type PoolConfig = typeof NVDA_USDG_POOL;
