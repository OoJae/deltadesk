# Spike S1 (M2): Dynamic, Railway and Hyperliquid facts

The M2 plan leaves six questions open until they are checked against the real services. This file records what was
checked on **Sat Sep 19, 2026, 12:30–12:45 UTC**, how, and what is still open. Nothing was deployed, broadcast or
posted. Secrets were loaded from `.env` inside each command and never printed. The environment ID is not written
here; "the sandbox environment" means the Dynamic environment in `DYNAMIC_ENVIRONMENT_ID`.

| # | Question | Status |
|---|---|---|
| 1 | Can one user have two embedded wallets and delegate only one? | **Partially answered** |
| 2 | Does the sandbox sign on chain 4663? | **Partially answered** (server wallet yes; delegated embedded wallet not yet) |
| 3 | Does the Linux glibc native addon work on Railway? | **Open** (agent track) |
| 4 | What are the delegation webhook's field names? | **Open** |
| 5 | Does the Dynamic policy apply on 4663, and is a denial observable? | **Open** |
| 6 | Do the HL SDK method names and shapes match what the agent calls? | **Answered**: no mismatches |

One finding blocks Plan B as the code stands: **the agent's server-wallet signer cannot sign.** It rebuilds
`walletMetadata` from the `walletId` alone, and the SDK refuses caller-supplied key shares without
`externalServerKeySharesBackupInfo`. The fix is to persist the full `walletMetadata` that `createWalletAccount`
returns (details under question 2).

## 1 · Two embedded wallets per user, only one delegated: partially answered

**Evidence.** The sandbox environment's public SDK settings (`GET https://app.dynamicauth.com/api/v0/sdk/<env>/settings`,
no auth, HTTP 200 in 1.8 s):

| Setting | Value |
|---|---|
| `environmentName` | `sandbox` |
| `sdk.waas.allowMultipleWaasWalletsPerChain` | `true` |
| `sdk.multiWallet` | `true` |
| `sdk.embeddedWallets.chainConfigurations` (EVM) | `enabled: true, primary: true` |
| `sdk.embeddedWallets.defaultWalletVersion` | `V3` |
| `sdk.embeddedWallets.automaticEmbeddedWalletCreation` | `true` |
| `sdk.waas.delegatedAccess` | `{enabled: false, promptUsersOnSignIn: false, requiresDelegation: false}` |
| `sdk.waas.exportDisabled` | `false` |
| `sdk.embeddedWallets.supportedSecurityMethods` | passkey enabled and default; email and password disabled |
| enabled sign-in / wallet providers | `emailOnly`, `turnkey` |

