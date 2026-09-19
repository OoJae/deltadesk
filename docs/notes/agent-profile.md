# Bankr Agent Profile: DeltaDesk (draft)

Bankr Agent Profiles live at https://bankr.bot/agents. The field names and limits below come from the Bankr skill's
`references/agent-profiles.md` in BankrBot/skills.

**When it can be created.** A profile needs `tokenAddress`: a token deployed through Bankr (Doppler or Clanker), or
one whose fees the wallet receives.

- $DESK is not launched yet. Stock-quoted launches are refused while the feed is stale, so the launch waits for a
  weekday, with the user present.
- So the profile is created right after the $DESK launch.
- New profiles start unapproved and appear publicly after Bankr approves them.

**Check the chain field.** The reference lists `tokenChainId` values as base, ethereum, polygon, solana, worldchain,
arbitrum and bnb. It does not list robinhood. Check `bankr agent profile create --help` at launch time. If Robinhood
Chain isn't accepted, ask Bankr before creating the profile.

## Fields

| Field | Limit | Value |
|---|---|---|
| `projectName` | 1–100 | `DeltaDesk` |
| `description` | ≤ 2,000 | see below |
| `tokenAddress` | required | {{DESK_TOKEN_ADDRESS}} (after the $DESK launch) |
| `tokenChainId` | | {{DESK_TOKEN_CHAIN}} (see the note above) |
| `tokenSymbol` | ≤ 20 | `DESK` |
| `tokenName` | ≤ 100 | `DeltaDesk` |
| `twitterUsername` | ≤ 50 | {{PROJECT_X_HANDLE}} |
| `profileImageUrl` | URL | {{PROFILE_IMAGE_URL}} (optional; it is taken from X when that account is linked) |
| `teamMembers` | ≤ 20 | {{TEAM_MEMBERS}} (name, role, links) |

### description (982 characters)

```
DeltaDesk is the open market-making desk for tokenized stocks. It keeps the books that LPs in 24/7 stock pools don't have: for any wallet on Robinhood Chain (Uniswap) or Base (Aerodrome, staked or unstaked), the fees earned against the value informed flow picked off (marked against Hyperliquid's 24/7 price), impermanent loss, gas and net, per $1k, reconciled to on-chain collects.

The same data powers safe-to-lp, a pre-trade ALLOW / CAUTION / BLOCK check any agent can pay for over x402, and a ledger command proposed for Bankr's hood-stock-lp and aero-stock-lp skills.

The desk runs a user's LP lane on Robinhood Chain through a delegated Dynamic wallet, inside a contract that can only pay its owner and refuses to add risk while the stock market is closed.

Study finding: in NVDA/USDG, LPs earned $362.9k in fees and informed flow took back $289.5k. Every figure is historical and reconciled; nothing here is a yield promise. Informational analytics, not investment advice.
```

## products

```json
[
  { "name": "Truth Study", "description": "Pool x regime x hour-of-week fees vs value picked off by informed flow, and who takes it (Flow X-ray).", "url": "https://web-production-10951.up.railway.app" },
  { "name": "Tearsheet", "description": "Any wallet's LP positions: fees, AERO, informed flow, IL, gas, net, per $1k, reconciled. x402, $0.05.", "url": "https://web-production-10951.up.railway.app/tearsheet" },
  { "name": "Safe to LP?", "description": "ALLOW / CAUTION / BLOCK before adding liquidity to NVDA, SPY, TSLA or QQQ/SPY on Robinhood Chain. x402, $0.005.", "url": "https://x402.bankr.bot/0xd8d5b9389721258bcdfa7ac1306af6330e5634cd/safe-to-lp?pool=NVDA" },
  { "name": "LP League", "description": "1,003 LP managers ranked by result vs holding per $1k per day. x402, $0.02.", "url": "https://web-production-10951.up.railway.app/league" },
  { "name": "lp-truth skill", "description": "Bankr skill that calls the endpoints above and formats the answer.", "url": "{{LP_TRUTH_SKILL_URL}}" },
  { "name": "The desk", "description": "Start a desk: a lane contract on Robinhood Chain run by a delegated agent that can only pay its owner.", "url": "https://web-production-10951.up.railway.app/desk" }
]
```

## revenueSources

```json
[
  { "name": "x402 data calls", "description": "Per-call USDC on Base for safe-to-lp ($0.005), fair-value ($0.002), pool-toxicity ($0.01), tearsheet ($0.05) and lp-league ($0.02)." },
  { "name": "$DESK trading fees", "description": "After launch: creator fees fund an auditable house LP lane and the desk's inference. No buybacks, dividends or yield promises." }
]
```

## Capabilities and endpoints (for the profile's detail text or the first update)

- **Fair value, 24/7.** Hyperliquid's price × a basis calibrated on the last completed session, vs the pool mid and a
  Chainlink feed that freezes on weekends. Free at `https://core-production-512e.up.railway.app/fair-value/{NVDA|SPY|TSLA|QQQ-SPY}`.
- **Paid endpoints (x402, USDC on Base).** Base URL `https://x402.bankr.bot/0xd8d5b9389721258bcdfa7ac1306af6330e5634cd/`,
  with the services `safe-to-lp`, `fair-value`, `pool-toxicity`, `tearsheet` and `lp-league`. Failed calls are not
  charged.
- **Skills:**
  - `lp-truth`;
  - `ledger` for `hood-stock-lp` and `aero-stock-lp` (proposed as PRs to BankrBot/skills).
- **Desk:** per-user `DeskLaneV3` lanes on Robinhood Chain (4663). The factory is
  `0x6968B97974aF2ba51537e751c043d5ba48d663B3`, Sourcify-verified:
  https://robinhoodchain.blockscout.com/address/0x6968B97974aF2ba51537e751c043d5ba48d663B3. Start a desk at
  https://web-production-10951.up.railway.app/desk.
- **LLM:** the desk agent's endpoint is the Bankr LLM Gateway (`https://llm.bankr.bot`). Its tighten-only overlay is
  off in M2.

## CLI (run by the user after the $DESK launch)

```bash
bankr agent profile create \
  --name "DeltaDesk" \
  --description "$(cat description.txt)" \
  --token {{DESK_TOKEN_ADDRESS}} \
  --image {{PROFILE_IMAGE_URL}}
# then add products, revenue sources and team via `bankr agent profile update` or PUT /agent/profile
bankr agent profile add-update --title "First live delegated mint" --content "Mon Sep 21: the desk's first delegated mint on Robinhood Chain, with its LaneAction and reasonHash on-chain: {{MINT_TX}}"
```
