// Skin discovery: every directory under assets/tray-skins/ with a meta.json
// becomes a selectable skin automatically - adding a new skin is a new
// directory + a PR, not a code change. See assets/tray-skins/README.md for
// the contribution format.

import type { DriveStatus } from "../../shared/chassis-types.js";

export interface SkinOverlayAnchor {
  cx?: number;
  cy?: number;
  r?: number;
  x?: number;
  y?: number;
  size?: number;
  /** Only meaningful on the `label` anchor - text color chosen to suit the skin's body color. */
  color?: string;
  /**
   * Only meaningful on the `label` anchor. When true the serial and the make/model text are drawn
   * rotated, reading bottom-to-top, in two columns starting at (x, y), instead of as horizontal
   * lines. For tall, narrow trays (a 3.5" drive mounted on edge) that have no room for horizontal text.
   */
  rotate?: boolean;
}

export interface SkinOverlays {
  led: SkinOverlayAnchor;
  icon: SkinOverlayAnchor;
  logo: SkinOverlayAnchor;
  label: SkinOverlayAnchor;
}

export interface SkinViewBox {
  w: number;
  h: number;
}

export interface SkinMeta {
  id: string;
  name: string;
  description: string;
  unofficial: boolean;
  disclaimer?: string;
  overlays: { horizontal: SkinOverlays; vertical: SkinOverlays };
  /** Optional per-orientation viewBox size for skins whose art is not the default 220x64 (horizontal) / 76x190 (vertical). Must match the viewBox attribute of the matching svg. */
  viewBox?: { horizontal?: SkinViewBox; vertical?: SkinViewBox };
  /** This skin's default status-LED colors - real trays don't all use the same green/amber/red convention. Falls back to status.ts's DEFAULT_LED_COLORS for any status left unset. */
  ledColors?: Partial<Record<DriveStatus, string>>;
}

export interface Skin extends SkinMeta {
  svg: { horizontal: string; vertical: string };
}

export const DEFAULT_VIEWBOX: Record<"horizontal" | "vertical", SkinViewBox> = {
  horizontal: { w: 220, h: 64 },
  vertical: { w: 76, h: 190 },
};

/** The viewBox size the skin's art for this orientation is drawn in. */
export function skinViewBox(skin: Pick<SkinMeta, "viewBox">, orientation: "horizontal" | "vertical"): SkinViewBox {
  return skin.viewBox?.[orientation] ?? DEFAULT_VIEWBOX[orientation];
}

const metaModules = import.meta.glob("../../../assets/tray-skins/*/meta.json", {
  eager: true,
  import: "default",
}) as Record<string, SkinMeta>;

const horizontalModules = import.meta.glob("../../../assets/tray-skins/*/horizontal.svg", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const verticalModules = import.meta.glob("../../../assets/tray-skins/*/vertical.svg", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

// import.meta.glob returns entries in directory-listing order (effectively
// alphabetical), which put "dell" ahead of the unbranded "generic" skin -
// deliberately reordered so the unbranded default sits right after the
// original classic skin, ahead of every vendor-styled one. Any skin added
// later without being listed here just sorts after these, alphabetically.
const SKIN_ORDER = ["classic", "generic", "dell", "hp", "netapp", "supermicro"];

export const skins: Skin[] = Object.entries(metaModules)
  .map(([path, meta]) => {
    const dir = dirOf(path);
    return {
      ...meta,
      svg: {
        horizontal: horizontalModules[`${dir}/horizontal.svg`] ?? "",
        vertical: verticalModules[`${dir}/vertical.svg`] ?? "",
      },
    };
  })
  .sort((a, b) => {
    const ai = SKIN_ORDER.indexOf(a.id);
    const bi = SKIN_ORDER.indexOf(b.id);
    if (ai === -1 && bi === -1) return a.id.localeCompare(b.id);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
