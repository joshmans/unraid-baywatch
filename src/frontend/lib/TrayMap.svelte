<script lang="ts">
  import type { ChassisLayout, BayDrive, LogoConfig, LedColorConfig, BrandLogoConfig, ManufacturerOverrides } from "./chassis";
  import { DEFAULT_PCIE_CARD_WIDTH_PX } from "./chassis";
  import { skins, skinViewBox } from "./trayskins";
  import TraySkin from "./TraySkin.svelte";
  import PcieCarrier from "./PcieCarrier.svelte";
  import { resolveLedColor } from "./status";
  import { detectBrand } from "./brand";

  export let layout: ChassisLayout;
  /** Keyed by BayConfig.id (bays) or `${cardId}-m${index}` (PCIe modules); no entry = empty. */
  export let drives: Record<string, BayDrive> = {};
  /** Manufacturer logo URL per tray-skin id (see assets/tray-skins/README.md); no entry = no logo overlay. */
  export let logos: LogoConfig = {};
  /** Status-LED color overrides per tray-skin id; no entry = that skin's own meta.json default. */
  export let ledColors: LedColorConfig = {};
  export let showRoleColor = false;
  export let showRoleIcon = false;
  export let brandLogos: BrandLogoConfig = {};
  export let manufacturerOverrides: ManufacturerOverrides = {};
  /** Keyed by device (e.g. "sda"), bumped each time App.svelte's /activity poll sees that device do I/O - see TraySkin.svelte's flashSeq prop. No entry means never observed active. */
  export let activity: Record<string, number> = {};

  $: skinById = new Map(skins.map((s) => [s.id, s]));
</script>

<div class="tray-map">
  {#each layout.groups as group (group.id)}
    <section class="group">
      <h3>{group.label}</h3>
      {#if group.kind === "bays"}
        <div
          class="grid"
          style="grid-template-columns: repeat({group.columns}, minmax(0, 1fr)); grid-template-rows: repeat({group.rows}, auto); {group.widthPx ? `width:${group.widthPx}px;` : ''}"
        >
          {#each group.bays as bay, i (bay.id)}
            {@const skin = skinById.get(bay.skinId) ?? skins[0]}
            {@const drive = drives[bay.id]}
            {@const brandId = drive ? manufacturerOverrides[bay.id] ?? detectBrand(drive.vendor, drive.model) : undefined}
            {@const brandLogoUrl = brandId ? brandLogos[brandId] : undefined}
            <div
              class="bay"
              class:vertical={bay.orientation === "vertical"}
              style="grid-row:{bay.row + 1};grid-column:{bay.col + 1};"
              title="{group.label} - Bay {i + 1}"
            >
              {#if drive && skin}
                <TraySkin
                  {skin}
                  orientation={bay.orientation}
                  status={drive.status}
                  driveType={drive.driveType}
                  label={drive.label}
                  logoUrl={brandLogoUrl ?? logos[bay.skinId] ?? null}
                  hasBrandLogo={!!brandLogoUrl}
                  ledColor={resolveLedColor(skin, ledColors, drive.status)}
                  flashSeq={drive.device ? (activity[drive.device] ?? 0) : 0}
                  role={drive.role}
                  poolName={drive.poolName}
                  sizeBytes={drive.sizeBytes}
                  vendor={drive.vendor}
                  model={drive.model}
                  {showRoleColor}
                  {showRoleIcon}
                />
              {:else}
                <div
                  class="empty"
                  style="aspect-ratio:{skinViewBox(skin, bay.orientation).w}/{skinViewBox(skin, bay.orientation).h}"
                >
                  empty
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <div class="cards">
          {#each group.cards as card (card.id)}
            {@const cardModules = Array.from({ length: card.moduleCount }, (_, i) => drives[`${card.id}-m${i}`])}
            <div class="card" title="{group.label} - {card.label}" style="width:{card.widthPx ?? DEFAULT_PCIE_CARD_WIDTH_PX}px">
              <PcieCarrier
                carrierId={card.carrierId}
                label={card.label}
                moduleCount={card.moduleCount}
                modules={cardModules}
                {showRoleColor}
                {showRoleIcon}
              />
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/each}
</div>

<style>
  .tray-map {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .group {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 10px 12px;
    /* A group's widthPx can exceed the panel's own width (set by the
       app shell's max-width) - scroll that one group horizontally rather
       than letting it push the whole page layout wider. */
    overflow-x: auto;
  }
  .group h3 {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--muted);
    margin: 0 0 8px;
  }
  .grid {
    display: grid;
    gap: 6px;
    align-items: end;
  }
  .cards {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }
  .card {
    width: 220px;
  }
  .bay {
    width: 100%;
  }
  .bay.vertical {
    width: 42px;
    justify-self: start;
  }
  .empty {
    width: 100%;
    border: 1px dashed var(--border);
    border-radius: 3px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 8px ui-monospace, "SFMono-Regular", Menlo, monospace;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
</style>
