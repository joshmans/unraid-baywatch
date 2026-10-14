# Roadmap

## Background

This project starts from the "Phase 3" idea in
[unraid-disklocation](https://github.com/joshmans/unraid-disklocation)'s
[ROADMAP.md](https://github.com/joshmans/unraid-disklocation/blob/master/ROADMAP.md):
rebuild the Disk Location concept (tray/bay drive map, SMART health history) on Unraid's
modern plugin stack instead of the classic PHP/webGUI architecture, once that PHP codebase
reached feature-complete/maintenance mode. That milestone was reached 2026-09-16, and this
repo is the result of scoping what "rebuild on the modern stack" actually means in practice.

This is a clean-room rewrite. It does not share code, files, or git history with the PHP
plugin, and depends on nothing from it at runtime. The relationship is inspiration and
mechanics only — the tray-map/SMART-history *ideas* carry over conceptually; nothing else
does.

## Key finding that shaped this repo's architecture

The original framing was "a native `unraid-api` plugin that registers its own GraphQL
resolvers and WebGUI components," on the assumption that `unraid-api` (Unraid's built-in
NestJS/GraphQL service, shipped in the OS since 7.2, Aug 2025) has a documented extensibility
point for third-party plugins to hook into that process, the way the PHP webGUI has
`.plg`/`.page` files.

As of this writing (2026-09), that doesn't appear to exist for outside developers:

- The official [unraid/api](https://github.com/unraid/api) repo's own developer docs cover
  building the first-party API/Connect package itself, not a third-party plugin contract.
- Unraid's own published roadmap lists "Developer Tools for Plugins" as a Q2 2025 target,
  still unshipped as of this writing.
- Every real third-party project found in the wild that touches `unraid-api`
  (Home Assistant integrations, MCP servers, monitoring agents) does so as an external
  client authenticating with an API key and querying the existing GraphQL schema — none
  extend the schema or inject WebGUI components in-process.

Decision: build as a **standalone TypeScript/Node.js service** that authenticates to
`unraid-api` via an API key and reads array/disk/SMART state over GraphQL, rather than
attempting in-process plugin registration. If Unraid ships a real third-party plugin SDK
later, revisit — this project's GraphQL-client core should mostly carry over either way, since
the in-process gap is only in *how it's loaded and how it draws UI*, not in *how it reads
data*.

## Settled decisions

- **Minimum Unraid version: 7.2+.** `unraid-api` is not present before that, so there's no
  lower floor to design around.
- **Repo/codebase: fully separate from `unraid-disklocation`.** Independent history,
  independent versioning, independent distribution — not a package inside that repo.
- **Approach: full rewrite, not a gradual migration.** There's no PHP logic worth wrapping
  behind a resolver; the data access pattern (GraphQL query vs. file-parsing/`smartctl`
  shell-out) is different enough that a wrapper would be its own throwaway layer.
- **Distribution: `.plg`-installed Node.js daemon, not a Docker container.** Closer to the
  original plugin's install experience and lets it register in Unraid's own nav (`Tools/`),
  rather than living in the Docker tab as a separate app. Precedent: plugins like
  netbird-unraid already install/supervise non-PHP daemons this way, via an `rc.d` script
  under `/usr/local/etc/rc.d/` (never `/etc/rc.d/`, which Unraid owns as a runtime symlink -
  packaging into it can break nginx/php-fpm/samba/docker) started by an array-start event
  hook. Skeleton: [plugin/rc.d/rc.unraid-baywatch](plugin/rc.d/rc.unraid-baywatch),
  [plugin/unraid-baywatch.plg](plugin/unraid-baywatch.plg).
- **UI delivery: mounted into the DOM, not an iframe.** The `.page` file is a normal plugin
  page with a mount `<div>` and a `<script>` tag loading this project's own bundled
  frontend JS - it renders in the same document, not a nested browsing context (iframing
  Unraid's own UI is a known source of breakage, e.g. the Connect plugin's iframe issues on
  the forums). Skeleton: [plugin/pages/BayWatch.page](plugin/pages/BayWatch.page).
  The nginx registration itself is owned by the daemon at runtime, not a static file - see
  [src/nginx.ts](src/nginx.ts) and the durability finding below.
  **Corrected against a real box (2026-09), replacing wrong assumptions this bullet used to
  make:**
  - The `.page` file must be installed flat at `/usr/local/emhttp/plugins/<name>/<Basename>.page`
    - **not** in a `pages/` subdirectory (this repo's own `plugin/pages/` is just a source-tree
    choice; a real install step needs to flatten it). Its URL is `/<TopMenu>/<Basename>`, e.g.
    `/Tools/BayWatch` - confirmed by checking a real sibling plugin's own working URL.
    A colliding `Title` with another installed plugin (we originally reused "Disk Location")
    is also a real, silent failure mode - menu entries need to be visibly distinct.
  - Unraid's `nginx.conf` does **not** wildcard-include `/etc/nginx/conf.d/*.conf` - it
    includes exactly one file, `conf.d/servers.conf`, which itself includes
    `conf.d/locations.conf` (once per server block). A dropped-in `.conf` file elsewhere in
    `conf.d/` is silently never read. The real, working pattern - confirmed by an existing
    real plugin (`u-manager-companion`) already doing exactly this for its own GraphQL proxy -
    is to persist the snippet under `/boot/config/plugins/<name>/nginx/<name>.conf` (survives
    reboots) and get it pulled in by appending one `include /boot/config/plugins/<name>/nginx/<name>.conf;`
    line into `/etc/nginx/conf.d/locations.conf`.
  - `/etc/rc.d/rc.nginx reload` **regenerates** `locations.conf` from a hardcoded heredoc in
    `build_locations()` (confirmed by reading that script on a real box) rather than just
    reloading nginx against whatever's on disk - a hand-appended `include` line there gets
    silently wiped by it every time, and there's no plugin-registration hook in that function
    to opt into surviving it - not a packaging oversight, just how the stock script works.
    **Solved (2026-09) by not fighting it - self-heal instead**, following the same real
    pattern `u-manager-companion`'s own service uses (confirmed by reading its
    `service/bundle.cjs`): [src/nginx.ts](src/nginx.ts)'s `startNginxSelfHeal()`, called once
    the daemon is actually listening, (1) writes the include file and appends the `include`
    line on startup if either is missing, doing a validated `nginx -t && nginx -s reload` only
    when something actually changed, then (2) `fs.watch`es `locations.conf` itself and, on any
    change, checks (after a 300ms debounce) whether the include line survived - if not
    (`rc.nginx reload`/`restart`/`renew` wiped it, for any reason, not just a plugin-install
    edge case), it re-appends and reloads again. `nginx -s reload` (the raw binary signal,
    bypassing Unraid's regenerating wrapper) is used for every reload here, same as
    `u-manager-companion`'s cleanup script does - `rc.nginx reload` would just re-trigger the
    exact regeneration this is healing from. Verified twice: first against scratch files
    standing in for the real paths (`BAYWATCH_LOCATIONS_CONF`/`_NGINX_INCLUDE`/
    `_NGINX_BIN` env overrides) and a fake `nginx` binary logging its invocations - cold start
    appended the line and reloaded once, overwriting the fake `locations.conf` to simulate a
    regeneration triggered a heal + reload within ~1s, a no-op touch triggered no reload - then
    against the real box's actual `/etc/rc.d/rc.nginx reload`: it visibly regenerated
    `locations.conf` (the include line's position shifted, proving the file was rebuilt from
    scratch) and wiped our line, and the daemon's log showed the heal firing and re-appending
    it within ~1-2s with zero manual intervention, `unraid-api` and the UI unaffected throughout.
- **Runtime packaging: Node.js + Single Executable Applications (SEA), not Bun.** SEA has
  been stable since Node 22 and streamlined further in Node 24 (`--build-sea`), so the
  `.plg` ships a compiled binary with no separate Node.js install required on the box
  (Unraid doesn't bundle Node.js itself). Chosen over Bun's `--compile` because it keeps the
  project on the actual Node.js runtime's long-term stability guarantees, which matters more
  than Bun's currently-smoother build ergonomics for something meant to run unattended for
  years. SQLite storage will use the built-in `node:sqlite` (Release Candidate, API-stable)
  rather than `better-sqlite3` specifically so there's no native `.node` addon that SEA can't
  embed in the blob - `node:sqlite` ships inside Node itself, so this isn't an issue.
  Note this doesn't help multiple independent Node-based plugins share a runtime: each
  compiled binary is its own OS process with its own heap regardless of packaging method -
  Node has no mechanism for one process to attach to another's running runtime, so this
  isn't something to design around.
- **The `unraid-api` GraphQL schema, verified 2026-09 against a live 7.2+ instance** (both
  by reading [unraid/api](https://github.com/unraid/api)'s resolver source and by running
  real queries against a real box - see [src/graphql/queries.ts](src/graphql/queries.ts)).
  Three findings that shape everything below:
  - `disks` (physical inventory: serial, model, vendor, size, `temperature`, and only a
    coarse `smartStatus: OK | UNKNOWN` - no detailed attributes) and `array` (logical
    Unraid slot assignment: `idx`, disk1/disk2/parity/cacheN/flash groupings) both work as
    expected and are now real, typed queries, not guesses.
  - **Unraid has no concept of physical bay/tray position, confirmed by the schema having
    none.** `array.idx` is a *logical* slot number, not a chassis location. This was always
    true of the original PHP plugin too (it's the entire reason "Disk Location" exists as
    a plugin rather than something Unraid itself shows) - it just confirms the physical
    mapping stays 100% this plugin's own stored config either way, unaffected by the
    rewrite.
  - **Detailed SMART attributes are not exposed over GraphQL, even though `unraid-api`
    reads them internally.** `DisksService.getTemperature()` runs `smartctl -A -j <device>`
    and parses the full `ata_smart_attributes.table` (the standard ATA attribute table -
    power-on hours, reallocated sectors, etc.) via its own zod schema, then discards
    everything except `temperature.current` before it reaches GraphQL. So this plugin's
    SMART-history feature (the whole reason for the original plugin's Trends tab) has to
    shell out to `smartctl` itself, the same way the PHP version did - `unraid-api` doesn't
    give us a shortcut here. This is a point in favor of the `.plg`-daemon-on-host
    distribution decision already made: a Docker container would need extra
    privileged/device-passthrough config to run `smartctl` against physical devices, a
    host-native daemon just does it directly.
- **Auth: always a stored API key, no session/cookie reuse.** `unraid-api` does support
  cookie-based auth alongside API keys (confirmed in `auth.service.ts`), but it doesn't
  matter here: SMART-history collection has to run as a background poll independent of any
  open browser tab, which only a persistent API key can do. Passing through a browser
  session cookie would still leave the background-polling path needing a stored key, so
  there's no scenario where it replaces one - not worth the added complexity.
- **SMART history storage - built.** [src/smart-history.ts](src/smart-history.ts) carries
  forward the PHP version's SQLite-time-series idea using `node:sqlite`'s `DatabaseSync`
  (one `smart_samples` table: `serial`, `ts`, `status`, and a JSON `data` blob for
  temperature/power-on hours/sector counts/etc., so adding another tracked attribute later
  never needs a migration). `node:sqlite` needs Node 22.5+ - confirmed working without any
  flag on the real box's Node v22.18.0 by actually running
  `node -e "require('node:sqlite')"` there rather than trusting version-range docs, so
  `package.json`'s `engines` was bumped from `>=20` to `>=22.5`. `pollAllDisks()` calls the
  existing `getDisks()`, then for every disk runs `smartctl -n standby -H -A -j <device>`
  (reusing `locate.ts`'s `normalizeDevice()` for the same injection-safe validation) and
  derives `ok`/`warn`/`critical` from `smart_status.passed`, ATA attributes 5/197/198
  (Reallocated/Pending/Offline-Uncorrectable), NVMe's
  `critical_warning`/`media_errors`/`percentage_used`, or SCSI/SAS's
  `scsi_grown_defect_list` - the same attributes smartmontools' own health logic and
  dashboards like Scrutiny already treat as failure-predictive, not thresholds invented for
  this project. **Corrected mid-implementation after live testing against the real box**:
  the original design gated polling on `DiskResult.isSpinning`, skipping any disk that
  field reported as not spinning, specifically to avoid waking a drive just to log a data
  point. Deploying and testing against the real array found every disk reporting
  `isSpinning: false` (the whole array was idle) - but a direct `dd` read from a real SAS
  drive (`HITACHI H0H72108CLAR8000`) completed in 0.03s at full throughput, and a manual
  `smartctl -H -A -j` against it returned real, populated data (`device.protocol: "SCSI"`,
  no `ata_smart_attributes` at all) - proving it was already awake despite `isSpinning`
  saying otherwise. `unraid-api`'s spin-state detection evidently doesn't work reliably for
  SAS drives, so trusting `isSpinning` as the sole gate would have meant this plugin never
  collects history for any SAS-attached drive, permanently. Fixed by dropping the
  `isSpinning` pre-filter entirely and using `smartctl -n standby` instead - smartctl's own
  purpose-built mechanism for exactly this, which skips the actual query (and any resulting
  spin-up) only when the drive itself reports being in standby, and is a no-op otherwise
  regardless of drive type. `pollDevice()` treats a response with none of
  `smart_status`/`ata_smart_attributes`/the NVMe log/`scsi_grown_defect_list`/`temperature`
  present as "nothing to record" (a standby skip or an unsupported/errored device) rather
  than guessing at smartctl's exact standby-skip JSON shape. Runs once ~10s after startup
  then every 30 minutes (`BAYWATCH_SMART_POLL_MS`), pruning samples past a 180-day
  default retention (`BAYWATCH_SMART_RETENTION_DAYS`) each cycle. Exposed via
  `GET /smart-history/latest` (`{serial: status}`) and `GET /smart-history?serial=...`
  (full sample history). Verified against a real daemon process with a fake `smartctl`
  binary and a mock GraphQL server standing in for `unraid-api`, covering all three device
  families: an ATA disk correctly derived `ok`, a SCSI disk with nonzero
  `scsi_grown_defect_list` correctly derived `warn` *despite reporting `isSpinning: false`*
  (proving the fix), and a simulated standby-skip response correctly recorded nothing.
  Retention was also verified by setting it to 0 days and confirming rows were pruned on
  the next poll. On first real deployment this also immediately surfaced a genuine finding
  on the live 43-disk array: two NVMe drives at `percentageUsed: 100` (wear-leveling
  maxed out) correctly derived `warn`, with every other drive `ok` - the feature's first
  real output, not a synthetic test result.

  Storage location is user-configurable: `StoredLayout.smartHistoryDbPath` (a new
  Settings-tab "Storage" field, empty = default) lets someone redirect the database off
  the flash boot drive - this is the one file this plugin writes to on a frequent
  schedule rather than only when a user saves a change, and `/boot` is often a
  write-cycle-limited USB flash device. `smart-history.ts`'s `getDb()` resolves the path
  lazily on first use (env var override, for local dev/testing, still wins over the
  persisted setting), so a change here takes effect on the daemon's next restart, the
  same way this plugin's other settings work. Verified by setting a custom path via
  `layout.json` and confirming a real daemon process created and used the SQLite file
  there instead of the default location.
- **Frontend framework: Svelte, built with Vite.** Chosen for a widget mounted directly
  into someone else's page (no iframe, per the UI-delivery decision above): Svelte compiles
  away to plain JS with no runtime framework object to load, and its scoped-by-default CSS
  and built-in transitions suit a small, visually-controlled widget better than shipping a
  full framework runtime. Verified with a real build, not just assumed - see below.
- **Tray-map visuals: a contributable, directory-discovered skin system**, not a hardcoded
  set of hand-picked designs. Each skin is a plain SVG pair (`horizontal.svg` /
  `vertical.svg` - real hardware mounts 3.5" drives flat/wide and 2.5" drives on edge/narrow,
  and either orientation should be selectable regardless of drive size) plus a `meta.json`
  declaring anchor points for four runtime overlays: SMART-status LED, drive-type icon,
  optional manufacturer logo, and a serial/model label. Skins draw only the hardware shell -
  never the dynamic bits, and never a manufacturer logo (logos stay exclusively on the
  existing user-configured logo framework, so a skin PR carries no trademark risk).
  [assets/tray-skins/README.md](assets/tray-skins/README.md) is the contribution guide.
  The frontend enumerates skins via `import.meta.glob('assets/tray-skins/*/meta.json')` at
  build time - adding a skin is a new directory and a PR, no code change. Shipped with six
  skins: a `classic` flat swatch (matching the original plugin), an unbranded `generic`
  archetype, and four vendor-styled ones researched against real part numbers rather than
  memory (SuperMicro SC93301, Dell 8FKXC/PowerEdge 13th-gen, HP 651687-001/651314-001,
  NetApp DS4246) - each corrected at least once after checking an actual product photo
  turned up a detail (Dell's orange accent ring, not a blue latch) that general recollection
  had wrong. Built and rendered end-to-end in a real browser against the compiled
  `dist/frontend.js` before being called done - see [src/frontend/](src/frontend/).
- **Drive-type icons**: real distinct silhouettes, not three variations on a rounded
  rectangle - HDD is a platter+arm circle, SSD is a flat rectangular drive body, NVMe is a
  notched gumstick (the actual M.2 module shape). [assets/drive-icons/](assets/drive-icons/).
- **Tray-map grid: a chassis is a list of groups, not one flat grid.** A real chassis is
  physically segmented (e.g. a front 3.5" hot-swap cage, a separate rear 2.5" cage, and an
  add-in PCIe carrier aren't one continuous grid), so
  [chassis-types.ts](src/shared/chassis-types.ts) models a `ChassisLayout` as a list of
  `Group`s - either a `BayGroup` (its own `rows`/`columns` grid of `BayConfig` entries, skin
  id + orientation per bay) or a `PcieGroup` (a list of carrier cards, each with a module
  count and shell id). [TrayMap.svelte](src/frontend/lib/TrayMap.svelte) renders each group as
  its own labeled section - a CSS grid of `TraySkin` instances for a `BayGroup`, a row of
  `PcieCarrier` instances for a `PcieGroup` - keyed by a stable id (`bay.id`, or
  `` `${card.id}-m${index}` `` per module) that live drive data merges onto; an unoccupied id
  renders as an empty placeholder rather than nothing. Verified end-to-end in a real browser
  against a mixed-orientation, multi-skin, multi-group example layout (24 SuperMicro-skinned
  horizontal bays + 4 HP-skinned vertical bays + a 4-module PCIe carrier) - confirmed
  programmatically, not just visually, that per-bay/per-module status and drive-type colors
  compute correctly for the right slots.
- **PCIe NVMe carrier as a live component.** [assets/pcie-carrier/default.svg](assets/pcie-carrier/default.svg)
  stays a static shell (frame, heatsink, edge connector only, per
  [assets/pcie-carrier/README.md](assets/pcie-carrier/README.md)); the per-module rows (status
  LED, drive-type icon, serial label - as many as the card's configured module count) are
  overlaid at render time by [PcieCarrier.svelte](src/frontend/lib/PcieCarrier.svelte), the
  same pattern `TraySkin.svelte` uses. Carrier shells are directory-discovered the same way
  tray skins are (`assets/pcie-carrier/*.svg`), just without per-skin metadata yet since there's
  only the one unbranded shell so far.
- **Settings UI for layout + logos, persisted through a real (if minimal) backend route.**
  [Settings.svelte](src/frontend/lib/Settings.svelte) edits groups/bays/cards and a
  per-tray-skin manufacturer-logo URL, and saves them via `POST /layout` (see
  [src/layout.ts](src/layout.ts) and the two routes added to
  [src/server.ts](src/server.ts)) to the same `/boot/config/plugins/...` convention
  `config.ts` already uses. `App.svelte` loads any saved layout on mount and falls back to the
  bundled example layout when none exists yet. Deliberately simple: a group's skin/orientation
  is set once for the whole group rather than per-bay (real chassis are usually uniform per
  physical cage), and there's no drag-and-drop grid editor - just rows/columns counts. Verified
  against the real daemon process (not a mock): saved an edited layout through the actual
  `POST /layout` handler, reloaded the page, and confirmed both the settings form and the tray
  map picked the saved config back up, including a configured logo URL actually rendering on
  the tray it was assigned to.
- **Live disk-to-bay assignment, with a Locate button to identify drives before assigning
  them.** [DiskAssignment.svelte](src/frontend/lib/DiskAssignment.svelte) lists every disk from
  `GET /disks` (a new backend route that calls the already-verified `getDisks()` GraphQL query)
  that isn't yet in the `assignments` map (bay/module id -> disk serial number - serial rather
  than `/dev/sdX` because device names aren't stable across reboots), lets the user pick an
  empty bay/module for it, and persists that mapping through the same `POST /layout` document
  as the settings UI (now `{layout, logos, assignments}`). [derive-drive.ts](src/shared/derive-drive.ts)
  turns an assigned disk into the `BayDrive` `TrayMap`/`PcieCarrier` already know how to render
  (driveType from `interfaceType`/`type`, status from `smartStatus`).
  **Locate**: the original plugin's "Locate" button worked by hammering a drive with `smartctl`
  in a loop, since read-only SMART queries are enough I/O to make a hot-swap bay's activity LED
  blink noticeably. [locate.ts](src/locate.ts) reimplements that same mechanic directly (not the
  original's compiled `smartlocate` binary) - `smartctl -a <device>` every 700ms via `execFile`
  with an argv array (never a shell string, so a device name can't inject anything), with the
  raw input strictly validated down to a bare alphanumeric name before a path is ever
  constructed from it, and a 5-minute auto-stop safety net in case the UI never sends stop.
  Each unassigned drive gets a Locate/Stop toggle; assigning a drive stops its locate session
  automatically. Verified for real, not mocked: ran the actual compiled route against a local
  `smartctl` (installed for this), confirmed with an instrumented wrapper that starting locate
  produces real repeating `smartctl -a <device>` calls on a ~700ms cadence and stopping it
  halts them immediately with zero further calls; confirmed device-name validation rejects
  shell-metacharacter and path-traversal payloads outright; and exercised the full assignment
  path against a local mock GraphQL server standing in for unraid-api (real request/response
  shape) - assigned a disk to a bay through the actual UI, watched the tray map render its real
  derived icon color/status LED/serial label, unassigned it, and confirmed persistence and the
  locate-stops-on-assign behavior via the real running daemon throughout.
- **`derive-drive.ts`'s field-shape guesses confirmed against a live 43-disk array (2026-09).**
  Re-ran the `disks` query against the same real box used for the original schema
  verification: `device` really does come back as a full path (`/dev/sda`, `/dev/nvme5n1`,
  ...), which `locate.ts`'s `normalizeDevice()` already handled defensively either way, and
  `type` really is `"HD"` / `"SSD"` / `"NVMe"`, which the existing `/ssd/i` substring check and
  the `interfaceType === "PCIE"` check correctly classify - no code changes needed, this just
  confirms the guesses were right. `smartStatus` was `"OK"` for every drive except one USB boot
  device (`"UNKNOWN"`), matching the documented OK/UNKNOWN-only shape. **Locate confirmed on real
  hot-swap hardware (2026-09-17)**: clicked Locate on an unassigned drive through the live UI
  running on the actual box, and the drive's bay activity LED visibly blinked - closing out the
  one piece of the Locate feature that GraphQL-only testing couldn't reach.
- **Per-skin default LED color, with a user override per skin/status.** Real trays don't agree
  on one green/amber/red convention - NetApp DS-series shelves are commonly blue for normal
  status rather than green, for instance (a general-knowledge call, not verified against a real
  NetApp shelf this session - flagging it the same way the vendor-styled skins themselves flag
  unverified visual details). So each skin's `meta.json` now carries its own `ledColors: {ok,
  warn, critical}` default (all five other skins keep the original green/amber/red;
  [netapp/meta.json](assets/tray-skins/netapp/meta.json) is `#2f6fd6`/amber/red) -
  [assets/tray-skins/README.md](assets/tray-skins/README.md) documents the field for
  contributors. [status.ts](src/frontend/lib/status.ts)'s `resolveLedColor(skin, overrides,
  status)` picks user override > skin default > the old hardcoded default, in that order.
  The settings UI's new "LED colors" section gives every skin three `<input type="color">`
  swatches (one per status) pre-filled with whatever's currently resolved, plus a Reset button
  that clears back to the skin's own default; overrides persist in the same `StoredLayout`
  document as everything else (`ledColors: LedColorConfig`, keyed by skin id then status).
  Verified in a real browser against the real daemon: confirmed all six skins' defaults resolve
  correctly (five green/amber/red, NetApp blue/amber/red) on an actually-rendered tray, set an
  override through the color picker and watched the tray's LED update immediately, reloaded the
  page and confirmed the override survived, then hit Reset and confirmed it reverted to the
  skin's own default color on the real rendered tray.
- **Whole-tile flash on a SMART fault, not just the LED dot.** A single small LED is easy to
  miss in a 24+ bay grid. `TraySkin.svelte`/`PcieCarrier.svelte` now add a pulsing red ring
  around the whole tray/module when `status === "critical"`, colored from that skin's own
  (possibly user-overridden) critical LED color via a `--fault-color` CSS variable, so the two
  features stay consistent rather than introducing a second color knob. Disabled in favor of a
  static ring under `prefers-reduced-motion: reduce`. **Now reachable from live data, not
  just demo data.** `driveFromDisk(disk, historyStatus?)` in
  [derive-drive.ts](src/shared/derive-drive.ts) combines the existing `smartStatus`-based
  `ok`/`warn` with the SMART-history poller's own derived status via a `worseStatus()`
  helper (rank `ok < warn < critical`, always keep the worse of the two) - `App.svelte`
  fetches `GET /smart-history/latest` alongside `/disks` and passes each disk's status in.
  Verified in a browser harness with a mocked backend: a disk assigned to a bay with a
  mocked `historyStatus` of `"critical"` actually rendered with the `fault` class applied
  on its `TraySkin`, confirmed by inspecting the live DOM, not just visually.
- **SMART trend-graph tab - built.** A fourth "SMART History" tab
  ([SmartHistory.svelte](src/frontend/lib/SmartHistory.svelte)) lists every disk
  `unraid-api` reports (not just tray-assigned ones - trend history is useful before
  you've configured a chassis at all), lazy-fetching `GET /smart-history?serial=...` only
  once a drive is picked. Charts render via `uPlot` (~45KB, zero dependencies itself) -
  the first third-party runtime dependency added to the frontend bundle beyond Svelte
  itself, added specifically for this because a hand-rolled chart would have meant
  reinventing axis/legend/time-scale handling for little benefit.
  [TrendChart.svelte](src/frontend/lib/TrendChart.svelte) wraps a single `uPlot` instance,
  reused for temperature, power-on hours, and a combined reallocated/pending/offline-
  uncorrectable sectors chart. Two non-obvious things it has to handle that a typical
  charting setup wouldn't: canvas `strokeStyle` can't resolve `var(--x)` CSS custom
  properties itself, so colors are resolved via `getComputedStyle` before being handed to
  uPlot; and this tab's panel can be `display:none` (an unselected tab) at the exact
  moment a chart first mounts, per the tab-panel convention above, which would give uPlot
  a real width of 0 - a `ResizeObserver` on the chart's container is what actually
  triggers construction/resizing, since it naturally fires once the tab is switched to
  and the container gets laid out for real. Verified in a browser harness: charts
  rendered correctly from mocked history data on first visit to the tab, and survived
  being hidden (switching to another tab) and shown again without going blank.
- **Daemon-down UX: no demo-data fallback, start/restart controls, configurable port.**
  Previously, when `/layout` was unreachable, `App.svelte` silently rendered bundled demo
  data - convenient for local dev, but on a real install this made a genuinely down
  daemon (confirmed live: the rc.d restart race from the bullet above did exactly this)
  indistinguishable from a working one. Now `loadLayout()`'s failure path (including a
  non-ok HTTP status, e.g. nginx 502 with nothing listening upstream - not just a thrown
  exception) sets `daemonReachable = false`, and the Tray Map tab shows a plain "The
  plugin's service isn't running" message with a real Start button instead.

  The hard part: **when the daemon is down, this plugin's own API is exactly what's
  unreachable**, so starting it - and changing its port, needed so it doesn't collide
  with a Docker container or other service - can't go through
  `/plugins/unraid-baywatch/api/*` at all. This goes through Unraid's own
  always-running PHP/nginx layer instead, using the real, verified convention for it
  (confirmed by reading an already-installed plugin, `unraid-zram-card`, not invented):
  its `.page` file exposes Unraid's own CSRF token (`$var['csrf_token']`, available to
  any `.page`'s embedded PHP) via an inline `window.ZRAM_PAGE = {CSRF: '...', API:
  '...'}` script tag, and its standalone action-handler `.php` file (dropped directly in
  the plugin's `emhttp` directory, not routed through `template.php`'s page-auth
  pipeline) validates that token server-side with `hash_equals()` against
  `/var/local/emhttp/var.ini`'s current token - failing closed if that file can't be
  read. [plugin/daemon-control.php](plugin/daemon-control.php) copies this exactly, and
  [plugin/pages/BayWatch.page](plugin/pages/BayWatch.page) exposes
  `window.BAYWATCH_PAGE = {CSRF, API}` the same way. Three actions: `status`
  (reads `port` straight out of `layout.json`, default 3838 - checks "is it running" via
  `file_exists("/proc/$pid")` on the rc.d pidfile, a zero-extension-dependency
  equivalent of `kill -0` that doesn't need PHP's `posix` extension), `start` (always
  runs the rc.d script's `restart`, never plain `start` - its `start()` already no-ops
  cleanly if already running, so one action covers both cases the UI needs), and
  `set-port` (validated 1-65535, refuses server-side too if currently running - defense
  in depth beyond the UI merely disabling the input, in case of a stale page or two tabs
  open; read-modify-writes just the `port` key into `layout.json`, seeding a minimal
  valid `{layout, logos}` structure first if the file doesn't exist yet, matching
  `chassis.ts`'s own `emptyLayout` shape, so the frontend never has to handle a document
  missing those keys).

  `plugin/rc.d/rc.unraid-baywatch`'s `start()` now reads the configured port via
  `jq` (already relied on elsewhere in Unraid's own `rc.nginx`, not a new dependency)
  before building its `EXEC` line, defaulting to 3838 if unset/unreadable - matches the
  "only changeable while stopped" rule by construction, since it's only ever read at
  startup, never hot-reloaded into a running process.

  The `src/frontend/lib/daemon-control.ts` wrapper degrades safely (returns a clear
  "not available" result rather than throwing) when `window.BAYWATCH_PAGE` is
  absent - true of every browser-harness/local-dev setup used throughout this session,
  none of which serve through Unraid's real `.page` pipeline.

  Verified in a browser harness (mocked `fetch` + a mocked `window.BAYWATCH_PAGE`):
  a daemon-down scenario shows the real message and Start button (not demo data),
  clicking Start calls the mocked PHP endpoint and displays its response; a
  daemon-running scenario shows "Restart daemon" (not "Start") and the port field/Save
  button both visibly disabled; `php -l` confirms both PHP files parse cleanly and `jq`
  confirms the port-extraction expression behaves correctly with and without a saved
  `port` key. **Confirmed against the real box**: the Settings tab's Daemon section
  loaded real status (not stuck on "Checking...") through the actual `$var['csrf_token']`
  round trip on first try - the `unraid-zram-card`-derived pattern held up exactly as read
  from its source, no adjustments needed.

- **Import from the classic Disk Location plugin - built.** That plugin's real,
  installed source (`/Users/josh/Git/unraid-disklocation` on the dev machine, not
  derived from or bundled with this project - see the top of this doc) was read
  directly to confirm this, and every claim below was cross-checked against a real
  installed copy's actual `groups.json`/`locations.json`/`devices.json`, not just its
  source:
  - Storage: `/boot/config/plugins/disklocation/{groups,locations,devices}.json`.
    `locations.json` is `{hash: {groupid, tray}}` (the real assignments); `groups.json`
    is the cage/grid definition (`grid_rows`, `grid_columns`, `grid_count`
    "row"/"column", `tray_direction`, `tray_start_num`, `disk_tray_direction` "h"/"v").
  - The hash (from `cronjob.php`) is `sha256(model_name + serial_number)` -
    `scsi_model_name ?? model_name`, smartctl's raw **vendor+model** string (e.g.
    "HITACHI H0H72108CLAR8000"), not `unraid-api`'s split `disk.name` (which drops the
    vendor prefix) - concatenated directly with `serial_number`, no separator.
    Recomputed by hand for a real disk on the live box and it exactly matched that
    disk's own key in the real `devices.json` before any code was written.
  - Tray-number-to-grid-position math (from `tray_number_assign()` in
    `functions_devices.php`, cross-checked against the real `groups.json`, where every
    group uses `tray_direction: "1"`): zero-based index `i = tray - tray_start_num`,
    then column-major (`col = floor(i / rows), row = i % rows`) if
    `grid_count == "column"`, row-major otherwise. Only `tray_direction: "1"` is
    imported - the other modes are more involved reversed/bottom-up schemes not
    verified against real data, so a group using one is skipped and reported rather
    than guessed at.
  - `disk_tray_direction` maps directly onto this project's own `BayConfig.orientation`.
    The classic plugin has no tray-skin or PCIe-carrier concept, so every imported
    group becomes a `BayGroup` (never `PcieGroup`) with every bay defaulting to the
    `classic` skin.

  [src/classic-import.ts](src/classic-import.ts)'s `previewImport()` does the read-only
  matching (reusing `smart-history.ts`'s exported `runSmartctl()` with the same
  `-n standby` flag - a one-time import is no more entitled to wake a sleeping drive
  than the background poller is) and returns a preview with match counts and skipped
  groups; nothing is written until the user explicitly confirms. Applying an accepted
  preview is just a normal `POST /layout` through the existing save path (`GET
  /classic-import/preview` in [server.ts](src/server.ts)), not a separate write path -
  one less thing that could disagree with how every other Settings save already works.
  The Settings tab's new "Import from classic plugin" section checks silently on mount
  and renders nothing at all if there's no classic-plugin data to import (`available:
  false`), so an install that was never migrated from sees no trace of this feature.

  Verified with a full synthetic scenario (fake `smartctl`, mock GraphQL, scratch
  `groups.json`/`locations.json`): a `column`-flow group's positions matched hand
  calculation exactly, a `row`-flow group's did too, a `tray_direction: "2"` group was
  skipped and reported, and both an unmatched hash and a location pointing at a skipped
  group were correctly dropped rather than silently mis-assigned. A browser harness
  confirmed the section stays invisible when unavailable and, when available, that
  confirming Import hands the exact previewed groups/assignments to the same
  `persistAll()` every other save uses.

  **Run end-to-end against the real box and two real bugs found and fixed:**
  1. `buildHashToSerialMap()` originally reused `smart-history.ts`'s `-n standby` flag
     for the identity lookup too - wrong call for this specific use, since `-n standby`'s
     whole point is to skip the query (returning bare device info only, no
     model/serial) when the drive's asleep. On a real array that's mostly spun down,
     this meant 0/13 real assignments ever matched. Fixed by switching to `-i`
     (identify/inquiry only) with no `-n` flag - confirmed live this doesn't wake a
     drive either (queried a real standby `/dev/sda` with `-i`, then immediately
     re-checked its power state with `-n standby -j`: still reported standby,
     unchanged), and it does return model/serial even while asleep, since IDENTIFY/
     INQUIRY doesn't require the platters spinning.
  2. Even after fixing (1), 2 of 13 real assignments still didn't match, both landing
     one tray past their group's own declared `grid_rows x grid_columns`. Cross-
     referencing the classic plugin's own live tray-map UI (which labels each bay with
     its tray number) against `locations.json` on the real box proved `tray_start_num`
     is **not** the first tray's own number - trays are 1-indexed *above* it
     (`tray_start_num: "0"` means the first real tray is numbered 1, not 0; every real
     group on this box had zero `tray: 0` entries, confirming the convention).
     `gridPosition()`'s `i = tray - startNum` was off by one; fixed to
     `i = tray - startNum - 1`. Once fixed, all 13/13 real assignments matched and
     landed in the exact bay positions the classic plugin's own UI showed.

  A tempting-but-wrong intermediate fix for (2) was tried first: expanding a group's
  grid to fit any out-of-range tray, on the assumption the classic plugin's declared
  grid size had simply undercounted a real physical group. Live-checked against the
  user directly and both real out-of-range groups turned out to have the *correct*
  declared size - the real bug was the off-by-one, not the grid dimensions. Kept as a
  cautionary note: an out-of-range tray isn't automatically evidence the grid is wrong.

- **Convert a bay group to a PCIe group, in place.** The classic-plugin importer has no
  PCIe-carrier concept at all, so it always imports every group as bays - including ones
  that are really M.2/U.2 carrier cards (confirmed live: a real imported "nvme" group
  turned out to be 4 individual NVMe drives on a carrier, not hot-swap bays). Rather than
  make the user redo that group by hand, `Settings.svelte`'s Chassis layout editor has a
  "Convert to PCIe group" button on any bay group, building an equivalent single-card
  `PcieGroup` (module count = the group's bay count, shell defaults to `pcieCarriers[0]`).
  The tricky part: bay ids and PCIe module ids (`` `${cardId}-m${index}` ``) are different
  addressing schemes, and `Settings.svelte` only edits a draft copy of the layout - it
  doesn't own the live `Assignments` map those ids are keyed against. A first version that
  just swapped the group in the draft left existing disk assignments silently stranded on
  now-nonexistent bay ids (confirmed live - the drives showed up "assigned" to raw ids like
  `classic-3-1` with no matching bay). Fixed by having `Settings.svelte` build the id
  remap (it already knows the group's bays) but hand it to a new `convertGroupToPcie`
  callback owned by `App.svelte`, which holds the real `liveAssignments` and persists the
  remapped layout+assignments together, atomically - same division of responsibility as
  `importClassic`.
- **Three new PCIe carrier shells - ASUS-style, SuperMicro-style, HPE-style.** Same
  unofficial/fan-styled-recreation convention as the vendor tray skins (no logos, a
  `<id>.json` disclaimer sibling file, modeled on real quad-NVMe carrier products the user
  linked - ASUS Hyper M.2, SuperMicro AOC-SHG3-4M2P, HPE Z Turbo Drive Quad Pro).
  `pciecarriers.ts` gained the same optional-meta-json-with-disclaimer loading
  `trayskins.ts` already had (previously unused since there was only the one unbranded
  shell) plus a `CARRIER_ORDER` array so `default` sorts first.
- **User-controlled sizing: PCIe card width, bay-group width, and the app shell's own max
  width.** All three defaulted small enough to read as "broken" once real module rows/text
  were on them - the PCIe card's hardcoded `220px` (now `DEFAULT_PCIE_CARD_WIDTH_PX = 380`,
  editable per card), and a bay group's "fill available space" default turned out to still
  be capped by `<main>`'s own `max-width: 720px` regardless of actual browser width (that
  cap raised to `1400px`). A `BayGroup`/`PcieCardConfig` can now carry an optional
  `widthPx` - unset keeps the old fluid-fill behavior for both; TrayMap's group panel gets
  `overflow-x: auto` so an oversized group scrolls in place instead of breaking page layout.
- **Drive types legend redesigned**: icon-above-description columns in one row (was a
  plain bullet list) with a breakpoint under 480px falling back to a stacked icon-left
  list, matching a direct ask for "icons, larger, one horizontal row, clean CSS for
  smaller widths."
- **Populated PCIe modules render as a small M.2 stick**, not an icon-in-a-circle: a gold
  edge-connector notch flush against a dark PCB strip, a circular controller-chip badge
  (drive-type icon - kept circular after an explicit correction; an intermediate version
  used a rounded square), the label, a status LED, and a mounting-screw grommet.
- **Every tab-panel/group/legend section now sits in its own bordered panel** (matching
  the Settings tab's existing `.settings-section` look), applied to `TrayMap.svelte`'s
  per-group sections and the Drive-types legend, per a direct ask to visually separate
  them the same way Settings already does.
- **Per-bay role (parity/data/cache/boot/unassigned), pool name, and accurate size -
  built, from Unraid's own runtime state files, not unraid-api.** Two real API gaps drove
  this, both confirmed by checking rather than assuming:
  - `unraid-api`'s GraphQL schema (downloaded and grepped directly, since introspection is
    disabled on a real box) has no per-disk pool-name field anywhere, and no dedicated
    pools query - `array.caches` is one flat, undifferentiated bucket. A multi-pool setup
    (this dev box has two: `nvcache` and `u2nvme`) can't be told apart through it.
  - `Disk.size` (the flat `disks` query) is not reliable for display. It passes straight
    through from the third-party `systeminformation` npm package's `diskLayout()`
    (confirmed by reading `unraid-api`'s own `disks.service.ts` source), which returns
    inconsistently-scaled values per drive type on this same real box: an 8TB SAS parity
    drive came back as `size: 7` (matches TiB, not bytes) while ~1TB SATA/SSD drives came
    back as e.g. `953` (matches GiB, not bytes) - two different wrong units from the one
    field, simultaneously, on the same array. (Same category of unraid-api-field
    unreliability already hit once this project with `isSpinning` on SAS drives.)

  Fix for both: [src/array-state.ts](src/array-state.ts) reads
  `/var/local/emhttp/disks.ini` and `devs.ini` directly - the same files, same general
  approach the classic PHP plugin uses (confirmed by reading its `variables.php`), a
  simple sectioned-INI format (`["sectionName"]` then `key="value"` lines). Verified
  against the real files' actual content, not just the PHP source: `disks.ini`'s section
  name is the pool/slot name, and a multi-disk pool gets one section per member with a
  trailing digit (`nvcache`, `nvcache2`, `nvcache3`, `nvcache4` are all one real pool,
  `nvcache` - confirmed against the real box's two actual multi-disk pools); `type` gives
  the role (Parity/Data/Cache/Flash); `sectors x sector_size` gives an exact byte size,
  verified to match `smartctl`'s own `user_capacity.bytes` for the same disk precisely
  (`1953506646 x 4096 = 8,001,563,222,016`, the parity drive's real size). `devs.ini`
  lists disks connected but in no array/pool at all (Unassigned Devices) - present there
  and absent from `disks.ini` maps to role `"unassigned"`. `enrichWithArrayState()` joins
  this onto whatever `getDisks()` returns before `/disks` responds, by bare device node
  (`disk.device` always carries a `/dev/` prefix from unraid-api; disks.ini/devs.ini never
  do).

  Settings gained two independent toggles (deliberately independent, not one style
  radio, per explicit direction) - "Color-code bays by role" (a colored ring around the
  bay/a tinted PCIe module border) and "Icon badge for role" (a small P/D/C/B/U letter
  badge, hover shows the full role - and for cache, the real pool name). Size is always
  shown regardless of either toggle (same treatment as everything else that's just
  informational, not a role judgment). The role badge originally sat top-right on its own
  and covered every skin's status LED, which also lives top-right on all six skins
  (checked every skin's `meta.json` overlay anchors before picking a new spot) - fixed by
  grouping the badge with the size text into one `.corner-info` cluster at bottom-right,
  clear of every skin's LED/logo anchors. `"unassigned"` intentionally has no role color
  by default (a bay with no array/pool membership isn't really "in a role") but still
  gets a "U" badge with a neutral, always-visible fill so it isn't silently invisible.
- **Disk Assignment tab redesigned: one unified, ordered, zebra-striped list.** Previously
  two disconnected sections - unassigned disks (full detail) and assigned bays (bare
  `bayId -> serial`, no disk detail, and in `Object.entries()` insertion order, i.e.
  whatever order things happened to get assigned in, not bay position). Now one list,
  assigned rows first (each resolved to full disk detail when currently detected, or
  flagged "Not currently detected" for a stale assignment rather than silently dropped),
  sorted by each bay's actual position in the layout, then unassigned disks - with
  alternating-row zebra striping and the same role-color left-border treatment as the
  Tray Map (gated behind the same Settings toggle). Every assigned row also gets a Locate
  button now, not just unassigned ones, so a user can blink-confirm an existing
  assignment is correct, not only a new one. The "Assign to..." dropdown shows "Bay N"
  (matching a plain sequential position, not row/column coordinates) - and every hover
  tooltip across the Tray Map (bay, PCIe card, drive-type icon) was aligned to the same
  "Group - Bay N" convention / a real drive-type name, replacing raw internal ids that
  used to leak into the UI as tooltip text.

- **Drive-brand logos, separated from tray-skin logos, plus a new "Drive Identity" tab.**
  The existing `LogoConfig` (Settings tab, "Manufacturer logos") is keyed by tray-skin id -
  every bay using the Dell skin gets the same logo, which conflates "what caddy/tray this
  is" with "what drive is in it" (a Dell skin doesn't mean a Dell drive). Per explicit
  direction, this is now a separate, drive-brand-keyed system that takes priority, with the
  skin logo kept as the fallback: `resolveBayLogo()` in
  [brand.ts](src/frontend/lib/brand.ts) checks, in order, (1) a manual per-bay brand
  override, (2) the drive's auto-detected brand (from `disk.vendor`/`disk.name` - regex
  patterns checked against real strings seen this session: HITACHI/HGST SAS drives, SPCC
  SATA/NVMe SSDs, Micron NVMe, Seagate SAS, plus other common brands), (3) the bay's tray
  skin's own `LogoConfig` entry. `BayDrive` gained `vendor`/`model` fields (`derive-drive.ts`)
  purely to carry the raw strings brand detection needs, kept separate from `label`
  (serial-first).

  New `StoredLayout` fields: `brandLogos` (brand id -> logo URL, its own hotlinked-URL
  table, same convention as skin logos) and `manufacturerOverrides` (bay id -> brand id,
  the manual per-bay override). A new fifth tab, "Drive Identity"
  ([DriveIdentity.svelte](src/frontend/lib/DriveIdentity.svelte), between Disk Assignment
  and SMART History), has the brand-logo URL table plus a per-assigned-bay row showing the
  auto-detected brand and a dropdown to override it - auto-detection is explicitly
  best-effort (rebadged/OEM drives, generic "ATA" vendor strings with no real brand info),
  which is the entire reason the override exists rather than trusting it blindly.

- **Local-asset (user-uploaded SVG) logos, for both skin and drive-brand logos.** A
  hotlinked URL only works for a publicly reachable image - per explicit direction, a
  user should be able to supply their own SVG file directly instead.
  [src/logos.ts](src/logos.ts) stores an uploaded SVG under
  `/boot/config/plugins/unraid-baywatch/logos/<kind>-<id>.svg` (`kind` is
  `"skin"` or `"brand"`, `id` is always a value from a fixed, known set - a tray-skin id
  or a `brand.ts` `KNOWN_BRANDS` id, never free-text from the client - so the resulting
  filename can never be a path-traversal vector even though it's built from client input;
  verified directly: a `saveLogo("skin", "../etc", ...)` call throws rather than writing
  outside the logos directory). `POST /logos` validates the content actually starts with
  `<svg`/`<?xml` and is under 256KB, then returns a served path; `GET /logos/:filename`
  serves it back with an `image/svg+xml` content-type. [logo-upload.ts](src/frontend/lib/logo-upload.ts)
  is the shared frontend helper - both Settings.svelte's "Manufacturer logos" section and
  DriveIdentity.svelte's "Brand logos" section got a file-picker next to the existing URL
  input; picking a file uploads it and fills the URL field with the served path, which is
  then used exactly like any hotlinked URL from that point on - no separate "local asset"
  concept anywhere downstream of the upload itself.

## Open questions (not yet decided)

- **No settings-UI step for adding a brand-new bay group when a drive shows up in an unexpected
  physical slot** - assignment only works against slots the layout editor already created.

## Settled decisions (continued)

- **Real `.plg` installer + Node SEA binary packaging + release pipeline - built.** Previously
  the `.plg` was a literal stub (`echo "scaffold only"; exit 1`) and the daemon had only ever
  run as `node dist/index.js` over manual SSH. Researched against real, currently-published
  Unraid plugins read in full from local clones (not invented): `Unraid-HBAviewer` and
  `unraid-docker-folders` both confirmed the modern convention - Unraid's own plugin engine
  downloads/hash-verifies/installs a Slackware `.txz` via
  `<FILE Name="..." Run="upgradepkg --install-new"><URL>...</URL><MD5>...</MD5></FILE>`, then a
  plain `<FILE Run="/bin/bash"><INLINE>` block does post-install config seeding/service start,
  and `Method="remove"` does `removepkg` + manual cleanup while explicitly leaving
  `/boot/config/plugins/<name>` (user config/data) alone - the old sibling PHP plugin's own
  `.plg` uses a different, older live-branch-zip convention that doesn't fit a supervised daemon
  binary, so it wasn't used as the model here. **Uses `<SHA256>` instead of the `<MD5>` those two
  precedents actually had**, confirmed via a live web search that Unraid's plugin engine supports
  it as a real, currently-preferred alternative - Unraid's own Community Apps review bot is
  actively retrofitting `<SHA256>` onto other plugins that still only declare `<MD5>` (e.g.
  [kaedinger/unspin#7](https://github.com/kaedinger/unspin/pull/7)), so starting there avoids the
  same change again later for CA compliance.
  - **A real, subtle bug caught before shipping**: XML `CDATA` sections do not expand entity
    references (`&name;` etc.) - that's the entire point of CDATA, literal text with no markup
    recognition at all. An earlier draft of the install/remove scripts mixed `<![CDATA[...]]>`
    wrapping with `&name;`/`&pluginLOC;`/etc. inside it, which would have shipped every path as
    the literal text `&name;` rather than the real value. Fixed by hardcoding plain bash
    variables (`NAME=`, `PLUGIN_LOC=`, etc.) at the top of each CDATA'd script instead - entity
    substitution stays working everywhere else in the file (attributes, `<URL>`/`<SHA256>`,
    `<CHANGES>`), just not inside CDATA. Caught by actually parsing the file with an XML parser
    and running `bash -n` against the extracted script bodies, not just by inspection.
  - **SEA packaging verified end-to-end locally**, not just wired up on faith:
    `npm run build:bundle` (new `esbuild` step - SEA only embeds the entry script's own source,
    so every sibling `dist/*.js` module has to be bundled into one file first) was smoke-tested
    by actually running the resulting `dist/bundle.cjs` as a plain script - it booted the HTTP
    server, served `/disks` (a handled 400 with no `unraid-api` configured, not a crash), and the
    SMART-history poller's `node:sqlite` usage fired without error. The actual
    `--experimental-sea-config`/`postject` injection recipe was also verified for real: this dev
    machine's Homebrew-built Node has SEA compiled out entirely (`process.config.variables.
    node_enable_experimentals: false`, confirmed by inspecting `process.config`), which isn't a
    problem with the approach - downloading the official nodejs.org release build (the same kind
    `actions/setup-node` installs in CI) and running the full recipe against it produced a real,
    standalone, runnable binary (code-signed ad hoc for this local macOS test only; the real
    Linux CI build needs no such step).
  - **Build/release pipeline**: new `build/build.sh` (adapted from `unraid-docker-folders`'s own
    script, a real currently-published plugin's actual release tooling) computes a date-stamped
    version, runs the full build chain, stages the Slackware filesystem tree, tars it, computes a
    SHA256, and - in `--release` mode only - `sed`/Python-edits the `.plg`'s version/SHA256
    entities and `<CHANGES>`, tags, and `gh release create`/`upload`s the `.txz`. New
    `.github/workflows/release.yml` runs this on `ubuntu-latest` (must be Linux x86_64 - the SEA
    binary embeds a copy of whatever `node` builds it, so a macOS/Windows runner would ship a
    binary that can't run on the target Unraid host), pinned to Node 22.x LTS.
  - `plugin/rc.d/rc.unraid-baywatch` now execs the compiled binary directly (no system
    Node dependency) instead of the placeholder `node dist/index.js` invocation.
  - The `.plg`'s post-install script installs the rc.d script at `/usr/local/etc/rc.d/` -
    matching `daemon-control.php`'s own `$RC_SCRIPT` path (the one the Settings tab's
    Start/Stop/Restart buttons already exercise successfully), not the ad hoc `/etc/rc.d/...`
    path this session's manual dev-restart commands used as a convenience.
  - **Two real bugs found on the first actual install, both fixed and re-released (v2026.09.19,
    v2026.09.19-2):**
    1. `NODE_TLS_REJECT_UNAUTHORIZED=0` was dropped from the rc.d script's `start()` during the
       SEA rework, on the wrong assumption it was tied to "system Node's own trust store." It
       isn't - `unraid-api`'s GraphQL endpoint is served over HTTPS with Unraid's own self-signed
       certificate, and Node's `fetch()`/undici rejects an untrusted cert by default regardless
       of whether it's system Node or a compiled SEA binary. Symptom on the real box: every
       `/disks` call failed with a bare `TypeError: fetch failed` and no visible cause.
       Reproduced and fixed against a real self-signed HTTPS server locally before re-releasing:
       confirmed the exact error text matched, confirmed the cause (`self-signed certificate`)
       was hiding on `err.cause` where a plain `String(err)` never surfaces it, and added
       `server.ts`'s `describeError()` (include `.cause` when present) to the two routes that
       call into `unraid-api` so a future misconfiguration is diagnosable from the UI itself.
    2. Far more serious: **upgrades never actually installed new files, silently, across two
       whole releases.** Confirmed directly against the real box: `upgradepkg --install-new`
       means "install only if nothing by this exact package name is already registered in
       `/var/log/packages` - otherwise skip unconditionally, regardless of whether the file
       content differs." This plugin's `<FILE Name="...">` used a deliberately version-less local
       cache filename (`&name;.txz`) specifically so `removepkg` calls could stay
       version-independent - that choice meant every release registered under the identical
       Slackware package name, so every subsequent install silently no-op'd
       (`upgradepkg`'s own literal output: `Skipping package unraid-baywatch (already
       installed)`), even surviving a full `plugin remove` (Unraid's own outer "is this plugin
       version already installed" bookkeeping - read from a persistent
       `/boot/config/plugins/<name>.plg` symlink target our uninstall script never touched, since
       it's a flat sibling of the config directory we deliberately preserve - and Slackware's own
       inner package-name check are two entirely separate mechanisms). This is exactly why the
       `NODE_TLS_REJECT_UNAUTHORIZED` fix above never reached the box despite two published
       releases and Unraid's plugin manifest correctly showing the newer version each time -
       diagnosed by manually running the exact same `wget`+`sha256sum` and
       `upgradepkg --install-new` commands Unraid's installer runs, directly over SSH, until
       Slackware's own tool printed the smoking gun. Fixed by encoding `&version;` into the local
       cache filename too (matching the real, currently-working `unraid-docker-folders`
       precedent, which does exactly this - confirmed by re-reading its `.plg` a second time
       after this bug, not assumed), plus a defensive pre-install cleanup step (and matching
       `Method="remove"` cleanup) that `removepkg`s any package already registered under our
       name, with or without a version suffix, so a box already affected by the bug self-heals on
       its very next upgrade rather than needing manual intervention.
    - **A second real XML bug caught while fixing the above**: a literal `--` inside an XML
      comment (quoting the install-new flag by name) is invalid per the XML spec - a comment's
      content can never contain `--` except immediately before the closing `-->`. Caught by
      actually parsing the file after editing, not by eyeballing it - the same discipline that
      caught the CDATA/entity-expansion bug earlier.
- **Real README.md - built.** Replaced the 17-line status blurb with actual user-facing
  documentation: features, requirements (Unraid 7.2+, an `unraid-api` key), install instructions
  (manual `.plg` URL paste today), a tab-by-tab usage tour, and a contributing pointer.
- **Settings-tab field for the `unraid-api` key/GraphQL URL - built.** Writing the README's
  install instructions surfaced that `src/config.ts`'s `settings.json` (`apiKey`/`graphqlUrl`)
  had no UI at all - every other setting in this project has one, this didn't. New `GET`/`POST
  /settings` routes in [server.ts](src/server.ts): `GET` never round-trips the saved key back to
  the browser (returns `apiKeySet: boolean` instead, same convention a normal secret-field UI
  uses), and `POST` keeps the existing key when the field is left blank, so updating just the
  GraphQL URL doesn't require re-pasting it. A new "Unraid API connection" section at the top of
  the Settings tab edits both. Confirmed `loadSettings()` is called fresh on every use site
  (`/disks`, `smart-history.ts`'s poll loop, `classic-import.ts`) rather than cached at daemon
  startup - a saved change takes effect on the very next request, no restart needed, unlike the
  daemon's listening port (which genuinely is read once at process start).
- **Community Apps feed entry - published.** A real install was confirmed working end-to-end on
  the live box (both real bugs above fixed and verified) before doing this, per the deferred plan
  this replaces. `unraid-baywatch.xml` in
  [joshmans/unraid-tools](https://github.com/joshmans/unraid-tools) - matched the exact format
  this author's own other two live CA entries in that same repo already use (read directly, not
  guessed at): `<Name>`/`<Overview>`/`<PluginURL>`/`<PluginAuthor>` plus the optional
  `<Support>`/`<Project>`/`<Category>`/`<MinVer>` block, `PluginAuthor` set to the forum handle
  `shwa87` matching those other entries rather than the `.plg`'s own `author` entity (a real
  name) - two different fields, two different real conventions. `MinVer` mirrors the `.plg`'s own
  `min="7.2.0"` attribute, which the file's own comment says CA prefers when both are present.
- **Tray LED now blinks for both a bad status and real drive activity - built.** Two separate
  fixes to [TraySkin.svelte](src/frontend/lib/TraySkin.svelte)'s `.led` dot, which used to be a
  static color swatch with no animation at all (only the outer per-tray glow flashed, and only
  for `critical`):
  1. A slower `step-end` blink (mirroring the classic plugin's status-orb convention in
     `functions_devices.php`'s `get_unraid_disk_status()`) whenever `status` is `warn`/`critical`.
  2. A real, physical-activity-LED-style flicker driven by actual disk I/O, not a power/status
     state - what "the tray LEDs blink" actually meant on the real box, confirmed after an initial
     wrong guess (a slow blink for `disks.isSpinning === false`/standby, reverted) turned out not
     to be it. New [disk-activity.ts](src/disk-activity.ts) reads `/sys/block/<dev>/stat`
     (read/write-completion counters, fields 1 and 5) directly - no unraid-api/GraphQL involved -
     and diffs against the previous sample to say whether a device did any I/O since last asked.
     A new `GET /activity?devices=sda,sdb,...` route in [server.ts](src/server.ts) exposes this;
     deliberately separate from the slow, GraphQL-backed `/disks` (20+ seconds on a big array,
     fetched once) so the frontend can poll it every 1.5s cheaply. [App.svelte](src/frontend/App.svelte)
     only runs that poll while the Tray Map tab is actually visible, and bumps a per-device counter
     (not a boolean) each time a device comes back active - `BayDrive.device` (from `disk.device`,
     threaded through [chassis-types.ts](src/shared/chassis-types.ts)/[derive-drive.ts](src/shared/derive-drive.ts))
     is the join key. `TraySkin.svelte` takes that counter as `flashSeq` and wraps the LED in
     `{#key flashSeq}`, forcing a remount (and replaying its one-shot flash animation) on every
     new tick that found activity - a boolean prop would only animate once at the start of a
     sustained-activity streak instead of continuing to flicker throughout it, verified against a
     synthetic harness driving a fake `flashSeq` at two different cadences. Both animations respect
     `prefers-reduced-motion`.
- **Fixed the whole app inlining itself onto the Tools page - real install bug, fixed in two
  passes.** After installing v2026.09.19c, the entire Tray Map UI rendered directly embedded on
  Unraid's Tools page itself, below Update OS/Downgrade OS/etc, instead of behind its own link.
  Root cause: [BayWatch.page](plugin/pages/BayWatch.page) had `Menu="Tools"`
  directly on the same file that holds the full Svelte app - Unraid's Tools page concatenates the
  body of every `Menu="Tools"` `.page` file directly inline.
  - First attempt (v2026.09.19d, later corrected): added a separate `Menu="Tools"`, `Type="menu"`,
    no-body stub file and moved the real app to `Menu="Utilities"`, on the theory (modeled on
    `HBAviewer.page`+`HBAviewer_Settings.page`, a real currently-published plugin) that a
    `Type="menu"` stub links through to whatever other page shares its `Title`. Wrong: on the real
    box this rendered as its own empty section header ("Bay Watch") on the Tools page,
    with no link and no content - `Type="menu"` creates a *named group section*, it doesn't link
    to an arbitrarily-named `Menu` elsewhere.
  - Actual fix: matched what the classic `disklocation` plugin's own two files do, more precisely
    read this time - `DiskUtilities.page` (`Menu="Tools"`, `Type="menu"`, `Title="Disk Utilities"`,
    no body) creates the "Disk Utilities" section header/group *by that name*, and any other page
    with `Menu="DiskUtilities"` (the group name with spaces stripped) is listed as a tile inside
    it - confirmed live on the user's own box, where unrelated third-party plugins ("Parity
    Problems Assistant", "Preclear Disk") already populate that same shared "Disk Utilities"
    group. So: no Tools-page stub file needed at all. `BayWatch.page` now has
    `Menu="DiskUtilities"`, `Type="xmenu"`, `Tabs="false"` directly - the same shape as the classic
    plugin's own `disklocationsystem.page` (a real, single-tile, non-tabbed page under that group)
    - and shows up as its own tile alongside the existing Disk Utilities entries, matching the
    user's explicit ask ("it should be under the disk utilities section like the legacy plugin").
    The now-pointless `BayWatchTools.page` stub was deleted, and the `.plg`'s post-install
    script `rm -f`s that filename explicitly on upgrade - `upgradepkg` only adds/overwrites files
    the new package lists, it doesn't delete ones only an older package shipped, so leftover stub
    files from v2026.09.19d would otherwise linger forever.

## Conventions carried forward

Same house rules as `unraid-disklocation`: one branch per feature, PR'd and merged
individually; verbose commit messages explaining *why* not just *what*; never bundle or
redistribute trademarked manufacturer logos (relevant again if/when a drive-brand-logo
feature is rebuilt here).
