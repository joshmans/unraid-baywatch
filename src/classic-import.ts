import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadSettings } from "./config.js";
import { getDisks } from "./graphql/client.js";
import { normalizeDevice } from "./locate.js";
import { runSmartctl } from "./smart-history.js";
import type { BayConfig, BayGroup, Assignments, Orientation } from "./shared/chassis-types.js";

// The original PHP plugin (unraid-disklocation) is a completely separate
// codebase - this is a clean-room rewrite, not derived from its GPLv3
// source - but its stored config is still real data a user shouldn't have
// to redo by hand. Everything below (paths, the hash algorithm, the tray-
// number-to-grid-position math) was confirmed against a real installed
// copy's actual files, not just its source: see ROADMAP.md.

// Not a user-facing setting (this is the stock classic plugin's own fixed
// install path, nothing to customize) - the env override exists purely for
// local testing, same convention as this project's other BAYWATCH_*
// overrides.
const CLASSIC_DIR = process.env.BAYWATCH_CLASSIC_DIR ?? "/boot/config/plugins/disklocation";
const GROUPS_PATH = `${CLASSIC_DIR}/groups.json`;
const LOCATIONS_PATH = `${CLASSIC_DIR}/locations.json`;

interface ClassicGroup {
  group_name: string;
  grid_rows: string;
  grid_columns: string;
  grid_count: "row" | "column";
  tray_direction: string;
  tray_start_num: string;
  disk_tray_direction: "h" | "v";
}

interface ClassicLocation {
  groupid: string;
  tray: number;
}

export interface ImportPreview {
  available: boolean;
  groups?: BayGroup[];
  assignments?: Assignments;
  matchedCount?: number;
  totalLocations?: number;
  skippedGroups?: { name: string; reason: string }[];
  // Locations whose tray index falls outside their group's own declared
  // grid_rows x grid_columns - confirmed live to be stale/invalid entries in
  // the classic plugin's own locations.json (its declared grid size was the
  // real physical enclosure size in both real cases seen), not evidence the
  // real cage is bigger - so these are reported and dropped, never used to
  // grow the imported grid.
  outOfRange?: { groupName: string; tray: number }[];
}

/**
 * Direction mode 1 is the only one implemented - confirmed by reading
 * tray_number_assign() in the original plugin's functions_devices.php AND
 * by checking a real installed copy's groups.json, where every group uses
 * this mode. Other modes are more involved reversed/bottom-up numbering
 * schemes not verified against real data, so a group using one is skipped
 * and reported rather than guessed at.
 *
 * tray_start_num is NOT the first tray's own number - trays are 1-indexed
 * starting just above it (tray_start_num "0" means the first real tray is
 * numbered 1, not 0). Confirmed by cross-referencing the classic plugin's
 * own live UI (which labels each bay with its tray number) against
 * locations.json on a real box: every assignment's UI-displayed bay label
 * was exactly its locations.json tray value minus 1 (tray 1 -> labeled "0",
 * tray 12 -> labeled "11", etc, with no tray-0 entries ever present).
 * Getting this wrong doesn't error - it just silently shifts every disk to
 * an adjacent bay and makes the last real tray look "out of range" for its
 * own declared grid, which is what real imported data on this box showed
 * before this was caught.
 */
function gridPosition(
  tray: number,
  rows: number,
  columns: number,
  gridCount: "row" | "column",
  startNum: number,
): { row: number; col: number } {
  const i = tray - startNum - 1;
  if (gridCount === "column") {
    return { col: Math.floor(i / rows), row: i % rows };
  }
  return { row: Math.floor(i / columns), col: i % columns };
}

