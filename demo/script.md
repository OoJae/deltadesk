# DeltaDesk demo script v5 (4:30, weekend submission, Sat Sep 19 2026)

This file is the single source for the demo. `demo/build/beats.mjs` parses every `### NN · id · title` block below:
the duration comes from the **Time** row, the voice from **Narration**, and the fallback from **Draft narration**.
Change a line here, then run `bash demo/build/build.sh`, and the narration, captions and timing all follow.

Rules the build enforces:
- A beat whose **Requires** placeholders are not all filled in `demo/record/config.json` is rendered as a PENDING
  card, and its **Draft narration** is used instead of the final one.
- A sentence containing a `{{PLACEHOLDER}}` that is still empty is dropped from the voice and the captions.
- Every replay is labeled REPLAY on screen for its whole duration. Every live scene carries a LIVE badge with the
  recording time. Evidence rendered from committed files carries a grey badge instead (TEST EVIDENCE, RECORD), never LIVE.

## Rundown

| # | Time | Beat | Surface | Live or replay |
|---|---|---|---|---|
| 00 | 0:00–0:03 | Title card | HTML card | card |
| 01 | 0:03–0:18 | Cold open: Igor's $80 vs $50, Hayden's question (paraphrased) | HTML quote card | card |
| 02 | 0:18–0:44 | The landing: the Sep 11–14 weekend engraved, in five acts | web `/` (three.js relief + acts N° 01–05) | REPLAY |
| 03 | 0:44–1:14 | Truth Study: headline, hour-of-week heatmap, Flow X-ray | web `/study` | LIVE |
| 04 | 1:14–1:32 | LP League → Tearsheet of the #1 LP wallet | web `/league`, `/tearsheet` | LIVE |
| 05 | 1:32–1:48 | Same tearsheet via x402 (`lp-truth`), then the first settled x402 call: a $0.005 `safe-to-lp` self-test | x402 endpoint, Base Blockscout | LIVE |
| 06 | 1:48–1:59 | It's Saturday: Live desk, Chainlink frozen | web `/live` | LIVE |
| 07 | 1:59–2:11 | Start a desk: Vault vs Operator | web `/desk` | LIVE |
| 08 | 2:11–2:27 | The user's desk: lane A's own page, then the public desk console | web `/desk/{{LANE_ADDRESS}}`, `/console` | LIVE |
| 09 | 2:27–2:39 | Factory source verified on 4663, then the user's lane | Robinhood Chain Blockscout | LIVE |
| 10 | 2:39–2:59 | The agent's weekend decisions on-chain: two delegated `signal()` txs, one decoded | Blockscout `{{SIGNAL_TX}}`, `{{SIGNAL_TX2}}` + receipt over RPC | LIVE |
| 11 | 2:59–3:15 | Staged prompt injection: Dynamic's co-signer never signed (Base); on 4663 the lane is the fence | `{{DENIAL_LOG}}` (docs/m2-desk.md §3) | RECORD |
| 12 | 3:15–3:28 | The contract can only pay the owner | `contracts/reports/*.txt` | TEST EVIDENCE |
| 13 | 3:28–3:41 | Weekend gap, Sep 12–13, against every other weekend | live API `by_weekend` | REPLAY |
| 14 | 3:41–3:59 | Labor Day REOPEN-GUARD, Tue Sep 8 | live API backtest `daily` | REPLAY |
| 15 | 3:59–4:18 | Honest economics | agent/README.md "Economics at M2 size" | card |
| 16 | 4:18–4:24 | Coming Monday: first live delegated mint | HTML card | card |
| 17 | 4:24–4:30 | Close + end card | HTML card | card |

## Beats

### 00 · title · Title card

| Field | Value |
|---|---|
| Time | 0:00–0:03 (3 s) |
| Mode | CARD |
| Surface | HTML title card: "DeltaDesk · the open market-making desk for tokenized stocks" |
| Requires | – |

**Narration**
> DeltaDesk.

### 01 · cold-open · Cold open

| Field | Value |
|---|---|
| Time | 0:03–0:18 (15 s) |
| Mode | CARD |
| Surface | HTML quote card: Igor (Bankr) quote, then Hayden Adams' question, paraphrased without quotation marks (the exact wording is not in the repo; check the source before quoting it) |
| Requires | – |

