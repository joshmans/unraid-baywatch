<script lang="ts">
  import { onMount } from "svelte";
  import type { ChassisLayout, Assignments, BayDrive, DriveStatus, Group } from "./lib/chassis";
  import { DEFAULT_LED_COLORS } from "./lib/status";
  import { ROLE_BADGE_LETTER, roleBadgeBackground } from "./lib/role";
  import type { DiskResult } from "../graphql/queries";
  import { driveFromDisk } from "../shared/derive-drive";

  // Deliberately independent of App.svelte/main.ts - this mounts into its
  // own tile on Unraid's Dashboard page, in its own small iife bundle
  // (vite.dashboard.config.ts), and only needs a read-only glance at
  // occupancy + health, never the editing state (logos, brand overrides,
  // SMART History tab, Settings) the main app carries. No CSRF/daemon-
  // control here either - this never starts/stops the daemon, only reads.
  const API_BASE = "/plugins/unraid-baywatch/api";

  let daemonReachable = true;
  let productionEmpty = false;
  let layout: ChassisLayout | null = null;
  let assignments: Assignments = {};
  let showRoleColor = false;
  let showRoleIcon = false;

  // Stays null until /disks resolves - occupied boxes render a neutral
  // "unknown" fill in the meantime rather than a misleading default green,
  // since we haven't actually checked health yet.
  let disks: DiskResult[] | null = null;
  let historyStatus: Record<string, DriveStatus> = {};

  onMount(loadLayout);

  async function loadLayout() {
    try {
      const res = await fetch(`${API_BASE}/layout`);
      if (res.ok) {
        daemonReachable = true;
        const stored = await res.json();
        if (stored) {
          layout = stored.layout;
          assignments = stored.assignments ?? {};
          showRoleColor = stored.showRoleColor ?? false;
          showRoleIcon = stored.showRoleIcon ?? false;
          loadDisks();
        } else {
          productionEmpty = true;
        }
      } else {
        daemonReachable = false;
      }
    } catch {
      daemonReachable = false;
    }
  }

  // One-shot, no polling/retry: this tile sits alongside many unrelated
  // Dashboard tiles, so unlike App.svelte it never retries a failed fetch
  // in the background - a miss here just leaves boxes in their neutral
  // "unknown" fill until the next full page load.
  async function loadDisks() {
    try {
      const res = await fetch(`${API_BASE}/disks`);
      if (res.ok) disks = await res.json();
    } catch {
      // best-effort - boxes just stay in the "unknown" fill
    }
    try {
      const res = await fetch(`${API_BASE}/smart-history/latest`);
      if (res.ok) historyStatus = await res.json();
    } catch {
      // leave historyStatus as-is
    }
  }

  $: drives = computeDrives(assignments, disks, historyStatus);

  function computeDrives(
    assignments: Assignments,
    disks: DiskResult[] | null,
    historyStatus: Record<string, DriveStatus>,
  ): Record<string, BayDrive> {
    if (!disks) return {};
    const bySerial = new Map(disks.map((d) => [d.serialNum, d]));
    const result: Record<string, BayDrive> = {};
    for (const [id, serial] of Object.entries(assignments)) {
      const disk = bySerial.get(serial);
      if (disk) result[id] = driveFromDisk(disk, historyStatus[serial]);
    }
    return result;
  }

  function countSlots(l: ChassisLayout): number {
    let total = 0;
    for (const group of l.groups) {
      if (group.kind === "bays") total += group.bays.length;
      else for (const card of group.cards) total += card.moduleCount;
    }
    return total;
  }

  $: totalSlots = layout ? countSlots(layout) : 0;
  $: occupied = Object.keys(assignments).length;

  // A plain flex-wrap row leaves a short group's own leftover height empty
  // rather than filling it with the next group (confirmed live: a short
  // "nvme" group just wrapped onto its own new line under a tall enclosure
  // instead of tucking in beside it) - so groups are greedily packed into
  // two columns by running height instead, in source order, each group
  // going to whichever column is currently shorter. `rows` is used as a
  // height proxy for a bay group; a PCIe group's modules render as one
  // horizontal row, so it only ever counts as 1.
  function groupHeight(g: Group): number {
    return g.kind === "bays" ? g.rows : 1;
  }

  function packColumns(groups: Group[]): [Group[], Group[]] {
    const col0: Group[] = [];
    const col1: Group[] = [];
    let h0 = 0;
    let h1 = 0;
    for (const g of groups) {
      if (h0 <= h1) {
        col0.push(g);
        h0 += groupHeight(g);
      } else {
        col1.push(g);
        h1 += groupHeight(g);
      }
    }
    return [col0, col1];
  }

  $: columns = layout ? packColumns(layout.groups) : [[], []];

  // These take drives/disks/showRoleColor/showRoleIcon as explicit params,
  // not just closed-over state, purely so the *markup* expressions below
  // reference them directly - Svelte's compiler only re-invalidates a node
  // when a variable named in that node's own template expression changes,
  // so a call like `fill(id)` alone silently goes stale the moment /disks
  // resolves after first render (confirmed live: boxes stuck on the
  // "unknown" fill forever without this).
  function fill(id: string, drives: Record<string, BayDrive>, disks: DiskResult[] | null, showRoleColor: boolean): string {
    const drive = drives[id];
    if (!drive) return disks ? "rgba(155, 154, 148, 0.3)" : "var(--unknown)";
    if (showRoleColor) return roleBadgeBackground(drive.role ?? "unassigned");
    return DEFAULT_LED_COLORS[drive.status];
  }

  function badge(id: string, drives: Record<string, BayDrive>, showRoleIcon: boolean): string {
    if (!showRoleIcon) return "";
    const drive = drives[id];
    return drive ? ROLE_BADGE_LETTER[drive.role ?? "unassigned"] : "";
  }