function buildImportedGroup(
  id: string,
  classic: ClassicGroup,
): BayGroup {
  const rows = Number(classic.grid_rows);
  const columns = Number(classic.grid_columns);
  const startNum = Number(classic.tray_start_num);
  const orientation: Orientation = classic.disk_tray_direction === "v" ? "vertical" : "horizontal";

  const bays: BayConfig[] = [];
  for (let tray = startNum + 1; tray <= startNum + rows * columns; tray++) {
    const { row, col } = gridPosition(tray, rows, columns, classic.grid_count, startNum);
    bays.push({ id: `classic-${id}-${tray}`, row, col, skinId: "classic", orientation });
  }
  return { kind: "bays", id: `classic-import-${id}`, label: classic.group_name, rows, columns, bays };
}

/** sha256(model_name + serial_number) - confirmed against a real installed copy's devices.json: recomputed for a real disk and it exactly matched that disk's own key. */
function classicHash(modelName: string, serialNumber: string): string {
  return createHash("sha256").update(modelName + serialNumber).digest("hex");
}

async function buildHashToSerialMap(): Promise<Map<string, string>> {
  const settings = loadSettings();
  const map = new Map<string, string>();
  if (!settings) return map;
  let disks;
  try {
    disks = await getDisks(settings);
  } catch {
    return map;
  }
  for (const disk of disks) {
    try {
      const device = normalizeDevice(disk.device);
      // -i (identify/inquiry only), not -n standby: -n standby's power-mode
      // check exits before returning model/serial at all when the drive is
      // asleep (confirmed live - every spun-down disk silently produced no
      // hash, hence 0/13 matches on a real array with mostly standby disks).
      // -i alone is safe - confirmed live too: querying a standby /dev/sda
      // with -i left it reporting standby immediately afterward, so it
      // doesn't wake the drive either.
      const stdout = await runSmartctl(["-i", "-j", device]);
      const parsed = JSON.parse(stdout);
      const modelName: string | undefined = parsed.scsi_model_name ?? parsed.model_name;
      const serialNumber: string | undefined = parsed.serial_number;
      if (modelName && serialNumber) {
        map.set(classicHash(modelName, serialNumber), disk.serialNum);
      }
    } catch {
      // Unreadable/standby/unsupported device - just not matchable, not a fatal error.
    }
  }
  return map;
}

export async function previewImport(): Promise<ImportPreview> {
  if (!existsSync(GROUPS_PATH) || !existsSync(LOCATIONS_PATH)) {
    return { available: false };
  }

  const classicGroups: Record<string, ClassicGroup> = JSON.parse(readFileSync(GROUPS_PATH, "utf-8"));
  const classicLocations: Record<string, ClassicLocation> = JSON.parse(readFileSync(LOCATIONS_PATH, "utf-8"));

  const groups: BayGroup[] = [];
  const skippedGroups: { name: string; reason: string }[] = [];
  const groupById = new Map<string, BayGroup>();
  for (const [id, classic] of Object.entries(classicGroups)) {
    if (classic.tray_direction !== "1") {
      skippedGroups.push({ name: classic.group_name, reason: `unsupported tray_direction "${classic.tray_direction}"` });
      continue;
    }
    const group = buildImportedGroup(id, classic);
    groups.push(group);
    groupById.set(id, group);
  }

  const hashToSerial = await buildHashToSerialMap();

  const assignments: Assignments = {};
  const outOfRange: { groupName: string; tray: number }[] = [];
  let matchedCount = 0;
  const totalLocations = Object.keys(classicLocations).length;
  for (const [hash, location] of Object.entries(classicLocations)) {
    const group = groupById.get(location.groupid);
    const serial = hashToSerial.get(hash);
    if (!group || !serial) continue;
    const rows = group.rows;
    const startNum = Number(classicGroups[location.groupid].tray_start_num);
    const gridCount = classicGroups[location.groupid].grid_count;
    const { row, col } = gridPosition(location.tray, rows, group.columns, gridCount, startNum);
    const bay = group.bays.find((b) => b.row === row && b.col === col);
    if (!bay) {
      outOfRange.push({ groupName: classicGroups[location.groupid].group_name, tray: location.tray });
      continue;
    }
    assignments[bay.id] = serial;
    matchedCount++;
  }

  return { available: true, groups, assignments, matchedCount, totalLocations, skippedGroups, outOfRange };
}
