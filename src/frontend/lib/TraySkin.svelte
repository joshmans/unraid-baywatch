<script lang="ts">
  import { skinViewBox, type Skin } from "./trayskins";
  import type { DriveRole } from "./chassis";
  import { driveIconColors, driveIconSvg, driveIconMeta } from "./driveicons";
  import { statusColor } from "./status";
  import { ROLE_COLORS, ROLE_BADGE_LETTER, roleBadgeBackground, roleLabel, formatSize } from "./role";

  export let skin: Skin;
  export let orientation: "horizontal" | "vertical" = "horizontal";
  export let status: "ok" | "warn" | "critical" = "ok";
  export let driveType: "hdd" | "ssd" | "nvme" = "hdd";
  export let label = "";
  export let logoUrl: string | null = null;
  /** Resolved final color for the current status (see status.ts's resolveLedColor) - callers that don't care about per-skin/user overrides can omit this and get the plain default. */
  export let ledColor: string | undefined = undefined;
  export let role: DriveRole | undefined = undefined;
  export let poolName: string | undefined = undefined;
  export let sizeBytes: number | undefined = undefined;
  export let showRoleColor = false;
  export let showRoleIcon = false;
  /** Raw vendor/model strings - shown as a fallback label only when there's no drive-specific brand logo to display (see modelText below), so the two never compete for the same space. */
  export let vendor: string | undefined = undefined;
  export let model: string | undefined = undefined;
  /** True only when logoUrl is a drive-brand logo (per-bay override or auto-detected), not the tray skin's own generic fallback logo - the skin's chassis-branding logo says nothing about the drive occupying this bay, so it shouldn't suppress the make/model text the way a real brand match does. */
  export let hasBrandLogo = false;
  /**
   * Bumped by the caller each time the backend's /activity poll sees this
   * device's read/write completion counters move (see disk-activity.ts).
   * The value itself is meaningless - only *changing* it matters, since
   * that's what forces the {#key} below to remount the LED and replay its
   * one-shot flash, even for back-to-back polls that both find activity.
   */
  export let flashSeq = 0;

  $: vb = skinViewBox(skin, orientation);
  $: svgMarkup = orientation === "horizontal" ? skin.svg.horizontal : skin.svg.vertical;
  $: o = skin.overlays[orientation];
  $: resolvedLedColor = ledColor ?? statusColor(status);
  $: iconColor = driveIconColors[driveType] ?? "#666";
  $: iconSvg = driveIconSvg[driveType] ?? "";
  $: roleColor = role ? ROLE_COLORS[role] : "transparent";
  $: sizeText = formatSize(sizeBytes);
  $: modelText = !hasBrandLogo ? [vendor, model].filter(Boolean).join(" ") : "";
  /** Tall narrow trays draw the serial and model rotated, in two columns (see SkinOverlayAnchor.rotate). */
  $: rotated = !!o.label.rotate;
  /** Where the rotated text columns stop: the logo anchor's top when it sits below them, else the bottom edge. */
  $: rotatedBottom = Math.min(vb.h, (o.logo.y ?? vb.h) - 4);
  $: rotatedHeight = Math.max(0, rotatedBottom - (o.label.y ?? 0));
  /** Distance between the two rotated columns, in viewBox units (the 8px serial plus a little air). */
  const ROTATED_COLUMN_GAP = 11;

  function pct(value: number, total: number): string {
    return `${(value / total) * 100}%`;
  }
</script>

<div
  class="tray-skin"
  class:fault={status === "critical"}
  class:role-tinted={showRoleColor}
  style="aspect-ratio:{vb.w}/{vb.h}; --fault-color:{resolvedLedColor}; --role-color:{roleColor}"
