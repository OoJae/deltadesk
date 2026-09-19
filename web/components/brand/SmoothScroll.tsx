"use client";

import { useEffect } from "react";

export type SmoothScrollProps = {
  /** Drive gsap's ScrollTrigger from Lenis (one RAF: gsap.ticker). Turn on when the page scrubs with ScrollTrigger. */
  scrollTrigger?: boolean;
};

/**
 * Lenis smooth scroll for the two pages that earn it: / (the Engraved Book) and /brand. Data pages scroll natively.
 * Render once per page: <SmoothScroll scrollTrigger />. Off under reduced motion. Cleans up on navigation.
 */
export function SmoothScroll({ scrollTrigger = false }: SmoothScrollProps) {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cancelled = false;
    let cleanup = () => {};
    (async () => {
      const { default: Lenis } = await import("lenis");
      if (cancelled) return;
      if (!scrollTrigger) {
        const lenis = new Lenis({ autoRaf: true, lerp: 0.11, wheelMultiplier: 0.95 });
        cleanup = () => lenis.destroy();
        return;
      }
      const [{ gsap }, { ScrollTrigger }] = await Promise.all([import("gsap"), import("gsap/ScrollTrigger")]);
      if (cancelled) return;
      gsap.registerPlugin(ScrollTrigger);
      const lenis = new Lenis({ autoRaf: false, lerp: 0.11, wheelMultiplier: 0.95 });
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
    };
  }, [scrollTrigger]);
  return null;
}
