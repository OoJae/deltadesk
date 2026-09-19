# X thread draft (DeltaDesk launch)

Post from the project's or the founder's account **after** the demo video and repo are public. Replace every `{{…}}`.
The counts below use X's weighting: every URL, and every placeholder that becomes one, counts as 23 characters, and
the emoji and symbols such as • and − count as 2. Every post fits in 280 with links. The first post's URL is the
Runtime form's "Project post on X" field.

Rules this draft follows:

- Only measured, historical numbers from the study or today's chain record.
- No P&L, yield or APR claims, and no token talk ($DESK is not launched).
- The weekend beats are stated as what they are: a decision to stay out, and a denied request.

Handles:

- `@bankrbot` is Bankr's, as used in the research notes.
- Check `@dynamic_xyz` before posting.
- Optionally add `@Uniswap` to post 4 (256 characters then), and write `@igoryuzo` in place of "Igor" in post 1, a
  courtesy tag for the quote (276 characters then; appending the tag instead would go over 280).

## 1/9 (271 characters as drafted)

```
Igor asked: "If I made $80 in fees but lost $50 to informed flow, that would be good to know."

We measured it for every LP in Robinhood Chain's NVDA, SPY, TSLA and QQQ/SPY pools.

NVDA/USDG: LPs earned $362.9k in fees. Informed flow took back $289.5k.

Meet DeltaDesk 🧵
```

Media: Study page screenshot: the hour-of-week heatmap (fees vs picked off), https://web-production-10951.up.railway.app

## 2/9 (259 characters as drafted)

```
Where it goes:

• Regular hours: edge 0.92 (fees ÷ value picked off). LPs lose.
• Monday 09:00 ET: 0.25. Informed flow takes ~$4 per $1 of fees.
• Weekends: 3.50, but pool-only markouts overstate it (by 20% at 1h).

Marked against Hyperliquid's 24/7 price.
```

## 3/9 (212 characters as drafted)

```
Who takes it:

Three operators account for 98.6% of NVDA LPs' net losses to informed flow.

Hyperliquid-arb bots pay 37% of fees and take 66% of the positive value picked off. Retail and aggregator flow pays LPs.
```

## 4/9 (247 characters as drafted)

```
Paste any wallet into the tearsheet: Uniswap on Robinhood Chain or Aerodrome on Base, staked or not.

Fees vs informed flow vs IL vs gas vs net, per $1k, reconciled to on-chain collects (golden positions within 0.0011 bp).

https://web-production-10951.up.railway.app/tearsheet
```

Media: Tearsheet screenshot of a public wallet (address cropped)

## 5/9 (238 characters as drafted)

```
On Aerodrome's NVDAc/USDC pool, swap fees cover only 0.97x of what informed flow takes. 82% of fees go to veAERO voters.

AERO emissions are what make it pay: 1.22x with AERO. AERO attributed to positions equals AERO distributed, exactly.
```

## 6/9 (211 characters as drafted)

```
For agents: 5 x402 endpoints on @bankrbot (safe-to-lp at $0.005, tearsheet $0.05), the lp-truth skill, and `ledger` PRs proposed for Bankr's hood-stock-lp and aero-stock-lp skills, to bring the answer into chat.
```

## 7/9 (271 characters as drafted)

```
The desk: a lane contract on Robinhood Chain that holds your Uniswap position.

An agent runs it through a separate @dynamic_xyz delegated wallet, never your owner wallet. The contract can only pay you, fences placements vs Chainlink, and refuses to add risk on weekends.
```

Media: 30-second clip from the demo: the lane's LaneAction on Blockscout, then the Dynamic denial

## 8/9 (254 characters as drafted)

```
Today, a Saturday, the agent's first on-chain decision was to stay out.

signal() tx: https://robinhoodchain.blockscout.com/tx/0xddbc1b92b20332ddee6e2ec587e27246021c42b2b51444e848fab7e0d4fe7375
A staged malicious transfer from the agent's wallet: Dynamic's co-signer refused it (on Base; Dynamic policies don't cover Robinhood Chain yet, where our contract is the fence).

First live mint Monday, posted here.
```

## 9/9 (269 characters as drafted)

```
Honest notes:
• A fair-value gap rule failed out of sample (−$128); only the reopen guard held.
• A rerange costs ~$0.107 in gas, so a $50 lane mints once and holds that range.

Demo: {{DEMO_VIDEO_URL}}
Code: {{GITHUB_URL}}
Built for Runtime Agent Week
```

## Monday follow-up (post when it happens)

```
Monday, regular session: the desk's first live delegated mint on Robinhood Chain (~$50, approved in copilot), with its LaneAction and reasonHash on-chain, then the owner's exit and withdraw.

mint: {{MINT_TX}}
exit: {{EXIT_TX}}
```
