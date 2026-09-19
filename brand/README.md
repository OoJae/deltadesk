# DeltaDesk brand kit

Generated files (do not edit by hand). Source of truth: `web/scripts/brand/generate.mjs` (vectors) and
`web/scripts/brand/rasterize.mjs` (PNGs), both reading `web/components/brand/geometry.ts`.
The live brand book, with rules, contrast ratios and motion, is the site's `/brand` page; the component API is
`web/components/brand/README.md`.

- `seal-{paper,vault}.svg`: the Delta Seal (guilloché band, micro-text, 9-stroke Δ). Paper ink for dark grounds, vault ink for paper.
- `seal-compact-*.svg`, `delta-*.svg`: the compact seal and the bare 3-stroke Δ (from 20 px).
- `favicon.svg`, `app-icon.svg`, `png/`: icons.
- `wordmark-*.svg`, `lockup-horizontal-*.svg`, `lockup-stacked-*.svg`: outlined Bodoni Moda 600, "Desk" in italic.
- `pattern-security-border.svg` (9-slice, `border-image: url(…) 24 round`), `pattern-divider.svg`, `pattern-hatch.svg`, `rosette-*.svg`.

Colours: vault #0A0D0C, paper #EDE6D6, serial #E4472B (the only accent).
