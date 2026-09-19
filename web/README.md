This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Desk

"Start a desk" and each lane's page live under `/desk`. They are the only pages that load wallet code: the Dynamic SDK is
mounted in `app/desk/layout.tsx` through a lazy import, and the site nav never prefetches `/desk`.

### Routes

| Route | What it does |
| --- | --- |
| `/desk` | The setup wizard: sign in (creates the Vault), create the Operator, top up gas, predict the lane address and set the Dynamic policy, create the lane from the Vault, delegate the Operator (done only once desk-agent confirms it received the key share), fund the lane, register it with desk-agent and pick a mode. "Your desks" lists the lanes the factory lists for the Vault whose roles match this setup. |
| `/desk/<lane>` | One lane, read straight from Robinhood Chain: positions, budgets, caps, the agent panel, a link to the lane's tearsheet, Vault-signed owner controls (pause, exit all, withdraw, withdraw a position NFT, revoke the agent) and the "If DeltaDesk is down" last resort. |
| `/api/desk/*` | Server-side proxy to desk-agent: `register` (POST /desks), `[lane]/status`, `[lane]/mode`, `[lane]/approve`, `operator-address` and `delegations/[operator]` (the Operator's delegation as desk-agent sees it, before registration). It adds `AGENT_API_KEY` as `x-desk-agent-key` and forwards the user's Dynamic JWT; the agent checks that JWT's verified wallets. |

The owner controls and every chain read work without desk-agent. The typed ABIs in `lib/desk/abi` come from the frozen
interfaces in `contracts/abi` plus the errors, events and views in `contracts/abi/extras.json`, so every revert decodes
by name; regenerate them with `node web/lib/desk/abi/sync.mjs`.

### Environment

Listed with one-line notes in [`.env.example`](.env.example). `NEXT_PUBLIC_*` values are inlined at build time, so rebuild after
changing them.

| Variable | Side | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_DYNAMIC_ENV_ID` | browser | Dynamic environment id (the sandbox in M2). Unset: sign-in is off and lanes are read-only. |
| `NEXT_PUBLIC_DESK_FACTORY` | browser | `DeskLaneFactory` on chain 4663. Unset: lane creation stays locked. |
| `NEXT_PUBLIC_DESK_GUARDIAN` | browser | Optional watchdog (guardian) written into new lanes. Unset: no guardian. |
| `AGENT_API_URL` | server | Base URL of desk-agent. |
| `AGENT_API_KEY` | server | Shared key for desk-agent; must equal the agent's `DESK_AGENT_API_KEY`. |

### Vault and Operator

Each user gets two Dynamic embedded wallets:

- **Vault**: the lane's immutable owner and the only address value can leave to. It is **never delegated** and holds only
  gas. Dynamic policies filter chain, destination and value but not function selectors, so a delegated Vault would let
  the agent call owner-only functions. The wizard delegates wallets only by explicit address and marks the Vault as denied.
- **Operator**: the agent's signer, delegated to DeltaDesk through Dynamic delegated access. On-chain it can only place,
  trim, collect and exit ranges inside the caps, or pause (owner ≠ operator is enforced by the contracts). Its Dynamic
  policy: chain 4663, allowlist [the lane], native value 0, `blockExport`.

Plan B, if the environment can't hold a second embedded wallet: DeltaDesk's server wallet is the Operator and nothing is
delegated.

### Dynamic safety settings

- Delegated access: **"Prompt users on sign in" OFF** and **"Require delegation" OFF**. Either one lets Dynamic push its own
  delegation dialog, which lists every wallet, the Vault included. The wizard stops (and says so) while either is on.
- Private Key Exports stays enabled, so the Vault can export its key for the last-resort exit on the explorer; the
  Operator's export is blocked by its policy (`blockExport`).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
