<script lang="ts">
  import { onMount } from "svelte";
  import type { ChassisLayout, Assignments } from "./chassis";
  import type { DiskResult } from "../../graphql/queries";
  import { ROLE_COLORS, roleLabel, formatSize } from "./role";

  const API_BASE = "/plugins/unraid-baywatch/api";

  // Read-only inputs; App.svelte owns the fetch/persist for the same reason
  // Settings.svelte does - one source of truth for the stored document.
  export let layout: ChassisLayout;
  export let disks: DiskResult[] | null;
  export let disksError = "";
  export let disksLoading = false;
  export let assignments: Assignments;
  export let showRoleColor = false;
  export let save: (assignments: Assignments) => Promise<{ ok: boolean; error?: string }>;
  export let redetect: () => Promise<void>;

  let locating = new Set<string>();
  let selectedBay: Record<string, string> = {};
  let status: "idle" | "saving" | "error" = "idle";
  let errorMessage = "";

  onMount(async () => {
    try {
      const res = await fetch(`${API_BASE}/locate`);
      if (res.ok) {
        const { devices } = await res.json();
        locating = new Set(devices);
      }
    } catch {
      // best-effort sync of already-running locate sessions after a reload
    }
  });

  // Every assignable slot in the layout: a bay id, or `${cardId}-m${index}` per PCIe module.
  $: allSlots = layout.groups.flatMap((g) => {
    if (g.kind === "bays") {
      return g.bays.map((b, i) => ({ id: b.id, label: `${g.label} - Bay ${i + 1}` }));
    }
    return g.cards.flatMap((c) =>
      Array.from({ length: c.moduleCount }, (_, i) => ({
        id: `${c.id}-m${i}`,
        label: `${g.label} - ${c.label} - module ${i + 1}`,
      })),
    );
  });
  $: emptySlots = allSlots.filter((slot) => !assignments[slot.id]);
  $: slotLabel = new Map(allSlots.map((s) => [s.id, s.label]));
  $: slotOrder = new Map(allSlots.map((s, i) => [s.id, i]));

  interface Row {
    disk?: DiskResult;
    bayId?: string;
    serial: string;
  }

  // Assigned rows first (per bay assignment, resolved to its disk when
  // currently detected - unresolved means a bay is assigned to a disk that
  // isn't showing up right now, e.g. removed/renamed device, still worth
  // surfacing rather than silently dropping), then every still-unassigned
  // detected disk. One flat list so zebra striping/sorting apply uniformly
  // instead of two disconnected sections.
  $: rows = ((): Row[] => {
    const bySerial = new Map((disks ?? []).map((d) => [d.serialNum, d]));
    const assignedRows: Row[] = Object.entries(assignments)
      .map(([bayId, serial]) => ({ disk: bySerial.get(serial), bayId, serial }))
      // Object.entries follows insertion order (whenever each bay happened
      // to get assigned), not bay position - sort by each bay's actual
      // position in the layout so the list reads top-to-bottom/in-order
      // instead of however assignment history left it.
      .sort((a, b) => (slotOrder.get(a.bayId) ?? Infinity) - (slotOrder.get(b.bayId) ?? Infinity));
    const assignedSerials = new Set(Object.values(assignments));
    const unassignedRows: Row[] = (disks ?? [])
      .filter((d) => !assignedSerials.has(d.serialNum))
      .map((d) => ({ disk: d, serial: d.serialNum }));
    return [...assignedRows, ...unassignedRows];
  })();
  $: unassignedCount = rows.filter((r) => !r.bayId).length;

  async function toggleLocate(device: string) {
    const starting = !locating.has(device);
    try {
      await fetch(`${API_BASE}/locate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device, action: starting ? "start" : "stop" }),
      });
    } catch {
      // best-effort - the backend also auto-stops after a few minutes as a safety net
    }
    if (starting) locating.add(device);
    else locating.delete(device);
    locating = locating;
  }

  async function stopAllLocate() {
    try {
      await fetch(`${API_BASE}/locate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "stopAll" }),
      });
    } catch {
      // best-effort
    }
    locating = new Set();
  }

  async function persist(next: Assignments) {
    status = "saving";
    const result = await save(next);
    status = result.ok ? "idle" : "error";
    errorMessage = result.error ?? "";
  }

  async function assign(disk: DiskResult) {
    const bayId = selectedBay[disk.serialNum];
    if (!bayId) return;
    if (locating.has(disk.device)) await toggleLocate(disk.device);
    await persist({ ...assignments, [bayId]: disk.serialNum });
  }

  async function unassign(bayId: string) {
    const next = { ...assignments };
    delete next[bayId];
    await persist(next);
  }
