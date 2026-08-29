# Proofmark design system

Reference: the Creditcoin block explorer (https://creditcoin.blockscout.com, Blockscout on Chakra UI).
Live catalogue with every primitive rendered: `/design`. Tokens: `app/globals.css`. Primitives: `components/ui/`.

## What we took from the explorer

| Trait | Explorer | Proofmark |
|---|---|---|
| Canvas | white, light by default; dark via toggle | same: `--canvas`, `data-theme="dark"` |
| Fills | gray.50 tiles with no border | `bg-surface` (`StatCard`, form panels) |
| Action colour | blue.600 links, solid blue buttons, 2px outline secondary | `link`, `accent`, `Button` |
| Brand moment | black plate, Poppins title in mint `#B3FCB2` | `Plate` + `text-mint`, nowhere else |
| Status | tinted tags, dark text of the same hue (`Contract call`, `Token transfer`) | `Tag` tones blue / green / orange / red / gray |
| Data | gray.100 table head, rounded top corners, 14/500 cells, hairlines | `.tbl` |
| Detail pages | fixed label column, hairline rows, copy buttons on hashes | `DetailRow`, `Hash` |
| Message strip | pale band ("scanning new transactions…") | `Band` tones note / info / ok / warn / bad |
| Chrome | 36px utility bar + 229px sidebar with 24px outline icons | `TopBar`, `Sidebar`, `Icon` |
| Type | Inter body, Poppins titles (32/500), sizes 12·14·16·18·32 | `--font-sans`, `--font-display` |
| Shape | 4 · 8 · 12 px | `rounded-sm` · `rounded-md` · `rounded-lg` |

## Rules

1. **Fill, don't outline.** Panels are `bg-surface` with no border. Borders: inputs (2px `line`), list containers (1px `line`). Never both.
2. **Blue is the only action colour.** Only clickable things are blue.
3. **Mint lives on black.** Never as a fill, tint or border on the canvas.
4. **Status is a tag.** No coloured borders, glows or gradients.
5. **Hashes go through `<Hash>`:** monospace, copyable, linked to the explorer when they live there.
6. **Same-shaped rows are a table.** Two things being compared sit side by side (`/onchain` policies).
7. **Silence over guesses.** An unset bit is "Not run", in muted text.

## Tokens (light / dark)

canvas `#FFF / #101112` · surface `#F7FAFC / white 6%` · surface-2 `#EDF2F7 / white 8%` · line `#E2E8F0 / white 10%` · divider `ink 6% / white 8%`
fg-strong `#101112 / #FFF` · fg `ink 80% / white 80%` · fg-muted `#718096 / #A0AEC0` · fg-subtle `#A0AEC0 / #718096`
link `#2B6CB0 / #63B3ED` · accent `#2B6CB0` · accent-tint `#EBF8FF / #2A4365` · focus `#4299E1 / #63B3ED`
plate `#000` · mint `#B3FCB2`
ok `#38A169` / ok-tint `#F0FFF4 / #22543D` · warn `#DD6B20` / warn-tint `#FFFAF0 / #7B341E` · bad `#E53E3E` / bad-tint `#FFF5F5 / #822727` · note-tint `#FFFAF0 / orange 44%`

## Adding a component

Use only semantic tokens (`bg-surface`, `text-fg-muted`, …). Put it in `components/ui/`, render it once on `/design`, and keep the count on that page honest.
