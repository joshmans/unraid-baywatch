# Tray skins

Each subdirectory here is one selectable tray skin in the tray-map UI. The
frontend discovers skins by scanning this directory at build time (via
`import.meta.glob('../../assets/tray-skins/*/meta.json')`) - **adding a new
skin is just adding a new directory here and opening a PR**, no code changes
needed.

## Contributing a skin

A skin directory needs exactly three files:

```
assets/tray-skins/<your-skin-id>/
  horizontal.svg   viewBox="0 0 220 64"   (3.5"-style: wide, mounted flat)
  vertical.svg      viewBox="0 0 76 190"   (2.5"-style: narrow, mounted on edge)
  meta.json
```

**The SVGs are shell art only** - the tray body, latch, and any texture/color
specific to the hardware you're modeling. Do **not** draw the status LED,
drive-type icon, serial label, or manufacturer logo into the SVG - those are
composited at runtime by the app (so they can reflect live disk state and the
user's own configured logo) using the anchor points you declare in
`meta.json`.

**No manufacturer logos, ever.** If you're modeling a specific vendor's
hardware (which is welcome and encouraged - see the SuperMicro/Dell/HP/NetApp
skins for precedent), match the shape, color, and latch/handle style, but
never draw their logo or wordmark into the SVG. Logos only ever come from the
user's own configured manufacturer-logo URL (a separate feature) - this is
what keeps skins safe to ship without a trademark license. Set `unofficial:
true` and a short `disclaimer` string in `meta.json` for any vendor-styled
skin (see existing skins for the wording pattern).

### `meta.json` schema

```json
{
  "id": "your-skin-id",
  "name": "Display Name",
  "description": "One sentence - what this models and why it looks the way it does.",
  "unofficial": false,
  "disclaimer": "Only present when unofficial is true.",
  "ledColors": { "ok": "#4a9d5f", "warn": "#d9a72e", "critical": "#c9463c" },
  "overlays": {
    "horizontal": {
      "led": { "cx": 0, "cy": 0, "r": 4 },
      "icon": { "cx": 0, "cy": 0, "r": 8 },
      "logo": { "x": 0, "y": 0, "size": 16 },
      "label": { "x": 0, "y": 0, "color": "#242420" }
    },
    "vertical": { "...": "same four anchors, for the vertical.svg viewBox" }
  }
}
```

- `ledColors`: optional. This skin's default status-LED colors - real hardware doesn't all use the
  same green/amber/red convention (some blink blue, some split activity/fault across two LEDs).
  Any status left out falls back to the app's own default (green/amber/red). Users can still
  override any of these per-skin from the settings UI; this is just what a fresh install shows.
- `led`: a filled circle showing SMART/health status color (per `ledColors` above, or a user override).
- `icon`: a filled circle behind the HDD/SSD/NVMe glyph (see
  `../drive-icons/`).
- `logo`: top-left corner of a square slot for the user's configured
  manufacturer logo, if any.
- `label`: text-anchor start position for a one-line serial/model string.
  `color` should be chosen to stay legible against your skin's body color
  (light text for a dark body, dark text for a light one).

Skins for tall, narrow trays (a 3.5" drive mounted on edge, as in a shelf that holds its drives
upright side by side) can go beyond the default 220x64 / 76x190 shapes:

- `viewBox` (optional, top level of `meta.json`): `{ "horizontal": { "w": 220, "h": 64 }, "vertical":
  { "w": 42, "h": 220 } }`. Give the size your svg's `viewBox` attribute uses; any orientation left out
  keeps the default size. The tray is drawn at this aspect ratio.
- `rotate: true` on the `label` anchor: the serial and the make/model text are drawn rotated, reading
  bottom-to-top, in two columns starting at the anchor's `x`/`y` instead of as horizontal lines. The
  columns stop 4 units above the `logo` anchor (or at the bottom edge if the logo is not below them),
  and the size/role badge is stacked at the bottom centre. See `vertical-35` for an example.

Coordinates are in the SVG's own viewBox units. Keep all four anchors clear
of your latch/handle art and of each other - `icon` and `label` typically sit
in the corners of whatever part of the tray isn't the latch.

## Requesting a skin instead of building one

Open an issue with the hardware's part number or model (see the
SuperMicro/Dell/HP/NetApp skins for the level of detail that's useful - a
real part number is worth more than a description from memory).
