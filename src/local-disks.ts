import { execFile } from "node:child_process";
import { getDeviceRuntimeState } from "./array-state.js";
import { getLatestStatuses } from "./smart-history.js";
import type { DiskResult } from "./graphql/queries.js";

const LSBLK_BIN = process.env.BAYWATCH_LSBLK_BIN ?? "lsblk";
const PHYSICAL_DISK_NAME = /^(sd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

// Why this exists instead of unraid-api's `disks` GraphQL query: on a stock
// unraid-api that resolver calls systeminformation's diskLayout(), which runs
// `smartctl -a -j` on every disk with no standby guard, so every query spins
// up every sleeping drive (issue #18). lsblk reads the udev database and
// Unraid's disks.ini/devs.ini are plain files - neither touches a drive.

interface LsblkDevice {
  name?: string;
  path?: string;
  model?: string | null;
  vendor?: string | null;
  serial?: string | null;
  tran?: string | null;
  rota?: boolean | string | number | null;
  size?: number | string | null;
}

function runLsblk(): Promise<LsblkDevice[]> {
  return new Promise((resolve) => {
    execFile(
      LSBLK_BIN,
      ["-d", "-b", "-J", "-o", "NAME,PATH,MODEL,VENDOR,SERIAL,TRAN,ROTA,SIZE"],
      { maxBuffer: 4 * 1024 * 1024 },
      (_err, stdout) => {
        try {
          const parsed = JSON.parse(stdout ?? "") as { blockdevices?: LsblkDevice[] };
          resolve(Array.isArray(parsed.blockdevices) ? parsed.blockdevices : []);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

function interfaceTypeOf(tran: string): DiskResult["interfaceType"] {
  switch (tran) {
    case "sas":
      return "SAS";
    case "sata":
    case "ata":
      return "SATA";
    case "usb":
      return "USB";
    case "nvme":
      return "PCIE";
    default:
      return "UNKNOWN";
  }
}

function isRotational(rota: LsblkDevice["rota"]): boolean {
  // util-linux emits a JSON boolean on current releases and "0"/"1" on older ones.
  return !(rota === false || rota === "0" || rota === 0);
}

/**
 * Same DiskResult shape unraid-api's `disks` query returned, built without
 * touching any drive. smartStatus is "OK" when Unraid reports the disk as
 * DISK_OK or this plugin's own SMART history has a sample for it (a sample's
 * own ok/warn/critical status is applied separately by driveFromDisk), and
 * "UNKNOWN" otherwise - the same meaning unraid-api gave it for a disk it
 * hadn't been able to read.
 */
export async function listLocalDisks(): Promise<DiskResult[]> {
  const [devices, runtime] = [await runLsblk(), getDeviceRuntimeState()];
  let historyStatuses: Record<string, string> = {};
  try {
    historyStatuses = getLatestStatuses();
  } catch {
    // no history db yet - fine, treated as no samples
  }
  // A dual-path SAS drive shows up as two device nodes with one serial; keep
  // one disk per serial, preferring the node Unraid itself tracks.
  const bySerial = new Map<string, DiskResult>();
  for (const d of devices) {
    const name = d.name ?? "";
    const serial = (d.serial ?? "").trim();
    if (!PHYSICAL_DISK_NAME.test(name) || !serial) continue;
    const state = runtime.get(name);
    const tran = (d.tran ?? "").trim().toLowerCase();
    const vendor = (d.vendor ?? "").trim();
    const known = bySerial.get(serial);
    if (known && (runtime.has(known.device.replace(/^\/dev\//, "")) || !state)) continue;
    bySerial.set(serial, {
      id: serial,
      device: d.path || `/dev/${name}`,
      name: (d.model ?? "").trim(),
      type: tran === "nvme" ? "NVMe" : isRotational(d.rota) ? "HD" : "SSD",
      // lsblk reports "ATA" as the vendor of every SATA drive behind a SAS HBA - noise, not a manufacturer.
      vendor: vendor.toUpperCase() === "ATA" ? "" : vendor,
      size: Number(d.size) || 0,
      serialNum: serial,
      interfaceType: interfaceTypeOf(tran),
      temperature: state?.tempC ?? null,
      smartStatus: state?.status === "DISK_OK" || historyStatuses[serial] ? "OK" : "UNKNOWN",
      isSpinning: state ? !state.spundown : true,
    });
  }
  return [...bySerial.values()];
}
