"use client";

import { useState } from "react";
import { Button } from "@/components/brand/Button";
import { Label } from "@/components/brand/Label";
import { Reveal } from "@/components/brand/Reveal";
import { useStamp } from "@/components/brand/StampToast";

/** Live demos for the motion spec: press, reveal, stamp. */
export function MotionDemos() {
  const [take, setTake] = useState(0);
  const { stamp } = useStamp();
  return (
    <div className="grid border border-rule md:grid-cols-3">
      <Demo label="Press · 0.24 s" note="Scale .97 on press; a guilloché sheen sweeps the face in 0.3 s. Focus is a 2 px serial ring.">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Press and hold</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
        </div>
      </Demo>
      <Demo
        label="Reveal · 0.8 s, stagger 0.08 s"
        note="Each line rises out of its own mask, once, as it nears the viewport."
        action={
          <Button variant="ghost" size="sm" onClick={() => setTake((t) => t + 1)}>
            Replay
          </Button>
        }
      >
        <Reveal key={take} as="p" className="max-w-[28ch] text-[1.35rem] leading-[1.3] text-paper">
          A $1k always-in-range LP paid $4.24 to informed flow and earned $3.32 in fees.
        </Reveal>
      </Demo>
      <Demo label="Stamp · on sign, approve, submit" note="An engraved stamp presses onto the page, holds for five seconds and lifts. Screen readers hear it.">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => stamp({ kind: "signed", title: "Delegation signed", detail: "Demo · lane A 0x7f89…d662", serial: "0xddbc1b92" })}
          >
            Sign
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => stamp({ kind: "approved", title: "Rerange approved", detail: "Demo · NVDA/USDG, ±100 ticks around fair", serial: "0xbe80e98b" })}
          >
            Approve
          </Button>
          <Button size="sm" variant="ghost" onClick={() => stamp({ kind: "submitted", title: "Exit submitted", detail: "Demo · every position back to the owner" })}>
            Submit
          </Button>
        </div>
      </Demo>
    </div>
  );
}

function Demo({ label, note, action, children }: { label: string; note: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[18rem] flex-col justify-between gap-8 border-rule p-6 not-last:border-b md:p-8 md:not-last:border-r md:not-last:border-b-0">
      <div className="flex items-center justify-between gap-4">
        <Label>{label}</Label>
        {action}
      </div>
      <div>{children}</div>
      <p className="max-w-[40ch] text-[0.9rem] leading-relaxed text-paper-dim">{note}</p>
    </div>
  );
}
