# DeltaDesk demo (M6)

A 4:30 demo video, built from the live product rather than edited by hand:

- [`script.md`](script.md) holds the beats, narration, durations and sources. It is the single source.
- `record/` drives the live web app, the API, x402 and the explorers with Playwright and records one scene per beat.
- `build/` produces the narration (macOS `say`, or your voice), the captions and the final mp4 (ffmpeg).

```
demo/
  script.md                 beats: Time (duration) · Mode · Surface · Requires · Narration · Draft narration
  record/config.json        URLs + placeholders ({{SIGNAL_TX}} etc.): fill these as the desk goes live
  record/run.mjs            scene runner (launches Chromium with ANGLE/Metal, so the landing's WebGL relief runs on the GPU)
  record/scenes/NN-*.mjs    one file per beat (00-title … 17-close)
  record/lib/harness.mjs    1920x1080 recordVideo, overlay (cursor, caption bar, LIVE/REPLAY/grey badge, tag), waits, scrolling
  record/lib/cards.mjs      HTML cards in the site's "Engraved Certificate" brand (title, quotes, replays, decoded LaneAction, economics, pending, captions)
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
node demo/record/run.mjs --scenes landing,lane     # re-record some (slug, "02", or "02-landing")
node demo/record/run.mjs --scenes signal --headed  # watch it drive the browser

bash demo/build/build.sh                           # narration + captions + stitch → demo/out/deltadesk-demo.mp4
bash demo/build/build.sh --record                  # record everything first
bash demo/build/build.sh --record signal,denial    # re-record those, then build
bash demo/build/build.sh --captions soft           # soft subtitle track (mov_text) instead of burned-in; or: none
DEMO_VOICE=Ava bash demo/build/build.sh            # another macOS voice (say -v '?')
DEMO_NO_GPU=1 node demo/record/run.mjs             # software WebGL (SwiftShader): the landing then records at ~25 fps
```

A full re-record takes about 8 minutes; a build without recording takes about 2 minutes. Output is
`demo/out/deltadesk-demo.mp4` (1920x1080, 30 fps, H.264 high, AAC 48 kHz), with `demo/out/deltadesk-demo.srt` beside it
for YouTube or X uploads.

## Status (Sat Sep 19, 21:25 UTC): 4:30, no PENDING beats, recorded against the redesigned site

