"use client";

// The only module that mounts the Dynamic SDK. DeskProviders loads it lazily, so its chunks are fetched when a desk page
// renders, never by a prefetch of /desk. Chain 4663 is the only EVM network the embedded wallets see.
import type { ReactNode } from "react";
import { DynamicContextProvider, type EvmNetwork } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { CHAIN_ID, EXPLORER_URL, RPC_URL } from "@/lib/desk/chain";
import { DeskSessionContext } from "./context";
import { useDynamicDeskSession } from "./session";

const EVM_NETWORKS: EvmNetwork[] = [
  {
    chainId: CHAIN_ID,
    networkId: CHAIN_ID,
    name: "Robinhood Chain",
    chainName: "Robinhood Chain",
    vanityName: "Robinhood Chain",
    iconUrls: ["/favicon.ico"],
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [RPC_URL],
    blockExplorerUrls: [`${EXPLORER_URL}/`],
  },
];

function SessionBridge({ children }: { children: ReactNode }) {
  return <DeskSessionContext.Provider value={useDynamicDeskSession()}>{children}</DeskSessionContext.Provider>;
}

export default function DynamicShell({ environmentId, children }: { environmentId: string; children: ReactNode }) {
  return (
    <DynamicContextProvider
      theme="auto"
      settings={{
        environmentId,
        appName: "DeltaDesk",
        walletConnectors: [EthereumWalletConnectors],
        overrides: { evmNetworks: EVM_NETWORKS },
        initialAuthenticationMode: "connect-and-sign",
      }}
    >
      <SessionBridge>{children}</SessionBridge>
    </DynamicContextProvider>
  );
}
