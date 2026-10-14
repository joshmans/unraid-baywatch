<script lang="ts">
  import type { DiskResult } from "../../graphql/queries";
  import TrendChart from "./TrendChart.svelte";
  import { DEFAULT_LED_COLORS } from "./status";

  const API_BASE = "/plugins/unraid-baywatch/api";

  // Every disk unraid-api reports, not just tray-assigned ones - trend
  // history is useful before you've configured a chassis at all.
  export let disks: DiskResult[] | null;
  export let disksError = "";
  export let tempUnit: "C" | "F" = "C";

  interface Sample {
    ts: number;
    status: "ok" | "warn" | "critical";
    temperatureC: number | null;
    powerOnHours: number | null;
    reallocatedSectors: number | null;
    pendingSectors: number | null;
    offlineUncorrectable: number | null;
    mediaErrors: number | null;
    percentageUsed: number | null;
    scsiGrownDefects: number | null;
    healthPassed: boolean | null;
  }

  let selectedSerial = "";
  let history: Sample[] | null = null;
  let historyError = "";

  async function selectDrive() {
    history = null;
    historyError = "";
    if (!selectedSerial) return;
    try {
      const res = await fetch(`${API_BASE}/smart-history?serial=${encodeURIComponent(selectedSerial)}`);
      if (res.ok) {
        history = await res.json();
      } else {
        historyError = (await res.json())?.error ?? `HTTP ${res.status}`;
      }
    } catch (err) {
      historyError = err instanceof Error ? err.message : String(err);
    }
  }

  $: timestamps = history?.map((s) => s.ts) ?? [];

  // Samples are always stored in Celsius (smartctl's own native unit, see
  // smart-history.ts) - Fahrenheit is a display-only conversion done here,
  // never persisted, so switching the Settings toggle never touches history.
  function toDisplayTemp(celsius: number | null): number | null {
    if (celsius === null) return null;
    return tempUnit === "F" ? (celsius * 9) / 5 + 32 : celsius;
  }
</script>

<div class="smart-history">
  {#if disksError}
    <p class="err">
      Couldn't load drives from unraid-api: {disksError}. The daemon needs an API key/URL saved
      (see README) before drives can be listed here.
    </p>
  {:else if !disks}
    <p class="hint">Loading drives...</p>
  {:else if disks.length === 0}
    <p class="hint">No drives detected yet.</p>
  {:else}
    <label class="picker">
      Drive
      <select bind:value={selectedSerial} on:change={selectDrive}>
        <option value="">Select a drive...</option>
        {#each disks as disk (disk.id)}
          <option value={disk.serialNum}>{disk.vendor} {disk.name} - {disk.serialNum}</option>
        {/each}
      </select>
    </label>

    {#if !selectedSerial}
      <p class="hint">Pick a drive to see its SMART history.</p>
    {:else if historyError}
      <p class="err">Couldn't load history: {historyError}</p>
    {:else if history === null}
      <p class="hint">Loading history...</p>
    {:else if history.length === 0}
      <p class="hint">
        No SMART samples recorded yet for this drive - the background poller only samples
        spinning drives, every 30 minutes by default, so a freshly configured install needs a
        little time before there's anything to chart.
      </p>
    {:else}
      <TrendChart
        title={`Temperature (°${tempUnit})`}
        {timestamps}
        series={[
          { label: "Temperature", color: DEFAULT_LED_COLORS.warn, values: history.map((s) => toDisplayTemp(s.temperatureC)) },
        ]}
      />
      <TrendChart
        title="Power-on hours"
        {timestamps}
        series={[{ label: "Power-on hours", color: DEFAULT_LED_COLORS.ok, values: history.map((s) => s.powerOnHours) }]}
      />
      <TrendChart
        title="Sector health"
        {timestamps}
        series={[
          { label: "Reallocated", color: DEFAULT_LED_COLORS.ok, values: history.map((s) => s.reallocatedSectors) },
          { label: "Pending", color: DEFAULT_LED_COLORS.warn, values: history.map((s) => s.pendingSectors) },
          {
            label: "Offline uncorrectable",
            color: DEFAULT_LED_COLORS.critical,
            values: history.map((s) => s.offlineUncorrectable),
          },
          {
            label: "SCSI grown defects",
            color: "#2f6fd6",
            values: history.map((s) => s.scsiGrownDefects),
          },
        ]}
      />
    {/if}
  {/if}
</div>

<style>
  .smart-history {
    font-size: 13px;
  }
  .picker {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 16px;
    max-width: 320px;
  }
  .hint {
    color: var(--muted);
  }
  .err {
    color: var(--accent-critical);
  }
  .smart-history :global(select) {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 5px 10px;
    font: inherit;
    font-size: 13px;
  }
</style>