| Beat | State |
|---|---|
| 00 title, 01 cold open, 15 economics, 16 Monday, 17 close | cards, in the site's brand (vault ink, Bodoni Moda, IBM Plex Mono, the security border). 01 paraphrases Hayden Adams without quotation marks (his exact words are not in the repo); 15 uses one cost basis, the 2× hurdle as built |
| 02 landing | the redesigned `/` at its native 1920x1080 (no body zoom): the hero, then the five pinned acts N° 01–05 while the three.js relief plays the real Sep 11–14 weekend. REPLAY, because it is historical data |
| 03 Study, 04 League → Tearsheet, 06 Live desk, 07 Start a desk, 08 the user's lane + console | recorded from the live app |
| 05 x402 | the live 402 terms of the tearsheet endpoint, then the first settled x402 call, labelled on screen as what it is: a $0.005 `safe-to-lp` self-test from our own wallet (`paidCallLabel` in config.json) |
| 09 contracts | Blockscout: the factory's "Contract source code verified" banner (the scene fails rather than record without it), then lane A with a tag showing its createLane sender is the lane's `owner()` (read over RPC) |
| 10 signal | both delegated `signal()` txs on Blockscout (From = the lane's `operator()`), then the first one's LaneAction decoded from the receipt over RPC, with keccak256 of the §3b preimage checked at recording time. Blockscout itself shows the log as raw topics: the DeskLaneV3 implementation is verified on Sourcify but not on Blockscout |
| 11 denial | RECORD badge: docs/m2-desk.md §3 Policy findings (Base: DENIED, the co-signer never signed; 4663: wallet policy not enforced, chain unsupported by Dynamic's policy API) |
| 12 invariants | TEST EVIDENCE badge: the committed `contracts/reports/*.txt` and I1 from `docs/m2-design-contracts.md` |
| 13 weekend Sep 12–13, 14 Labor Day reopen | REPLAY, from the live API tables |

### What is not on camera, and why

- **The lane page's agent panel** (mode, delegation status, pending approvals) reads `/api/desk/<lane>/status`, which
  answers 401 without the Vault's JWT, so it only renders for the signed-in owner. Beat 08 shows the same facts from the
  desk agent's **public** feed on `/console` instead (agent healthy, 1 copilot lane, the lane's operator, both gate
  signals executed with their txs). Nothing in this demo signs in as anyone.
- **The owner controls** on that page are on camera, with their real state: locked, with "Sign in with this lane's Vault
  to use these controls" — they are Vault-signed, not agent-signed, which is the point of the beat.
- **Lane A holds ~$50 but no position yet.** The first live delegated mint runs Monday in a regular session (beat 16).

## After the desk goes live: re-record

1. Fill `demo/record/config.json` → `placeholders` with the real values (never estimates):

   | Placeholder | Value | Beat |
   |---|---|---|
   | `DESK_URL` | the deployed wizard: **set** to `https://web-production-10951.up.railway.app/desk` | 07 |
   | `FACTORY_ADDRESS` | `DeskLaneFactory` `0x6968…63B3` (`contracts/deployments/4663.json`) | 09 |
   | `LANE_ADDRESS` | **set**: lane A `0x7f89…d662` (`docs/m2-desk.md` §3) | 08, 09 |
   | `SIGNAL_TX` | **set**: the first delegated `signal()` tx `0xddbc…7375` (`docs/m2-desk.md` §3b) | 10 |
   | `SIGNAL_TX2` | **set**: the second one `0xbe80…3223` (same §3b). Empty: beat 10 shows the first tx alone | 10 |
   | `DENIAL_LOG` | **set** to `docs/m2-desk.md` (§3 Policy findings). Also accepted: a URL, or a repo file `.json` (a signer-check report: its chain, token and outcome are shown, whatever they are), `.txt`, `.log`, `.md`, `.png`/`.jpg`. Files outside the repo, key/env files (`*.pem`, `*.key`, `.env*`) and text that looks like a secret are refused | 11 |
   | `CONSOLE_URL` | the console's replay view (W1), e.g. `…/console#console-replays`. Empty: beat 13 stays on its chart, and the landing (beat 02) already carries the Sep 11–14 replay | 13 (optional) |
   | `REPLAY_SEP12_LINE` | one spoken sentence with the W1 replay result for Sep 12–13 (control lane vs DeltaDesk). When you fill it, add about 6 s to beat 13's Time | 13 (optional) |
   | `GITHUB_URL` | the public repo (shown on the end card) | 17 |
   | `DEMO_VIDEO_URL` | where the video is hosted; used by the submission, not in the video | – |

2. Check the URLs, re-record only what changed, then rebuild:

   ```bash
   node demo/record/run.mjs --dry
   bash demo/build/build.sh --record contracts,signal,denial,lane,close
   ```

   With the placeholders filled, those beats switch from their **Draft narration** to the final **Narration**, and
   the PENDING cards are replaced by the recordings. Anything still empty stays PENDING, so the video never shows a
   claim before its evidence exists.

3. Look at the result before it goes anywhere, for example by extracting a few frames:
   `for t in 25 48 90 140 173 214 250; do ffmpeg -v error -y -ss $t -i demo/out/deltadesk-demo.mp4 -frames:v 1 /tmp/f$t.png; done`.

The explorer scenes (05, 09, 10) warm every explorer page in a hidden tab first, wait for real content inside `<main>`
(Blockscout paints grey skeletons for 10–30 s headless), and highlight only elements that are visible (`s.visible`).
Beat 10 goes further: it loads signal 1 → signal 2 off camera, steps **back** to signal 1, and then moves **forward**
again on camera, so the switch between the two txs takes about a second instead of ten. Highlights follow their element
every frame, so rows that shift while the page finishes loading keep their outline. If Blockscout's layout changes, run
the scene `--headed` and adjust the selectors in `record/scenes/NN-*.mjs`, then check a few frames of
`out/scenes/<id>.webm` before rebuilding.

The landing scene (02) is the only one recorded at the page's **native** size (`pageZoom: 1` in its overlay): the relief
fits itself to the viewport and the headline, so zooming the body would break its geometry. Its REPLAY badge is moved
into the nav's empty middle (`replayCss`), because the relief's instrument readout lives in the top-right corner. The
scene reads each act's sticky range from the DOM and scrolls linearly through it, so the relief animates at an even
pace while each act's panel holds still for about three seconds.

## Your own voiceover

The TTS is a fallback. To use your voice, record per beat and drop the files into `demo/voice/`, named by beat id:

```
demo/voice/01-cold-open.m4a   demo/voice/02-landing.m4a   …   demo/voice/17-close.m4a
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
| 00-title | 3 | 05-x402 | 16.5 | 10-signal | 20 | 15-economics | 18.5 |
| 01-cold-open | 15 | 06-live-desk | 11 | 11-denial | 16 | 16-monday | 6 |
| 02-landing | 26 | 07-start-desk | 12 | 12-invariants | 12.5 | 17-close | 6 |
| 03-study | 30 | 08-lane | 16 | 13-weekend-replay | 13.5 | | |
| 04-tearsheet | 17.5 | 09-contracts | 12 | 14-reopen-replay | 18 | | |

## Editing

- **Words or timing:** edit `script.md` (the Time row's `(N s)` is the duration), then `bash demo/build/build.sh`.
  Captions are cut at 74 characters (84 to absorb a short trailing fragment) and no cue shows for under 0.9 s.
  Re-record a scene when its duration changes, because scene pacing follows the duration: `--record <slug>`.
  The Time ranges in the rundown and in each beat are cumulative; `node demo/build/beats.mjs` prints them and warns
  when a row disagrees.
- **Pronunciation** of the TTS: `build/pronounce.json` (spoken-only substitutions; the captions keep the original text,
  so `$4.24` is read "four dollars twenty-four" and still reads as `$4.24` on screen).
- **What a scene shows:** `record/scenes/NN-*.mjs`. Helpers: `s.goto(url, {waitFor, idle, bar, tag})`, `s.start()` (the
  first kept frame), `s.until(fraction of the beat)`, `s.scrollTo(target, {ms, ease})`, `s.moveTo`, `s.click`,
  `s.highlight`, `s.highlightUnion`, `s.warm(url, selector)` (preloads a slow page in a hidden tab), `s.bar`, `s.tag`,
  `s.stamp` (the recording time, for a relabelled LIVE bar).
- **Tearsheet wallet:** `tearsheetWallet` in `config.json` (default: the League's #1 manager). To use Bankr's own LP
  wallet, get Igor's OK first, then change it and re-record `tearsheet,x402`.

## How it works (and why)

- **1080p that stays sharp.** Playwright records video at the viewport's CSS size, so the viewport is a native
  1920x1080 and most pages get `body { zoom: 1.5 }` (they lay out at 1280 CSS px, big enough to read). The landing
  opts out with `pageZoom: 1`. Overlays sit on `<html>`, outside the page zoom, at their own 1.5.
- **Honest labels.** LIVE scenes carry a caption bar with the source URL and the recording time (UTC). REPLAY scenes
  keep an amber REPLAY badge on screen for the whole beat. Evidence rendered from committed files gets a grey badge
  (TEST EVIDENCE, RECORD), never LIVE. Pending beats are grey PENDING cards. A scene can relabel its bar mid-beat
  (`s.bar`, or `s.goto(url, { bar, tag })`) and add a tag (`s.tag`) saying what a page is evidence of.
- **Deterministic pacing.** Each scene calls `start()` once its page is ready (network idle plus a selector); the
  build trims everything before that and pads with the last frame. Actions are timed as fractions of the beat's
  duration, so they line up with the narration.
- **No `drawtext` in this ffmpeg build** (Homebrew ffmpeg 8.1 without freetype/libass). Cards and caption strips are
  therefore rendered as PNGs by Playwright, and burned-in captions are one ffconcat stream composited with `overlay`.
- **Live numbers drift.** The Study's API refreshes every 10 minutes, so its figures move between recordings (at the
  last one: $367.2k in fees, $289.1k picked off, $63 of every $80). The narration is written against what the
  recording actually shows and rounds ("about three hundred sixty-five thousand"); re-check those words whenever the
  Study beat is re-recorded.