- Several embedded (WaaS) wallets per chain are allowed, which the Vault + Operator design needs.
- Delegated Access is **not enabled yet** (expected: the user hasn't switched it on). Both of its sub-flags are
  already off, which is the setting the design wants.
- The SDK types support one delegated share set beside the user's: `WalletMetadata.shareSetType` is one of
  `rootUser | delegated | server | offlineRecovery`, and `otherShareSets` lists "a `delegated` row alongside
  `rootUser`". Nothing yet shows which wallets a delegation covers.
- For the web track: the embedded-wallet security method is **passkey** (the default; email and password are off).
  Check in the Playwright pass that the wizard doesn't stall on a passkey prompt.
- `exportDisabled` is `false`. The plan's policy includes `blockExport`; that is a policy setting, checked under
  question 5.

**Remains.** Enable Delegated Access, run the wizard, and confirm that exactly one `wallet.delegation.created`
arrives, for the Operator, while the Vault stays undelegated (Phase 4, below).

## 2 · Sandbox signing on chain 4663: partially answered

**Chain.** Chain 4663 is in the environment's enabled EVM networks (the list is `1` and `4663`): name
`Robinhood Chain`, key `robinhood`, `isTestnet: false`, RPC host `rpc.mainnet.chain.robinhood.com`, explorer
`robinhoodchain.blockscout.com`. The key and the Dynamic-hosted icon suggest this is Dynamic's catalogue entry, not
a hand-entered custom network.

**Server wallet (Plan B), sign-only: works, with full metadata.** One 2-of-2 server wallet was created in the sandbox,
and one EIP-1559 transaction was signed and **never broadcast** (the scripts have no RPC client):
`{chainId: 4663, to: 0x…dEaD, value: 0, data: 0x, nonce: 0, gas: 21000, maxFeePerGas: 0.1 gwei, maxPriorityFeePerGas: 0}`.

- The run drives the agent's own code read-only: `createServerWalletClient` and `createServerWalletSigner`
  (`agent/src/signer/dynamic-server.ts`), `storeServerWallet` (`agent/scripts/create-server-wallet.ts`, sealed with a
  throwaway in-memory KEK) and `verifySignedTx` (`agent/src/signer/types.ts`). It then re-verifies with viem.
- Wallet: `0x2bD9Fa1054FC39B322819ed92eb315b337E0D762` (sandbox, unfunded; spike only, never use it as an operator).
  `backUpToDynamic: false`, so its only external key share is in the spike's scratch directory, outside the repo
  (mode 0600). It is not stored anywhere in the repo.
- **The agent's signer path failed.** `walletMetadataFor(walletId, address)` rebuilds identity-only metadata, and the
  SDK threw locally (4 ms). Verbatim error:

  > `walletMetadata.externalServerKeySharesBackupInfo is required to verify the password when signing with
  > caller-supplied externalServerKeyShares. Persist the full walletMetadata returned by
  > createWalletAccount/importPrivateKey and pass it back in. fetchWalletMetadata returns identity-only metadata and
  > cannot be used on this path.`

  The agent classified it `ExecError[SIGNER_UNAVAILABLE]`. The SDK also logged it to the console itself, with a
  stack trace: `[DynamicWaasWalletClient] [ERROR]: Error in sign Error: …`.
- **With the full `walletMetadata`,** `client.signTransaction` returned a `0x02…` serialized type-2 transaction
  (216 hex characters).
  - The agent's `verifySignedTx` passed: every field equals the request, and the recovered address equals the wallet.
  - viem's `parseTransaction` gives `chainId 4663`, `to 0x…dead`, value 0, nonce 0, data `0x`.
    `recoverTransactionAddress` equals the wallet.
  - Hash `0xb94d8c5d…26ad` (never broadcast).
- **JSON round trip:** a second sign-only call used the metadata and shares as they come back from JSON, which is what
  the vault stores. It also produced a valid chain-4663 transaction recovering to the wallet (hash `0xd8e2b8e1…26a7`).
  JSON turns the share's empty `pubkey` `Uint8Array` into `{}`, and that is harmless.
- **The two hashes differ:** MPC signatures are randomised. This is one more reason crash recovery rebroadcasts the
  stored bytes and never re-signs.

**Latency** (from the laptop, sandbox):

| Step | Time |
|---|---|
| load `@dynamic-labs-wallet/node-evm` (native MPC addon, darwin) | 1.1 s (one timed run) |
| `new DynamicEvmWalletClient` + `authenticateApiToken` | 1.6 s |
| `createWalletAccount({TWO_OF_TWO, backUpToDynamic: false})` | 7.9 s |
| `signTransaction` (in-memory shares) | 3.9 s |
| `signTransaction` (JSON round-tripped shares) | 4.8 s |

A sign takes 4–5 s, inside the executor's 15 s sign timeout.

**SDK calls vs the hand-written shim** (`agent/src/signer/dynamic-sdk.ts`, against `@dynamic-labs-wallet/{node,node-evm}`
1.1.14 `.d.ts` and the runtime values above):

1. **`WalletMetadata` (blocking for Plan B).**
   - The shim declares `{walletId, accountAddress, chainName, thresholdSignatureScheme, derivationPath?}`. The SDK type
     adds `addressType?`, `externalServerKeySharesBackupInfo?`, `shareSetId?`, `shareSetType?` and `otherShareSets?`.
   - At runtime `createWalletAccount` returns `walletId`, `accountAddress` (checksummed), `chainName: "EVM"`,
     `thresholdSignatureScheme: "TWO_OF_TWO"` and `derivationPath` (a JSON index map, `{"0":44,"1":60,"2":0,"3":0,"4":0}`).
     It also returns `shareSetId` (36 characters) and `externalServerKeySharesBackupInfo`, which is
     `{backups: {dynamic, googleDrive, iCloud, user, external: [1 entry], delegated, offlineRecovery}, passwordEncrypted}`.
   - Signing needs the backup info, so these all fail on every sign:
     - `walletMetadataFor()` in `dynamic-server.ts`;
     - the `server_wallets` row, which stores the `walletId` and key shares only;
     - `create-server-wallet.ts`, which does not persist `created.walletMetadata`.
   - **Fix (agent track):** persist the full `walletMetadata` (sealed or beside the row) and pass it back unchanged.
2. `createWalletAccount` returns more than the shim declares: `publicKeyHex` (130 characters), `rawPublicKey`
   (`{pubkey: Uint8Array(64)}`) and `externalKeySharesWithBackupStatus` (`[{share, backedUpToClientKeyShareService}]`).
   Harmless: the shim declares a subset.
3. `ServerKeyShare`: the shim has `Record<string, unknown>`; the SDK has `EcdsaKeygenResult | Ed25519KeygenResult |
   BIP340KeygenResult`. At runtime it is `{pubkey: Uint8Array(0), secretShare: string(416)}`, one share for 2-of-2.
   The JSON round trip is verified to work.
4. `createWalletAccount` arguments: the SDK adds `password?` and `onError?`. `thresholdSignatureScheme` is the string
   enum `ThresholdSignatureScheme`, and the literal `"TWO_OF_TWO"` works at runtime. Harmless.
5. `signTransaction`: the SDK adds `password?` and `context?: SignMessageContext`. The return type `Promise<string>`
   matches: a `0x02…` raw signed transaction.
6. `DynamicEvmWalletClient` constructor: the SDK's `DynamicWalletClientProps` adds `baseMPCRelayApiUrl?`, `debug?`,
   `forwardMPCClient?`, `enableMPCAccelerator?` and `logger?`. The SDK logs signing errors to the console on its own,
   outside pino's redaction. The message seen carried no secret, but passing a `logger` would route SDK output through
   pino. Suggested, not blocking.
7. `authenticateApiToken(authToken): Promise<void>` matches, and it works with `DYNAMIC_API_KEY` in the sandbox.
8. `delegatedSignTransaction` arguments: the SDK adds `shareSetId?`, `derivationPath?: Uint32Array` and `context?`.
   The SDK says `shareSetId` comes "from the `wallet.delegation.created` webhook payload"; without it, Dynamic
   resolves the share set by `walletId`. The shim and signer omit it. Optional, but worth storing (question 4).
9. `createDelegatedEvmWalletClient`: the SDK config adds `baseMPCRelayApiUrl?` and `debug?`, and it returns
   `DelegatedWalletClient & {chainName: 'EVM'}` (opaque in the shim). Harmless.
10. `decryptDelegatedWebhookData`: the arguments `{privateKeyPem, encryptedDelegatedKeyShare, encryptedWalletApiKey}`,
    the return `{decryptedDelegatedShare, decryptedWalletApiKey}` and `EncryptedDelegatedPayload {alg, iv, ct, tag, ek,
    kid?}` match exactly.
11. Classification: the missing-backup-info error maps to `SIGNER_UNAVAILABLE` (one retry), though it is a permanent
    configuration error. After fix 1 it shouldn't occur.

**Remains.** Delegated signing by the user's **embedded Operator** wallet on 4663 (`delegatedSignTransaction`) needs a
real delegation: `pnpm signer-check` in Phase 4.

## 3 · Linux glibc native addon on Railway: open

- see agent track Docker smoke

## 4 · Delegation webhook field names: open

What the agent accepts today (`agent/src/http/dynamic-webhook.ts`), to be confirmed against one real delivery:

- **Header:** `x-dynamic-signature-256`, a hex HMAC-SHA256 of the raw body, optionally prefixed `sha256=`.
- **Envelope:** `eventId`, `eventName`, `environmentId?`, `timestamp?`, `userId?` and `data`.
- **`wallet.delegation.created` data:** `walletId` and `userId?`, plus `chain?`.
  - The address in one of `accountAddress | walletAddress | address | publicKey`.
  - The share as `encryptedDelegatedShare` or `encryptedDelegatedKeyShare`.
  - `encryptedWalletApiKey`.
  - Each encrypted field is `{alg, iv, ct, tag, ek, kid?}`.
- **`wallet.delegation.revoked` data:** `walletId`.

The schema accepts several spellings because the names aren't confirmed. The SDK fixes only the decrypt helper's
argument names (above) and mentions a `shareSetId` in the created payload.

**Remains.** Capture the first real `wallet.delegation.created` and `wallet.delegation.revoked` deliveries and write
down their key names (names only; the encrypted values never leave `desk-agent`). Then narrow the schema, and store
`shareSetId` if it is present.

## 5 · Dynamic policy on 4663, and an observable denial: open

**Remains.** This needs Delegated Access and a policy: the chain `[4663]`, an allowlist of `[the predicted lane]`,
value 0 and `blockExport`. The allowlist can only be set once the wizard has predicted the lane, before `createLane`
and the delegation (Phase 4, step 7). `pnpm signer-check` stages the probe: after signing a lane `signal()`
(sign-only), it asks the delegated Operator to sign `USDG.transfer(owner, 1)`.

- A `SIGNER_DENIED` result, recorded under `data/signer-check/`, proves the policy applies on 4663 and that a denial
  is observable (exit code 0).
- A signature means the policy is **not** enforced (exit code 2).

## 6 · HL SDK method names: answered (no mismatches)

The agent pins `@nktkas/hyperliquid` 0.33.3. Every SDK call in `agent/src/hl/{client,format}.ts` was mirrored in a
scratch TypeScript file and type-checked with the agent's `tsc` against the installed package:

- **Clients:** `new HttpTransport({apiUrl, timeout})`, `new InfoClient({transport})` and
  `new ExchangeClient({transport, wallet})`.
- **Info reads:** `allMids({dex})` / `allMids()`, `meta({dex})` / `meta()` (`universe[i].{name, szDecimals,
  maxLeverage}`) and `perpDexs()` (`(… | null)[]`, where null is the main dex).
- **`order`:** `order({orders: [{a, b, p, s, r, t: {limit: {tif}}, c}], grouping: "na"})`, reading
  `response.data.statuses[0]`.
- **`cancelByCloid`:** `cancelByCloid({cancels: [{asset, cloid}]})`.
- **Formatting:** `formatPrice(px, szDecimals, "perp")` and `formatSize(sz, szDecimals)` from
  `@nktkas/hyperliquid/utils`.

The result is **`tsc` exit 0**. A negative control, the same file with `allMid` and `assetId`, fails with `TS2551` and
`TS2561`, so the check does bite.

- One read-only live call, `allMids({dex: "xyz"})` through the agent's `createHlInfoClient(httpTransport(…))`,
  answered in 1.5 s:
  - 123 keys, all prefixed `xyz:`;
  - every value a decimal string;
  - `xyz:NVDA = "222.035"` at 12:44 UTC.
- The websocket feed (`bbo`, `activeAssetCtx`, `trades`) uses a raw WebSocket like `recorder/tape.mjs`, not the SDK.
  The REST fallback posts `{"type": "allMids", "dex": "xyz"}`, the same body as the SDK's `AllMidsRequest`.

**Remains (not blocking).** `xyz:NVDA → asset 110002` (100000 + dex index × 10000 + universe index) is not confirmed
live: that needs `meta({dex: "xyz"})` and `perpDexs()`, and the spike was held to one call. It matters only for the
live HL path (`HL_MODE=live`), which is unused in M2.

## Phase 4 steps that answer the open questions

Each outward step is confirmed with the user first. The order matters. The policy allowlist names the lane, and the
lane's address exists only once the factory is deployed and the wizard has predicted it: `predictLane` hashes every
parameter (Vault, Operator, guardian, caps, salt). The policy must be in place before the Operator is delegated.

1. **Deploy and verify the contracts on 4663** (recorded in `docs/m2-desk.md`, section 1):
   - `forge script script/Deploy.s.sol --broadcast` from the keystore deployer: fence, factory, the `DeskLaneV3`
     implementation, `setImplementation(1)` and `setPoolAllowed`;
   - verify on Blockscout (a manual upload if Cloudflare blocks the CLI), then run `CheckDeployment.s.sol`;
   - put the factory address in `DESK_FACTORY_ADDRESS` (desk-agent) and `NEXT_PUBLIC_DESK_FACTORY` (web). The wizard
     cannot predict a lane without it. Without it the webhook refuses only the owners of registered desks.
2. **Deploy `desk-agent`** on Railway in advisory + DRY_RUN:
   - settings: `DESK_MODE=advisory`, `DRY_RUN=true`, `DESK_ARM=0`, a volume at `/data`;
   - the webhook secret and the Dynamic credentials as sealed variables.

   This also answers question 3 on Railway itself.
3. **`pnpm gen-rsa`:**
   - put the private key in the sealed variable `DYNAMIC_RSA_PRIVATE_KEY_PEM`;
   - upload the printed public key in the dashboard (Delegated Access → encryption key).
4. **Webhook:** set the URL to `https://<desk-agent>/webhooks/dynamic` with its secret, subscribed to
   `wallet.delegation.created` and `wallet.delegation.revoked`.
5. **Turn on Delegated Access** with **prompt users on sign-in OFF** and **requires delegation OFF**. Then the Vault is
   never asked to delegate, and delegation happens only in the wizard's Operator step. Leave the allowlist for step 7:
   the lane has no address yet.
6. **Run the wizard** (`/desk`) up to the prediction:
   - sign in by email (the Vault);
   - create the Operator;
   - top up gas on 4663 (about 0.002 ETH for the Vault, 0.005 for the Operator);
   - `predictLane`: the wizard shows the lane address and holds `createLane` until the policy is confirmed.
7. **Set the policy** for the address the wizard shows: chain `[4663]`, allowlist `[that lane]`, value 0,
   `blockExport`. Then tick the wizard's policy confirmation.
8. **Finish the wizard:**
   - `createLane` from the Vault. If the wizard reports that the lane landed at a different address, replace the
     address in the policy before going on;
   - delegate the Operator only; the wizard polls `GET /delegations/<operator>` until it is `active`;
   - funding can be skipped for now;
   - register the desk (`POST /desks`, advisory). Registration binds the Operator's delegation to the lane. A
     delegation that no registration has bound is deleted after 24 h (the unbound-delegation purge in `main.ts`).

   This answers question 1 when:
   - `webhook_events` holds exactly one `wallet.delegation.created` row, `processed` (the Operator's). A Vault
     delegation would add a second, `ignored` row and a critical "lane OWNER wallet was delegated" alert;
   - the Dynamic dashboard shows the Vault not delegated;
   - `GET /delegations/<operator>` is `active`. `GET /delegations/<vault>` being `unknown` is supporting evidence only:
     a Vault delegation the webhook refused reads `unknown` too.

   It answers question 4 by recording the delivery's key names.
9. **`pnpm signer-check --lane <lane>`** in the `desk-agent` service, against its `/data` volume (it signs with the
   delegation stored there). Run it after registration, or within 24 h of the delegation:
   - the signed-but-never-broadcast lane `signal()` answers question 2 for the delegated embedded wallet;
   - the staged `USDG.transfer` denial answers question 5.

   If the lane `signal()` is refused too, check that the allowlist names this lane, fix the policy and run it again.

## How it was run (secrets redacted)

Scratch files lived in the session scratch directory (`spike-s1/`), outside the repo. `node_modules` was a symlink to
`agent/node_modules`, and no `agent/` file was changed. Every command's output went through a filter that replaces the
`.env` values.

```sh
set -a; . deltadesk/.env; set +a
curl -sS "https://app.dynamicauth.com/api/v0/sdk/${DYNAMIC_ENVIRONMENT_ID}/settings"   # → settings.json (0600)
tsx server-wallet-sign.ts | ./redact.py     # create ≤ 1 server wallet, agent signer path, fallback, verify
tsx roundtrip-sign.ts | ./redact.py         # reuse that wallet: sign with JSON round-tripped metadata + shares
tsc -p tsconfig.json                        # HL mirror (hl-types.ts): exit 0; negative control: exit 1
tsx hl-allmids.ts                           # one allMids({dex: "xyz"}) call
```
