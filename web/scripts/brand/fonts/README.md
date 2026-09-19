# Fonts for outlining and the share card

Static instances fetched from the Google Fonts CSS API (`fonts.googleapis.com/css2`), all under the SIL Open Font
License 1.1 (redistribution permitted):

| File | Family | Instance | Used for |
|---|---|---|---|
| BodoniModa-Mark-600(-Italic).ttf | Bodoni Moda | opsz 36, wght 600 | outlined wordmark and lockups |
| BodoniModa-Display-500(-Italic).ttf | Bodoni Moda | opsz 96, wght 500 | share-card headline |
| IBMPlexMono-500.ttf / -400.ttf | IBM Plex Mono | 500 / 400 | seal micro-text, serials |
| InstrumentSans-500.ttf | Instrument Sans | wght 500 | share-card body |

The site itself loads the variable families through `next/font/google` (app/layout.tsx); these files are only read
by `generate.mjs` and `components/brand/og.tsx`.
