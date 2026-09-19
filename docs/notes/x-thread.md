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

## 1/9

```
Igor asked: "If I made $80 in fees but lost $50 to informed flow, that would be good to know."

We measured it for every LP in Robinhood Chain's NVDA, SPY, TSLA and QQQ/SPY pools.

NVDA/USDG: LPs earned $367.3k in fees. Informed flow took back $289.1k.

Meet DeltaDesk 🧵
```

Media: `x-images/04-study-account.png` (the account: $367.3k fees, −$289.1k picked off, $78.2k left)

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

Media: `x-images/07-league.png` (the LP League; or a tearsheet you like, address cropped)

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

Media: `x-images/08-lane.png` (the live lane: Vault, Operator, Guardian, $50.77, risk-adding closed)

## 8/9

```
Today, a Saturday, the agent's first on-chain decision was to stay out, and to say so on-chain:

https://robinhoodchain.blockscout.com/tx/0xddbc1b92b20332ddee6e2ec587e27246021c42b2b51444e848fab7e0d4fe7375

A staged malicious transfer from its wallet was refused by @dynamic_xyz's co-signer.

First live mint Monday, posted here.
```

## 9/9 (269 characters as drafted)

```
Honest notes:
• A fair-value gap rule failed out of sample (−$128); only the reopen guard held.
• A rerange costs ~$0.107 in gas, so a $50 lane mints once and holds that range.

Demo: https://youtu.be/pjpZgsKzxQY
Code: https://github.com/OoJae/deltadesk
Built for Runtime Agent Week
```

## Images (in `docs/notes/x-images/`, captured from the live site)

| File | Shows | Suggested post |
|---|---|---|
| `01-hero.png` | the landing: "Market making stocks was a closed club. We published its books." with the engraved relief | 1 (alt) or 9 |
| `02-act-gap.png` | act N° 03 of the weekend replay: the gap opens, $4.24 paid vs $3.32 earned | 2 |
| `03-act-lane-aside.png` | act N° 04: the lane stands aside, 0 risk-adding steps while closed | 8 |
| `04-study-account.png` | the study's account: $367.3k fees, −$289.1k picked off, $78.2k left | **1** |
| `06-study-scroll.png` | pool edges and the hour-of-week view | 2 |
| `07-league.png` | the LP League, ~1,000 managers ranked against holding | **4** |
| `08-lane.png` | the live lane: roles, $50.77, risk-adding closed | **7** |
| `09-console.png` | the public desk console: agent healthy, both gate signals executed | 7 (alt) |
| `10-signal-tx.png` | Blockscout: the Operator called `signal` on the lane, success | **8** |
| `12-laneaction-log.png` | the decoded `LaneAction` log of that transaction | 8 (alt) |
| `11-brand.png` | the brand book and the Delta seal | 9 (alt) |

X shows up to 4 images per post. One strong image per post reads better than a grid.

## Monday follow-up (post when it happens)

```
Monday, regular session: the desk's first live delegated mint on Robinhood Chain (~$50, approved in copilot), with its LaneAction and reasonHash on-chain, then the owner's exit and withdraw.

mint: {{MINT_TX}}
exit: {{EXIT_TX}}
```
