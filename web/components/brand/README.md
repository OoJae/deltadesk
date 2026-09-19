# DeltaDesk brand kit: "Engraved Certificate"

The world is the engraved share certificate, the ancestor of a tokenized stock: guilloché rosettes, hairline
engraving, security borders, red serial numbers, the embossed seal, plus ledger ruling. Thesis line:
**"Market making stocks was a closed club. We published its books."**

Live brand book: `/brand`. Tokens: `app/globals.css`. Files: `public/brand/*` (served at `/brand/*`).
Everything in this folder is typed; import each component from its own file (there is no barrel, on purpose:
client bundles only pull what they use).

```tsx
import { Button } from "@/components/brand/Button";
import { PageHeader } from "@/components/brand/PageHeader";
```

## Rules that are not optional

1. **One accent, rationed.** `serial` (#E4472B) marks the certificate serial (N°), fair value, the gap, the one
   primary action per view, and focus. Never decoration, links, or "negative" numbers.
2. **Bodoni Moda only for hero and section titles** (`font-display`, via `PageHeader`). Never for UI, labels or data.
   Italic marks the one word that matters.
3. **Every number is IBM Plex Mono, tabular** (`font-mono tabular`, or the `num` class, or `Stat`).
4. **"N°" only where the sequence is true**: the weekend's five acts in time order, and the chain id 4663.
5. **Motion animates transform and opacity only.** Reduced motion is handled globally (everything instant);
   JS-driven motion must also check `prefersReducedMotion()` from `tokens.ts`.
6. **Copy**: sentence case, specific, from the reader's side, real numbers with their source. No hype, no yield or
   profit claims. The disclaimer is "Informational analytics, not investment advice".
7. Square corners, hairlines (`border-rule`), no shadows except the stamp toast, no gradients, no glow, no glass.
8. `/desk` links always pass `prefetch={false}` (the wallet SDK stays lazy under /desk).

## Tokens (Tailwind 4 roles)

| Role | Class examples | Value | Contrast |
|---|---|---|---|
| vault (page) | `bg-vault` | #0A0D0C | |
| vault-2 (panels) | `bg-vault-2` | #131816 | |
| vault-3 (inputs, hover) | `bg-vault-3` | #1B211E | |
| paper (primary ink) | `text-paper`, `bg-paper` | #EDE6D6 | 15.70:1 on vault |
| paper-dim (secondary) | `text-paper-dim` | #A7A293 | 7.65:1 on vault |
| paper-mute (captions) | `text-paper-mute` | #8F8A7C | 5.67:1 on vault, 4.75:1 on vault-3 |
| rule (hairline, 14%) | `border-rule`, `bg-rule` | rgba(237,230,214,.14) | |
| rule-strong (28%) | `border-rule-strong` | rgba(237,230,214,.28) | |
| serial (accent) | `text-serial`, `bg-serial` | #E4472B | 4.87:1 on vault |
| serial-ink (text on serial) | `text-serial-ink` | #0A0D0C | 4.87:1 (paper on serial is 3.23: never) |

Legacy names still work and are remapped onto the brand: `--page`, `--surface-1/2`, `--text-primary/secondary/muted`,
`--grid`, `--axis`, `--ring`, `--accent` (= serial), `bg-page`, `bg-surface-1/2`, `text-ink`, `text-ink-2`,
`text-muted`, `border-grid`. `.card` is restyled as a square hairline panel; prefer `LedgerPanel` in new code.

**Charts** (validated with the dataviz validator, dark mode, on vault and vault-2, all pairs):
`--series-1` #3987E5 (blue), `--series-2` #199E70 (aqua), `--series-3` #C98500 (yellow). The reference orange was
dropped: it is indistinguishable from serial (ΔE 3.6). Fair value / the gap inside a chart is `var(--serial)`.
Never put `series-3` and a serial mark in the same chart. Diverging: `--div-pos-1..4` (blue), `--div-neg-1..4` (red),
`--div-mid`. Status (reserved, always with icon + label): `--good`, `--warning`, `--serious`, `--critical`.

**Type**: `font-display` (Bodoni Moda, opsz auto), `font-body` / `font-sans` (Instrument Sans, `font-condensed`
= wdth 85), `font-mono` (IBM Plex Mono). Scale utilities: `text-hero` (clamp 3–9.5rem / .92 / −0.02em),
`text-section` (clamp 2.25–5rem / .98), `text-title` (clamp 1.5–2.25rem / 1.1), `text-body` (clamp 1–1.15rem / 1.6),
`text-label`. The `label` utility = Plex Mono .72rem, +0.08em, uppercase, 500.

**Motion**: `--ease-out` cubic-bezier(0.16,1,0.3,1) (gsap `"expo.out"`), `--ease-inout` cubic-bezier(0.65,0,0.35,1);
`--dur-micro` .24s, `--dur-reveal` .8s, `--dur-page` 1.2s, `--stagger` .08s. Tailwind `ease-out` uses the brand curve.

**Engraving utilities** (static tiles): `security-border` (16px border-image frame), `guilloche-rule` (12px woven
rule), `hatch` (45° tint). Tables: `.ledger-table` (hairline rows, mono header labels; add `className="n"` to
right-align numeric `td`/`th`). `.ledger-ruled` puts a hairline between direct children.

**Layout**: `CONTAINER` / `<Container>` = `mx-auto w-full max-w-[90rem] px-4 md:px-8` (nav and footer use it).

**JS tokens** (`tokens.ts`): `INK` (hex), `SERIES`, `rgb(hex)` for shaders, `MOTION`, `CHAIN_SERIAL`,
`prefersReducedMotion()`.

## Components

### `PageHeader` (server)
```tsx
<PageHeader
  label="The Truth Study · Robinhood Chain"   // mono label
  title="Can LPs beat informed flow?"          // Bodoni
  italic="informed flow"                       // substring set in italic
  serial="01"                                  // optional N°, only when the sequence is true
  lede={<p>…</p>}                              // paper-dim, max 62ch
  actions={<Button href="/tearsheet">Check your LP</Button>}
  size="section"                               // "section" (default) | "hero"
  as="h1"                                      // "h1" (default) | "h2"
  transitionName="page-title"                  // default for h1; false to opt out; must be unique per page
/>
```
One h1 PageHeader per page: its title is the shared element that morphs between pages. Use `as="h2"` for section
headers inside a page (no transition name).

### `LedgerPanel` (server): replaces `.card`
```tsx
<LedgerPanel label="Flow X-ray" title="Who takes LP money" serial={undefined} actions={<Button size="sm" variant="ghost">CSV</Button>}
  ruled tone="raised" inset>
  …rows…
</LedgerPanel>
```
Props: `as` (default `section`), `label`, `title` (Instrument Sans, not Bodoni), `titleAs` ("h2"|"h3"|"h4"),
`serial`, `actions`, `ruled` (hairline between children), `tone` ("raised" vault-2 | "flat"), `inset` (padding,
default true; false for edge-to-edge `.ledger-table`), `className`, `bodyClassName`, `aria-label`, `id`.

### `Button` (server-safe, works in client components)
```tsx
<Button>Save</Button>                                   // <button type="button">
<Button href="/tearsheet" trailing="→">Check your LP</Button>   // next/link
<Button href="/desk" prefetch={false}>Start a desk</Button>      // /desk: always prefetch={false}
<Button href="https://explorer…" variant="link" trailing="↗">View tx</Button>  // external <a target=_blank>
```
`variant`: "primary" (serial fill, vault ink; one per view) | "ghost" (hairline) | "link" (underlined).
`size`: "sm" 36px | "md" 44px | "lg" 56px. `trailing`: glyph after the label. Press = scale .97 + guilloché
sheen (0.3s); focus = 2px serial ring. All native button/anchor props pass through (`onClick`, `disabled`, `type`…).
`buttonClass(variant, size, className)` returns the class string for custom elements (e.g. a `<label>`).

### `Label`, `Serial`, `Stat` (server)
```tsx
<Label as="dt" tone="mute">Pool mid</Label>        // tone: mute | dim | paper | serial
<Serial n={1} pad={2} />                            // "N° 01" (sr: "Number 01"); tone: serial | dim
<Stat label="Picked off" value="$267k" unit="USDG" caption="Within an hour of the swap" size="lg" tone="paper" />
```
`Stat` sizes: md 1.75rem, lg 2.75rem, xl clamp(3rem,6vw,5.5rem). `tone="serial"` only when the number is the gap.

### `Seal` (server) and `DeltaMark` (client-safe, tiny)
```tsx
<Seal size={520} draw title="The Delta Seal" className="h-auto w-full max-w-[34rem]" />  // full seal (~60 KB inline)
<Seal variant="compact" size={32} />                       // = DeltaMark
<DeltaMark variant="seal" size={32} className="text-paper" />   // "seal" | "delta" | "solid" (favicon)
```
The full seal draws non-scaling hairlines, so it reads at any size; `draw` engraves it in (rings turn in, then the
nine Δ strokes land, stagger 0.08s; off under reduced motion). `tone`: "paper" (default) | "vault". Use the full
seal where it is the subject (hero, brand book); in chrome use `DeltaMark`. For a static image use
`/brand/seal-paper.svg` (stroke weights tuned for 200–600px).

### `Wordmark` (server)
`<Wordmark size="1.4rem" tone="paper" />`: live text, Bodoni Moda 600, "Desk" italic. Files: `/brand/wordmark-*.svg`.

### `Guilloche` (server-safe): the engraving kit
```tsx
<div className="relative"><Guilloche variant="border" width={14} opacity={0.5} />…</div>  // frame overlay (absolute inset-0)
<Guilloche variant="rosette" size={320} petals={60} turns={23} reach={40} layers={2} />
<Guilloche variant="divider" ornament />
<Guilloche variant="hatch" angle={45} gap={6} className="h-24" />   // 45 | 135 (| 0 | 90 for ledger ruling)
```
All accept `tone` ("paper" | "vault" | "serial"), `opacity`, `className`, `style`. Always aria-hidden.
The math is in `geometry.ts` (`loopChain`, `roseWave`, `hypotrochoid`, `rosettePaths`, `deltaStrokes`,
`waveBand`, `securityBorderSvg`, `dividerTileSvg`, `hatchTileSvg`, `svgDataUri`, `curvePath`); use it for any new
engraved graphic (e.g. the landing's hairline relief can take `curvePath`).

### `StampToast` (client): confirmation for sign / approve / submit
```tsx
"use client";
import { useStamp } from "@/components/brand/StampToast";
const { stamp } = useStamp();
stamp({ kind: "signed", title: "Delegation signed", detail: "Lane A · operator 0x…", serial: txHash, href: explorerUrl });
```
`kind`: signed | approved | submitted | revoked | recorded. `serial` is shown shortened in red on the stamp's rim.
`duration` ms (default 5200; 0 = until dismissed). `<StampProvider>` is already mounted in `app/layout.tsx`.
Announced via an `aria-live="polite"` status region. `StampMark` exports the stamp graphic alone.

### `Reveal` (client)
```tsx
<Reveal as="h2" className="font-display text-section">We published its <em>books</em>.</Reveal>
<Reveal mode="block" delay={0.1}><figure>…</figure></Reveal>
```
Line-mask reveal (gsap SplitText, loaded on demand), once, when the element nears the viewport; 0.8s, stagger
0.08s. Text is pre-hidden only when scripts run and motion is allowed (never lost without JS).

### `SmoothScroll` (client)
`<SmoothScroll />` or `<SmoothScroll scrollTrigger />` (Lenis driven by gsap's ticker + ScrollTrigger.update).
**Only on `/` and `/brand`.** Off under reduced motion; destroyed on navigation. Add `data-lenis-prevent` to
scrollable overlays.

### Nav, footer, transitions (`components/nav/`, mounted by `app/layout.tsx`)
- `SiteNav`: compact seal + wordmark, links (`links.ts`: Study, Live desk, Tearsheet, League, Console, Brand) and the
  "Start a desk" CTA. Below `lg` a full-screen certificate sheet (focus trap, Esc, focus return).
- `SiteFooter`: seal, thesis, map, data sources, the disclaimer, N° 4663.
- `RouteTransition` (via `app/template.tsx`): React `<ViewTransition>` with `enter="page-enter" exit="page-exit"`.
  The outgoing page lifts and fades (0.6s), the incoming rises (0.8s); the nav is anchored (`site-nav`), the nav seal
  stamps (`site-seal`), the footer waits for the new page (`site-footer`), and each h1 `PageHeader` title morphs
  (`page-title`, class `title-morph`). Reserved view-transition names: `site-nav`, `site-seal`, `site-footer`,
  `page-title`. Page files don't need their own wrapper.
- Skip link targets `#content`. Layout provides no `<main>`: each page renders its own `<main>`.

## Files (`web/scripts/brand/`)
- `generate.mjs`: `node scripts/brand/generate.mjs` writes every SVG to `public/brand/` and `../brand/`, plus
  `seal-data.ts`, `mark-data.ts` and `app/icon.svg`. Deterministic, Node only (≥ 22.18, type stripping).
- `rasterize.mjs`: `node scripts/brand/rasterize.mjs` renders `app/apple-icon.png`, `app/favicon.ico` and
  `public/brand/png/*` with headless Chromium (dev-time Playwright from `demo/node_modules`).
- `ttf.mjs`: a tiny TrueType reader (glyf outlines + GPOS kerning) that outlines the type in the marks.
- `fonts/`: static OFL instances used for outlining and the share card (`app/opengraph-image.tsx`).
