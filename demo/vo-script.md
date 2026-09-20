# DeltaDesk demo — voiceover script

Video: `demo/out/deltadesk-demo.mp4` · 18 beats · total 4:29.5 (269.5 s) · 1920×1080.

**How to hand the voiceover back** (either works):

1. **Per beat (best):** export one audio file per beat, named exactly by its id, into `demo/voice/` —
   e.g. `demo/voice/02-landing.m4a`. `.m4a`, `.wav`, `.mp3` and `.aiff` all work. Any beat you skip keeps the
   current voice. Each file is loudness-matched automatically and starts 0.35 s into its beat; if a take runs long,
   the build holds that scene's last frame and shifts everything after it, captions included.
2. **One continuous take:** export the whole read as a single file and give it to me. I'll split it on the pauses,
   align each segment to its beat, stretch the scenes to fit your pacing, and rebuild the captions.

**Target length** per beat is the duration minus about 0.8 s of air. Words and the implied pace are listed so you can
match Clipchamp's speed setting: read at roughly the stated words-per-minute, or tell me and I'll re-time the video.

| # | Beat id | In | Out | Length | Words | Pace |
|---|---|---|---|---|---|---|
| 00 | `00-title` | 0:00.0 | 0:03.0 | 3 s | 1 | 27 wpm |
| 01 | `01-cold-open` | 0:03.0 | 0:18.0 | 15 s | 39 | 165 wpm |
| 02 | `02-landing` | 0:18.0 | 0:44.0 | 26 s | 63 | 150 wpm |
| 03 | `03-study` | 0:44.0 | 1:14.0 | 30 s | 81 | 166 wpm |
| 04 | `04-tearsheet` | 1:14.0 | 1:31.5 | 17.5 s | 44 | 158 wpm |
| 05 | `05-x402` | 1:31.5 | 1:48.0 | 16.5 s | 43 | 164 wpm |
| 06 | `06-live-desk` | 1:48.0 | 1:59.0 | 11 s | 29 | 171 wpm |
| 07 | `07-start-desk` | 1:59.0 | 2:11.0 | 12 s | 34 | 182 wpm |
| 08 | `08-lane` | 2:11.0 | 2:27.0 | 16 s | 46 | 182 wpm |
| 09 | `09-contracts` | 2:27.0 | 2:39.0 | 12 s | 32 | 171 wpm |
| 10 | `10-signal` | 2:39.0 | 2:59.0 | 20 s | 55 | 172 wpm |
| 11 | `11-denial` | 2:59.0 | 3:15.0 | 16 s | 40 | 158 wpm |
| 12 | `12-invariants` | 3:15.0 | 3:27.5 | 12.5 s | 36 | 185 wpm |
| 13 | `13-weekend-replay` | 3:27.5 | 3:41.0 | 13.5 s | 33 | 156 wpm |
| 14 | `14-reopen-replay` | 3:41.0 | 3:59.0 | 18 s | 52 | 181 wpm |
| 15 | `15-economics` | 3:59.0 | 4:17.5 | 18.5 s | 52 | 176 wpm |
| 16 | `16-monday` | 4:17.5 | 4:23.5 | 6 s | 14 | 162 wpm |
| 17 | `17-close` | 4:23.5 | 4:29.5 | 6 s | 11 | 127 wpm |

---

## The script

Read only the text in the blocks. Numbers are written the way they should be spoken (they were tuned for text-to-speech);
say them naturally. Nothing here is a claim of profit or a recommendation — keep the plain, factual tone.

### 00 · `00-title` — 0:00.0→0:03.0 (3 s, ~1 words)

```
DeltaDesk.
```

### 01 · `01-cold-open` — 0:03.0→0:18.0 (15 s, ~39 words)

```
Igor, at Bankr, LPs tokenized stocks, and he asked: if I made eighty dollars in fees but lost fifty to informed flow, that would be good to know. And Hayden Adams asks whether automated strategies can perform well enough.
```

### 02 · `02-landing` — 0:18.0→0:44.0 (26 s, ~63 words)

```
Replay: the real weekend of September eleventh to fourteenth, in NVDA's pool on Robinhood Chain. Friday at 8 pm Eastern, Chainlink froze, but the pool kept trading. A $1k LP kept in range paid $4.24 to informed flow and earned $3.32 in fees. DeltaDesk's lane added no risk while the market was closed. At Sunday night's reopen, the gap hit 52.6 basis points.
```

### 03 · `03-study` — 0:44.0→1:14.0 (30 s, ~81 words)

