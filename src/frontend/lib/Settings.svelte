<script lang="ts">
  import { onMount } from "svelte";
  import type { ChassisLayout, BayGroup, PcieGroup, BayConfig, LogoConfig, LedColorConfig, DriveStatus, Orientation } from "./chassis";
  import { DEFAULT_PCIE_CARD_WIDTH_PX } from "./chassis";
  import { skins } from "./trayskins";
  import { pcieCarriers } from "./pciecarriers";
  import { resolveLedColor } from "./status";
  import { getDaemonStatus, startDaemon, stopDaemon, setDaemonPort, type DaemonStatus } from "./daemon-control";
  import { uploadLogoFile } from "./logo-upload";
  import { uid } from "./uid";

  // App.svelte owns the fetch/persist and the assignments this layout's bay
  // ids get joined against elsewhere, so it stays the single source of truth
  // for the whole stored document - this component only edits a draft copy
  // and hands it back through `save` (a prop, not an event, so it can await
  // the result and show success/failure inline).
  export let initialLayout: ChassisLayout;
  export let initialLogos: LogoConfig;
  export let initialLedColors: LedColorConfig;
  export let initialSmartHistoryDbPath = "";
  export let initialShowRoleColor = false;
  export let initialShowRoleIcon = false;
  export let initialTempUnit: "C" | "F" = "C";
  export let save: (
    layout: ChassisLayout,
    logos: LogoConfig,
    ledColors: LedColorConfig,
    smartHistoryDbPath: string,
    showRoleColor: boolean,
    showRoleIcon: boolean,
    tempUnit: "C" | "F",
  ) => Promise<{ ok: boolean; error?: string }>;
  export let importClassic: (
    groups: BayGroup[],
    assignments: Record<string, string>,
  ) => Promise<{ ok: boolean; error?: string }>;
  export let convertGroupToPcie: (
    oldGroupId: string,
    pcieGroup: PcieGroup,
    idRemap: Record<string, string>,
  ) => Promise<{ ok: boolean; error?: string }>;

  const API_BASE = "/plugins/unraid-baywatch/api";
  const DEFAULT_SMART_DB_PATH = "/boot/config/plugins/unraid-baywatch/smart-history.db";

  interface ImportPreview {
    available: boolean;
    groups?: BayGroup[];
    assignments?: Record<string, string>;
    matchedCount?: number;
    totalLocations?: number;
    skippedGroups?: { name: string; reason: string }[];
    outOfRange?: { groupName: string; tray: number }[];
  }

  function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }

  let layout: ChassisLayout = clone(initialLayout);
  let logos: LogoConfig = { ...initialLogos };
  let ledColors: LedColorConfig = clone(initialLedColors);
  let smartHistoryDbPath = initialSmartHistoryDbPath;
  let showRoleColor = initialShowRoleColor;
  let showRoleIcon = initialShowRoleIcon;
  let tempUnit = initialTempUnit;
  let status: "idle" | "saving" | "saved" | "error" = "idle";
  let errorMessage = "";

  let daemonStatus: DaemonStatus | null = null;
  let daemonActionInFlight = false;
  let daemonMessage = "";
  let portDraft = "";

  async function refreshDaemonStatus() {
    daemonStatus = await getDaemonStatus();
    if (daemonStatus) portDraft = String(daemonStatus.port);
  }

  onMount(refreshDaemonStatus);

  let classicPreview: ImportPreview | null = null;
  let classicImporting = false;
  let classicMessage = "";

  onMount(async () => {
    try {
      const res = await fetch(`${API_BASE}/classic-import/preview`);
      if (res.ok) classicPreview = await res.json();
    } catch {
      // No classic plugin, or daemon not reachable yet - section just stays hidden.
    }
  });

  // apiKey is never sent back down from GET /settings once saved (see
  // server.ts) - apiKeySet just says whether one already exists, and the
  // input starts blank; leaving it blank on save keeps whatever's stored.
  let apiGraphqlUrl = "";
  let apiKeyDraft = "";
  let apiKeySet = false;
  let apiConnStatus: "idle" | "loading" | "saving" | "saved" | "error" = "loading";
  let apiConnMessage = "";

  // The daemon runs on the same box as the webGUI that's serving this page
  // right now, so the current page's own host is a reliable guess at the
  // GraphQL endpoint's host too - only used to prefill a brand-new install's
  // still-empty field (never overwrites a saved value), and the user can
  // still edit it before saving.
  function guessGraphqlUrl(): string {
    const { protocol, hostname, port } = window.location;
    const standardPort = protocol === "https:" ? "443" : "80";
    const portSuffix = port && port !== standardPort ? `:${port}` : "";
    return `${protocol}//${hostname}${portSuffix}/graphql`;
  }

  onMount(async () => {
    try {
      const res = await fetch(`${API_BASE}/settings`);
      if (res.ok) {
        const data = await res.json();
        apiGraphqlUrl = data.graphqlUrl || guessGraphqlUrl();
        apiKeySet = !!data.apiKeySet;
      }
      apiConnStatus = "idle";
    } catch {
      apiConnStatus = "error";
      apiConnMessage = "Couldn't reach the daemon";
    }
  });

  async function onSaveApiSettingsClick() {
    apiConnStatus = "saving";
    apiConnMessage = "";
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: apiKeyDraft || undefined, graphqlUrl: apiGraphqlUrl }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      apiKeySet = apiKeySet || !!apiKeyDraft;
      apiKeyDraft = "";
      apiConnStatus = "saved";
      setTimeout(() => {
        if (apiConnStatus === "saved") apiConnStatus = "idle";
      }, 2000);
    } catch (err) {
      apiConnStatus = "error";
      apiConnMessage = err instanceof Error ? err.message : String(err);
    }
  }

  async function onImportClassicClick() {
    if (!classicPreview?.groups) return;
    classicImporting = true;
    classicMessage = "";
    const result = await importClassic(classicPreview.groups, classicPreview.assignments ?? {});
    classicMessage = result.ok ? "Imported" : `Error: ${result.error}`;
    classicImporting = false;
  }

  async function onStartDaemonClick() {
    daemonActionInFlight = true;
    daemonMessage = "";
    const result = await startDaemon();
    daemonMessage = result.message ?? (result.ok ? "Started" : "Failed to start");
    daemonActionInFlight = false;
    setTimeout(refreshDaemonStatus, 1500);
  }

  async function onStopDaemonClick() {
    daemonActionInFlight = true;
    daemonMessage = "";
    const result = await stopDaemon();
    daemonMessage = result.message ?? (result.ok ? "Stopped" : "Failed to stop");
    daemonActionInFlight = false;
    setTimeout(refreshDaemonStatus, 1500);
  }

  async function onSavePortClick() {
    const port = parseInt(portDraft, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      daemonMessage = "Port must be an integer between 1 and 65535";
      return;
    }
    daemonActionInFlight = true;
    daemonMessage = "";
    const result = await setDaemonPort(port);
    daemonMessage = result.message ?? (result.ok ? "Saved" : "Failed to save");
    daemonActionInFlight = false;
    refreshDaemonStatus();
  }

  const LED_STATUSES: DriveStatus[] = ["ok", "warn", "critical"];
  const LED_STATUS_LABELS: Record<DriveStatus, string> = { ok: "OK", warn: "Warn", critical: "Critical" };

  function buildBays(rows: number, columns: number, existing: BayConfig[]): BayConfig[] {
    const byPos = new Map(existing.map((b) => [`${b.row}-${b.col}`, b]));
    const bays: BayConfig[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const prior = byPos.get(`${row}-${col}`);
        bays.push(
          prior ?? {
            id: `bay-${uid()}`,
            row,
            col,
            skinId: skins[0]?.id ?? "classic",
            orientation: "horizontal",
          },
        );
      }
    }
    return bays;
  }

  function resizeGroup(group: BayGroup, rows: number, columns: number) {
    group.rows = Math.max(1, rows);
    group.columns = Math.max(1, columns);
    group.bays = buildBays(group.rows, group.columns, group.bays);
    layout = layout;
  }

  function setGroupSkin(group: BayGroup, skinId: string) {
    group.bays = group.bays.map((b) => ({ ...b, skinId }));
    layout = layout;
  }

  function setGroupOrientation(group: BayGroup, orientation: string) {
    const o = orientation as Orientation;
    group.bays = group.bays.map((b) => ({ ...b, orientation: o }));
    layout = layout;
  }

  function setGroupWidth(group: BayGroup, raw: string) {
    const trimmed = raw.trim();
    group.widthPx = trimmed ? Math.max(200, +trimmed) : undefined;
    layout = layout;
  }

  function addGroup(kind: "bays" | "pcie") {
    const group: BayGroup | PcieGroup =
      kind === "bays"
        ? { kind: "bays", id: `group-${uid()}`, label: "New bay group", rows: 1, columns: 4, bays: buildBays(1, 4, []) }
        : {
            kind: "pcie",
            id: `pcie-${uid()}`,
            label: "New PCIe group",
            cards: [{ id: `card-${uid()}`, carrierId: pcieCarriers[0]?.id ?? "default", label: "x16 NVMe carrier", moduleCount: 4 }],
          };
    layout.groups = [...layout.groups, group];
  }

  function removeGroup(id: string) {
    layout.groups = layout.groups.filter((g) => g.id !== id);
  }

  let convertingGroupId: string | null = null;
  let convertMessage = "";

  // Replaces a bay group with an equivalent single-card PCIe group - useful
  // after importing from the classic plugin, which has no PCIe-carrier
  // concept and always imports every group as bays, even ones that are
  // really M.2/U.2 carriers. Module ids are new (`${cardId}-m${i}`), so this
  // persists immediately through App.svelte (like importClassic) rather than
  // just editing the draft, since only App.svelte holds the live assignments
  // that need remapping from the old bay ids to the new module ids in the
  // same step - otherwise a save here would silently strand them.
  async function onConvertToPcieClick(group: BayGroup) {
    convertingGroupId = group.id;
    convertMessage = "";
    const cardId = `card-${uid()}`;
    const idRemap: Record<string, string> = {};
    group.bays.forEach((bay, i) => (idRemap[bay.id] = `${cardId}-m${i}`));
    const pcieGroup: PcieGroup = {
      kind: "pcie",
      id: group.id,
      label: group.label,
      cards: [{ id: cardId, carrierId: pcieCarriers[0]?.id ?? "default", label: group.label, moduleCount: group.bays.length }],
    };
    const result = await convertGroupToPcie(group.id, pcieGroup, idRemap);
    if (result.ok) {
      layout.groups = layout.groups.map((g) => (g.id === group.id ? pcieGroup : g));
    } else {
      convertMessage = `Error: ${result.error}`;
    }
    convertingGroupId = null;
  }

  function addCard(group: PcieGroup) {
    group.cards = [
      ...group.cards,
      { id: `card-${uid()}`, carrierId: pcieCarriers[0]?.id ?? "default", label: "New card", moduleCount: 4 },
    ];
    layout = layout;
  }

  function removeCard(group: PcieGroup, id: string) {
    group.cards = group.cards.filter((c) => c.id !== id);
    layout = layout;
  }

  function setLogo(skinId: string, url: string) {
    logos = { ...logos, [skinId]: url };
  }

  let logoUploadMessage = "";

  async function onLogoFileChange(skinId: string, e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    logoUploadMessage = "Uploading...";
    const result = await uploadLogoFile("skin", skinId, file);
    if (result.ok && result.url) {
      setLogo(skinId, result.url);
      logoUploadMessage = "";
    } else {
      logoUploadMessage = `Error: ${result.error}`;
    }
    input.value = "";
  }

  function setLedColor(skinId: string, ledStatus: DriveStatus, color: string) {
    ledColors = { ...ledColors, [skinId]: { ...ledColors[skinId], [ledStatus]: color } };
  }

  function resetLedColors(skinId: string) {
    const next = { ...ledColors };
    delete next[skinId];
    ledColors = next;
  }

  async function onSaveClick() {
    status = "saving";
    errorMessage = "";
    const result = await save(
      clone(layout),
      { ...logos },
      clone(ledColors),
      smartHistoryDbPath.trim(),
      showRoleColor,
      showRoleIcon,
      tempUnit,
    );
    if (result.ok) {
      status = "saved";
      setTimeout(() => {
        if (status === "saved") status = "idle";
      }, 2000);
    } else {
      status = "error";
      errorMessage = result.error ?? "unknown error";
    }
  }
