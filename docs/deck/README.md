# Deck

`deck.html` is the source. `proofmark-deck.pdf` and `slides/*.png` are rendered from it.

```sh
node docs/deck/render.mjs              # all 13 slides plus the PDF
node docs/deck/render.mjs --only 6,11  # just those PNGs; the PDF always rewrites
```

Rendering uses the system Chrome through Playwright, so no chromium download is needed.

Edit the HTML, re-render, and commit both. A deck whose PDF disagrees with its source is worse
than no deck, which is why the renderer lives here rather than in a scratch directory.

Design follows `web/DESIGN.md`: white canvas, one blue for action, black plate with mint reserved
for the cover and the two divider slides.
