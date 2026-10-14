<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import TrayMap from "./lib/TrayMap.svelte";
  import Settings from "./lib/Settings.svelte";
  import DiskAssignment from "./lib/DiskAssignment.svelte";
  import SmartHistory from "./lib/SmartHistory.svelte";
  import { driveIconMeta, driveIconSvg } from "./lib/driveicons";
  import DriveIdentity from "./lib/DriveIdentity.svelte";
  import { exampleDrives, emptyLayout } from "./lib/chassis";
  import type {
    ChassisLayout,
    LogoConfig,
    LedColorConfig,
    Assignments,
    BayDrive,
    BayGroup,
    PcieGroup,
    DriveStatus,
    BrandLogoConfig,
    ManufacturerOverrides,
  } from "./lib/chassis";
  import type { DiskResult } from "../graphql/queries";
  import { driveFromDisk } from "../shared/derive-drive";
  import { startDaemon as phpStartDaemon } from "./lib/daemon-control";

  const API_BASE = "/plugins/unraid-baywatch/api";

  type Tab = "map" | "assign" | "identity" | "settings" | "history";
  let activeTab: Tab = "map";

  let liveLayout: ChassisLayout = emptyLayout;
  let liveLogos: LogoConfig = {};
  let liveLedColors: LedColorConfig = {};
  let liveAssignments: Assignments = {};
  let liveSmartHistoryDbPath = "";
  let liveShowRoleColor = false;
  let liveShowRoleIcon = false;
  let liveTempUnit: "C" | "F" = "C";
  let liveBrandLogos: BrandLogoConfig = {};
  let liveManufacturerOverrides: ManufacturerOverrides = {};
  let disks: DiskResult[] | null = null;
  let disksError = "";
  let disksLoading = false;
  // This plugin's own smartctl-derived assessment (src/smart-history.ts) -
  // the only way a real "critical" status is reachable, since unraid-api's
  // smartStatus is OK/UNKNOWN only. Keyed by serial; missing entry means no
  // poll sample yet.
  let historyStatus: Record<string, DriveStatus> = {};
  // Split from disks on purpose: /layout is fast, /disks can take 20+
  // seconds on a large real array (unraid-api gathers SMART data per disk
  // under the hood) - the layout/settings/tray-map structure shouldn't sit
  // blocked behind that.
  let layoutLoaded = false;
  // True once we've confirmed the daemon is reachable and has no saved
  // layout yet (a real, unconfigured production install).
  let productionEmpty = false;
  // False when /layout couldn't be reached at all (network error, or nginx
  // returning a non-ok status because nothing's listening upstream) - shows
  // a "start the daemon" panel instead of ever quietly falling back to
  // demo data, which used to happen here and was actively misleading (a
  // real down daemon looked identical to a normal, working install).
  let daemonReachable = true;
  let startingDaemon = false;
  let startDaemonMessage = "";
  // Guards loadDisks so it only ever fires once. Used to also require at
  // least one bay/PCIe group to exist first (nothing to assign otherwise),
  // but the SMART History tab needs disks/history regardless of whether a
  // chassis has been configured at all - so this just waits for the fast
  // /layout fetch to finish, not for any particular layout content.
  let disksRequested = false;
  // Keyed by device (e.g. "sda"); bumped, not just toggled, so TraySkin can
  // tell two consecutive active polls apart and replay its flash for each
  // one rather than only lighting up once at the start of a busy streak.
  let activity: Record<string, number> = {};
  let activityTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    loadLayout();
  });

  onDestroy(() => stopActivityPolling());

  $: if (layoutLoaded && !disksRequested) {
    disksRequested = true;
    loadDisks();
  }

  // Only while the tray map itself is visible and there's something to
  // poll for - this hits local /sys/block/*/stat reads (see
  // disk-activity.ts), not unraid-api, so it's cheap, but no reason to run
  // it against a tab nobody's looking at.
  $: if (activeTab === "map" && disks && !activityTimer) {
    startActivityPolling();
  } else if ((activeTab !== "map" || !disks) && activityTimer) {
    stopActivityPolling();
  }

  function startActivityPolling() {
    pollActivity();
    activityTimer = setInterval(pollActivity, 1500);
  }

  function stopActivityPolling() {
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = null;
  }

  async function pollActivity() {
    if (!disks?.length) return;
    const devices = disks.map((d) => d.device).filter(Boolean);
    if (!devices.length) return;
    try {
      const res = await fetch(`${API_BASE}/activity?devices=${devices.join(",")}`);
      if (!res.ok) return;
      const result: Record<string, boolean> = await res.json();
      const next = { ...activity };
      for (const [device, wasActive] of Object.entries(result)) {
        if (wasActive) next[device] = (next[device] ?? 0) + 1;
      }
      activity = next;
    } catch {
      // best-effort - a missed tick just means the LED sits solid a moment longer
    }
  }

  async function loadLayout() {
    try {
      const res = await fetch(`${API_BASE}/layout`);
      if (res.ok) {
        daemonReachable = true;
        const stored = await res.json();
        if (stored) {
          liveLayout = stored.layout;
          liveLogos = stored.logos;
          liveAssignments = stored.assignments ?? {};
          liveLedColors = stored.ledColors ?? {};
          liveSmartHistoryDbPath = stored.smartHistoryDbPath ?? "";
          liveShowRoleColor = stored.showRoleColor ?? false;
          liveShowRoleIcon = stored.showRoleIcon ?? false;
          liveTempUnit = stored.tempUnit ?? "C";
          liveBrandLogos = stored.brandLogos ?? {};
          liveManufacturerOverrides = stored.manufacturerOverrides ?? {};
        } else {
          productionEmpty = true;
          liveLayout = emptyLayout;
          liveLogos = {};
          liveLedColors = {};
        }
      } else {
        daemonReachable = false;
      }
    } catch {
      daemonReachable = false;
    }
    layoutLoaded = true;
  }

  async function handleStartDaemon() {
    startingDaemon = true;
    startDaemonMessage = "";
    const result = await phpStartDaemon();
    startDaemonMessage = result.message ?? (result.ok ? "Started" : "Failed to start");
    startingDaemon = false;
    if (result.ok) {
      // Give it a moment to actually come up and start listening before
      // retrying - matches the ~1s the rc.d script itself waits before
      // reporting success.
      setTimeout(loadLayout, 1500);
    }
  }

  async function loadDisks() {
    disksLoading = true;
    try {
      const res = await fetch(`${API_BASE}/disks`);
      if (res.ok) {
        disks = await res.json();
        disksError = "";
      } else {
        disksError = (await res.json())?.error ?? `HTTP ${res.status}`;
      }
    } catch (err) {
      disksError = err instanceof Error ? err.message : String(err);
    }
    disksLoading = false;

    // Best-effort - a disk simply not having a poll sample yet isn't an
    // error state worth surfacing, driveFromDisk() already treats a missing
    // entry as "no negative signal from history yet".
    try {
      const res = await fetch(`${API_BASE}/smart-history/latest`);
      if (res.ok) historyStatus = await res.json();
    } catch {
      // leave historyStatus as-is
    }
  }

  // Real assigned occupancy once disks have loaded; the bundled demo occupancy
  // otherwise (unconfigured daemon, local dev without the proxy in front, or
  // just still loading).
  $: liveDrives = computeDrives(liveAssignments, disks, historyStatus);

  function computeDrives(
    assignments: Assignments,
    disks: DiskResult[] | null,
    historyStatus: Record<string, DriveStatus>,
  ): Record<string, BayDrive> {
    if (!disks) return exampleDrives;
    const bySerial = new Map(disks.map((d) => [d.serialNum, d]));
    const result: Record<string, BayDrive> = {};
    for (const [bayId, serial] of Object.entries(assignments)) {
      const disk = bySerial.get(serial);
      if (disk) result[bayId] = driveFromDisk(disk, historyStatus[serial]);
    }
    return result;
  }

  async function persistAll(next: {
    layout?: ChassisLayout;
    logos?: LogoConfig;
    ledColors?: LedColorConfig;
    assignments?: Assignments;
    smartHistoryDbPath?: string;
    showRoleColor?: boolean;
    showRoleIcon?: boolean;
    tempUnit?: "C" | "F";
    brandLogos?: BrandLogoConfig;
    manufacturerOverrides?: ManufacturerOverrides;
  }): Promise<{ ok: boolean; error?: string }> {
    const merged = {
      layout: next.layout ?? liveLayout,
      logos: next.logos ?? liveLogos,
      ledColors: next.ledColors ?? liveLedColors,
      assignments: next.assignments ?? liveAssignments,
      smartHistoryDbPath: next.smartHistoryDbPath ?? liveSmartHistoryDbPath,
      showRoleColor: next.showRoleColor ?? liveShowRoleColor,
      showRoleIcon: next.showRoleIcon ?? liveShowRoleIcon,
      tempUnit: next.tempUnit ?? liveTempUnit,
      brandLogos: next.brandLogos ?? liveBrandLogos,
      manufacturerOverrides: next.manufacturerOverrides ?? liveManufacturerOverrides,
    };
    try {
      const res = await fetch(`${API_BASE}/layout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(merged),
      });
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      liveLayout = merged.layout;
      liveLogos = merged.logos;
      liveLedColors = merged.ledColors;
      liveAssignments = merged.assignments;
      liveSmartHistoryDbPath = merged.smartHistoryDbPath;
      liveShowRoleColor = merged.showRoleColor;
      liveShowRoleIcon = merged.showRoleIcon;
      liveTempUnit = merged.tempUnit;
      liveBrandLogos = merged.brandLogos;
      liveManufacturerOverrides = merged.manufacturerOverrides;
      // A successful save proves the daemon is reachable, so this always
      // reflects real state going forward (not just the initial classification).
      productionEmpty = merged.layout.groups.length === 0;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  function saveSettings(
    layout: ChassisLayout,
    logos: LogoConfig,
    ledColors: LedColorConfig,
    smartHistoryDbPath: string,
    showRoleColor: boolean,
    showRoleIcon: boolean,
    tempUnit: "C" | "F",
  ) {
    return persistAll({ layout, logos, ledColors, smartHistoryDbPath, showRoleColor, showRoleIcon, tempUnit });
  }

  function saveAssignments(assignments: Assignments) {
    return persistAll({ assignments });
  }

  function saveIdentity(brandLogos: BrandLogoConfig, manufacturerOverrides: ManufacturerOverrides) {
    return persistAll({ brandLogos, manufacturerOverrides });
  }

  function importClassic(groups: BayGroup[], assignments: Assignments) {
    return persistAll({ layout: { ...liveLayout, groups }, assignments });
  }

  // Settings.svelte builds the replacement PcieGroup and the old-bay-id ->
  // new-module-id remap (it already knows the group's bays), but only
  // App.svelte holds the authoritative liveAssignments, so the actual
  // remap - and persisting layout+assignments together, atomically, so a
  // reload never shows the new group with the old group's now-dangling
  // assignments - happens here.
  function convertGroupToPcie(oldGroupId: string, pcieGroup: PcieGroup, idRemap: Record<string, string>) {
    const nextAssignments = { ...liveAssignments };
    for (const [oldId, newId] of Object.entries(idRemap)) {
      if (nextAssignments[oldId] !== undefined) {
        nextAssignments[newId] = nextAssignments[oldId];
        delete nextAssignments[oldId];
      }
    }
    const groups = liveLayout.groups.map((g) => (g.id === oldGroupId ? pcieGroup : g));
    return persistAll({ layout: { ...liveLayout, groups }, assignments: nextAssignments });
  }
</script>

<main>
  <nav class="tabs">
    <button type="button" class:active={activeTab === "map"} on:click={() => (activeTab = "map")}>
      Tray Map
    </button>
    <button type="button" class:active={activeTab === "assign"} on:click={() => (activeTab = "assign")}>
      Disk Assignment
    </button>
    <button type="button" class:active={activeTab === "identity"} on:click={() => (activeTab = "identity")}>
      Drive Identity
    </button>
    <button type="button" class:active={activeTab === "history"} on:click={() => (activeTab = "history")}>
      SMART History
    </button>
    <button type="button" class:active={activeTab === "settings"} on:click={() => (activeTab = "settings")}>
      Settings
    </button>
  </nav>

  <!-- All four tab panels stay mounted once loaded - switching tabs only
       toggles visibility, so nothing re-fetches or re-initializes on every
       switch back to a tab you already visited. -->
  <section class="tab-panel" class:hidden={activeTab !== "map"}>
    {#if !daemonReachable}
      <p class="status err">The plugin's service isn't running.</p>
      <button type="button" on:click={handleStartDaemon} disabled={startingDaemon}>
        {startingDaemon ? "Starting..." : "Start daemon"}
      </button>
      {#if startDaemonMessage}<p class="status">{startDaemonMessage}</p>{/if}
    {:else if layoutLoaded}
      {#if productionEmpty}
        <p class="status">To begin, go to the Settings tab and define at least one tray group.</p>
      {:else}
        <p class="status">
          {liveLayout.name}
          {#if !disks}- occupancy shown here is sample data ({disksError || "loading drives..."}).{/if}
        </p>
        <TrayMap
          layout={liveLayout}
          drives={liveDrives}
          logos={liveLogos}
          ledColors={liveLedColors}
          showRoleColor={liveShowRoleColor}
          showRoleIcon={liveShowRoleIcon}
          brandLogos={liveBrandLogos}
          manufacturerOverrides={liveManufacturerOverrides}
          {activity}
        />

        <section class="legend-panel">
          <h2>Drive types</h2>
          <div class="legend">
            {#each Object.entries(driveIconMeta) as [type, info] (type)}
              <div class="legend-item">
                <div class="legend-icon" style="background:{info.color}">
                  <div class="glyph">{@html driveIconSvg[type] ?? ""}</div>
                </div>
                <div class="legend-text"><strong>{info.name}</strong> - {info.description}</div>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    {:else}
      <p class="status">Loading layout...</p>
    {/if}
  </section>

  <section class="tab-panel" class:hidden={activeTab !== "assign"}>
    <DiskAssignment
      layout={liveLayout}
      {disks}
      {disksError}
      {disksLoading}
      assignments={liveAssignments}
      showRoleColor={liveShowRoleColor}
      save={saveAssignments}
      redetect={loadDisks}
    />
  </section>

  <section class="tab-panel" class:hidden={activeTab !== "identity"}>
    <DriveIdentity
      layout={liveLayout}
      assignments={liveAssignments}
      {disks}
      initialBrandLogos={liveBrandLogos}
      initialManufacturerOverrides={liveManufacturerOverrides}
      save={saveIdentity}
    />
  </section>

  <section class="tab-panel" class:hidden={activeTab !== "history"}>
    <SmartHistory {disks} {disksError} tempUnit={liveTempUnit} />
  </section>

  <section class="tab-panel" class:hidden={activeTab !== "settings"}>
    {#if layoutLoaded}
      <Settings
        initialLayout={liveLayout}
        initialLogos={liveLogos}
        initialLedColors={liveLedColors}
        initialSmartHistoryDbPath={liveSmartHistoryDbPath}
        initialShowRoleColor={liveShowRoleColor}
        initialShowRoleIcon={liveShowRoleIcon}
        initialTempUnit={liveTempUnit}
        save={saveSettings}
        {importClassic}
        {convertGroupToPcie}
      />
    {:else}
      <p class="status">Loading layout...</p>
    {/if}
  </section>
</main>

<style>
  main {
    /* Self-contained panel with its own light/dark pairing rather than
       inheriting the host page's theme - Unraid's webGUI defaults to dark,
       and assuming a light host background made most of this unreadable
       there (confirmed against a real install). */
    --bg: #1b1b1d;
    --bg-panel: #242427;
    --fg: #e9e8e3;
    --muted: #9b9a94;
    --border: rgba(233, 232, 227, 0.14);
    --accent-ok: #4a9d5f;
    --accent-warn: #d9a72e;
    --accent-critical: #c9463c;

    font-family: system-ui, -apple-system, sans-serif;
    /* 720px was fine for the original single-column form layouts, but it
       silently capped every tray/group grid to that width too - a bay
       group set to "fill available space" was really only ever filling
       this box, not the actual browser window, on anything wider than a
       narrow pane. 1400px is a generous dashboard-style cap; still finite
       so text-heavy tabs (Settings) don't stretch to unreadable line
       lengths on an ultrawide monitor. */
    max-width: 1400px;
    background: var(--bg);
    color: var(--fg);
    padding: 16px 20px 24px;
    border-radius: 6px;
  }
  h2 {
    font-size: 15px;
    margin: 20px 0 8px;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 16px;
  }
  .tabs button {
    background: none;
    border: none;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    padding: 8px 12px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .tabs button.active {
    color: var(--fg);
    border-bottom-color: var(--accent-ok);
  }
  .tab-panel.hidden {
    display: none;
  }
  .status {
    font-size: 12px;
    color: var(--muted);
    margin-top: 0;
  }
  .status.err {
    color: var(--accent-critical);
  }
  .legend-panel {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 10px 12px;
    margin-top: 18px;
  }
  .legend-panel h2 {
    margin-top: 0;
  }
  /* One horizontal row of icon-above-description columns by default (there
     are only 3 drive types, so this comfortably fits at the app shell's
     normal widths) - the 480px breakpoint below falls back to a plain
     icon-left/text-right stacked list once a column would get too narrow
     for the description to read well. */
  .legend {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 24px;
  }
  .legend-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 8px;
    font-size: 13px;
    flex: 1 1 160px;
    min-width: 140px;
    max-width: 240px;
  }
  .legend-icon {
    flex: 0 0 auto;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
  }
  .legend-icon .glyph {
    width: 58%;
    height: 58%;
  }
  .legend-icon .glyph :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
  @media (max-width: 480px) {
    .legend {
      flex-direction: column;
      flex-wrap: nowrap;
      gap: 10px;
    }
    .legend-item {
      flex-direction: row;
      text-align: left;
      max-width: none;
    }
    .legend-icon {
      width: 32px;
      height: 32px;
    }
  }
  main button {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 5px 10px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
</style>
