import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Button } from "@/components/brand/Button";
import { contrast, grade } from "@/components/brand/contrast";
import { DeltaMark } from "@/components/brand/DeltaMark";
import { Guilloche } from "@/components/brand/Guilloche";
import { Label } from "@/components/brand/Label";
import { LedgerPanel } from "@/components/brand/LedgerPanel";
import { PageHeader } from "@/components/brand/PageHeader";
import { Seal } from "@/components/brand/Seal";
import { Serial } from "@/components/brand/Serial";
import { SmoothScroll } from "@/components/brand/SmoothScroll";
import { Stat } from "@/components/brand/Stat";
import { INK, SERIES } from "@/components/brand/tokens";
import { Wordmark } from "@/components/brand/Wordmark";
import { MotionDemos } from "./MotionDemos";

export const metadata: Metadata = {
  title: "Brand book · DeltaDesk",
  description: "The DeltaDesk brand book: the engraved certificate, the Delta Seal, colour with measured contrast, type, the engraving kit, motion, and downloads.",
};

const W = "mx-auto w-full max-w-[90rem] px-4 md:px-8";

const SWATCHES = [
  { name: "Vault", token: "--vault", hex: INK.vault, role: "The page. Engraving ink: black with a green cast.", on: INK.paper, onName: "paper" },
  { name: "Vault 2", token: "--vault-2", hex: INK.vault2, role: "Raised panels, table stripes.", on: INK.paper, onName: "paper" },
  { name: "Paper", token: "--paper", hex: INK.paper, role: "Primary ink: the certificate stock. Never pure white.", on: INK.vault, onName: "vault" },
  { name: "Paper dim", token: "--paper-dim", hex: INK.paperDim, role: "Secondary text.", on: INK.vault, onName: "vault" },
  { name: "Paper mute", token: "--paper-mute", hex: INK.paperMute, role: "Captions, labels, axis text.", on: INK.vault, onName: "vault" },
  { name: "Serial", token: "--serial", hex: INK.serial, role: "The one accent: fair value, the gap, the primary action, focus.", on: INK.vault, onName: "vault" },
] as const;

const DOWNLOADS: { group: string; files: { href: string; name: string; note: string }[] }[] = [
  {
    group: "Seal",
    files: [
      { href: "/brand/seal-paper.svg", name: "seal-paper.svg", note: "Full seal, paper ink, for dark grounds" },
      { href: "/brand/seal-vault.svg", name: "seal-vault.svg", note: "Full seal, vault ink, for paper grounds" },
      { href: "/brand/png/seal-paper-1024.png", name: "seal-paper-1024.png", note: "1024 px, transparent" },
      { href: "/brand/seal-compact-paper.svg", name: "seal-compact-paper.svg", note: "Compact seal (nav, 24 px and up)" },
      { href: "/brand/seal-compact-vault.svg", name: "seal-compact-vault.svg", note: "Compact seal, vault ink" },
      { href: "/brand/delta-paper.svg", name: "delta-paper.svg", note: "The bare 3-stroke Δ" },
    ],
  },
  {
    group: "Wordmark and lockups",
    files: [
      { href: "/brand/wordmark-paper.svg", name: "wordmark-paper.svg", note: "Outlined Bodoni Moda 600 · Desk in italic" },
      { href: "/brand/wordmark-vault.svg", name: "wordmark-vault.svg", note: "Vault ink" },
      { href: "/brand/lockup-horizontal-paper.svg", name: "lockup-horizontal-paper.svg", note: "Compact seal + wordmark" },
      { href: "/brand/lockup-horizontal-vault.svg", name: "lockup-horizontal-vault.svg", note: "Vault ink" },
      { href: "/brand/lockup-stacked-paper.svg", name: "lockup-stacked-paper.svg", note: "Full seal over wordmark and line" },
      { href: "/brand/lockup-stacked-vault.svg", name: "lockup-stacked-vault.svg", note: "Vault ink" },
    ],
  },
  {
    group: "Icons",
    files: [
      { href: "/brand/favicon.svg", name: "favicon.svg", note: "Solid Didone Δ on the vault, 16–32 px" },
      { href: "/brand/app-icon.svg", name: "app-icon.svg", note: "Seal band and Δ, no micro-text" },
      { href: "/brand/png/app-icon-512.png", name: "app-icon-512.png", note: "512 px" },
      { href: "/opengraph-image", name: "opengraph-image.png", note: "1200 × 630 share card" },
    ],
  },
  {
    group: "Engraving",
    files: [
      { href: "/brand/pattern-security-border.svg", name: "pattern-security-border.svg", note: "9-slice tile: border-image 24 round" },
      { href: "/brand/pattern-divider.svg", name: "pattern-divider.svg", note: "Woven rule, repeat-x" },
      { href: "/brand/pattern-hatch.svg", name: "pattern-hatch.svg", note: "Engraver's tint, 45°" },
      { href: "/brand/rosette-paper.svg", name: "rosette-paper.svg", note: "Spirograph rosette, R 60 · r 23 · d 40" },
    ],
  },
];

