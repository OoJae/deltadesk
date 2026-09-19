# DeltaDesk demo (M6)

A roughly 4-minute demo video, built from the live product rather than edited by hand:

- [`script.md`](script.md) holds the beats, narration, durations and sources. It is the single source.
- `record/` drives the live web app, the API, x402 and the explorers with Playwright and records one scene per beat.
- `build/` produces the narration (macOS `say`, or your voice), the captions and the final mp4 (ffmpeg).

```
demo/
  script.md                 beats: Time (duration) · Mode · Surface · Requires · Narration · Draft narration
  record/config.json        URLs + placeholders ({{SIGNAL_TX}} etc.): fill these as the desk goes live
  record/run.mjs            scene runner
  record/scenes/NN-*.mjs    one file per beat (00-title … 15-close)
  record/lib/harness.mjs    1920x1080 recordVideo, overlay (cursor, caption bar, LIVE/REPLAY/grey badge, tag), waits, scrolling
  record/lib/cards.mjs      HTML cards (title, quotes, replays, decoded LaneAction, economics, pending, captions)
  record/lib/chain.mjs      read-only RPC on 4663: lane owner/operator, tx sender, LaneAction decoded from a receipt
  build/build.sh            the one command
  build/{beats,tts,srt,render,stitch}.mjs, build/pronounce.json
  voice/                    put your own voiceover here (see below)
  out/                      generated: scenes/*.webm, voice/*, captions/*, deltadesk-demo.mp4, deltadesk-demo.srt
```

## Commands

```bash
cd demo && npm install && npx playwright install chromium   # once (already done on this machine)

node demo/record/run.mjs --dry                     # plan + HTTP status of every URL; records nothing
node demo/record/run.mjs                           # record every scene whose placeholders are filled
node demo/record/run.mjs --scenes study,x402       # re-record some (slug, "02", or "02-study")
node demo/record/run.mjs --scenes signal --headed  # watch it drive the browser

bash demo/build/build.sh                           # narration + captions + stitch → demo/out/deltadesk-demo.mp4
bash demo/build/build.sh --record                  # record everything first
bash demo/build/build.sh --record signal,denial    # re-record those, then build
bash demo/build/build.sh --captions soft           # soft subtitle track (mov_text) instead of burned-in; or: none
DEMO_VOICE=Ava bash demo/build/build.sh            # another macOS voice (say -v '?')
```

A full re-record takes about 5 minutes; a build without recording takes about 2.5 minutes. Output is
`demo/out/deltadesk-demo.mp4` (1920x1080, 30 fps, H.264 high, AAC 48 kHz), with `demo/out/deltadesk-demo.srt` beside it
for YouTube or X uploads.

## Status (Sat Sep 19, 16:25 UTC): 4:09, no PENDING beats