</script>

<div class="assignment">
  {#if layout.groups.length === 0}
    <p class="hint">
      Define at least one bay or PCIe group in the Settings tab before assigning disks. A disk
      detection will be triggered once a group is detected.
    </p>
  {:else}
    <div class="section-header">
      <h3>Detected drives</h3>
      <button type="button" on:click={redetect} disabled={disksLoading}>
        {disksLoading ? "Detecting..." : "Force (re)detect"}
      </button>
    </div>
    {#if disksError}
      <p class="err">
        Couldn't load drives from unraid-api: {disksError}. The daemon needs an API key/URL saved
        (see README) before drives can be listed here.
      </p>
    {:else if disks === null}
      <p class="hint">Loading drives...</p>
    {:else}
      <div class="section-header">
        <h3>Drives ({Object.keys(assignments).length} assigned, {unassignedCount} unassigned)</h3>
        {#if locating.size > 0}
          <button type="button" on:click={stopAllLocate}>Stop all locate ({locating.size})</button>
        {/if}
      </div>
      {#if rows.length === 0}
        <p class="hint">No drives detected yet.</p>
      {/if}
      <div class="drive-list">
        {#each rows as row (row.bayId ?? row.serial)}
          {@const role = row.disk?.role}
          <div
            class="drive-row"
            class:role-tinted={showRoleColor}
            style="--role-color:{role ? ROLE_COLORS[role] : 'transparent'}"
          >
            <div class="drive-info">
              {#if row.disk}
                <strong>{row.disk.vendor} {row.disk.name}</strong>
                <span class="mono">{row.serial}</span>
                <span class="hint">
                  {row.disk.interfaceType}{#if formatSize(row.disk.sizeBytes)} - {formatSize(row.disk.sizeBytes)}{/if}
                  {#if role} - {roleLabel(role, row.disk.poolName)}{/if}
                </span>
              {:else}
                <strong>Not currently detected</strong>
                <span class="mono">{row.serial}</span>
              {/if}
            </div>
            {#if row.bayId}
              <span class="mono bay-label">{slotLabel.get(row.bayId) ?? row.bayId}</span>
              {#if row.disk}
                <button
                  type="button"
                  class:active={locating.has(row.disk.device)}
                  on:click={() => toggleLocate(row.disk.device)}
                >
                  {locating.has(row.disk.device) ? "Stop" : "Locate"}
                </button>
              {/if}
              <button type="button" on:click={() => unassign(row.bayId)}>Unassign</button>
            {:else if row.disk}
              <button
                type="button"
                class:active={locating.has(row.disk.device)}
                on:click={() => toggleLocate(row.disk.device)}
              >
                {locating.has(row.disk.device) ? "Stop" : "Locate"}
              </button>
              <select bind:value={selectedBay[row.disk.serialNum]}>
                <option value="">Assign to...</option>
                {#each emptySlots as slot (slot.id)}
                  <option value={slot.id}>{slot.label}</option>
                {/each}
              </select>
              <button type="button" disabled={!selectedBay[row.disk.serialNum]} on:click={() => assign(row.disk)}>
                Assign
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
  {#if status === "error"}<p class="err">Error: {errorMessage}</p>{/if}
</div>

<style>
  .assignment {
    font-size: 13px;
  }
  .section-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  h3 {
    font-size: 13px;
    margin: 12px 0 4px;
  }
  .hint {
    color: var(--muted);
  }
  .drive-list {
    display: flex;
    flex-direction: column;
  }
  .drive-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    border-left: 3px solid transparent;
  }
  /* Zebra striping so a long real array's rows stay visually separable at a
     glance - nth-child works cleanly here since rows are the only direct
     children of .drive-list (no interleaved headers breaking the count). */
  .drive-row:nth-child(even) {
    background: rgba(255, 255, 255, 0.025);
  }
  .drive-row.role-tinted {
    border-left-color: var(--role-color);
  }
  .drive-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .bay-label {
    color: var(--muted);
  }
  .mono {
    font: 12px ui-monospace, "SFMono-Regular", Menlo, monospace;
  }
  .assignment :global(button),
  .assignment :global(select) {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 5px 10px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .assignment :global(button.active) {
    background: var(--accent-warn);
    color: #1b1b1d;
    border-color: var(--accent-warn);
  }
  .err {
    color: var(--accent-critical);
  }
</style>
