import { existsSync, readFileSync } from "node:fs";
import type { DiskResult } from "./graphql/queries.js";
import type { DriveRole } from "./shared/chassis-types.js";

// Not a user-facing setting (this is Unraid's own fixed runtime-state
// directory), same convention as classic-import.ts's CLASSIC_DIR - the env
// override exists purely for local testing.
const EMHTTP_DIR = process.env.BAYWATCH_EMHTTP_DIR ?? "/var/local/emhttp";
const DISKS_INI_PATH = `${EMHTTP_DIR}/disks.ini`;
const DEVS_INI_PATH = `${EMHTTP_DIR}/devs.ini`;

interface ArrayStateEntry {
  role: DriveRole;
  poolName?: string;
  sizeBytes?: number;
}

/**
 * unraid-api's own Disk.size field is not trustworthy - it comes straight
 * from the third-party `systeminformation` npm package's diskLayout(),
 * which (like its isSpinning field, already worked around in
 * smart-history.ts) returns inconsistent units per drive: confirmed live,
 * an 8TB SAS parity drive came back as size=7 (matches TiB, not bytes) while
 * ~1TB SATA/SSD drives came back as size=953/931/etc (matches GiB, not
 * bytes) - two different, both-wrong scalings from the same field on the
 * same box. disks.ini/devs.ini's own sectors x sector_size is exact -
 * verified against smartctl's own user_capacity.bytes for the same disk.
 */
function sizeBytesOf(fields: Record<string, string>): number | undefined {
  const sectors = Number(fields.sectors);
  const sectorSize = Number(fields.sector_size);
  if (!sectors || !sectorSize) return undefined;
  return sectors * sectorSize;
}

/**
 * Sectioned INI, `["sectionName"]` header lines then `key="value"` lines
 * until the next header or EOF - confirmed against a real box's actual
 * disks.ini/devs.ini (not just the classic plugin's PHP source, which reads
 * the same files via parse_ini_file($file, true)). Quoting is always double
 * quotes in practice; stripped here rather than JSON-parsed since a bare
 * unquoted value (not observed, but not guaranteed absent) shouldn't throw.
 */
function parseSectionedIni(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const header = trimmed.match(/^\["?(.+?)"?\]$/);
    if (header) {
      current = {};
      sections[header[1]] = current;
      continue;
    }
    const kv = trimmed.match(/^([^=]+)="(.*)"$/);
    if (kv && current) current[kv[1]] = kv[2];
  }
  return sections;
}

const ROLE_BY_TYPE: Record<string, DriveRole> = {
  parity: "parity",
  data: "data",
  cache: "cache",
  flash: "boot",
};

/**
 * disks.ini's section name is the pool/slot name (e.g. "nvcache", not the
 * device node), and a multi-disk pool gets one section per member with a
 * trailing digit appended (nvcache, nvcache2, nvcache3, nvcache4 all belong
 * to the one real pool "nvcache") - confirmed against a real box with two
 * separate multi-disk cache pools. Single-disk pools just keep the bare
 * name. Only meaningful for cache entries - disk1/disk2/... and
 * parity/parity2 use the same trailing-digit convention for array slots,
 * not pool identity, so this is never applied to those.
 */
function stripPoolSuffix(sectionName: string): string {
  return sectionName.replace(/\d+$/, "") || sectionName;
}

/**
 * Reads Unraid's own runtime state directly (same files, same approach the
 * original PHP plugin uses - see ROADMAP.md) rather than unraid-api's
 * GraphQL, which has no per-disk pool-name field at all and would only ever
 * give a generic "cache" bucket. Returns device-node (bare, e.g. "sdb") ->
 * role/poolName; a device absent from both files (or present only in
 * devs.ini, which lists disks connected but not in the array/any pool) maps
 * to "unassigned".
 */
export function getArrayState(): Map<string, ArrayStateEntry> {
  const result = new Map<string, ArrayStateEntry>();
  if (!existsSync(DISKS_INI_PATH)) return result;

  const disks = parseSectionedIni(readFileSync(DISKS_INI_PATH, "utf-8"));
  for (const [sectionName, fields] of Object.entries(disks)) {
    const device = fields.device;
    if (!device) continue;
    const role = ROLE_BY_TYPE[(fields.type ?? "").toLowerCase()] ?? "unassigned";
    result.set(device, {
      role,
      poolName: role === "cache" ? stripPoolSuffix(sectionName) : undefined,
      sizeBytes: sizeBytesOf(fields),
    });
  }

  if (existsSync(DEVS_INI_PATH)) {
    const devs = parseSectionedIni(readFileSync(DEVS_INI_PATH, "utf-8"));
    for (const fields of Object.values(devs)) {
      const device = fields.device;
      if (device && !result.has(device)) result.set(device, { role: "unassigned", sizeBytes: sizeBytesOf(fields) });
    }
  }

  return result;
}

/** Attaches role/poolName/sizeBytes to each disk from getArrayState(), matched by bare device node (disk.device from unraid-api always carries a /dev/ prefix; disks.ini/devs.ini never do). A disk this plugin can't place in either file (rare - e.g. read right as the array is starting) is left as "unassigned" with no sizeBytes rather than failing the whole /disks response. */
export function enrichWithArrayState(disks: DiskResult[]): DiskResult[] {
  const state = getArrayState();
  return disks.map((disk) => {
    const bare = disk.device.replace(/^\/dev\//, "");
    const entry = state.get(bare);
    return { ...disk, role: entry?.role ?? "unassigned", poolName: entry?.poolName, sizeBytes: entry?.sizeBytes };
  });
}
