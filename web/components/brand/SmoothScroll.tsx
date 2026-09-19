"use client";

import { useLayoutEffect } from "react";

export type SmoothScrollProps = {
  /** Drive gsap's ScrollTrigger from Lenis (one RAF: gsap.ticker). Turn on when the page scrubs with ScrollTrigger. */
  scrollTrigger?: boolean;
};

/** Shared by both drivers. stopInertiaOnNavigate: clicking a same-origin link to another path halts the glide at once. */
const OPTIONS = { lerp: 0.11, wheelMultiplier: 0.95, stopInertiaOnNavigate: true } as const;

/**
 * Lenis smooth scroll for the two pages that earn it: / (the Engraved Book) and /brand. Data pages scroll natively.
 * Render once per page: <SmoothScroll scrollTrigger />. Off under reduced motion.
 *
 * Teardown is a layout effect on purpose. React runs layout-effect cleanups of the outgoing page in the mutation
 * phase, before Next scrolls the incoming page to the top in the layout phase. A passive (useEffect) cleanup runs
 * after that scroll, so a glide still in flight would write the old page's position onto the new one: scroll the
 * landing, click "Study" and /study would open 2.8k px down. Two guards, then: the click halts the glide
 * (stopInertiaOnNavigate), and the instance plus its gsap ticker callback are gone before Next scrolls.
 */
export function SmoothScroll({ scrollTrigger = false }: SmoothScrollProps) {
  useLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cancelled = false;
    let cleanup = () => {};
    (async () => {
      const { default: Lenis } = await import("lenis");
      if (cancelled) return;
      if (!scrollTrigger) {
        const lenis = new Lenis({ ...OPTIONS, autoRaf: true });
        cleanup = () => lenis.destroy();
        return;
      }
      const [{ gsap }, { ScrollTrigger }] = await Promise.all([import("gsap"), import("gsap/ScrollTrigger")]);
      if (cancelled) return;
      gsap.registerPlugin(ScrollTrigger);
      const lenis = new Lenis({ ...OPTIONS, autoRaf: false });
      lenis.on("scroll", ScrollTrigger.update);
      const tick = (time: number) => lenis.raf(time * 1000);
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);
      cleanup = () => {
        gsap.ticker.remove(tick);
        lenis.destroy();
      };
    })();
    return () => {
      cancelled = true;
      cleanup();
      cleanup = () => {};
    };
  }, [scrollTrigger]);
  return null;
}
