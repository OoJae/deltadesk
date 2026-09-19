import { ViewTransition, type CSSProperties } from "react";
import { Button } from "@/components/brand/Button";
import { CONTAINER } from "@/components/brand/Container";
import { Guilloche } from "@/components/brand/Guilloche";
import { Label } from "@/components/brand/Label";
import { Serial } from "@/components/brand/Serial";
import { Stat } from "@/components/brand/Stat";
import { ACTS, type Act } from "./acts";
import { ReliefMount } from "./ReliefMount";
import { ReliefPoster } from "./ReliefPoster";

const BOOK_ID = "the-book";
const i = (n: number) => ({ "--i": n }) as CSSProperties;

/**
 * The hero and the five-act scene share one sticky stage: the engraved relief sits at rest beside the headline,
 * then plays the real Sep 11–14 2026 weekend as the acts scroll over it.
 */
export function EngravedBook() {
  return (
    <div id={BOOK_ID} className="book">
      <div className="book-track">
        <div className="book-stage">
          <ReliefPoster className="book-poster" />
          <ReliefMount bookId={BOOK_ID} />
        </div>
      </div>
      <div className="book-content">
        <Hero />
        <section aria-labelledby="weekend-title">
          <h2 id="weekend-title" className="sr-only">
            The weekend of Sep 11–14 2026 on the NVDA/USDG pool, in five acts
          </h2>
          <p className="sr-only">
            The relief behind these panels is the NVDA/USDG pool&apos;s real on-chain liquidity, summed from every open position every 30 minutes
            from Friday Sep 11 16:00 to Monday Sep 14 09:45 Eastern: one engraved ridge per moment, Friday at the back. A paper line marks the pool
            price and a red line the Hyperliquid-derived fair value. Each act below describes one stretch of that weekend.
          </p>
          <ol className="book-acts">
            {ACTS.map((a) => (
              <li key={a.n} className="book-act" data-act={a.n}>
                <div className={`book-panel ${CONTAINER} pointer-events-none motion-reduce:py-3`}>
                  <ActPanel act={a} />
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative flex min-h-[calc(100svh-4rem)] flex-col">
      <div aria-hidden="true" className="pointer-events-none absolute inset-1.5 md:inset-4">
        {/* 10 px band on phones (so the five-line headline keeps its measure), 14 px from md: see --hero-frame. */}
        <Guilloche variant="border" width={14} opacity={0.42} style={{ borderWidth: "var(--hero-frame)" }} />
      </div>
      <div className={`${CONTAINER} relative flex flex-1 flex-col justify-start pb-28 pt-12 md:justify-center md:pb-24 md:pt-10`}>
        {/* Phones: the frame's band ends 16 px in (inset 6 + band 10), so the copy starts at 24 px, 8 px clear of it. */}
        <div data-hero-copy className="px-2 md:pl-6 md:pr-0">
          <Label as="p" tone="dim" className="dd-hero-fade" style={i(0)}>
            The open market-making desk for tokenized stocks
          </Label>
          <ViewTransition name="page-title" share="title-morph" default="none">
            <h1 id="hero-title" className="mt-5 font-display text-hero text-paper md:mt-7" style={{ fontSize: "var(--hero-fs)" }}>
              <span className="dd-hero-line">
                <span style={i(0)}>Market making</span>
              </span>
              <span className="dd-hero-line">
                <span style={i(1)}>stocks was a</span>
              </span>
              <span className="dd-hero-line">
                <span style={i(2)}>closed club.</span>
              </span>
              <span className="dd-hero-line">
                <span style={i(3)}>
                  <span className="tracking-[-0.13em]">W</span>e published
                </span>
              </span>
              <span className="dd-hero-line">
                <span style={i(4)}>
                  its <em className="italic">books</em>.
                </span>
              </span>
            </h1>
          </ViewTransition>
          <p className="dd-hero-fade mt-6 max-w-[40ch] text-body text-paper-dim md:mt-8" style={i(1)}>
            Every swap in Robinhood Chain&apos;s stock pools, marked against the price that never closes.
          </p>
          <div className="dd-hero-fade mt-7 flex flex-wrap items-center gap-3 md:mt-9" style={i(2)}>
            <Button href="/tearsheet" size="lg" trailing="→">
              Check your LP
            </Button>
            <Button href="/desk" prefetch={false} variant="ghost" size="lg" className="bg-vault">
              Start a desk
            </Button>
          </div>
        </div>
      </div>
      <div className={`${CONTAINER} dd-hero-fade absolute inset-x-0 bottom-7 flex items-end justify-between gap-6 md:bottom-10`} style={i(3)}>
        <p data-hero-copy className="pl-2 font-mono text-[0.72rem] uppercase tracking-[0.08em] text-paper-mute md:pl-6">
          <Serial n="4663" /> · NVDA/USDG · replay Sep 11–14
        </p>
        <p className="flex items-center gap-3 pr-2 font-mono text-[0.72rem] uppercase tracking-[0.08em] text-paper-mute md:pr-0">
          <span className="hidden sm:inline">The weekend, in five acts</span>
          <span aria-hidden="true" className="dd-cue-line" />
        </p>
      </div>
    </section>
  );
}

function ActPanel({ act }: { act: Act }) {
  const t = act.title.indexOf(act.italic);
  return (
    <article aria-labelledby={`act-${act.n}`} className="pointer-events-auto w-full max-w-[26.5rem] border border-rule bg-vault">
      <header className="flex items-center justify-between gap-4 border-b border-rule px-5 py-3.5 md:px-7">
        <Serial n={act.n} pad={2} className="text-[0.8rem]" />
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.08em] text-paper-dim">{act.time}</span>
      </header>
      <div className="px-5 pb-5 pt-5 md:px-7 md:pb-7 md:pt-7">
        <h3 id={`act-${act.n}`} className="font-display text-[clamp(2rem,3.2vw,3.1rem)] leading-[0.98] tracking-[-0.02em] text-paper">
          {t < 0 ? (
            act.title
          ) : (
            <>
              {act.title.slice(0, t)}
              <em className="italic">{act.italic}</em>
              {act.title.slice(t + act.italic.length)}
            </>
          )}
        </h3>
        <p className="mt-3 text-[0.95rem] leading-[1.55] text-paper-dim md:mt-4 md:text-body">{act.body}</p>
        {act.n === 1 ? (
          <ul className="mt-4 hidden flex-wrap gap-x-5 gap-y-1.5 font-mono text-[0.7rem] uppercase tracking-[0.06em] text-paper-mute md:flex">
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="h-px w-5 bg-paper" /> Pool price
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="h-px w-5 bg-serial" /> Fair value (Hyperliquid)
            </li>
            <li>Hairline: liquidity per 10 ticks</li>
          </ul>
        ) : null}
        <Stat
          className="mt-5 border-t border-rule pt-4 md:mt-6 md:pt-5"
          size="md"
          label={act.stat.label}
          value={act.stat.value}
          unit={act.stat.unit}
          caption={act.stat.caption}
          tone={act.stat.tone}
        />
      </div>
    </article>
  );
}