>
  <div class="base">{@html svgMarkup}</div>

  {#key flashSeq}
    <div
      class="led"
      class:blink={status === "warn" || status === "critical"}
      class:flicker={flashSeq > 0}
      style="left:{pct(o.led.cx ?? 0, vb.w)};top:{pct(o.led.cy ?? 0, vb.h)};width:{pct((o.led.r ?? 4) * 2, vb.w)};background:{resolvedLedColor}"
    ></div>
  {/key}

  <div
    class="icon"
    style="left:{pct((o.icon.cx ?? 0) - (o.icon.r ?? 8), vb.w)};top:{pct((o.icon.cy ?? 0) - (o.icon.r ?? 8), vb.h)};width:{pct((o.icon.r ?? 8) * 2, vb.w)};height:{pct((o.icon.r ?? 8) * 2, vb.h)};background:{iconColor}"
    title={driveIconMeta[driveType]?.name ?? driveType}
  >
    <div class="glyph">{@html iconSvg}</div>
  </div>

  <div
    class="logo"
    style="left:{pct(o.logo.x ?? 0, vb.w)};top:{pct(o.logo.y ?? 0, vb.h)};width:{pct(o.logo.size ?? 16, vb.w)};height:{pct(o.logo.size ?? 16, vb.h)}"
  >
    {#if logoUrl}
      <img src={logoUrl} alt="" />
    {/if}
  </div>

  {#if rotated}
    <div
      class="label rotated"
      style="left:{pct(o.label.x ?? 0, vb.w)};top:{pct(o.label.y ?? 0, vb.h)};height:{pct(rotatedHeight, vb.h)};color:{o.label.color ?? '#242420'}"
      title={label}
    >
      {label}
    </div>
    {#if modelText}
      <div
        class="model-text rotated"
        style="left:{pct((o.label.x ?? 0) + ROTATED_COLUMN_GAP, vb.w)};top:{pct(o.label.y ?? 0, vb.h)};height:{pct(rotatedHeight, vb.h)};color:{o.label.color ?? '#242420'}"
        title={modelText}
      >
        {modelText}
      </div>
    {/if}
  {:else}
    <div
      class="label"
      style="left:{pct(o.label.x ?? 0, vb.w)};top:{pct((o.label.y ?? 0) - 6, vb.h)};color:{o.label.color ?? '#242420'}"
    >
      {label}
    </div>

    {#if modelText}
      <div
        class="model-text"
        style="left:{pct(o.label.x ?? 0, vb.w)};top:{pct((o.label.y ?? 0) + 10, vb.h)};max-width:{pct(vb.w - (o.label.x ?? 0) - 4, vb.w)};color:{o.label.color ?? '#242420'}"
        title={modelText}
      >
        {modelText}
      </div>
    {/if}
  {/if}

  {#if (showRoleIcon && role) || sizeText}
    <div class="corner-info" class:stacked={rotated} style={rotated ? `color:${o.label.color ?? "#242420"}` : undefined}>
      {#if showRoleIcon && role}
        <div class="role-badge" style="background:{roleBadgeBackground(role)}" title={roleLabel(role, poolName)}>
          {ROLE_BADGE_LETTER[role]}
        </div>
      {/if}
      {#if sizeText}
        <div class="size-text">{sizeText}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tray-skin {
    position: relative;
    width: 100%;
    color: #242420;
    border-radius: 3px;
  }
  /* A ring rather than a fill/border - the base skin art (and its own
     status LED) stays fully legible underneath, this just frames it. */
  .tray-skin.role-tinted {
    box-shadow: 0 0 0 2px var(--role-color);
  }
  /* Bottom-right, below every skin's logo anchor and clear of the
     top-right LED every skin uses (checked all six skins' meta.json) -
     role-badge used to sit at top-right on its own and covered the LED. */
  .corner-info {
    position: absolute;
    bottom: 3%;
    right: 3%;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .role-badge {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 700 8px ui-monospace, "SFMono-Regular", Menlo, monospace;
    color: #fff;
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.4);
  }
  .size-text {
    flex: 0 0 auto;
    font: 8px ui-monospace, "SFMono-Regular", Menlo, monospace;
    color: rgba(36, 36, 32, 0.65);
  }
  /* Rotated (tall, narrow) trays have no room beside each other for the badge and size. */
  .corner-info.stacked {
    right: 50%;
    transform: translateX(50%);
    flex-direction: column;
    gap: 1px;
  }
  .corner-info.stacked .size-text {
    white-space: nowrap;
    color: inherit;
    opacity: 0.8;
  }
  .tray-skin.fault {
    animation: tray-fault-flash 1s ease-in-out infinite;
  }
  @keyframes tray-fault-flash {
    0%,
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
    50% {
      box-shadow: 0 0 0 3px var(--fault-color);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tray-skin.fault {
      animation: none;
      box-shadow: 0 0 0 3px var(--fault-color);
    }
  }
  .base {
    position: absolute;
    inset: 0;
  }
  .base :global(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }
  .led {
    position: absolute;
    aspect-ratio: 1;
    border-radius: 50%;
    transform: translate(-50%, -50%);
  }
  /* Matches the classic plugin's own convention: a drive that isn't in
     plain normal operation (spun down, degraded, disabled/missing) gets a
     blinking status LED, not just a static color change. */
  .led.blink {
    animation: tray-led-blink 1s step-end infinite;
  }
  @keyframes tray-led-blink {
    0%,
    49% {
      opacity: 1;
    }
    50%,
    100% {
      opacity: 0.15;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .led.blink {
      animation: none;
    }
  }
  /* A quick, single flash rather than a steady loop - each /activity poll
     that finds fresh I/O retriggers this (see TrayMap.svelte's key-based
     restart trick), so a busy drive keeps re-flashing every poll tick while
     an idle one just goes solid again. Meant to read as "the drive just did
     something," not as a status the way .blink is. */
  .led.flicker {
    animation: tray-led-flash 0.3s ease-out;
  }
  @keyframes tray-led-flash {
    0% {
      opacity: 0.2;
    }
    100% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .led.flicker {
      animation: none;
    }
  }
  .icon {
    position: absolute;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
  }
  .icon .glyph {
    width: 62%;
    height: 62%;
  }
  .icon .glyph :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
  .logo {
    position: absolute;
    border: 1px dashed rgba(0, 0, 0, 0.35);
    border-radius: 3px;
    overflow: hidden;
    box-sizing: border-box;
  }
  .logo img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }
  .label {
    position: absolute;
    font: 8px ui-monospace, "SFMono-Regular", Menlo, monospace;
    white-space: nowrap;
  }
  /* Reads bottom-to-top: the box is turned 180 degrees, so the text starts at the bottom of its
     height and any overflow is cut off (with an ellipsis) at the top. */
  .label.rotated,
  .model-text.rotated {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .model-text {
    position: absolute;
    font: 9px ui-monospace, "SFMono-Regular", Menlo, monospace;
    /* color set inline per-skin (same source as .label's) - a hardcoded
       dark tone here was invisible on dark-bodied skins like supermicro/dell,
       which set a light label color specifically to contrast their own art. */
    opacity: 0.75;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