export default function BrandPage() {
  return (
    <main>
      <SmoothScroll />

      {/* ---------------------------------------------------------------------------------------------- Hero */}
      <section className={W}>
        <div className="relative mt-6 mb-4 md:mt-8">
          <Guilloche variant="border" width={14} opacity={0.5} />
          <div className="relative grid items-center gap-12 px-6 pt-14 pb-20 md:px-12 md:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:gap-8 lg:px-16 lg:pb-24">
            <PageHeader
              label="Brand book · Engraved Certificate · v1, September 2026"
              title="Before the token, the certificate."
              italic="certificate."
              lede={
                <p>
                  A stock was a sheet of engraved paper before it was a token: guilloché rosettes, a security border, a red serial number, an embossed
                  seal. DeltaDesk takes that paper&apos;s discipline for an open market-making desk. This book holds the rules and the files.
                </p>
              }
              actions={
                <>
                  <Button href="#downloads" trailing="↓">
                    Download the kit
                  </Button>
                  <Button href="#mark" variant="ghost">
                    Read the rules
                  </Button>
                </>
              }
            />
            <div className="flex justify-center lg:justify-end">
              <Seal draw size={520} title="The Delta Seal" className="h-auto w-full max-w-[34rem]" />
            </div>
          </div>
          <div className="absolute inset-x-8 bottom-6 hidden items-center justify-between md:flex">
            <Label>
              <Serial n="4663" /> · Robinhood Chain
            </Label>
            <Label>Paper · Vault · Serial</Label>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------------------------------------- Story */}
      <Section id="story">
        <PageHeader
          as="h2"
          label="Why the certificate"
          title="Market making stocks was a closed club. We published its books."
          italic="books."
          lede={
            <p>
              The desk that quotes a stock has always kept its book to itself. On Robinhood Chain the book is public by construction: every swap, every
              range, every fee. DeltaDesk reads it, marks it to the 24/7 price, and hands you a desk of your own. So the brand borrows from the paper a
              share was before it became a token, and from the ledger the specialist kept.
            </p>
          }
        />
        <div className="mt-16 grid border-y border-rule md:grid-cols-3">
          {[
            {
              name: "Vault, the ink",
              hex: INK.vault,
              body: "Engraving ink is black with a green cast: the colour of a plate that has printed ten thousand certificates. It is the page. Panels step up to vault-2, never to grey.",
            },
            {
              name: "Paper, the stock",
              hex: INK.paper,
              body: "Certificate stock is cream, never white. Everything we say is printed in it; secondary text is the same paper, dimmed, so the page reads as one sheet.",
            },
            {
              name: "Serial, the one red",
              hex: INK.serial,
              body: "Red is rationed like a serial number: the chain serial, fair value and the gap between pool and fair, the one action per view, the focus ring. Nothing decorative is ever red.",
            },
          ].map((x) => (
            <div key={x.name} className="space-y-5 border-rule p-6 not-last:border-b md:p-8 md:not-last:border-r md:not-last:border-b-0">
              <span className="block h-10 w-10 rounded-full border border-rule-strong" style={{ background: x.hex }} aria-hidden="true" />
              <h3 className="text-[1.3rem] font-medium text-paper">{x.name}</h3>
              <p className="max-w-[38ch] leading-relaxed text-paper-dim">{x.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ---------------------------------------------------------------------------------------------- Mark */}
      <Section id="mark">
        <PageHeader
          as="h2"
          label="The mark"
          title="A delta, engraved in nine strokes."
          italic="nine strokes."
          lede={
            <p>
              One script draws the Delta Seal from real curves, so every copy is exact. The Δ is cut the way a Didone would cut it, hairline on the left,
              heavy on the right and base, except that the weight is made of engraved lines instead of ink.
            </p>
          }
        />

        <div className="mt-16 grid gap-px border border-rule bg-rule lg:grid-cols-[1.1fr_0.9fr]">
          <div className="flex items-center justify-center bg-paper p-8 md:p-14">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/seal-vault.svg" alt="The Delta Seal in vault ink on paper" width={440} height={440} className="h-auto w-full max-w-[440px]" loading="lazy" />
          </div>
          <dl className="ledger-ruled bg-vault">
            {[
              ["Band", "Three prolate epitrochoids 120° apart, 48 loops each: x = 227.5 cos t + 13.2 cos 49t."],
              ["Legend", "OPEN MARKET-MAKING DESK above, ROBINHOOD CHAIN below, in IBM Plex Mono 500 outlined on the ring."],
              ["Serial", "N° 4663 is the chain id: the one number on the seal, and the only red."],
              ["Lace", "Two rose waves, r = 166.5 + 2.6 sin 90θ, half a wave apart."],
              ["Δ", "Nine nested strokes, inset 0.9 left, 3.7 right, 3.1 base per stroke, with a seven-wave guilloché that tapers to nothing at the corners."],
            ].map(([k, v]) => (
              <div key={k} className="grid grid-cols-[7rem_1fr] gap-4 px-6 py-5 md:px-8">
                <dt className="label pt-1 text-paper-mute">{k}</dt>
                <dd className="leading-relaxed text-paper-dim">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Compact marks at size */}
        <div className="mt-6 grid gap-px border border-rule bg-rule sm:grid-cols-3">
          {[
            { label: "Compact seal", sizes: [48, 32, 24], el: (s: number) => <DeltaMark variant="seal" size={s} className="text-paper" /> },
            { label: "Δ", sizes: [48, 32, 24], el: (s: number) => <DeltaMark variant="delta" size={s} className="text-paper" /> },
            { label: "Favicon", sizes: [48, 32, 16], el: (s: number) => <FaviconTile size={s} /> },
          ].map((row) => (
            <div key={row.label} className="space-y-6 bg-vault p-6 md:p-8">
              <Label>{row.label}</Label>
              <div className="flex items-end gap-8">
                {row.sizes.map((s) => (
                  <figure key={s} className="flex flex-col items-center gap-3">
                    {row.el(s)}
                    <figcaption className="font-mono text-[0.7rem] text-paper-mute">{s}px</figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Clear space + lockups */}
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <LedgerPanel label="Clear space and minimum size" tone="flat">
            <div className="flex flex-col items-center gap-6 py-6">
              <div className="relative">
                <Guilloche variant="hatch" gap={7} opacity={0.22} className="absolute -inset-[34px] border border-dashed border-rule-strong" />
                <div className="relative flex items-center gap-3 bg-vault px-1">
                  <DeltaMark variant="seal" size={44} className="text-paper" />
                  <Wordmark size="1.9rem" />
                </div>
              </div>
              <p className="mt-6 max-w-[46ch] text-center text-[0.9rem] leading-relaxed text-paper-dim">
                Keep the height of the seal free on every side (the hatched field). The compact seal holds from 20 px, the horizontal lockup from 96 px
                wide, the full seal from 96 px.
              </p>
            </div>
          </LedgerPanel>
          <div className="grid gap-px border border-rule bg-rule">
            <div className="flex items-center justify-center bg-vault p-10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/lockup-horizontal-paper.svg" alt="Horizontal lockup, paper on vault" className="h-12 w-auto" loading="lazy" />
            </div>
            <div className="flex items-center justify-center bg-paper p-10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/lockup-horizontal-vault.svg" alt="Horizontal lockup, vault on paper" className="h-12 w-auto" loading="lazy" />
            </div>
          </div>
        </div>

        {/* Misuse */}
        <div className="mt-6 grid gap-px border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-4">
          <Misuse note="Don't recolour the mark. Paper or vault ink only; red belongs to the serial.">
            <DeltaMark variant="seal" size={56} style={{ color: SERIES[0] }} />
          </Misuse>
          <Misuse note="Don't stretch, skew or rotate it.">
            <div style={{ transform: "scaleX(1.55)" }} className="flex items-center gap-2">
              <DeltaMark variant="seal" size={34} className="text-paper" />
              <Wordmark size="1.2rem" />
            </div>
          </Misuse>
          <Misuse note="Don't add glow, gradients or bevels. It is engraved, not lit.">
            <Wordmark size="1.9rem" style={{ textShadow: "0 0 18px #3987e5, 0 0 4px #fff" }} />
          </Misuse>
          <Misuse note="Don't reset the wordmark in another face.">
            <span className="text-[1.7rem] font-bold tracking-tight text-paper">DeltaDesk</span>
          </Misuse>
        </div>
      </Section>

      {/* ---------------------------------------------------------------------------------------------- Colour */}
      <Section id="colour">
        <PageHeader
          as="h2"
          label="Colour"
          title="Two inks and a serial number."
          italic="serial number."
          lede={<p>Contrast is measured, not eyeballed: each ratio below is computed from the tokens this page is built with (WCAG 2.x).</p>}
        />
        <div className="mt-16 grid gap-px border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-3">
          {SWATCHES.map((s) => {
            const r = contrast(s.on, s.hex);
            const onVault = s.hex === INK.vault || s.hex === INK.vault2 ? null : contrast(s.hex, INK.vault);
            return (
              <div key={s.token} className="bg-vault">
                <div className="flex h-40 items-end justify-between p-5" style={{ background: s.hex, color: s.on }}>
                  <span className="font-display text-[2.6rem] leading-none">Aa</span>
                  <span className="font-mono text-[0.72rem]">
                    {s.onName} {r.toFixed(2)}:1
                  </span>
                </div>
                <div className="space-y-2 p-5">
                  <div className="flex items-baseline justify-between gap-4">
                    <h3 className="text-[1.05rem] font-medium text-paper">{s.name}</h3>
                    <span className="font-mono text-[0.78rem] text-paper-dim">{s.hex}</span>
                  </div>
                  <p className="text-[0.9rem] leading-relaxed text-paper-dim">{s.role}</p>
                  <p className="font-mono text-[0.72rem] text-paper-mute">
                    {s.token}
                    {onVault != null ? ` · on vault ${onVault.toFixed(2)}:1 · ${grade(onVault)}` : ` · paper on it ${r.toFixed(2)}:1 · ${grade(r)}`}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1fr]">
          <LedgerPanel label="Hairline" tone="flat">
            <div className="space-y-4">
              <div className="h-px w-full" style={{ background: "var(--rule)" }} />
              <p className="text-[0.9rem] leading-relaxed text-paper-dim">
                <span className="font-mono text-paper">--rule</span> is paper at 14%: every border, table rule and engraving stroke at rest. It is a
                hairline, so it carries structure, never meaning. Stronger rules use 28%.
              </p>
            </div>
          </LedgerPanel>
          <LedgerPanel label="Charts on the vault" tone="flat">
            <div className="flex flex-wrap items-center gap-5">
              {[...SERIES.map((c, i) => ({ c, n: `series-${i + 1}` })), { c: INK.serial, n: "serial (fair)" }].map((x) => (
                <span key={x.n} className="flex items-center gap-2 font-mono text-[0.75rem] text-paper-dim">
                  <span className="h-3 w-6" style={{ background: x.c }} aria-hidden="true" />
                  {x.n}
                </span>
              ))}
            </div>
            <p className="mt-4 text-[0.9rem] leading-relaxed text-paper-dim">
              The validated dark steps, checked on vault and vault-2 with the palette validator: blue, aqua, yellow pass every pair (worst CVD ΔE 8.4).
              The reference orange is dropped because it cannot be told from serial red (ΔE 3.6). Serial draws fair value inside a chart; it never sits
              beside yellow.
            </p>
          </LedgerPanel>
        </div>
      </Section>

      {/* ---------------------------------------------------------------------------------------------- Type */}
      <Section id="type">
        <PageHeader
          as="h2"
          label="Type"
          title="Engraved for titles, set for reading, tabular for money."
          italic="tabular"
          lede={<p>Three families, each with one job. Display type never sets UI or data; every number is mono.</p>}
        />
        <div className="mt-16 grid gap-px border border-rule bg-rule">
          <Specimen family="Bodoni Moda" role="Display · hero and section titles only" meta="Variable · opsz 6–96 · wght 400–900 · italic">
            <p className="font-display text-[clamp(3rem,9vw,8.5rem)] leading-[0.9] tracking-[-0.02em] text-paper">
              The books, <em>published.</em>
            </p>
            <p className="mt-6 max-w-[60ch] text-[0.95rem] leading-relaxed text-paper-dim">
              A Didone, because certificates were engraved in one: hairline serifs, vertical stress. Optical size follows the point size, so the hero
              gets the sharpest hairlines. The word that matters goes italic. Tracking −0.02em.
            </p>
          </Specimen>
          <Specimen family="Instrument Sans" role="Body · interface and prose" meta="Variable · wdth 75–100 · wght 400–700">
            <div className="grid gap-8 md:grid-cols-[1.3fr_1fr]">
              <p className="max-w-[52ch] text-body text-paper">
                Chainlink freezes at 20:00 on Friday and the market closes on-chain. The pool keeps trading. By Sunday the gap between the pool and fair
                value is 52.6 bp, and whoever quotes inside it is paying for someone else&apos;s information.
              </p>
              <div className="space-y-2">
                {[75, 87.5, 100].map((w) => (
                  <p key={w} className="flex items-baseline justify-between gap-4 border-b border-rule pb-2">
                    <span className="text-[1.6rem] font-medium text-paper uppercase" style={{ fontStretch: `${w}%`, letterSpacing: "0.04em" }}>
                      Ledger
                    </span>
                    <span className="font-mono text-[0.72rem] text-paper-mute">wdth {w}</span>
                  </p>
                ))}
              </div>
            </div>
          </Specimen>
          <Specimen family="IBM Plex Mono" role="Utility · tickers, serials, addresses, every number" meta="400 · 500 · tabular figures">
            <div className="grid gap-8 md:grid-cols-3">
              <Stat label="Volume, all pools" value="$952M" caption="Tabular figures keep columns honest." />
              <Stat label="Largest weekend gap" value="52.6" unit="bp" tone="serial" caption="Serial red because this number is the gap." />
              <div className="space-y-2 font-mono text-[0.85rem] text-paper-dim">
                <p>NVDA/USDG</p>
                <p>0xddbc1b92…</p>
                <p className="text-paper">
                  <Serial n="01" /> Fri 16:00 close
                </p>
              </div>
            </div>
          </Specimen>
        </div>

        <div className="mt-6 overflow-x-auto border border-rule">
          <table className="ledger-table min-w-[44rem]">
            <thead>
              <tr>
                <th>Role</th>
                <th>Size / leading</th>
                <th>Family</th>
                <th>Sample</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["hero", "clamp(3rem, 8.5vw, 9.5rem) / 0.92", "Bodoni Moda", <span key="h" className="font-display text-[2.4rem] leading-none">Hero</span>],
                ["section", "clamp(2.25rem, 5vw, 5rem) / 0.98", "Bodoni Moda", <span key="s" className="font-display text-[1.8rem] leading-none">Section</span>],
                ["title", "clamp(1.5rem, 2.4vw, 2.25rem) / 1.1", "Instrument Sans", <span key="t" className="text-[1.4rem] leading-none font-medium">Panel title</span>],
                ["body", "clamp(1rem, 1.05vw, 1.15rem) / 1.6", "Instrument Sans", <span key="b">Body copy, from the reader&apos;s side.</span>],
                ["label", ".72rem · +0.08em · uppercase", "IBM Plex Mono", <span key="l" className="label text-paper-dim">Label</span>],
              ].map(([role, size, fam, sample]) => (
                <tr key={String(role)}>
                  <td className="font-mono text-[0.8rem] text-paper">{role}</td>
                  <td className="font-mono text-[0.8rem] text-paper-dim">{size}</td>
                  <td className="text-[0.9rem] text-paper-dim">{fam}</td>
                  <td className="text-paper">{sample}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ---------------------------------------------------------------------------------------------- Engraving */}
      <Section id="engraving">
        <PageHeader
          as="h2"
          label="Engraving kit"
          title="Security printing, as components."
          italic="as components."
          lede={<p>Everything is generated from the curve, not drawn: rosette, border, rule and tint are functions you can call with other numbers.</p>}
        />
        <div className="mt-16 grid gap-px border border-rule bg-rule md:grid-cols-2">
          <KitCell name="Rosette" code={`<Guilloche variant="rosette" />`} note="Hypotrochoid: R 60, r 23, d 40, plus a copy at 0.62× turned half a lobe.">
            <Guilloche variant="rosette" size={260} opacity={0.6} />
          </KitCell>
          <KitCell name="Security border" code={`<Guilloche variant="border" />`} note="Three sines woven between two hairlines, rosettes at the corners. A 9-slice border-image: any size, no JS.">
            <div className="relative h-[260px] w-full max-w-[420px]">
              <Guilloche variant="border" width={16} opacity={0.6} />
              <div className="absolute inset-0 flex items-center justify-center">
                <Serial n="4663" />
              </div>
            </div>
          </KitCell>
          <KitCell name="Divider" code={`<Guilloche variant="divider" ornament />`} note="The woven rule between sections, with an optional rosette knot.">
            <Guilloche variant="divider" ornament opacity={0.6} className="w-full max-w-[420px]" />
          </KitCell>
          <KitCell name="Hatch" code={`<Guilloche variant="hatch" angle={45} />`} note="Engraver's tint for blocked or out-of-range areas. 45° and its 135° mirror only.">
            <div className="grid w-full max-w-[420px] grid-cols-2 gap-3">
              <Guilloche variant="hatch" angle={45} opacity={0.45} className="h-28 border border-rule" />
              <Guilloche variant="hatch" angle={135} opacity={0.45} className="h-28 border border-rule" />
            </div>
          </KitCell>
        </div>
      </Section>

      {/* ---------------------------------------------------------------------------------------------- Motion */}
      <Section id="motion">
        <PageHeader
          as="h2"
          label="Motion"
          title="Pressed, not bounced."
          italic="Pressed,"
          lede={<p>Motion is a press, a line rising out of its mask, a page lifting off the stack. Only transform and opacity move. Reduced motion makes all of it instant.</p>}
        />
        <div className="mt-16 grid gap-px border border-rule bg-rule md:grid-cols-2 lg:grid-cols-4">
          <EaseCell name="--ease-out" curve={[0.16, 1, 0.3, 1]} use="Everything that arrives: reveals, pages, stamps." />
          <EaseCell name="--ease-inout" curve={[0.65, 0, 0.35, 1]} use="Things that travel and return: the sheen, the seal press." />
          <div className="space-y-4 bg-vault p-6 lg:col-span-2">
            <Label>Durations</Label>
            <ul className="ledger-ruled">
              {[
                ["0.24 s", "micro", "press, hover, menus"],
                ["0.6 s", "page out", "the old page lifts and fades"],
                ["0.8 s", "reveal", "lines, the new page rising in"],
                ["1.2 s", "hero", "the seal engraving itself"],
                ["0.08 s", "stagger", "between lines and strokes"],
              ].map(([t, n, u]) => (
                <li key={n} className="grid grid-cols-[4.5rem_6rem_1fr] items-baseline gap-3 py-2.5">
                  <span className="font-mono text-[0.95rem] text-paper">{t}</span>
                  <span className="label text-paper-mute">{n}</span>
                  <span className="text-[0.9rem] text-paper-dim">{u}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-6">
          <MotionDemos />
        </div>
      </Section>

      {/* ---------------------------------------------------------------------------------------------- Voice */}
      <Section id="voice">
        <PageHeader
          as="h2"
          label="Voice"
          title="Specific, from the reader's side."
          italic="Specific,"
          lede={<p>Sentence case. Real numbers with their source. No promise of returns: this is informational analytics, not investment advice.</p>}
        />
        <div className="mt-16 grid gap-px border border-rule bg-rule md:grid-cols-2">
          <div className="space-y-4 bg-vault p-6 md:p-8">
            <Label tone="dim">Write</Label>
            <ul className="ledger-ruled text-[1.05rem] leading-relaxed text-paper">
              <li className="py-3">A $1k always-in-range LP paid $4.24 to informed flow and earned $3.32 in fees.</li>
              <li className="py-3">Risk-adding is blocked on-chain from Saturday 00:00 to Monday 01:00 UTC.</li>
              <li className="py-3">Check your LP.</li>
            </ul>
          </div>
          <div className="space-y-4 bg-vault p-6 md:p-8">
            <Label tone="dim">Not</Label>
            <ul className="ledger-ruled text-[1.05rem] leading-relaxed text-paper-mute line-through decoration-rule-strong">
              <li className="py-3">Unlock next-gen yield on tokenized equities.</li>
              <li className="py-3">Our AI-powered engine maximizes your returns.</li>
              <li className="py-3">Get Started Now!</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------------------------------------- Downloads */}
      <Section id="downloads">
        <PageHeader
          as="h2"
          label="Downloads"
          title="The files."
          italic="files."
          lede={
            <p>
              Every file is generated by <span className="font-mono text-[0.9em] text-paper">web/scripts/brand/generate.mjs</span> from the same geometry
              the components use. Type is outlined, so nothing depends on installed fonts.
            </p>
          }
        />
        <div className="mt-16 grid gap-6 lg:grid-cols-2">
          {DOWNLOADS.map((g) => (
            <LedgerPanel key={g.group} label={g.group} inset={false} tone="flat">
              <ul className="ledger-ruled">
                {g.files.map((f) => (
                  <li key={f.href}>
                    <a href={f.href} download={f.href.startsWith("/brand/") ? "" : undefined} className="group flex items-baseline justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-vault-2 md:px-6">
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-[0.85rem] text-paper group-hover:underline group-hover:decoration-rule-strong group-hover:underline-offset-4">
                          {f.name}
                        </span>
                        <span className="block text-[0.85rem] text-paper-dim">{f.note}</span>
                      </span>
                      <span aria-hidden="true" className="font-mono text-[0.85rem] text-paper-mute group-hover:text-paper">
                        ↓
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </LedgerPanel>
          ))}
        </div>
      </Section>
    </main>
  );
}

function Section({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section id={id} className={`${W} scroll-mt-20 border-t border-rule py-24 md:py-32`}>
      {children}
    </section>
  );
}

function FaviconTile({ size }: { size: number }) {
  return (
    <span className="grid place-items-center rounded-[22%] bg-vault-3 text-paper" style={{ width: size, height: size }}>
      <DeltaMark variant="solid" size={Math.round(size * 0.86)} />
    </span>
  );
}

function Misuse({ note, children }: { note: string; children: ReactNode }) {
  return (
    <figure className="relative flex min-h-[13rem] flex-col justify-between gap-6 overflow-hidden bg-vault p-6">
      <div className="relative flex min-h-[7rem] flex-1 items-center justify-center">
        <div className="opacity-80">{children}</div>
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
          <line x1="8" y1="92" x2="92" y2="8" stroke="var(--paper-mute)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <figcaption className="relative text-[0.85rem] leading-snug text-paper-dim">
        <span className="label mr-2 text-paper">Don&apos;t</span>
        {note.replace(/^Don't /, "")}
      </figcaption>
    </figure>
  );
}

function Specimen({ family, role, meta, children }: { family: string; role: string; meta: string; children: ReactNode }) {
  return (
    <div className="bg-vault p-6 md:p-10">
      <div className="mb-8 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-4">
        <h3 className="text-[1.15rem] font-medium text-paper">
          {family} <span className="ml-2 text-paper-dim">{role}</span>
        </h3>
        <span className="font-mono text-[0.72rem] text-paper-mute">{meta}</span>
      </div>
      {children}
    </div>
  );
}

function KitCell({ name, code, note, children }: { name: string; code: string; note: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-8 bg-vault p-6 md:p-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-[1.15rem] font-medium text-paper">{name}</h3>
        <code className="font-mono text-[0.75rem] text-paper-mute">{code}</code>
      </div>
      <div className="flex min-h-[260px] items-center justify-center">{children}</div>
      <p className="max-w-[48ch] text-[0.9rem] leading-relaxed text-paper-dim">{note}</p>
    </div>
  );
}

function EaseCell({ name, curve, use }: { name: string; curve: [number, number, number, number]; use: string }) {
  const [x1, y1, x2, y2] = curve;
  const P = (x: number, y: number) => `${8 + x * 104} ${112 - y * 104}`;
  return (
    <div className="space-y-4 bg-vault p-6">
      <Label>{name}</Label>
      <svg viewBox="0 0 120 120" className="h-36 w-36" aria-label={`Easing curve cubic-bezier(${curve.join(", ")})`} role="img">
        <path d="M8 112 H112 M8 112 V8" stroke="var(--rule-strong)" strokeWidth="0.6" fill="none" />
        <path d={`M${P(0, 0)} L${P(x1, y1)} M${P(1, 1)} L${P(x2, y2)}`} stroke="var(--rule-strong)" strokeWidth="0.6" strokeDasharray="2 2" fill="none" />
        <path d={`M${P(0, 0)} C${P(x1, y1)} ${P(x2, y2)} ${P(1, 1)}`} stroke="var(--paper)" strokeWidth="1.4" fill="none" />
        <circle cx={8 + x1 * 104} cy={112 - y1 * 104} r="2" fill="var(--paper-dim)" />
        <circle cx={8 + x2 * 104} cy={112 - y2 * 104} r="2" fill="var(--paper-dim)" />
      </svg>
      <p className="font-mono text-[0.72rem] text-paper-mute">cubic-bezier({curve.join(", ")})</p>
      <p className="text-[0.9rem] leading-relaxed text-paper-dim">{use}</p>
    </div>
  );
}