| Beat | State |
|---|---|
| 00 title, 01 cold open, 13 economics, 14 Monday, 15 close | cards. 01 paraphrases Hayden Adams without quotation marks (his exact words are not in the repo); 13 uses one cost basis, the 2× hurdle as built |
| 02 Study, 03 League → Tearsheet, 05 Live desk, 06 Start a desk | recorded from the live app |
| 04 x402 | the live 402 terms of the tearsheet endpoint, then the first settled x402 call, labelled on screen as what it is: a $0.005 `safe-to-lp` self-test from our own wallet (`paidCallLabel` in config.json) |
| 07 contracts | Blockscout: the factory's "Contract source code verified" banner (the scene fails rather than record without it), then lane A with a tag showing its createLane sender is the lane's `owner()` (read over RPC) |
| 08 signal | Blockscout tx (From = the lane's `operator()`), then its LaneAction decoded from the receipt over RPC, with keccak256 of the §3b preimage checked at recording time. Blockscout itself shows the log as raw topics: the DeskLaneV3 implementation is verified on Sourcify but not on Blockscout |
| 09 denial | RECORD badge: docs/m2-desk.md §3 Policy findings (Base: DENIED, the co-signer never signed; 4663: wallet policy not enforced, chain unsupported by Dynamic's policy API) |
| 10 invariants | TEST EVIDENCE badge: the committed `contracts/reports/*.txt` and I1 from `docs/m2-design-contracts.md` |
| 11 weekend Sep 12–13 (14 s), 12 Labor Day reopen | REPLAY, from the live API tables |

## After the desk goes live: re-record

1. Fill `demo/record/config.json` → `placeholders` with the real values (never estimates):

   | Placeholder | Value | Beat |
   |---|---|---|
   | `DESK_URL` | the deployed wizard: **set** to `https://web-production-10951.up.railway.app/desk` (re-record `start-desk` if the page changes) | 06 |
   | `FACTORY_ADDRESS` | **set**: `DeskLaneFactory` `0x6968…63B3` (`contracts/deployments/4663.json`) | 07 |
   | `LANE_ADDRESS` | **set**: lane A `0x7f89…d662` (`docs/m2-desk.md` §3) | 07 |
   | `SIGNAL_TX` | **set**: the delegated `signal()` tx `0xddbc…7375` (`docs/m2-desk.md` §3b) | 08 |
   | `DENIAL_LOG` | **set** to `docs/m2-desk.md` (§3 Policy findings). Also accepted: a URL, or a repo file `.json` (a signer-check report: its chain, token and outcome are shown, whatever they are), `.txt`, `.log`, `.md`, `.png`/`.jpg`. Files outside the repo, key/env files (`*.pem`, `*.key`, `.env*`) and text that looks like a secret are refused | 09 |
   | `CONSOLE_URL` | the desk console's replay view (W1), e.g. `…/console` | 11 (optional) |
   | `REPLAY_SEP12_LINE` | one spoken sentence with the W1 replay result for Sep 12–13 (control lane vs DeltaDesk). When you fill it, set beat 11's Time back to about 20 s | 11 (optional) |
   | `GITHUB_URL` | the public repo (shown on the end card) | 15 |
   | `DEMO_VIDEO_URL` | where the video is hosted; used by the submission, not in the video | – |

2. Check the URLs, re-record only what changed, then rebuild:

   ```bash
   node demo/record/run.mjs --dry
   bash demo/build/build.sh --record contracts,signal,denial,weekend-replay,close
   ```

   With the placeholders filled, those beats switch from their **Draft narration** to the final **Narration**, and
   the PENDING cards are replaced by the recordings. Anything still empty stays PENDING, so the video never shows a
   claim before its evidence exists.

3. Look at the result before it goes anywhere, for example by extracting a few frames:
   `for t in 20 70 130 150 190; do ffmpeg -v error -y -ss $t -i demo/out/deltadesk-demo.mp4 -frames:v 1 /tmp/f$t.png; done`.

The explorer scenes (04, 07, 08) warm every explorer page in a hidden tab first, wait for real content inside `<main>`
(Blockscout paints grey skeletons for 10–30 s headless), and highlight only elements that are visible (`s.visible`).
Highlights follow their element every frame, so rows that shift while the page finishes loading keep their outline.
If Blockscout's layout changes, run the scene `--headed` and adjust the selectors in `record/scenes/0N-*.mjs`, then check
a few frames of `out/scenes/<id>.webm` before rebuilding.

## Your own voiceover

The TTS is a fallback. To use your voice, record per beat and drop the files into `demo/voice/`, named by beat id:

```
demo/voice/01-cold-open.m4a   demo/voice/02-study.m4a   …   demo/voice/15-close.m4a
```

- `.m4a`, `.wav`, `.aiff` or `.mp3` all work, and any beat without a file keeps the TTS. The text to read is each
  beat's **Narration** in `script.md`; while a beat is PENDING, read its **Draft narration** instead.
- Each file is loudness-normalized (−16 LUFS) and starts 0.35 s into its beat. If a take runs longer than the beat,
  the build holds that scene's last frame and shifts everything after it, and the captions follow.
- A single continuous take also works: `demo/voice/full.m4a` replaces the whole narration track (keep to the
  script's timings; captions then use the script times).
- QuickTime (File → New Audio Recording) exports `.m4a` directly. Then run `bash demo/build/build.sh`, no `--record`
  needed.

Beat ids and target lengths (voice ≈ duration − 0.8 s):

| id | s | id | s | id | s | id | s |
|---|---|---|---|---|---|---|---|
| 00-title | 3 | 04-x402 | 18 | 08-signal | 18 | 12-reopen-replay | 20 |
| 01-cold-open | 15 | 05-live-desk | 12 | 09-denial | 16 | 13-economics | 18 |
| 02-study | 35 | 06-start-desk | 16 | 10-invariants | 15 | 14-monday | 7 |
| 03-tearsheet | 21 | 07-contracts | 13 | 11-weekend-replay | 14 | 15-close | 8 |

## Editing

- **Words or timing:** edit `script.md` (the Time row's `(N s)` is the duration), then `bash demo/build/build.sh`.
  Captions are cut at 74 characters (84 to absorb a short trailing fragment) and no cue shows for under 0.9 s.
  Re-record a scene when its duration changes, because scene pacing follows the duration: `--record <slug>`.
- **Pronunciation** of the TTS: `build/pronounce.json` (spoken-only substitutions; the captions keep the original text).
- **What a scene shows:** `record/scenes/NN-*.mjs`. Helpers: `s.goto(url, {waitFor, idle})`, `s.start()` (the first
  kept frame), `s.until(fraction of the beat)`, `s.scrollTo`, `s.moveTo`, `s.click`, `s.highlight`,
  `s.highlightUnion`, `s.warm(url, selector)` (preloads a slow page in a hidden tab).
- **Tearsheet wallet:** `tearsheetWallet` in `config.json` (default: the League's #1 manager). To use Bankr's own LP
  wallet, get Igor's OK first, then change it and re-record `tearsheet,x402`.

## How it works (and why)

- **1080p that stays sharp.** Playwright records video at the viewport's CSS size, so the viewport is a native
  1920x1080 and pages get `body { zoom: 1.5 }`. The app therefore lays out at 1280 CSS px, big enough to read.
  Overlays sit on `<html>`, outside the zoom.
- **Honest labels.** LIVE scenes carry a caption bar with the source URL and the recording time (UTC). REPLAY scenes
  keep an amber REPLAY badge on screen for the whole beat. Evidence rendered from committed files gets a grey badge
  (TEST EVIDENCE, RECORD), never LIVE. Pending beats are grey PENDING cards. A scene can relabel its bar mid-beat
  (`s.bar`, or `s.goto(url, { bar, tag })`) and add a tag (`s.tag`) saying what a page is evidence of.
- **Deterministic pacing.** Each scene calls `start()` once its page is ready (network idle plus a selector); the
  build trims everything before that and pads with the last frame. Actions are timed as fractions of the beat's
  duration, so they line up with the narration.
- **No `drawtext` in this ffmpeg build** (Homebrew ffmpeg 8.1 without freetype/libass). Cards and caption strips are
  therefore rendered as PNGs by Playwright, and burned-in captions are one ffconcat stream composited with `overlay`.
- **Live numbers drift a little.** The API refreshes every 10 minutes, so the Study shows today's figures ($364k fees
  and $289k picked off at recording), while `docs/m1-truth-study.md` has the Sep 18 cut ($362.9k and $289.5k). The
  narration rounds ("about three hundred sixty thousand") so both stay true.
