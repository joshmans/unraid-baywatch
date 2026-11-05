// Chassis layout types, shared between the backend (persists this as the
// plugin's own config - unraid-api has no concept of physical bay position,
// see ROADMAP.md) and the frontend (renders it and lets the user edit it).
// No DOM/Node dependency here so both sides can import it as-is.

export type Orientation = "horizontal" | "vertical";
export type DriveType = "hdd" | "ssd" | "nvme";
export type DriveStatus = "ok" | "warn" | "critical";

/**
 * A disk's Unraid array/pool role - derived server-side from
 * /var/local/emhttp/disks.ini + devs.ini (see array-state.ts), not from
 * unraid-api's GraphQL schema, which has no per-disk pool-name field at all
 * (confirmed 2026-09 against the real schema - see ROADMAP.md). "unassigned"
 * covers both a disk devs.ini lists with no array/pool membership, and the
 * fallback when this plugin's own /disks enrichment step can't be run.
 */
export type DriveRole = "parity" | "data" | "cache" | "boot" | "unassigned";

/** What a bay or PCIe module slot renders when occupied; absent = empty. */
export interface BayDrive {
  driveType: DriveType;
  status: DriveStatus;
  label: string;
  role?: DriveRole;
  /** Only meaningful when role is "cache" - the real pool name (e.g. "nvcache"), not just the generic role. Absent means role is unknown or not a cache disk. */
  poolName?: string;
  sizeBytes?: number;
  /** Raw vendor/model strings (unraid-api's disk.vendor/disk.name) - kept separate from `label` (serial-first) purely for brand.ts's detection, see role.ts's sibling brand.ts. */
  vendor?: string;
  model?: string;
  /** unraid-api's disks.device (e.g. "sda") - used to key the /activity poll (see disk-activity.ts), not shown directly anywhere. */
  device?: string;
}

export interface BayConfig {
  /** Stable id, unique across the whole layout - used to key live drive data onto a bay. */
  id: string;
  row: number;
  col: number;
  /** Which assets/tray-skins/<skinId> to render this bay with. */
  skinId: string;
  orientation: Orientation;
}

export interface BayGroup {
  kind: "bays";
  id: string;
  /** Shown as a heading above the group, e.g. "Front (3.5" hot-swap)". */
  label: string;
  rows: number;
  columns: number;
  bays: BayConfig[];
  /** Optional explicit rendered width in px for this group's whole grid on the Tray Map. Absent (the default) fills the available container width, same as before this existed. */
  widthPx?: number;
}

export interface PcieCardConfig {
  /** Stable id, unique across the whole layout. Module drive data is keyed as `${id}-m${index}`. */
  id: string;
  /** Which assets/pcie-carrier/<carrierId>.svg shell to render. */
  carrierId: string;
  /** e.g. "Slot 3 - x16" */
  label: string;
  moduleCount: number;
  /** Rendered width in px on the Tray Map; the shell's fixed aspect ratio (520:150) sets the height. Absent (cards saved before this existed) falls back to DEFAULT_PCIE_CARD_WIDTH_PX. */
  widthPx?: number;
}

/** 220 (the original hardcoded TrayMap.svelte width) read as "tiny" once real module rows/text were on it - this is the new default for a freshly added card. */
export const DEFAULT_PCIE_CARD_WIDTH_PX = 380;

export interface PcieGroup {
  kind: "pcie";
  id: string;
  label: string;
  cards: PcieCardConfig[];
}

export type Group = BayGroup | PcieGroup;

export interface ChassisLayout {
  id: string;
  name: string;
  groups: Group[];
  /** Dashboard tile only: give every group its own column, in source order, wrapping onto a new line when the tile runs out of width - instead of the default height-balanced two columns. Absent = off. */
  dashboardSideBySide?: boolean;
}

/** Hotlinked manufacturer logo URL per tray-skin id - kept separate from the skins themselves so a skin PR never needs to carry a logo (see assets/tray-skins/README.md). */
export type LogoConfig = Record<string, string>;

/** Hotlinked logo URL per detected drive-brand id (see brand.ts) - a bay's logo prefers this (its occupying drive's real manufacturer) over its tray skin's LogoConfig entry, which is only a fallback for an empty bay or an undetected brand. */
export type BrandLogoConfig = Record<string, string>;

/** Manual brand-id override per bay/module id, for when auto-detection (brand.ts, from the drive's vendor/model strings) gets it wrong or can't tell - e.g. a rebadged/OEM drive. Absent means trust auto-detection. */
export type ManufacturerOverrides = Record<string, string>;

/** Which physical disk (by serial number, stable across reboots/device renumbering) occupies which bay/module id. */
export type Assignments = Record<string, string>;

/**
 * Per-skin status-LED color overrides, keyed by skin id then status. Each
 * skin's meta.json declares its own defaults (real trays don't agree on one
 * green/amber/red convention - some blink blue, some split activity/fault
 * across two LEDs); this only holds the user's explicit overrides on top of
 * those defaults, so an unset entry here just means "use the skin's own".
 */
export type LedColorConfig = Record<string, Partial<Record<DriveStatus, string>>>;

export interface StoredLayout {
  layout: ChassisLayout;
  logos: LogoConfig;
  /** Optional for backward compatibility with layout.json files saved before assignment existed. */
  assignments?: Assignments;
  /** Optional for backward compatibility with layout.json files saved before LED color overrides existed. */
  ledColors?: LedColorConfig;
  /**
   * Full file path for the SMART-history SQLite database (see smart-history.ts).
   * Empty/absent means the default under /boot/config/plugins/... - some users
   * prefer to redirect this elsewhere since it's the one file this plugin
   * writes to frequently (every poll cycle), unlike this document itself
   * which only changes when a user explicitly saves something, and /boot is
   * often a flash drive with real write-cycle limits.
   */
  smartHistoryDbPath?: string;
  /** Tint a bay/module by its DriveRole (see role.ts's ROLE_COLORS). Independent of showRoleIcon - both, either, or neither can be on. Absent = off. */
  showRoleColor?: boolean;
  /** Badge a bay/module with a role letter (P/D/C/B) and, for cache, its pool name in the tooltip. Independent of showRoleColor. Absent = off. */
  showRoleIcon?: boolean;
  /** Optional for backward compatibility with layout.json files saved before drive-brand logos existed. */
  brandLogos?: BrandLogoConfig;
  /** Optional for backward compatibility with layout.json files saved before per-bay brand overrides existed. */
  manufacturerOverrides?: ManufacturerOverrides;
  /**
   * Unit the SMART History tab's temperature chart displays in. Samples are
   * always stored in Celsius (smartctl's own native unit, see
   * smart-history.ts) - this only controls display, converted client-side,
   * so switching it never touches already-recorded history. Absent = "C".
   */
  tempUnit?: "C" | "F";
}
