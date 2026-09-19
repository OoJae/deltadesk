"use client";

import { useEffect, useRef, type CSSProperties, type ElementType, type ReactNode } from "react";

export type RevealProps = {
  children: ReactNode;
  /** Element to render. Default "div". Put the heading inside, or render as the heading: <Reveal as="h2">. */
  as?: ElementType;
  /**
   * "lines" (default): each line rises out of its own mask (gsap SplitText), 0.8 s, stagger 0.08 s.
   * "block": the whole element rises and fades in. Use for non-text (figures, panels).
   */
  mode?: "lines" | "block";
  /** Seconds before it starts once in view. */
  delay?: number;
  className?: string;
  style?: CSSProperties;
  id?: string;
};

/**
 * Line-mask reveal that fires once, when the element nears the viewport. Transform/opacity only.
 * Reduced motion: rendered immediately, no animation. Without JS: rendered immediately (the pre-hide lives in
 * a `scripting: enabled` media query). gsap and SplitText load on demand, only on pages that use Reveal.
 */
export function Reveal({ children, as: Tag = "div", mode = "lines", delay = 0, className, style, id }: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const show = () => el.setAttribute("data-reveal", "done");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      show();
      return;
    }
    let cancelled = false;
    let cleanup = () => {};
    (async () => {
      try {
        const [{ gsap }, { SplitText }] = await Promise.all([import("gsap"), import("gsap/SplitText")]);
        gsap.registerPlugin(SplitText);
        if (mode === "lines") await document.fonts?.ready;
        if (cancelled) return;
        let tween: gsap.core.Tween | null = null;
        let split: SplitText | null = null;
        if (mode === "lines") {
          split = SplitText.create(el, {
            type: "lines",
            mask: "lines",
            linesClass: "dd-reveal-line",
            autoSplit: true,
            onSplit(self) {
              const progress = tween?.progress() ?? 0;
              const played = tween ? tween.isActive() || progress > 0 : false;
              tween?.kill();
              tween = gsap.from(self.lines, { yPercent: 108, duration: 0.8, ease: "expo.out", stagger: 0.08, delay, paused: true });
              if (played) tween.progress(progress).play();
            },
          });
        } else {
          tween = gsap.from(el, { y: 28, opacity: 0, duration: 0.8, ease: "expo.out", delay, paused: true });
        }
        show();
        const io = new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting)) {
              tween?.play();
              io.disconnect();
            }
          },
          { rootMargin: "0px 0px -10% 0px" },
        );
        io.observe(el);
        cleanup = () => {
          io.disconnect();
          tween?.kill();
          split?.revert();
        };
      } catch {
        show();
      }
    })();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [mode, delay]);

  return (
    <Tag ref={ref} id={id} data-reveal="pending" className={className} style={style}>
      {children}
    </Tag>
  );
}
