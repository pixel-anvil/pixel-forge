# Built-in palette presets

Each preset is a palette whose colours come from a Lospec `.hex` file, never typed by hand.

## Layout

- `sources/<slug>.hex` is the downloaded Lospec file: one 6-digit hex colour per line, in file order.
  The slug is the Lospec palette slug, fetched from `https://lospec.com/palette-list/<slug>.hex`.
- `<id>.ts` (one per palette) exports a `PalettePreset` with `id` (the slug), `name`, `source` (the
  Lospec page URL), `author`, `license` (licence text from the source page, or
  `not stated on source page`) and `hex`.
- `types.ts` defines the `PalettePreset` interface.
- `index.ts` exports every preset, `PRESETS` (display order) and `presetToPalette(preset, id, name?)`,
  which converts hex values into a schema `Palette` (RGBA8 tuples, alpha 255, `ramps: []`).

## Rules

- Colours are copied from `sources/<slug>.hex` (lower-cased, trimmed), in file order.
- `hex` values are 6-digit lower-case hex with no leading `#`.
- Preset ids are unique and equal the Lospec slug.
- `test/presets.test.ts` checks every `hex` list against its source file and checks that
  `presetToPalette` output parses with the schema `Palette`.