</script>

<div class="dl-dashboard">
  {#if !daemonReachable}
    <p class="status err">The plugin's service isn't running.</p>
  {:else if productionEmpty}
    <p class="status">Bay Watch is not configured.</p>
  {:else if !layout}
    <p class="status">Loading...</p>
  {:else}
    <p class="count">{occupied} of {totalSlots} drives assigned.</p>
    <div class="groups">
      {#each columns as col, i (i)}
        {#if col.length}
          <div class="column">
            {#each col as group (group.id)}
              <div class="group-panel">
                <h4 class="group-label">{group.label}</h4>
                {#if group.kind === "bays"}
                  <div
                    class="grid"
                    style="grid-template-columns: repeat({group.columns}, minmax(0, 1fr)); grid-template-rows: repeat({group.rows}, auto);"
                  >
                    {#each group.bays as bay (bay.id)}
                      {@const isAssigned = bay.id in assignments}
                      <div
                        class="box"
                        class:empty={!isAssigned}
                        style="grid-row:{bay.row + 1};grid-column:{bay.col + 1};{isAssigned ? `background:${fill(bay.id, drives, disks, showRoleColor)}` : ''}"
                        title={group.label}
                      >
                        {#if isAssigned && badge(bay.id, drives, showRoleIcon)}<span class="badge">{badge(bay.id, drives, showRoleIcon)}</span>{/if}
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="cards">
                    {#each group.cards as card (card.id)}
                      <div class="card-modules">
                        {#each Array.from({ length: card.moduleCount }) as _, i (i)}
                          {@const modId = `${card.id}-m${i}`}
                          {@const isAssigned = modId in assignments}
                          <div
                            class="box"
                            class:empty={!isAssigned}
                            style={isAssigned ? `background:${fill(modId, drives, disks, showRoleColor)}` : ""}
                            title="{group.label} - {card.label}"
                          >
                            {#if isAssigned && badge(modId, drives, showRoleIcon)}<span class="badge">{badge(modId, drives, showRoleIcon)}</span>{/if}
                          </div>
                        {/each}
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .dl-dashboard {
    --unknown: #6b6b70;
    font-size: 12px;
  }
  .status {
    color: #9b9a94;
    margin: 0;
  }
  .status.err {
    color: #c9463c;
  }
  .count {
    margin: 0 0 8px;
  }
  /* Two packed columns (see packColumns()) rather than a plain flex-wrap
     row - a shorter group (e.g. a single-row nvme group) now tucks in
     underneath another short group instead of leaving that space empty
     while it wraps onto its own new line. */
  .groups {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 10px;
  }
  .column {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .group-panel {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(155, 154, 148, 0.2);
    border-radius: 4px;
    padding: 6px 8px;
  }
  .group-label {
    margin: 0 0 6px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #9b9a94;
  }
  .grid {
    display: grid;
    gap: 4px;
  }
  .cards {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .card-modules {
    display: flex;
    gap: 4px;
  }
  .box {
    position: relative;
    width: 24px;
    height: 24px;
    border-radius: 3px;
  }
  .box.empty {
    background: rgba(155, 154, 148, 0.12);
    border: 1px solid rgba(155, 154, 148, 0.25);
    box-sizing: border-box;
  }
  .badge {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    color: rgba(0, 0, 0, 0.65);
  }
</style>