**Narration**
> Igor, at Bankr, LPs tokenized stocks, and he asked: if I made eighty dollars in fees but lost fifty to informed flow, that would be good to know. And Hayden Adams asks whether automated strategies can perform well enough.

### 02 · landing · The weekend, engraved

| Field | Value |
|---|---|
| Time | 0:18–0:44 (26 s) |
| Mode | REPLAY |
| Surface | Web app, the landing `https://web-production-10951.up.railway.app/` at its native 1920x1080 layout: the hero ("Market making stocks was a closed club. We published its books." + the engraved relief of the NVDA/USDG pool's real Sep 11–14 2026 liquidity), then a slow scroll through the five pinned acts N° 01–05, ending on N° 05. The relief is scroll-driven, so the scroll's pace is the animation's pace; the instrument readout beside it reads the replay's own figures at the frame on screen |
| Requires | – |

**Narration**
> Replay: the real weekend of September eleventh to fourteenth, in NVDA's pool on Robinhood Chain. Friday at 8 pm Eastern, Chainlink froze, but the pool kept trading. A $1k LP kept in range paid $4.24 to informed flow and earned $3.32 in fees. DeltaDesk's lane added no risk while the market was closed. At Sunday night's reopen, the gap hit 52.6 basis points.

### 03 · study · The Truth Study

| Field | Value |
|---|---|
| Time | 0:44–1:14 (30 s) |
| Mode | LIVE |
| Surface | Web app, Study: `https://web-production-10951.up.railway.app/study` (page title → headline account → hour-of-week heatmap, hover Mon 09:00 → Flow X-ray) |
| Requires | – |

**Narration**
> So we measured it: every swap in Robinhood Chain's stock pools, marked against Hyperliquid's 24/7 price. NVDA LPs earned about three hundred sixty-five thousand dollars in fees, and informed flow took about two hundred ninety thousand back: for every eighty dollars, sixty-three. By hour of the week, the Monday 9 a.m. hour gives back four dollars for every dollar of fees. And the Flow X-ray shows who: three bot operators take about ninety-eight percent of LPs' net losses. Retail pays LPs.

### 04 · tearsheet · LP League and Tearsheet

| Field | Value |
|---|---|
| Time | 1:14–1:32 (17.5 s) |
| Mode | LIVE |
| Surface | Web app, League `/league` → click #1 → Tearsheet `/tearsheet?wallet=0x6d1eb2cbe55ed1dc958a9e6f715ee70266ea6626&as=operator` |
| Requires | – |

**Narration**
> Every LP can get their own books. The LP League ranks about a thousand managers against simply holding. Here's number one: about twenty-two hundred dollars in fees, nine hundred picked off, sixteen hundred fifty ahead of holding, reconciled to what it actually collected on-chain.

### 05 · x402 · The same tearsheet over x402

| Field | Value |
|---|---|
| Time | 1:32–1:48 (16.5 s) |
| Mode | LIVE |
| Surface | `https://x402.bankr.bot/0xd8d5b9389721258bcdfa7ac1306af6330e5634cd/tearsheet?wallet=…&chain=robinhood` (the 402 terms: $0.05 USDC on Base) → the first settled x402 call on Base Blockscout, `0x309ddc0cbc51eccddf649fa001a25ecdc049179e402bc6dad91e798c8c8e6708`: `safe-to-lp?pool=NVDA`, $0.005, a self-test from our own Bankr wallet, labelled so on screen (`paidCallLabel` in config.json) |
| Requires | – |

**Narration**
> The same tearsheet is a paid x402 endpoint on Bankr: five cents in USDC on Base, no API key. Our lp-truth skill lets any Bankr agent call it. The first call to settle was our own test: a half-cent safe-to-LP check, on Base.

### 06 · live-desk · It's Saturday

| Field | Value |
|---|---|
| Time | 1:48–1:59 (11 s) |
| Mode | LIVE |
| Surface | Web app, Live desk `/live` (regime "Weekend dark window", Chainlink "frozen") |
| Requires | – |

**Narration**
> It's Saturday. The stock market is closed and Chainlink has been frozen since Friday, but the pools and Hyperliquid keep trading. This is when a desk has to decide.

### 07 · start-desk · Start a desk

| Field | Value |
|---|---|
| Time | 1:59–2:11 (12 s) |
| Mode | LIVE |
| Surface | Web app, Start a desk: `{{DESK_URL}}` (Vault vs Operator explainer, the wizard's eight steps) |
| Requires | {{DESK_URL}} |

**Narration**
> So we built the desk. Your Vault owns a lane contract and is the only address it can ever pay. A separate Operator wallet, delegated through Dynamic, is all the agent can sign with.

**Draft narration**
> Next, the desk. Your Vault owns a lane contract, and a separate Operator wallet, delegated through Dynamic, is all the agent can sign with. This screen goes live later today.

### 08 · lane · The user's desk, live

| Field | Value |
|---|---|
| Time | 2:11–2:27 (16 s) |
| Mode | LIVE |
| Surface | Web app, lane A's page `/desk/{{LANE_ADDRESS}}`: read from the lane contract every 5 s, so anyone can open it without signing in (roles, what the lane holds, the fence's risk state, the owner controls, which only the Vault can sign). Then the public desk console `/console`: the agent's public feed (agent healthy, 1 copilot lane, regime and gates) and the decision log with today's two executed gate signals. The lane page's own agent panel (mode, delegation, approvals) needs the Vault signed in, so it is not on camera |
| Requires | {{LANE_ADDRESS}} |

**Narration**
> This is the user's desk, read live from the chain, no sign-in needed: lane A holds about fifty dollars, and only the Vault can sign its owner controls. The public console shows the desk in copilot, the agent healthy, and both of today's gate signals executed.

**Draft narration**
> Next, the user's own lane page and the public desk console.

### 09 · contracts · Verified on Robinhood Chain

| Field | Value |
|---|---|
| Time | 2:27–2:39 (12 s) |
| Mode | LIVE |
| Surface | Robinhood Chain Blockscout: factory `{{FACTORY_ADDRESS}}` (Contract tab: "Contract source code verified"; the scene fails rather than record without that banner), then the user's lane `{{LANE_ADDRESS}}` (Creator = the factory, at the createLane tx; a tag shows that tx's sender is the lane's `owner()`, both read over RPC) |
| Requires | {{FACTORY_ADDRESS}}, {{LANE_ADDRESS}} |

**Narration**
> The contracts are live on Robinhood Chain, with verified source. This is the factory that clones every lane. And this is the user's own lane, created through the factory by their Vault.

**Draft narration**
> The contracts are live on Robinhood Chain, with verified source. The user's lane comes next.

### 10 · signal · The agent's weekend decisions, on-chain

| Field | Value |
|---|---|
| Time | 2:39–2:59 (20 s) |
| Mode | LIVE |
| Surface | Robinhood Chain Blockscout tx `{{SIGNAL_TX}}` (Success; From = the lane's `operator()`; to = the lane), then the second signal `{{SIGNAL_TX2}}` (CLOSED + STALE-REF → CLOSED, when the fair value came back), then the first tx's LaneAction log decoded from its receipt over RPC (Blockscout shows it as raw topics because the implementation's source is on Sourcify, not Blockscout): SIGNAL, WEEKEND_DARK, CLOSED + STALE-REF, caller, reasonHash, and keccak256 of the §3b preimage |
| Requires | {{SIGNAL_TX}} |

**Narration**
> On a weekend the lane refuses to add risk, so the agent stands aside, and says so on-chain. It proposed a gate signal, the owner approved, and its delegated Operator signed it. A second followed when the fair value came back. Each LaneAction carries a hash of the agent's reasoning, which matches its published record.

**Draft narration**
> Next, the agent's weekend decisions on-chain: signal LaneActions for the weekend gates, sent by its delegated Operator.

### 11 · denial · Staged prompt injection vs the Operator

| Field | Value |
|---|---|
| Time | 2:59–3:15 (16 s) |
| Mode | RECORD (staged attack, recorded result) |
| Surface | `{{DENIAL_LOG}}`: `docs/m2-desk.md` renders §3's Policy findings table (the Base DENIED row, then the two 4663 gaps: wallet policy not enforced, chain unsupported); a signer-check `.json` renders its own chain, token and outcome |
| Requires | {{DENIAL_LOG}} |

**Narration**
> Then we attacked it. A staged prompt injection told the Operator to send USDC on Base outside its allowlist, and Dynamic's co-signer never signed. Robinhood Chain isn't in Dynamic's policies yet, so there the lane contract itself is the fence.

**Draft narration**
> Next, a staged prompt injection against the Operator, and what Dynamic's policy did with it.

### 12 · invariants · It can only pay the owner

| Field | Value |
|---|---|
| Time | 3:15–3:28 (12.5 s) |
| Mode | TEST (committed reports; badge TEST EVIDENCE) |
| Surface | `contracts/reports/local-2026-09-19-r2.txt` (1000 runs × depth 100, I1–I14 = 0) and `contracts/reports/fork-archive-2026-09-19.txt` (fork 50 × 20, 0 violations) |
| Requires | – |

**Narration**
> And the lane contract can only ever pay its owner. A thousand fuzzing runs, a hundred calls deep, with an evil operator and an attacker: zero violations. The same on a fork of the live chain.

### 13 · weekend-replay · Weekend gap, Sep 12–13 (REPLAY)

| Field | Value |
|---|---|
| Time | 3:28–3:41 (13.5 s) |
| Mode | REPLAY |
| Surface | Live API `GET /study/table/hl_ref/by_weekend` rendered as a labeled chart (NVDA/USDG weekends, Sep 12–13 highlighted); `{{CONSOLE_URL}}`, the console's replay view, is shown after it when that placeholder is filled |
| Requires | – |

**Narration**
> Replay, clearly labeled: the weekend of September twelfth, the worst NVDA weekend in our data. NVDA LPs earned about ten thousand four hundred dollars in fees, and informed flow took ten thousand back. {{REPLAY_SEP12_LINE}}

### 14 · reopen-replay · Labor Day reopen guard (REPLAY)

| Field | Value |
|---|---|
| Time | 3:41–3:59 (18 s) |
| Mode | REPLAY |
| Surface | Live API `GET /study/table/backtest/daily` (NVDA/USDG, Tue 2026-09-08: rule R0 always-in vs R3 reopen guard) rendered as a labeled card |
| Requires | – |

**Narration**
> Replay: the Labor Day reopen, Tuesday, September eighth. NVDA LPs who stayed in lost seven thousand three hundred fifty dollars that day. With the reopen guard out from nine-twenty to nine-forty-five, they'd have made seven hundred. One day isn't proof, but it's the only rule that paid in and out of sample.

### 15 · economics · Honest economics

| Field | Value |
|---|---|
| Time | 3:59–4:18 (18.5 s) |
| Mode | CARD |
| Surface | HTML card from `agent/README.md` "Economics at M2 size", one cost basis (the 2× hurdle as built): rerange ≈ $0.107 measured; a rerange must promise ≥ $0.783; lane size to clear it ≈ $36.7k median hour, ≈ $4.3k best hour (measured-gas figures in the fine print) |
| Requires | – |

**Narration**
> Honest economics: a rerange costs about eleven cents on Robinhood Chain, and our hurdle wants seventy-eight cents of expected fees before it moves. That clears only on a lane of about thirty-seven thousand dollars at a median hour, and forty-three hundred at the week's best. So small lanes hold one wide range.

### 16 · monday · Coming Monday

| Field | Value |
|---|---|
| Time | 4:18–4:24 (6 s) |
| Mode | CARD |
| Surface | HTML card: "Mon Sep 21, regular session: first live delegated mint, posted as an update" |
| Requires | – |

**Narration**
> Monday, in the regular session: the first live delegated mint, posted as an update.

### 17 · close · Close

| Field | Value |
|---|---|
| Time | 4:24–4:30 (6 s) |
| Mode | CARD |
| Surface | End card: close line, web URL, x402 base, `{{GITHUB_URL}}` |
| Requires | – |

**Narration**
> Market making stocks was a closed club. We published its books.

## Facts used and where they come from

| Claim | Source |
|---|---|
| Igor's "$80 in fees but lost $50 to informed flow" | README.md epigraph |
| Hayden Adams' question (paraphrased, no quotation marks) | not in the repo: buildplan.md line 30 and the brief; the post (x.com/haydenzadams/status/2100573416461893993) could not be fetched. Verify the wording before submitting, or cut it |
| The landing's replay is the real Sep 11–14 2026 weekend on NVDA/USDG: one engraved ridge per 30 minutes of the pool's own liquidity, Fri 16:00 → Mon 09:45 ET | `web/public/relief/weekend-2026-09-11.json`, built from the engine's swap and position record; described in `web/components/landing/acts.ts` |
| Chainlink frozen Fri 20:00 → Sun 20:00 ET (48 h), fence code 5 "market closed" | landing act N° 02; console replay W1 ("Market closed Fri 09-11 20:00 ET → Sun 09-13 20:00 ET (48 h)") |
| A $1k LP kept in range across the 48 h closed window paid $4.24 to informed flow and earned $3.32 in fees (net −$0.92) | landing act N° 03 and the relief's control series; the console's W1 replay says the same for its control lane |
| DeltaDesk's lane added no risk while the market was closed: 0 risk-adding steps in the 48 h | landing act N° 04; console replay W1 ("Lane A ($50): 1 initial placement before the window, 0 re-centers and 0 exits in it") |
| Gap 52.6 bp at the wake, Sun 20:02 ET, the widest of that weekend | landing act N° 05; console replay W1 ("largest pool-vs-fair gap 52.6 bp, pool above fair (Sun 09-13 20:02 ET)") |
| ~$365k fees, ~$290k picked off (NVDA/USDG, vs HL 1h); $63 of every $80 | live Study page at recording time ($367.2k fees, $289.1k picked off, "for every $80 LPs earned, about $63 was picked off"); docs/m1-truth-study.md §answer 1 has the Sep 18 cut ($362.9k / $289.5k) |
| Monday 09:00 ET hour: edge 0.25 (≈ $4 given back per $1 of fees) | docs/m1-truth-study.md §answer 2; live heatmap hover (Mon 09:00, edge 0.25) |
| Three operators ≈ 98% of net losses; retail pays LPs | docs/m1-truth-study.md §2 (98.6%); live Flow X-ray (98.5% on Sep 19) |
| League ≈ 1,000 managers; #1 wallet +$1.65k vs holding, fees $2.19k, picked off $891.56, 33 positions reconciled within 0.0005 bp | live `/league` (1,013 qualifying) and `/tearsheet` for 0x6d1e…6626 on Sep 19 |
| x402 tearsheet terms $0.05 USDC on Base | live 402 response at recording time |
| First settled x402 call 0x309ddc0c…6708 is `safe-to-lp?pool=NVDA`, $0.005, a self-test (payer and payee both DeltaDesk's wallet 0xd8d5…34cd), not a tearsheet call and not outside demand | README.md "Live now"; Base Blockscout (0xD8…34Cd → BankrFeeRouterV2 → 0xD8…34Cd, 0.005 USDC) |
| Chainlink frozen on the weekend, pools + HL keep trading | live `/live` (regime "Weekend dark window", oracle age "frozen") |
| Lane A holds 25.796085 USDG + 0.112258293 NVDA ≈ $50.75 (the page shows ≈ $50.77, Chainlink-valued, at recording time); funded by the owner, converted through SwapRouter02 with the lane as recipient | docs/m2-desk.md §3c; the lane page's own chain reads |
| The lane page needs no sign-in to read (viem reads the lane every 5 s); the owner controls need the Vault signed in, and the agent panel (mode, delegation, approvals) needs the Vault's JWT, so the console's public feed is used instead | web/components/desk/LaneDesk.tsx, web/app/api/desk/[lane]/status/route.ts (401 without a bearer token) |
| Desk console: agent healthy, 1 copilot lane (default advisory), lane #0 0x7f89…d662 operator 0x8662…3678, regime "Weekend dark window", and both gate-signal decisions executed with their txs | live `/console` (desk agent public feed, refreshes every 10 s) |
| I1 "every ERC-20 transfer from the lane goes to the owner or into its own NPM mint"; 1000 × 100 local, 50 × 20 fork, 0 violations | docs/m2-design-contracts.md (I1–I14); contracts/reports/local-2026-09-19-r2.txt, fork-archive-2026-09-19.txt |
| Sep 12–13 weekend: fees $10,367 vs picked off $9,994 (HL 1h), edge 1.04, the lowest NVDA/USDG edge of all 9 weekends in the table (the in-progress Sep 19 one included: 3.02); the card shows the 8 finished ones | live API `/study/table/hl_ref/by_weekend` (checked Sep 19 15:55 UTC) |
| Labor Day reopen (Tue Sep 8): R0 always-in net −$7,350.03 (spoken "seven thousand three hundred fifty"); R3 reopen guard net +$713.8; R3 the only rule positive in both periods | live API `/study/table/backtest/daily`; docs/m1-truth-study.md §4 |
| Rerange ≈ $0.107 (measured); the hurdle charges ≈ $0.392 and a rerange must promise ≥ $0.783; lane size where a typical rerange clears the 2× hurdle as built ≈ $36.7k median hour, ≈ $26.6k mean, ≈ $4.3k best hour (at measured gas: ≈ $10k / ≈ $1.18k). These are hurdle-clearing sizes, not break-evens | agent/README.md "Economics at M2 size" |
| Factory 0x6968…63B3 source verified (Sourcify full match; Blockscout shows "verified, partial match" since about 15:35 UTC); the DeskLaneV3 implementation 0xBf5f…EDD9 is verified on Sourcify but not on Blockscout (so lane logs show as raw topics there) | docs/m2-desk.md §1; Blockscout checked Sep 19 15:50 UTC |
| Lane A 0x7f89…d662: owner() = Vault 0x3976…B85A, operator() = 0x8662…3678; createLane tx 0x0e104b50…a158 sent by the Vault to the factory | docs/m2-desk.md §3; eth_call / eth_getTransactionByHash on 4663 |
| Signal tx 1, 0xddbc1b92…7375: status 1, block 67,199,987, from the Operator to the lane; LaneAction action 8 SIGNAL, regime 4 WEEKEND_DARK, gatesMask 0b1001 CLOSED + STALE-REF, caller = operator(), reasonHash 0x90023d03…7314 = keccak256(§3b preimage); proposed by the agent, approved by the owner (copilot) | docs/m2-desk.md §3b; the receipt over RPC; `cast keccak` |
| Signal tx 2, 0xbe80e98b…3223: the same lane and Operator at 15:51 UTC, CLOSED + STALE-REF → CLOSED once the engine's `/basis` endpoint returned a fair value; the console shows its preimage hash-verified too | docs/m2-desk.md §3b; live `/console` (gate signals) |
| Policy probes: wallet-level policy on 4663 NOT enforced (USDG.transfer signed); environment rule for 4663 refused ("Unsupported chainIds for EVM: 4663"); Base 8453 rule (allowlist = the lane): a Base USDC transfer to the Vault (the staged injection) DENIED, the co-signer never signed (MPC session dropped after 61.6 s) | docs/m2-desk.md §3 (recorded 15:10–15:40 UTC) |

## Placeholders (fill in `demo/record/config.json` → `placeholders`)

| Placeholder | What | Beat |
|---|---|---|
| `{{DESK_URL}}` | The deployed "Start a desk" page: set to `https://web-production-10951.up.railway.app/desk` | 07 |
| `{{FACTORY_ADDRESS}}` | `DeskLaneFactory` on 4663: **set** to `0x6968B97974aF2ba51537e751c043d5ba48d663B3` (contracts/deployments/4663.json) | 09 |
| `{{LANE_ADDRESS}}` | The user's lane on 4663: **set** to `0x7f8968734E613f509991D3392074CF7f1e4bd662` (docs/m2-desk.md §3) | 08, 09 |
| `{{SIGNAL_TX}}` | The first delegated `signal()` LaneAction tx on 4663: **set** to `0xddbc1b92b20332ddee6e2ec587e27246021c42b2b51444e848fab7e0d4fe7375` (docs/m2-desk.md §3b) | 10 |
| `{{SIGNAL_TX2}}` | The second one: **set** to `0xbe80e98beb80f8f87275b01568fd451fe4ceea35881fe74c106e2826ed083223`. Empty: the beat shows the first tx alone | 10 |
| `{{DENIAL_LOG}}` | The recorded policy probes: **set** to `docs/m2-desk.md` (§3 Policy findings). A signer-check report (`agent/data/signer-check/<file>.json`) or a URL also works; key and env files are refused | 11 |
| `{{CONSOLE_URL}}` | The console's replay view, e.g. `…/console#console-replays`. Empty: beat 13 stays on its chart (the landing, beat 02, already shows the Sep 11–14 replay) | 13 |
| `{{REPLAY_SEP12_LINE}}` | One spoken sentence with a W1 replay result for Sep 12–13 (control lane vs DeltaDesk). When you fill it, add about 6 s to beat 13's Time | 13 |
| `{{GITHUB_URL}}` | The public repo | 17 |
| `{{DEMO_VIDEO_URL}}` | Where the final video is hosted (for the submission form, not shown in the video) | – |