</script>

<div class="settings">
  <section class="settings-section">
    <h3>Unraid API connection</h3>
    <p class="hint">
      This plugin is a standalone service that reads disk/array data from Unraid's own
      <code>unraid-api</code> over GraphQL - it needs an API key with read access to disk/array
      data. Generate one from Unraid's own Settings &gt; Management Access (or
      <code>unraid-api apikey</code> on the command line).
    </p>
    <label class="db-path-row">
      GraphQL URL
      <input type="text" placeholder="https://localhost/graphql" bind:value={apiGraphqlUrl} />
    </label>
    <label class="db-path-row">
      API key
      <input
        type="password"
        placeholder={apiKeySet ? "•••••••• (set - leave blank to keep)" : "paste your unraid-api key"}
        bind:value={apiKeyDraft}
        autocomplete="off"
      />
    </label>
    <div class="save-row">
      <button type="button" on:click={onSaveApiSettingsClick} disabled={apiConnStatus === "saving"}>
        {apiConnStatus === "saving" ? "Saving..." : "Save"}
      </button>
      {#if apiConnStatus === "saved"}<span class="ok">Saved</span>{/if}
      {#if apiConnStatus === "error"}<span class="err">Error: {apiConnMessage}</span>{/if}
    </div>
  </section>

  {#if classicPreview?.available}
    <section class="settings-section">
      <h3>Import from classic plugin</h3>
      <p class="hint">
        Found {classicPreview.groups?.length ?? 0} group(s) from the original Disk Location
        plugin - {classicPreview.matchedCount ?? 0} of {classicPreview.totalLocations ?? 0} tray
        assignments matched a currently connected disk.
        {#if classicPreview.skippedGroups?.length}
          Skipped: {classicPreview.skippedGroups.map((g) => `${g.name} (${g.reason})`).join(", ")}.
        {/if}
      </p>
      {#if classicPreview.outOfRange?.length}
        <p class="hint err">
          {classicPreview.outOfRange.length} assignment(s) referenced a tray number outside that
          group's own grid size and were dropped as invalid:
          {classicPreview.outOfRange.map((o) => `${o.groupName} tray ${o.tray}`).join(", ")}.
        </p>
      {/if}
      <p class="hint">Importing replaces your current chassis layout and disk assignments.</p>
      <div class="save-row">
        <button type="button" on:click={onImportClassicClick} disabled={classicImporting}>
          {classicImporting ? "Importing..." : "Import (replaces current layout)"}
        </button>
        {#if classicMessage}<span class:ok={classicMessage === "Imported"} class:err={classicMessage !== "Imported"}>{classicMessage}</span>{/if}
      </div>
    </section>
  {/if}

  <section class="settings-section">
  <h3>Chassis layout</h3>
  <div class="role-toggles">
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={showRoleColor} />
      Color-code bays by role (parity/data/cache/boot)
    </label>
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={showRoleIcon} />
      Icon badge for role (hover for pool name on cache disks)
    </label>
  </div>
  {#if convertMessage}<p class="hint err">{convertMessage}</p>{/if}
  {#each layout.groups as group (group.id)}
    <div class="group-editor">
      <div class="group-header">
        <input type="text" bind:value={group.label} placeholder="Group label" />
        {#if group.kind === "bays"}
          <button type="button" on:click={() => onConvertToPcieClick(group)} disabled={convertingGroupId === group.id}>
            {convertingGroupId === group.id ? "Converting..." : "Convert to PCIe group"}
          </button>
        {/if}
        <button type="button" class="remove" on:click={() => removeGroup(group.id)}>Remove group</button>
      </div>

      {#if group.kind === "bays"}
        <div class="fields">
          <label>
            Rows
            <input
              type="number"
              min="1"
              value={group.rows}
              on:change={(e) => resizeGroup(group, +e.currentTarget.value, group.columns)}
            />
          </label>
          <label>
            Columns
            <input
              type="number"
              min="1"
              value={group.columns}
              on:change={(e) => resizeGroup(group, group.rows, +e.currentTarget.value)}
            />
          </label>
          <label>
            Skin
            <select value={group.bays[0]?.skinId} on:change={(e) => setGroupSkin(group, e.currentTarget.value)}>
              {#each skins as s (s.id)}
                <option value={s.id}>{s.name}</option>
              {/each}
            </select>
          </label>
          <label>
            Orientation
            <select
              value={group.bays[0]?.orientation}
              on:change={(e) => setGroupOrientation(group, e.currentTarget.value)}
            >
              <option value="horizontal">Horizontal (3.5&quot;)</option>
              <option value="vertical">Vertical (2.5&quot;)</option>
            </select>
          </label>
          <label>
            Width (px)
            <input
              type="number"
              min="200"
              max="2000"
              placeholder="Auto"
              value={group.widthPx ?? ""}
              on:change={(e) => setGroupWidth(group, e.currentTarget.value)}
            />
          </label>
        </div>
        <p class="hint">{group.bays.length} bay(s). Skin/orientation apply to the whole group. Width is optional - leave blank to fill the available space (the default); set it to make this group's bays render larger (or smaller) than that.</p>
      {:else}
        {#each group.cards as card (card.id)}
          <div class="fields card-row">
            <label class="grow">
              Label
              <input type="text" bind:value={card.label} />
            </label>
            <label>
              Modules
              <input type="number" min="1" max="8" bind:value={card.moduleCount} />
            </label>
            <label>
              Shell
              <select bind:value={card.carrierId}>
                {#each pcieCarriers as c (c.id)}
                  <option value={c.id}>{c.name}</option>
                {/each}
              </select>
            </label>
            <label>
              Width (px)
              <input
                type="number"
                min="120"
                max="900"
                value={card.widthPx ?? DEFAULT_PCIE_CARD_WIDTH_PX}
                on:change={(e) => (card.widthPx = +e.currentTarget.value)}
              />
            </label>
            <button type="button" class="remove" on:click={() => removeCard(group, card.id)}>Remove</button>
          </div>
        {/each}
        <button type="button" on:click={() => addCard(group)}>Add card</button>
      {/if}
    </div>
  {/each}

  <div class="add-group">
    <button type="button" on:click={() => addGroup("bays")}>+ Bay group</button>
    <button type="button" on:click={() => addGroup("pcie")}>+ PCIe group</button>
  </div>

  <div class="save-row">
    <button type="button" on:click={onSaveClick} disabled={status === "saving"}>
      {status === "saving" ? "Saving..." : "Save Layout"}
    </button>
    {#if status === "saved"}<span class="ok">Saved</span>{/if}
    {#if status === "error"}<span class="err">Error: {errorMessage}</span>{/if}
  </div>
  </section>

  <section class="settings-section">
    <h3>Manufacturer logos</h3>
    <p class="hint">
      Hotlinked logo URL applied to every bay using that skin, or upload your own SVG
      instead (stored on this box, no hotlinking needed). Leave blank for none.
    </p>
    {#if logoUploadMessage}<p class="hint" class:err={logoUploadMessage.startsWith("Error")}>{logoUploadMessage}</p>{/if}
    {#each skins as s (s.id)}
      <label class="logo-row">
        <span>{s.name}</span>
        <input
          type="url"
          placeholder="https://..."
          value={logos[s.id] ?? ""}
          on:change={(e) => setLogo(s.id, e.currentTarget.value)}
        />
        <input type="file" accept=".svg,image/svg+xml" on:change={(e) => onLogoFileChange(s.id, e)} />
      </label>
    {/each}
    <div class="save-row">
      <button type="button" on:click={onSaveClick} disabled={status === "saving"}>
        {status === "saving" ? "Saving..." : "Save Logos"}
      </button>
      {#if status === "saved"}<span class="ok">Saved</span>{/if}
      {#if status === "error"}<span class="err">Error: {errorMessage}</span>{/if}
    </div>
  </section>

  <section class="settings-section">
    <h3>LED colors</h3>
    <p class="hint">
      Each skin has its own default status-LED color (real trays don't all blink the same color) -
      override any of them here. Reset clears an override back to that skin's default.
    </p>
    {#each skins as s (s.id)}
      <div class="led-row">
        <span class="skin-name">{s.name}</span>
        {#each LED_STATUSES as st (st)}
          <label class="led-swatch">
            {LED_STATUS_LABELS[st]}
            <input
              type="color"
              value={resolveLedColor(s, ledColors, st)}
              on:input={(e) => setLedColor(s.id, st, e.currentTarget.value)}
            />
          </label>
        {/each}
        <button
          type="button"
          class="remove"
          disabled={!ledColors[s.id]}
          on:click={() => resetLedColors(s.id)}
        >
          Reset
        </button>
      </div>
    {/each}
    <div class="save-row">
      <button type="button" on:click={onSaveClick} disabled={status === "saving"}>
        {status === "saving" ? "Saving..." : "Save Colors"}
      </button>
      {#if status === "saved"}<span class="ok">Saved</span>{/if}
      {#if status === "error"}<span class="err">Error: {errorMessage}</span>{/if}
    </div>
  </section>

  <section class="settings-section">
    <h3>Daemon</h3>
    {#if daemonStatus === null}
      <p class="hint">Checking daemon status...</p>
    {:else}
      <p class="hint">
        Status:
        <span class:ok={daemonStatus.running} class:err={!daemonStatus.running}>
          {daemonStatus.running ? `Running on port ${daemonStatus.port}` : `Not running (configured port: ${daemonStatus.port})`}
        </span>
      </p>
      <div class="daemon-row">
        <button type="button" on:click={onStartDaemonClick} disabled={daemonActionInFlight}>
          {daemonActionInFlight ? "Working..." : daemonStatus.running ? "Restart daemon" : "Start daemon"}
        </button>
        {#if daemonStatus.running}
          <button type="button" on:click={onStopDaemonClick} disabled={daemonActionInFlight}>
            {daemonActionInFlight ? "Working..." : "Stop daemon"}
          </button>
        {/if}
      </div>
      <label class="db-path-row">
        Port
        <input type="number" min="1" max="65535" bind:value={portDraft} disabled={daemonStatus.running} />
      </label>
      <button type="button" on:click={onSavePortClick} disabled={daemonStatus.running || daemonActionInFlight}>
        Save Port
      </button>
      <p class="hint">
        Only changeable while the daemon isn't running, so a Docker container or another
        service can't collide with whatever it's currently bound to. Takes effect the next
        time it starts.
      </p>
    {/if}
    {#if daemonMessage}<p class="hint">{daemonMessage}</p>{/if}
  </section>

  <section class="settings-section">
    <h3>Storage</h3>
    <label class="db-path-row">
      SMART history database path
      <input type="text" bind:value={smartHistoryDbPath} placeholder={DEFAULT_SMART_DB_PATH} />
    </label>
    <p class="hint">
      This is the one file this plugin writes to often (every SMART poll cycle) rather than
      only when you save a change here, and the default lives on the flash boot drive - some
      people prefer to redirect it to the array or a cache pool instead. Leave blank to use
      the default. Takes effect the next time the plugin's service restarts.
    </p>
    <label class="db-path-row">
      Temperature unit (SMART History tab)
      <select bind:value={tempUnit}>
        <option value="C">Celsius (°C)</option>
        <option value="F">Fahrenheit (°F)</option>
      </select>
    </label>
    <p class="hint">
      Samples are always recorded in Celsius - this only changes how the SMART History tab's
      temperature chart displays them.
    </p>
    <div class="save-row">
      <button type="button" on:click={onSaveClick} disabled={status === "saving"}>
        {status === "saving" ? "Saving..." : "Save Location"}
      </button>
      {#if status === "saved"}<span class="ok">Saved</span>{/if}
      {#if status === "error"}<span class="err">Error: {errorMessage}</span>{/if}
    </div>
  </section>

  <div class="save-row">
    <button type="button" on:click={onSaveClick} disabled={status === "saving"}>
      {status === "saving" ? "Saving..." : "Save Everything"}
    </button>
    {#if status === "saved"}<span class="ok">Saved</span>{/if}
    {#if status === "error"}<span class="err">Error: {errorMessage}</span>{/if}
  </div>
</div>

<style>
  .settings {
    font-size: 13px;
  }
  .settings :global(input),
  .settings :global(select) {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 4px 6px;
    font: inherit;
    font-size: 13px;
  }
  .settings :global(input[type="color"]) {
    padding: 0;
  }
  .settings :global(button) {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 5px 10px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .group-editor {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 10px 12px;
    margin-bottom: 10px;
  }
  .settings-section {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 10px 12px;
    margin-bottom: 16px;
  }
  .settings-section h3 {
    margin-top: 0;
  }
  .group-header {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .group-header input {
    flex: 1;
    font-weight: 600;
  }
  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: end;
  }
  .fields label {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .fields label.grow {
    flex: 1 1 auto;
    min-width: 120px;
  }
  .fields input[type="number"] {
    width: 60px;
  }
  .card-row {
    margin-bottom: 8px;
  }
  .hint {
    color: var(--muted);
    margin: 6px 0 0;
  }
  .role-toggles {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    margin-bottom: 10px;
  }
  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .checkbox-row input {
    width: auto;
  }
  .add-group {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
  }
  h3 {
    font-size: 13px;
    margin: 0 0 4px;
  }
  .db-path-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 4px 0 0;
    max-width: 480px;
  }
  .daemon-row {
    display: flex;
    gap: 8px;
    margin: 4px 0;
  }
  .logo-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
  }
  .logo-row span {
    width: 110px;
    flex: 0 0 auto;
  }
  .logo-row input[type="url"] {
    flex: 1;
  }
  .logo-row input[type="file"] {
    flex: 0 0 auto;
    max-width: 160px;
  }
  .led-row {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 6px 0;
  }
  .led-row .skin-name {
    width: 110px;
    flex: 0 0 auto;
  }
  .led-swatch {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--muted);
  }
  .led-swatch input[type="color"] {
    width: 28px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: none;
    cursor: pointer;
  }
  .save-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
  }
  .settings :global(button.remove) {
    color: var(--accent-critical);
  }
  .settings :global(button:disabled) {
    opacity: 0.4;
    cursor: default;
  }
  .ok {
    color: var(--accent-ok);
  }
  .err {
    color: var(--accent-critical);
  }
</style>