```
So we measured it: every swap in Robinhood Chain's stock pools, marked against Hyperliquid's 24/7 price. NVDA LPs earned about three hundred sixty-five thousand dollars in fees, and informed flow took about two hundred ninety thousand back: for every eighty dollars, sixty-three. By hour of the week, the Monday 9 a.m. hour gives back four dollars for every dollar of fees. And the Flow X-ray shows who: three bot operators take about ninety-eight percent of LPs' net losses. Retail pays LPs.
```

### 04 · `04-tearsheet` — 1:14.0→1:31.5 (17.5 s, ~44 words)

```
Every LP can get their own books. The LP League ranks about a thousand managers against simply holding. Here's number one: about twenty-two hundred dollars in fees, nine hundred picked off, sixteen hundred fifty ahead of holding, reconciled to what it actually collected on-chain.
```

### 05 · `05-x402` — 1:31.5→1:48.0 (16.5 s, ~43 words)

```
The same tearsheet is a paid x402 endpoint on Bankr: five cents in USDC on Base, no API key. Our lp-truth skill lets any Bankr agent call it. The first call to settle was our own test: a half-cent safe-to-LP check, on Base.
```

### 06 · `06-live-desk` — 1:48.0→1:59.0 (11 s, ~29 words)

```
It's Saturday. The stock market is closed and Chainlink has been frozen since Friday, but the pools and Hyperliquid keep trading. This is when a desk has to decide.
```

### 07 · `07-start-desk` — 1:59.0→2:11.0 (12 s, ~34 words)

```
So we built the desk. Your Vault owns a lane contract and is the only address it can ever pay. A separate Operator wallet, delegated through Dynamic, is all the agent can sign with.
```

### 08 · `08-lane` — 2:11.0→2:27.0 (16 s, ~46 words)

```
This is the user's desk, read live from the chain, no sign-in needed: lane A holds about fifty dollars, and only the Vault can sign its owner controls. The public console shows the desk in copilot, the agent healthy, and both of today's gate signals executed.
```

### 09 · `09-contracts` — 2:27.0→2:39.0 (12 s, ~32 words)

```
The contracts are live on Robinhood Chain, with verified source. This is the factory that clones every lane. And this is the user's own lane, created through the factory by their Vault.
```

### 10 · `10-signal` — 2:39.0→2:59.0 (20 s, ~55 words)

```
On a weekend the lane refuses to add risk, so the agent stands aside, and says so on-chain. It proposed a gate signal, the owner approved, and its delegated Operator signed it. A second followed when the fair value came back. Each LaneAction carries a hash of the agent's reasoning, which matches its published record.
```

### 11 · `11-denial` — 2:59.0→3:15.0 (16 s, ~40 words)

```
Then we attacked it. A staged prompt injection told the Operator to send USDC on Base outside its allowlist, and Dynamic's co-signer never signed. Robinhood Chain isn't in Dynamic's policies yet, so there the lane contract itself is the fence.
```

### 12 · `12-invariants` — 3:15.0→3:27.5 (12.5 s, ~36 words)

```
And the lane contract can only ever pay its owner. A thousand fuzzing runs, a hundred calls deep, with an evil operator and an attacker: zero violations. The same on a fork of the live chain.
```

### 13 · `13-weekend-replay` — 3:27.5→3:41.0 (13.5 s, ~33 words)

```
Replay, clearly labeled: the weekend of September twelfth, the worst NVDA weekend in our data. NVDA LPs earned about ten thousand four hundred dollars in fees, and informed flow took ten thousand back.
```

### 14 · `14-reopen-replay` — 3:41.0→3:59.0 (18 s, ~52 words)

```
Replay: the Labor Day reopen, Tuesday, September eighth. NVDA LPs who stayed in lost seven thousand three hundred fifty dollars that day. With the reopen guard out from nine-twenty to nine-forty-five, they'd have made seven hundred. One day isn't proof, but it's the only rule that paid in and out of sample.
```

### 15 · `15-economics` — 3:59.0→4:17.5 (18.5 s, ~52 words)

```
Honest economics: a rerange costs about eleven cents on Robinhood Chain, and our hurdle wants seventy-eight cents of expected fees before it moves. That clears only on a lane of about thirty-seven thousand dollars at a median hour, and forty-three hundred at the week's best. So small lanes hold one wide range.
```

### 16 · `16-monday` — 4:17.5→4:23.5 (6 s, ~14 words)

```
Monday, in the regular session: the first live delegated mint, posted as an update.
```

### 17 · `17-close` — 4:23.5→4:29.5 (6 s, ~11 words)

```
Market making stocks was a closed club. We published its books.
```

