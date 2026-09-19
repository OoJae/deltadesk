# Runtime Agent Week submission draft (DeltaDesk)

These are the fields of the real form at https://runtime.nyc/submit. Field names, limits and rules are taken from the
site's own `validation.js`, fetched on 2026-09-19. Required fields: project name, "What does it do?", your name,
contact email, project link and X handle. A recorded (online) submission also requires a demo video link.

Fill every `{{…}}` placeholder before pasting. [`docs/m2-desk.md`](m2-desk.md) holds today's on-chain values.

**The user submits the form. Nothing here has been submitted.**

| Field (form label) | Limit | Paste this |
|---|---|---|
| **Project name** | 120 | `DeltaDesk` |
| **What does it do?** | 2,000 | the text in [What does it do?](#what-does-it-do-1982-characters) below |
| **Your name** | 120 | {{CONTACT_NAME}} |
| **Contact email** | 254 | {{CONTACT_EMAIL}} |
| **Your X handle (Twitter)** | 15 chars + @ | {{X_HANDLE}}, your personal handle, e.g. `@yourname` |
| **Other team members** | 1,000 | {{TEAM_MEMBERS}}, names and X handles, or leave blank |
| **Project link** | URL | `https://web-production-10951.up.railway.app` |
| **Demo plans** | choice | **Recorded demo only (online submission)** |
| **Repository link** | URL | {{GITHUB_URL}} (it must be public; the Uniswap track requires it) |
| **Demo video link** | URL | {{DEMO_VIDEO_URL}} (required for a recorded submission) |
| **Project post on X (Twitter)** | a status URL | {{X_POST_URL}}, the first post of [notes/x-thread.md](notes/x-thread.md). A profile link is rejected. |
| **Pitch deck link** | URL | optional; leave blank, or {{DECK_URL}} |
| **Prize entries** | multi-select | ☑ **Dynamic** ☑ **Uniswap**. Bankr is added automatically. Leave Definitive Flash, Grok Bot and Blackbird unchecked. |

## What does it do? (1,982 characters)

```
DeltaDesk is the open market-making desk for tokenized stocks. LPs in 24/7 stock pools do a market maker's job without a market maker's books; DeltaDesk is those books, plus a desk built on them.

1) The truth layer (live). We rebuilt every swap (3.34M, $1.07B) and LP position in Robinhood Chain's NVDA, SPY, TSLA and QQQ/SPY Uniswap pools and Aerodrome's NVDA pool, marked each swap against Hyperliquid's 24/7 price, and reconciled fees to the chain (golden positions within 0.0011 bp). Finding: NVDA/USDG LPs earned $362.9k in fees; informed flow took back $289.5k. Regular hours lose (edge 0.92), Monday 09:00 ET runs at 0.25, three operators take 98.6% of LPs' net losses. It answers Igor's "$80 in fees vs $50 to informed flow" for any wallet: fees vs informed flow vs IL vs net, per $1k.

2) Distribution for agents. 5 x402 endpoints on Bankr (safe-to-lp, fair-value, pool-toxicity, tearsheet, lp-league; first call settled on Base as a self-test), the lp-truth skill, and a ledger command proposed as PRs to Igor's hood-stock-lp and aero-stock-lp skills, with credit.

3) The desk. Per-user lane contracts on Robinhood Chain that hold Uniswap v3 positions for their owner. An agent operates them through a Dynamic delegated Operator wallet, never the owner's Vault; the contract can only pay the owner, fences placements against Chainlink, and refuses to add risk on weekends. Local invariants 1,000x100 and fork campaigns: 0 violations.

Live today: contracts deployed and source-verified on 4663, the user's lane funded, the agent's first on-chain decision (a delegated signal() for the weekend gate), and a recorded Dynamic policy denial of a staged malicious transfer request (the call a prompt injection would try). It is Saturday, so by design the first live mint is Monday, posted as an update. Honest numbers: a rerange costs ~$0.107 of gas, so a $50 lane mints once and keeps its first range until exit. A gap rule that failed out of sample is reported, not hidden.
```

**Only keep the "Live today" paragraph as written if `docs/m2-desk.md` has every one of those hashes.** The contracts
are already deployed and verified (`docs/m2-desk.md` §1), so only the lane, the delegated `signal()` and the policy
denial can still slip. If any of them is not done by submission time, replace the paragraph with this one (the whole
text is then 1,966 characters), and move whichever of the three did land into its first sentence. Keep the total
under 2,000.

```
Live today: the desk contracts, deployed and source-verified on 4663 and fork-tested on the real NVDA/USDG pool; the desk agent; Start a desk. It is Saturday, so by design the contracts refuse to add risk until Monday; the user's lane, the agent's first delegated signal() and the policy denial follow as updates, then the first live mint Monday. Honest numbers: a rerange costs ~$0.107 of gas, so a $50 lane mints once and keeps its first range until exit. A gap rule that failed out of sample is reported, not hidden.
```

## Checklists per track

### Bankr (automatic; grand prize plus the onchain-equities bonus)

The form has no Bankr-specific field. These are the points to cover in the video and the X post:

- **Product:**
  - Tearsheet, Study and League, live.
  - The pre-trade `safe-to-lp`.
  - The desk.
- **Founder-market fit:** market making is the closed part of the equity stack.
- **Execution:**
  - Every number reconciles to the chain.
  - Contracts pass 1,000 × 100 invariant runs and fork campaigns.
- **Originality:** the first public markout / informed-flow ledger for tokenized stocks.
- **Onchain potential:** fills are public, so the books can be public.
- **Token:** $DESK is planned (see "What's next"). It is not launched: stock-quoted launches are refused while the
  feed is stale on weekends.

### Uniswap

1. ☐ Make the repo public: {{GITHUB_URL}}. The README code pointers are in the "Code pointers" section of
   `README.md`.
2. ☐ `FEEDBACK.md` is at the repo root: {{GITHUB_URL}}/blob/main/FEEDBACK.md.
3. ☐ **Fill in the Uniswap Developer Feedback Form**, https://developers.uniswap.org/hackathon-feedback, and include
   the FEEDBACK.md link. Uniswap audits submissions that skip it.
4. ☐ Select **Uniswap** in the Runtime form.

### Dynamic

The handbook asks for five things. Here is where each one is:

| Handbook asks for | Where it is |
|---|---|
| **The job:** the decision the agent makes | The desk agent runs a user's LP lane. Today its decision is the weekend gate: stay out of the pool, logged on-chain as a `signal()` `LaneAction`. |
| **Wallet ownership:** pattern, owner, auth | **Delegated access.** The user owns two Dynamic embedded wallets: the **Vault**, the lane owner, which is never delegated, and the **Operator**, which is delegated to DeltaDesk. The agent signs with `delegatedSignTransaction` using the key share from the delegation webhook, decrypted with our RSA key and sealed in an AES-GCM vault. |
| **The action:** live vs simulated | Live: [`0xddbc1b92…7375`](https://robinhoodchain.blockscout.com/tx/0xddbc1b92b20332ddee6e2ec587e27246021c42b2b51444e848fab7e0d4fe7375) (weekend: market closed) and [`0xbe80e98b…3223`](https://robinhoodchain.blockscout.com/tx/0xbe80e98beb80f8f87275b01568fd451fe4ceea35881fe74c106e2826ed083223) (fair value restored), each with a `reasonHash` whose preimage is recorded, delegated transactions on Robinhood Chain 4663 approved by the owner in copilot mode. Staged malicious transfer requests (the call a prompt injection would try) were sent straight to the delegated signer: Dynamic's policy API refuses Robinhood Chain (`Unsupported chainIds for EVM: 4663`), so on 4663 the lane contract and the agent's ABI are the fence. On Base, an environment rule (allowlist = the lane address) made Dynamic's co-signer refuse the delegated Operator's staged USDC transfer (the session was dropped after 61.6 s, nothing signed), while the same key signed an allowed destination in 2.3 s: [docs/m2-desk.md §3](docs/m2-desk.md). No LLM or prompt is involved in the probe. The live mint is Monday (lane funded, market closed on-chain until Mon 01:00 UTC). |
| **The evidence** | `docs/m2-desk.md` (the deployed and Sourcify-verified contracts, the lane, tx hashes, the denial record). |
| **The integration:** SDK calls | README → "Code pointers" → the Agent rows: `createDelegatedSigner` / `delegatedSignTransaction`, `createDynamicDelegatedSigner`, `verifyDynamicSignature`, `decryptDelegatedWebhookData`. |

## Extra copy (for the video description, the X post or a deck)

- **One-liner:** The open market-making desk for tokenized stocks: public books for every LP, and a desk that runs
  your lane through a delegated agent that can only ever pay you.
- **Problem:** LPs in tokenized-stock pools are market makers without books.
  - In NVDA/USDG, informed flow took back $289.5k of $362.9k in fees.
  - Most of that went at predictable hours and to three operators.
  - No public tool we found showed LPs this, position by position.
- **Solution:**
  - A reconciled ledger of fees vs informed flow vs IL vs net for any wallet.
  - A pre-trade check for LPs and agents.
  - A desk contract plus an agent that acts only inside on-chain limits.
- **Tech stack:**
  - Python / Polars / DuckDB on Envio HyperSync data;
  - FastAPI, Next.js and Railway;
  - Bankr x402 Cloud and Bankr skills;
  - Solidity 0.8.26 / Foundry, with Uniswap v3 NPM and v4-core math;
  - a TypeScript agent: viem, zod, SQLite, the Dynamic node-evm SDK;
  - Hyperliquid data; Chainlink on Robinhood Chain.
- **What's onchain:**
  - Uniswap v3/v4 pools read end to end.
  - x402 payments on Base (first settled call, a self-test from our own Bankr wallet: `0x309ddc0c…6708`).
  - `DeskLaneFactory`, `ChainlinkFence` and the `DeskLaneV3` implementation on 4663:
    `0x6968B97974aF2ba51537e751c043d5ba48d663B3`, `0xc82Cc6A466b7fE32e822A7dA59E7D9d7b726C1ea`,
    `0xBf5f4880B2f569656E913d225bcF4810Dcc4EDD9` (Sourcify full match).
  - The user's lane [`0x7f8968734E613f509991D3392074CF7f1e4bd662`](https://robinhoodchain.blockscout.com/address/0x7f8968734E613f509991D3392074CF7f1e4bd662).
  - The delegated `signal()` [`0xddbc1b92…7375`](https://robinhoodchain.blockscout.com/tx/0xddbc1b92b20332ddee6e2ec587e27246021c42b2b51444e848fab7e0d4fe7375) (weekend: market closed) and [`0xbe80e98b…3223`](https://robinhoodchain.blockscout.com/tx/0xbe80e98beb80f8f87275b01568fd451fe4ceea35881fe74c106e2826ed083223) (fair value restored), each with a `reasonHash` whose preimage is recorded.
- **What's next:**
  - Mon Sep 21: the first live delegated mint (~$50), then the owner's exit.
  - M3 lanes: hedged, and QQQ/SPY on v4.
  - A fully automated weekend, Sep 25–28.
  - $DESK via Bankr, its fees funding an auditable house lane.
