# Bay Watch

*Formerly **Disk Location Next**.*

Every bay needs a lifeguard. Bay Watch keeps an eye on your drives: a visual map of which
physical bay, tray or PCIe slot each one lives in, plus SMART health history over time. No
slow-motion running along the array required (though if your drive activity LEDs are blinking in
slow motion, that's what the Locate button is for).

It started life as a ground-up rewrite of the [Disk Location](https://github.com/olehj/disklocation)
Unraid plugin concept. This version is a standalone TypeScript/Node.js service that talks to
Unraid's native `unraid-api` GraphQL interface (Unraid 7.2+) and Unraid's own runtime state
files, instead of a classic PHP webGUI plugin.

> **About the name.** This project was first called "Disk Location Next", which made it sound
> like an official next version of Disk Location. It isn't: Bay Watch is an independent project
> with its own codebase, and it is not affiliated with Disk Location or its author, Ole-Henrik
> Jakobsen (olehj). He kindly suggested a name that makes the difference clear, so it is now Bay
> Watch. Credit for the original idea belongs to Disk Location, which is still maintained and
> well worth using on its own.
>
> **Already installed as Disk Location Next?** Installing Bay Watch carries over your Unraid API
> settings, chassis layout, logos and SMART history, and removes the old plugin. See
> [Moving from Disk Location Next](#moving-from-disk-location-next).

This is a **separate codebase** from the Disk Location plugin - no PHP code, files, or history carry
over, only the underlying idea and the lessons learned building it. See [ROADMAP.md](ROADMAP.md)
for the full architecture history, every real API gap this project ran into (and how each was
worked around), and what's still open.

## Features

- **Tray/bay drive map.** A chassis is modeled as a list of physical groups (a front hot-swap
  cage, a rear cage, a PCIe carrier card) rather than one flat grid, matching how real hardware
  is actually laid out. Each bay renders with a directory-discovered **tray-skin** (`classic`, an
  unbranded `generic`, and unofficial fan-styled recreations of SuperMicro/Dell/HP/NetApp
  hardware) or, for M.2/U.2 drives, a **PCIe carrier** shell (default, plus unofficial
  ASUS/SuperMicro/HPE-style quad-NVMe carriers) - both are plain SVGs you can add to without
  touching any code.
- **Per-bay drive info at a glance**: SMART-status LED (color configurable per skin/status),
  drive-type icon (HDD/SSD/NVMe), array role (parity/data/cache/boot/unassigned - with cache pool
  name), exact capacity, and make/model - shown as text when there's no logo, or a manufacturer
  logo when there is. Role coloring and role badges are independent, optional toggles.
- **Disk assignment**, in bay-position order, with a **Locate** button (blinks the real drive's
  activity LED via repeated `smartctl` queries) on both unassigned and already-assigned drives, so
  you can sanity-check an assignment without guessing.
- **Brand-logo system**: a hotlinked URL or a locally-uploaded SVG per detected drive brand
  (auto-detected from the drive's own vendor/model string, overridable per bay), separate from
  each tray skin's own chassis-branding logo - a Dell-skinned bay doesn't mean a Dell drive.
- **Import from the classic Disk Location plugin**, if it's still installed: matches its saved
  tray assignments to your currently-connected drives by recomputing its own identity hash, and
  previews the match count before touching anything.
- **SMART History tab**: temperature, power-on hours, and reallocated/pending/uncorrectable
  sector trend charts per drive, derived from periodic `smartctl` polls (a drive in standby is
  never woken just to sample it).
- **Layout sizing controls**: per-group and per-card widths, plus an overall app-width setting,
  so a large chassis isn't squeezed into a fixed layout.
- **Daemon control from the Settings tab**: start/stop/restart and change the listening port,
  even when the daemon itself is down - this goes through Unraid's own always-running PHP/nginx
  layer, not the daemon's own API (which is exactly what's unreachable in that case).

## Requirements

- Unraid 7.2 or later (this is the first version to ship `unraid-api`; there's no lower floor to
  design around).
- An `unraid-api` API key with read access to disk/array data. Generate one from Unraid's own
  Settings > Management Access (or `unraid-api apikey` on the command line) - see the
  [unraid-api docs](https://github.com/unraid/api) for the exact steps on your version.

## Installing

Not yet in Community Applications - install by pasting this repo's `.plg` URL directly into
Unraid's **Plugins > Install Plugin** field:

```
https://raw.githubusercontent.com/joshmans/unraid-baywatch/main/plugin/unraid-baywatch.plg
```

A Community Apps entry is planned as a fast-follow once a real tagged release has been installed
and verified on a live box (see ROADMAP.md's open questions).

### Moving from Disk Location Next

If you installed this plugin under its old name (`unraid-disklocation-next`), install Bay Watch
with the URL above. The installer, once, copies `settings.json`, `layout.json`, the SMART-history
database and any uploaded logos from `/boot/config/plugins/unraid-disklocation-next` into
`/boot/config/plugins/unraid-baywatch`, stops the old daemon, and removes the old plugin. It
never deletes the old folder, so you can check everything came across and then delete it yourself
(it also holds old downloaded packages that can be large). The page is now at **Tools > Bay
Watch**, and its web address changed from `/plugins/unraid-disklocation-next/` to
`/plugins/unraid-baywatch/`.

### First-run configuration

Open **Tools > Bay Watch > Settings > Unraid API connection** and enter your GraphQL
URL (typically `https://localhost/graphql`, since the daemon runs on the box itself) and API key.
Everything else (chassis layout, disk assignments, skins, brand logos, LED colors, SMART-history
retention) is configured entirely from the plugin's own Tools page too - no config files to
hand-edit.

## Using it

Open **Tools > Bay Watch**. Five tabs:

- **Tray Map** - the live, read-only chassis view. Shows "the plugin's service isn't running"
  with a Start button if the daemon is down, instead of silently falling back to sample data.
- **Disk Assignment** - assign a detected disk (by serial number, stable across reboots) to an
  empty bay/module, or Locate one to confirm it physically.
- **Drive Identity** - the brand-logo URL/upload table and per-bay brand overrides.
- **Settings** - chassis layout editor (groups, rows/columns, skins, PCIe carriers, sizing),
  manufacturer/skin logos, per-skin LED colors, role display toggles, SMART-history storage
  location and retention, daemon start/stop/restart and port, and the classic-plugin import.
- **SMART History** - trend charts for temperature, power-on hours, and sector health, for any
  drive `unraid-api` reports (not just ones you've assigned a bay to yet).

## Contributing

Same house rules as the original plugin: one branch per feature, PR'd and merged individually,
commit messages explaining *why* not just *what*. A tray-skin or PCIe-carrier contribution is
just a new SVG pair + `meta.json` under `assets/` - see
[assets/tray-skins/README.md](assets/tray-skins/README.md) and
[assets/pcie-carrier/README.md](assets/pcie-carrier/README.md). Never bundle or redistribute a
real trademarked manufacturer logo - logos stay strictly in the user-configured logo/brand
system, never shipped with the plugin itself.

See [ROADMAP.md](ROADMAP.md) for the architecture decisions, every real `unraid-api` quirk this
project found and worked around, and what's still open.

## License

MIT - see [LICENSE](LICENSE).
