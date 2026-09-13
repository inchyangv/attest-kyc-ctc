# Deck

`deck.html` is the source. `proofmark-deck.pdf` and `slides/*.png` are rendered from it.

Current version: **2026-09-07 submission deck**, 13 slides, for the BUIDL CTC 2026 Fall form and
the CEIP conversation that follows it. The story runs: problem → product → what the demo shows →
one mark two policies → architecture → security → operations → why Creditcoin → business →
competition → team → ask. Team, market and the ask live here and in the DoraHacks text, not in
the two-minute video.

Every number on a slide has a source in the repository (test counts from `npm test` and
`npm run test:ts`, sanctions counts from the built index, timings from
`docs/16-propagation-observations.md`, hashes from the README). Update the HTML, re-render, and
commit both; a rendered deck whose PDF disagrees with its source is worse than no deck.

```sh
node docs/deck/render.mjs              # all 13 slides plus the PDF
node docs/deck/render.mjs --only 6,11  # just those PNGs; the PDF always rewrites
```

Rendering uses the system Chrome through Playwright, so no chromium download is needed.

Design follows `web/DESIGN.md`: white canvas, one blue for action, black plate with mint reserved
for the cover and the three divider slides (5, 9, 13).
