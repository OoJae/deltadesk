// Robinhood Chain (4663) for the desk UI: viem chain, the addresses the web reads, and one shared public client.
// Addresses mirror contracts/script/Addresses4663.sol (verified read-only on 2026-09-19).
import { createPublicClient, defineChain, http, type Address } from "viem";

export const CHAIN_ID = 4663;
export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

export const robinhood = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER_URL } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const ADDR = {
  NPM: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
  POOL_NVDA_USDG: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3",
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  CL_NVDA_USD: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
  CL_USDG_USD: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2",
} as const satisfies Record<string, Address>;

/** Lane A pool facts: token0 USDG (6 dec), token1 NVDA (18 dec), fee 500, tick spacing 10. */
export const LANE_A = { pool: ADDR.POOL_NVDA_USDG, token0: ADDR.USDG, token1: ADDR.NVDA, dec0: 6, dec1: 18, sym0: "USDG", sym1: "NVDA", spacing: 10 } as const;

/** Implementation kind for Uniswap v3 LP lanes (IDeskLaneFactory.CreateParams.kind). */
export const KIND_V3_LP = 1;

/** Robinhood Chain orders FCFS with ~100 ms blocks; timestamps are the only clock the lane trusts. */
export const publicClient = createPublicClient({ chain: robinhood, transport: http(RPC_URL, { batch: { wait: 16 } }), batch: { multicall: true } });

export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (addr: string) => `${EXPLORER_URL}/address/${addr}`;
