// Minimal React DOM driver for the component tests (happy-dom): render, click by text, advance fake timers, all
// inside act() so every effect and poll settles before the next assertion.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type Mounted = {
  el: HTMLElement;
  text: () => string;
  /** Title of the wizard step marked aria-current="step", or null when none is active. */
  activeStep: () => string | null;
  button: (label: string | RegExp) => HTMLButtonElement | null;
  click: (label: string | RegExp) => Promise<void>;
  clickEl: (target: Element | null) => Promise<void>;
  unmount: () => void;
};

export async function mount(node: ReactNode): Promise<Mounted> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(el);
    root.render(node);
  });
  const clickEl = async (target: Element | null) => {
    if (!target) throw new Error("nothing to click");
    await act(async () => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const button = (label: string | RegExp) =>
    [...el.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? ""))) ?? null;
  return {
    el,
    text: () => el.textContent ?? "",
    activeStep: () => el.querySelector("[aria-current=step] h3")?.textContent ?? null,
    button,
    click: async (label) => {
      const b = button(label);
      if (!b) throw new Error(`no button ${String(label)}`);
      await clickEl(b);
    },
    clickEl,
    unmount: () => {
      act(() => root?.unmount());
      el.remove();
    },
  };
}

/** Advances vitest's fake clock by `ms`, running due timers and the promises they start. */
export async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
