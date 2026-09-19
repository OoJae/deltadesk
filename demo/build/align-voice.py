#!/usr/bin/env python3
"""Align ONE continuous voiceover take to the script, cut it into per-beat files and time the captions from the
words actually spoken.

    uv run --with mlx-whisper python demo/build/align-voice.py "<take.m4a>"

It transcribes the take with word timestamps (Whisper via MLX, Apple Silicon), matches those words to each beat's
narration in script.md (numbers are ignored when matching: the script spells them out, the transcript digitises
them), then writes:
    demo/voice/<beat-id>.m4a   one file per beat, cut on its first and last spoken word
    demo/voice/align.json      each beat's cut start plus every matched word in beat-local seconds
`demo/build/srt.mjs` reads align.json and times each caption cue from those words instead of by character share.
Then rebuild with `bash demo/build/build.sh` (no --record needed).
"""
import json
import re
import subprocess
import sys
from pathlib import Path

DEMO = Path(__file__).resolve().parents[1]
NUMW = set(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen"
    " seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million"
    " billion percent point dollars dollar cents cent".split()
)


def norm(w: str) -> str:
    return re.sub(r"[^a-z0-9']", "", w.lower())


def keep(w: str) -> bool:
    n = norm(w)
    return bool(n) and n not in NUMW and not re.fullmatch(r"[0-9][0-9.,]*", n)


def beats() -> list[dict]:
    """The effective beat list (id, narration, duration) straight from script.md."""
    out = subprocess.run(
        ["node", "--input-type=module", "-e",
         "import {loadBeats, loadConfig} from './demo/build/beats.mjs';"
         "const c=await loadConfig();const b=await loadBeats(c);"
         "console.log(JSON.stringify(b.map(x=>({id:x.id,text:x.text,duration:x.duration}))))"],
        cwd=DEMO.parent, capture_output=True, text=True, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


def transcribe(src: Path) -> list[dict]:
    import mlx_whisper  # noqa: PLC0415  (optional dependency, only needed here)

    wav = DEMO / "out" / "voice-align.wav"
    wav.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-ac", "1", "-ar", "16000", str(wav)], check=True)
    r = mlx_whisper.transcribe(str(wav), path_or_hf_repo="mlx-community/whisper-small.en-mlx",
                               word_timestamps=True, verbose=False)
    return [{"w": w["word"].strip(), "s": w["start"], "e": w["end"]}
            for seg in r["segments"] for w in seg.get("words", [])]


def main(src: Path) -> int:
    import difflib

    bs, asr = beats(), transcribe(src)
    script = [(bi, wi, w) for bi, b in enumerate(bs) for wi, w in enumerate((b["text"] or "").split())]
    sk = [(i, norm(w)) for i, (_, _, w) in enumerate(script) if keep(w)]
    ak = [(j, norm(a["w"])) for j, a in enumerate(asr) if keep(a["w"])]
    sm = difflib.SequenceMatcher(a=[x[1] for x in sk], b=[y[1] for y in ak], autojunk=False)
    pair = {sk[a + k][0]: ak[b + k][0] for a, b, n in sm.get_matching_blocks() for k in range(n)}
    print(f"matched {len(pair)} of {len(sk)} content words")

    total = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                  str(src)], capture_output=True, text=True, check=True).stdout)
    spans = []
    for bi, b in enumerate(bs):
        idx = [gi for gi, (bb, _, _) in enumerate(script) if bb == bi and gi in pair]
        spans.append(None if not idx else
                     {"start": asr[pair[idx[0]]]["s"], "end": asr[pair[idx[-1]]]["e"],
                      "words": [{"wi": script[gi][1], "s": asr[pair[gi]]["s"], "e": asr[pair[gi]]["e"]} for gi in idx]})

    voice = DEMO / "voice"
    voice.mkdir(exist_ok=True)
    align = {}
    for i, (b, sp) in enumerate(zip(bs, spans)):
        if sp is None:  # a beat whose words never matched (e.g. a one-word title): take the run-up to the next beat
            nxt = next((s for s in spans[i + 1:] if s), None)
            st, en = (0.0, max(0.6, nxt["start"] - 0.20)) if i == 0 else (0.0, 0.0)
            if en <= st:
                print(f"  {b['id']}: no words matched, skipped")
                continue
            words = []
        else:
            prev = next((spans[j]["end"] for j in range(i - 1, -1, -1) if spans[j]), 0.0)
            nxt = next((spans[j]["start"] for j in range(i + 1, len(spans)) if spans[j]), total)
            st = max(prev + 0.05, sp["start"] - 0.14)
            en = min(nxt - 0.05, sp["end"] + 0.28, total)
            words = [{"wi": w["wi"], "s": round(w["s"] - st, 3), "e": round(w["e"] - st, 3)} for w in sp["words"]]
        dst = voice / f"{b['id']}.m4a"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{st:.3f}", "-to", f"{en:.3f}", "-i", str(src),
                        "-c:a", "aac", "-b:a", "192k", str(dst)], check=True)
        align[b["id"]] = {"cutStart": round(st, 3), "words": words}
        print(f"  {b['id']:<20} {st:7.2f} → {en:7.2f}  ({en - st:5.1f}s vs beat {b['duration']}s)")
    (voice / "align.json").write_text(json.dumps(align, indent=1) + "\n")
    print(f"wrote {len(align)} beat takes and voice/align.json; now run: bash demo/build/build.sh")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(Path(sys.argv[1]).resolve()))
