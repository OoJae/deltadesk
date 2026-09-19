"use client";

// Dynamic session for the desk: which embedded wallet is the Vault (owner, never delegated) and which is the Operator.
// DynamicShell calls this once, under DynamicContextProvider; components read the result with useDeskSession() from
// ./context, so they never import the Dynamic SDK themselves.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ChainEnum, getAuthToken, useDynamicContext, useDynamicWaas, useIsLoggedIn, useProjectSettings, useUserWallets, useWalletDelegation } from "@dynamic-labs/sdk-react-core";
import { isEthereumWallet } from "@dynamic-labs/ethereum";
import { getAddress, isAddress, type Address } from "viem";
import { useStoredString, writeStored } from "./hooks";

const VAULT_KEY = (userId: string) => `deltadesk:vault:${userId}`;
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export type DelegationStatus = "delegated" | "denied" | "pending" | "unknown";

export function useDynamicDeskSession() {
  const { primaryWallet, sdkHasLoaded, setShowAuthFlow, handleLogOut, user } = useDynamicContext();
  const loggedIn = useIsLoggedIn();
  const wallets = useUserWallets();
  const { createWalletAccount } = useDynamicWaas();
  const delegation = useWalletDelegation();
  const projectSettings = useProjectSettings();

  const embedded = useMemo(() => wallets.filter(isEthereumWallet).filter((w) => w.connector.isEmbeddedWallet), [wallets]);
  const userId = user?.userId ?? null;
  const storedVault = useStoredString(userId ? VAULT_KEY(userId) : null);

  // The Vault is pinned per user on first sight so that switching Dynamic's primary wallet can never swap roles.
  const vault = useMemo(() => {
    const pinned = storedVault ? embedded.find((w) => same(w.address, storedVault)) : undefined;
    if (pinned) return pinned;
    const primary = primaryWallet && embedded.find((w) => w.id === primaryWallet.id);
    return primary ?? embedded[0] ?? null;
  }, [embedded, primaryWallet, storedVault]);

  useEffect(() => {
    if (userId && vault && !storedVault) writeStored(VAULT_KEY(userId), vault.address);
  }, [userId, vault, storedVault]);

  const others = useMemo(() => embedded.filter((w) => !vault || !same(w.address, vault.address)), [embedded, vault]);
  const walletFor = useCallback((addr?: string | null) => embedded.find((w) => same(w.address, addr)) ?? null, [embedded]);

  const { getWalletsDelegatedStatus, dismissDelegationPrompt, denyWalletDelegation, delegatedAccessEnabled } = delegation;
  const delegationOf = useCallback(
    (addr?: string | null): DelegationStatus => {
      if (!addr) return "unknown";
      const w = getWalletsDelegatedStatus().find((x) => same(x.address, addr));
      return w ? w.status : "unknown";
    },
    [getWalletsDelegatedStatus],
  );

  // Dynamic's own delegation modal must never be able to offer the Vault. With "prompt users on sign-in" on, Dynamic
  // re-checks after every credential change (sign-in, a new Operator wallet) and opens the modal without a wallet list,
  // which lists and pre-selects every wallet whose status is "pending", the Vault included. A per-wallet dismiss doesn't
  // change that status, so:
  // 1. Turn the automatic prompt off for the session. Dynamic keeps this flag in localStorage and clears it on logout,
  //    so set it on mount (before any sign-in) and again whenever the user changes. A layout effect, so it lands before
  //    Dynamic's own (passive) prompt check in the same commit, e.g. on a page load with a restored session.
  //    delegateOnly() still works: an explicit wallet list is accepted whatever the prompt state.
  useLayoutEffect(() => {
    dismissDelegationPrompt();
  }, [userId, dismissDelegationPrompt]);

  // 2. Record in Dynamic that the Vault denies delegated access. Its status becomes "denied", which drops it from any
  //    list-less prompt on any device. Tried once per Vault per mount; if it fails, guard 1 still holds here.
  const deniedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!vault || !delegatedAccessEnabled) return;
    const w = getWalletsDelegatedStatus().find((x) => same(x.address, vault.address));
    if (!w?.id || w.status !== "pending" || deniedFor.current === w.id) return;
    deniedFor.current = w.id;
    denyWalletDelegation(w.id).catch((e) => console.warn("DeltaDesk: could not mark the Vault as non-delegable in Dynamic", e));
  }, [vault, delegatedAccessEnabled, getWalletsDelegatedStatus, denyWalletDelegation]);

  // Environment settings that make Dynamic push delegation by itself. DeltaDesk needs both off; VaultAlarm blocks on them.
  const da = projectSettings?.sdk?.waas?.delegatedAccess;
  const unsafeDelegationSettings = da?.enabled
    ? [da.promptUsersOnSignIn && "Prompt users on sign-in", da.requiresDelegation && "Require delegation"].filter((x): x is string => !!x)
    : [];

  /** Creates one more embedded EVM wallet (the Operator). Returns its address. */
  const createOperator = useCallback(async (): Promise<Address> => {
    const before = new Set(embedded.map((w) => w.address.toLowerCase()));
    const created = (await createWalletAccount([ChainEnum.Evm])) as { accountAddress?: string }[];
    const addr = created.map((c) => c?.accountAddress).find((a): a is string => !!a && isAddress(a) && !before.has(a.toLowerCase()));
    if (!addr) throw new Error("Dynamic did not return a new wallet address.");
    return getAddress(addr);
  }, [createWalletAccount, embedded]);

  const createVault = useCallback(async () => {
    await createWalletAccount([ChainEnum.Evm]);
  }, [createWalletAccount]);

  /** Delegates exactly one wallet. Never call delegateKeyShares() without a list: that delegates every pending wallet. */
  const delegateOnly = useCallback(
    async (addr: Address) => {
      if (vault && same(addr, vault.address)) throw new Error("Refusing to delegate the Vault.");
      const w = walletFor(addr);
      if (!w) throw new Error("The Operator is not one of this user's embedded wallets.");
      try {
        await delegation.delegateKeyShares([{ chainName: ChainEnum.Evm, accountAddress: w.address }]);
      } catch (e) {
        // Password/MFA-protected wallets need Dynamic's own prompt; scope it to the Operator only.
        if (e instanceof Error && /password|mfa|unlock/i.test(e.message)) await delegation.initDelegationProcess({ wallets: [w] });
        else throw e;
      }
    },
    [delegation, vault, walletFor],
  );

  const revokeDynamicDelegation = useCallback(
    async (addr: Address) => {
      const w = walletFor(addr);
      if (!w || delegationOf(addr) !== "delegated") return false;
      await delegation.revokeDelegation([{ chainName: ChainEnum.Evm, accountAddress: w.address }]);
      return true;
    },
    [delegation, delegationOf, walletFor],
  );

  const jwt = useCallback(() => getAuthToken() ?? null, []);

  return {
    sdkHasLoaded,
    loggedIn,
    email: user?.email ?? null,
    vault,
    others,
    walletFor,
    delegatedAccessEnabled,
    unsafeDelegationSettings,
    delegationOf,
    createOperator,
    createVault,
    delegateOnly,
    revokeDynamicDelegation,
    signIn: () => setShowAuthFlow(true),
    signOut: handleLogOut,
    jwt,
  };
}

export type DeskSession = ReturnType<typeof useDynamicDeskSession>;
