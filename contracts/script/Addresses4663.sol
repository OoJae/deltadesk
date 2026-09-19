// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Robinhood Chain (4663) addresses, each verified with read-only cast calls on 2026-09-19.
library Addresses4663 {
    uint256 internal constant CHAIN_ID = 4663;

    // Uniswap v3
    address internal constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address internal constant SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2; // not used in M2
    address internal constant QUOTER_V2 = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7; // off-chain planning only
    address internal constant WETH9 = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    // Pools
    address internal constant POOL_NVDA_USDG = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3; // fee 500, spacing 10

    // Tokens
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 dec, token0 of the NVDA pool
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC; // 18 dec, ERC-8056, token1
    address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;

    // Chainlink proxies (price per token already includes the uiMultiplier; decimals read live)
    address internal constant CL_NVDA_USD = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address internal constant CL_SPY_USD = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address internal constant CL_QQQ_USD = 0x80901d846d5D7B030F26B480776EE3b29374C2ae;
    address internal constant CL_TSLA_USD = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address internal constant CL_USDG_USD = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;
    address internal constant CL_ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    // Infra
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
}
