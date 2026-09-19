#!/usr/bin/env bash
# Build the DeltaDesk demo video.
#   bash demo/build/build.sh                      TTS + captions + stitch from the scenes already in demo/out/scenes
#   bash demo/build/build.sh --record             record every non-pending scene first
#   bash demo/build/build.sh --record study,x402  re-record just those scenes first
#   bash demo/build/build.sh --captions soft      soft subtitle track instead of burned-in (also: none)
#   DEMO_VOICE=Ava bash demo/build/build.sh       another macOS voice (say -v '?' lists them)
# Output: demo/out/deltadesk-demo.mp4 (+ demo/out/deltadesk-demo.srt)
set -euo pipefail
DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEMO"

CAPTIONS=burn
RECORD=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --captions) CAPTIONS="$2"; shift 2 ;;
    --record)
      if [[ $# -gt 1 && "$2" != --* ]]; then RECORD="$2"; shift 2; else RECORD="all"; shift; fi ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

for bin in node ffmpeg ffprobe say; do command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }; done
if [[ ! -d node_modules/playwright ]]; then npm install --silent && npx playwright install chromium; fi

echo "== beats (demo/script.md)"
node build/beats.mjs
if [[ -n "$RECORD" ]]; then
  echo "== record"
  if [[ "$RECORD" == all ]]; then node record/run.mjs; else node record/run.mjs --scenes "$RECORD"; fi
fi
echo "== narration"
node build/tts.mjs
echo "== captions"
node build/srt.mjs
echo "== stills"
if [[ "$CAPTIONS" == burn ]]; then node build/render.mjs; else node build/render.mjs --no-captions; fi
echo "== stitch"
node build/stitch.mjs --captions "$CAPTIONS"
echo "== check"
ffprobe -v error -show_entries format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate -of compact out/deltadesk-demo.mp4
