# Proofmark design system

Dark only. One canvas, one panel step, hairline structure, one mint accent.
Tokens: `app/globals.css`. Primitives: `components/ui/`. Internal catalogue with every primitive rendered: `/design`
(not linked from the app, returns 404 in production).

## Why it looks the way it does

The first pass mirrored the Creditcoin explorer's light Chakra theme and flipped it for dark. The result was a row of
translucent cards on a translucent canvas, muddy tinted bands and values that changed size from tile to tile — the
generic "generated UI" look. This pass keeps what was Creditcoin-native (mint on black, Poppins title, explorer-style
detail rows and tables) and rebuilds the structure around fixed columns and line boxes so nothing is ragged.

## Rules

1. **One container.** Every box is `.panel`: `surface` fill, 1px `line`, 6px radius. No stacked translucent fills, no 12px radius, no shadows.
2. **One accent.** Mint (`#B3FCB2`) is the only chromatic accent: primary button, active nav marker, focus ring, link hover, claim tags. Status has three hues (`ok` / `warn` / `bad`) and nothing else is coloured. Blue is not used.
3. **Fixed columns.** Detail labels are 176px. Bit numbers are a 64px right-aligned mono column. Verdict tags in policy rows are 72px. Stat cells are equal and split by hairlines.
4. **Line boxes.** Table rows 40px, table heads 36px, group rows 32px, inputs and buttons 36px, tags 24px on a 24px line, page-header aside on the 32px title line. Labels and values share a baseline.
5. **Same-shaped rows are a table.** Two things being compared sit side by side in equal-height cards with the footer pinned to the bottom of both.
6. **Hashes go through `<Hash>`**: mono, copyable, truncated by default, full where it matters, underlined only when they link out.
7. **Status is a tag in a table and a dot in a sentence.** `<Tag>` inside rows; `<Status>` (dot + word) where the value must sit on the baseline of its neighbours (stat cells, verdict row).
8. **Silence over guesses.** An unset bit is "Not run", in muted text. The UI never implies a check that did not happen.

## Tokens

canvas `#0D0E11` · surface `#14161A` · surface-2 `#1C1F25` · sunk `#0A0B0D`
line `white 8%` · line-strong `white 16%` · divider `white 6%`
fg-strong `#F2F3F5` · fg `white 74%` · fg-muted `#8A8F98` · fg-subtle `#5C616A`
mint `#B3FCB2` · mint-hover `#C9FFC8` · mint-fg `#0B1A0C` · mint-tint `mint 10%` · focus = mint
ok `#6EE7A8` / `ok 12%` · warn `#F6B64B` / `warn 12%` · bad `#FF6F6F` / `bad 12%`
radius 4 · 6 · 8

## Type

Inter everywhere; Poppins only for the page title (26/32 · 600 · tight). Body 14/20. Rows and detail values 13/20.
Labels 12/16 · 500 muted. Eyebrows 11/16 · 600 · caps · +8%. Mono (`.mono`) 12px, tabular, for hashes, hex, revisions and timestamps.

## Primitives

`PageHeader` · `Section` · `Eyebrow` · `Stats`/`Stat` · `Tag` · `Status` · `Band` · `Button`/`LinkButton` · `Field`/`Input` · `DetailList`/`DetailRow` · `Hash` · `Icon`/`CreditcoinMark` · `Mark`/`Wordmark`

Adding one: use only semantic utilities (`bg-surface`, `text-fg-muted`, …), give it a fixed line box, put it in
`components/ui/`, render it once on `/design`, and keep the count on that page honest.

## Checking alignment

`node shot.mjs` (dev server on :3000) screenshots the two demo screens to `/tmp` and asserts the policy split.
Look at the full-page shots at 1440px and 390px; the things that go wrong are a column that stops being fixed-width,
a value that changes size between cells, and a label that wraps.
