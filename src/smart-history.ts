import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { loadSettings } from "./config.js";
import { loadLayoutConfig } from "./layout.js";
import { getDisks } from "./graphql/client.js";
import { normalizeDevice } from "./locate.js";
import type { DriveStatus } from "./shared/chassis-types.js";

// unraid-api doesn't expose detailed SMART attributes over GraphQL - its own
// DisksService.getTemperature() runs `smartctl -A -j <device>` internally and
// discards everything except current temperature before it reaches GraphQL
// (confirmed by reading its resolver source, see ROADMAP.md). So the same
// SMART-history feature the original PHP plugin had (its Trends tab) has to
// shell out to smartctl itself here too, on the same 700ms-interval-safe
// execFile+argv pattern locate.ts already established (never a shell string).

const DEFAULT_DB_PATH = "/boot/config/plugins/unraid-baywatch/smart-history.db";
export const SMARTCTL_BIN = process.env.BAYWATCH_SMARTCTL_BIN ?? "smartctl";
const POLL_MS = Number(process.env.BAYWATCH_SMART_POLL_MS ?? 30 * 60 * 1000);
const RETENTION_DAYS = Number(process.env.BAYWATCH_SMART_RETENTION_DAYS ?? 180);
const FIRST_POLL_DELAY_MS = 10_000;

export interface SmartSample {
  ts: number;
  status: DriveStatus;
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

let db: DatabaseSync | undefined;

/**
 * Env var always wins (dev/testing), then whatever the user set in the
 * Settings tab, then the default under /boot. Resolved lazily on first use
 * (not at module load) so it reflects the layout.json on disk at daemon
 * startup - a change here takes effect on the next daemon restart, same as
 * this plugin's other settings.
 */
function resolveDbPath(): string {
  if (process.env.BAYWATCH_SMART_DB) return process.env.BAYWATCH_SMART_DB;
  return loadLayoutConfig()?.smartHistoryDbPath || DEFAULT_DB_PATH;
}

function getDb(): DatabaseSync {
  if (db) return db;
  const dbPath = resolveDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serial TEXT NOT NULL,
      ts INTEGER NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_smart_samples_serial_ts ON smart_samples(serial, ts);
  `);
  return db;
}

/** Exported so classic-import.ts can reuse the exact same invocation pattern for its own smartctl calls. */
export function runSmartctl(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    // smartctl's own exit code is a bitmask that's nonzero even on a
    // successful read (e.g. bit 4 = "prefail attribute below threshold" is
    // exactly one of the failure signals we WANT to see) - so stdout is what
    // matters here, not the exit code, unlike a typical execFile error check.
    execFile(SMARTCTL_BIN, args, { maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => resolve(stdout ?? ""));
  });
}

interface AtaAttribute {
  id: number;
  raw?: { value?: number };
}

interface SmartctlJson {
  smart_status?: { passed?: boolean };
  temperature?: { current?: number };
  power_on_time?: { hours?: number };
  ata_smart_attributes?: { table?: AtaAttribute[] };
  nvme_smart_health_information_log?: {
    critical_warning?: number;
    media_errors?: number;
    percentage_used?: number;
  };
  // SAS/SCSI drives (device.protocol === "SCSI") have neither ATA attributes
  // nor an NVMe log - confirmed against a real SAS drive on the live box.
  // scsi_grown_defect_list is their closest analog to ATA's reallocated-
  // sector count (a nonzero count means the drive has remapped bad sectors).
  scsi_grown_defect_list?: number;
}

function ataAttribute(parsed: SmartctlJson, id: number): number | null {
  const attr = parsed.ata_smart_attributes?.table?.find((a) => a.id === id);
  return attr?.raw?.value ?? null;
}

/**
 * Derives ok/warn/critical from the same attributes smartmontools' own health
 * logic and common SMART dashboards (e.g. Scrutiny) treat as failure-
 * predictive - not thresholds invented for this project.
 */
function deriveStatus(parsed: SmartctlJson, sample: Omit<SmartSample, "status" | "ts">): DriveStatus {
  if (parsed.smart_status?.passed === false) return "critical";
  const nvme = parsed.nvme_smart_health_information_log;
  if (nvme) {
    if ((nvme.critical_warning ?? 0) !== 0 || (sample.mediaErrors ?? 0) > 0) return "critical";
    if ((nvme.percentage_used ?? 0) >= 90) return "warn";
    return "ok";
  }
  if ((sample.pendingSectors ?? 0) > 0 || (sample.offlineUncorrectable ?? 0) > 0) return "critical";
  if ((sample.reallocatedSectors ?? 0) > 0 || (sample.scsiGrownDefects ?? 0) > 0) return "warn";
  return "ok";
}

/** Whether smartctl actually gave us anything worth recording, vs. skipping a standby drive or hitting an unsupported/errored device. */
function hasUsableSmartData(parsed: SmartctlJson): boolean {
  return (
    parsed.smart_status !== undefined ||
    parsed.ata_smart_attributes !== undefined ||
    parsed.nvme_smart_health_information_log !== undefined ||
    parsed.scsi_grown_defect_list !== undefined ||
    parsed.temperature !== undefined
  );
}

async function pollDevice(rawDevice: string): Promise<SmartSample | null> {
  const device = normalizeDevice(rawDevice);
  // `-n standby` is smartctl's own purpose-built mechanism for this: it skips
  // the actual SMART query (and any resulting spin-up) if the drive reports
  // itself already in standby, and is a plain no-op otherwise. This is used
  // unconditionally rather than gating on unraid-api's `disk.isSpinning`
  // field - confirmed against a real SAS drive on the live box that
  // `isSpinning` can be false while the drive is demonstrably already awake
  // (a fast, non-blocking read succeeded instantly), so trusting it as the
  // sole gate would have meant this drive's history never gets collected.
  const stdout = await runSmartctl(["-n", "standby", "-H", "-A", "-j", device]);
  let parsed: SmartctlJson;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null; // smartctl produced no usable JSON (device error, unsupported, etc.)
  }
  if (!hasUsableSmartData(parsed)) return null; // skipped (standby) or nothing readable
  const nvme = parsed.nvme_smart_health_information_log;
  const sample: Omit<SmartSample, "status" | "ts"> = {
    temperatureC: parsed.temperature?.current ?? null,
    powerOnHours: parsed.power_on_time?.hours ?? null,
    reallocatedSectors: ataAttribute(parsed, 5),
    pendingSectors: ataAttribute(parsed, 197),
    offlineUncorrectable: ataAttribute(parsed, 198),
    mediaErrors: nvme?.media_errors ?? null,
    percentageUsed: nvme?.percentage_used ?? null,
    scsiGrownDefects: parsed.scsi_grown_defect_list ?? null,
    healthPassed: parsed.smart_status?.passed ?? null,
  };
  return { ...sample, status: deriveStatus(parsed, sample), ts: Date.now() };
}

function insertSample(serial: string, sample: SmartSample): void {
  const { ts, status, ...data } = sample;
  getDb()
    .prepare("INSERT INTO smart_samples (serial, ts, status, data) VALUES (?, ?, ?, ?)")
    .run(serial, ts, status, JSON.stringify(data));
}

function pruneOldSamples(): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  getDb().prepare("DELETE FROM smart_samples WHERE ts < ?").run(cutoff);
}

let loggedUnconfigured = false;

export async function pollAllDisks(): Promise<void> {
  const settings = loadSettings();
  if (!settings) {
    if (!loggedUnconfigured) {
      console.log("[smart-history] not configured yet, skipping poll");
      loggedUnconfigured = true;
    }
    return;
  }
  loggedUnconfigured = false;

  let disks;
  try {
    disks = await getDisks(settings);
  } catch (err) {
    console.error(`[smart-history] couldn't fetch disks: ${err}`);
    return;
  }

  for (const disk of disks) {
    // No isSpinning pre-filter here (see pollDevice's comment) - `-n standby`
    // is what actually protects a genuinely sleeping drive from being woken.
    try {
      const sample = await pollDevice(disk.device);
      if (sample) insertSample(disk.serialNum, sample);
    } catch (err) {
      console.error(`[smart-history] poll failed for ${disk.device}: ${err}`);
    }
  }

  pruneOldSamples();
}

export function getLatestStatuses(): Record<string, DriveStatus> {
  const rows = getDb()
    .prepare(
      `SELECT serial, status FROM smart_samples
       WHERE id IN (SELECT MAX(id) FROM smart_samples GROUP BY serial)`,
    )
    .all() as { serial: string; status: DriveStatus }[];
  return Object.fromEntries(rows.map((r) => [r.serial, r.status]));
}

export function getHistory(serial: string, sinceMs?: number): SmartSample[] {
  const rows = (
    sinceMs
      ? getDb()
          .prepare("SELECT ts, status, data FROM smart_samples WHERE serial = ? AND ts >= ? ORDER BY ts")
          .all(serial, sinceMs)
      : getDb().prepare("SELECT ts, status, data FROM smart_samples WHERE serial = ? ORDER BY ts").all(serial)
  ) as { ts: number; status: DriveStatus; data: string }[];
  return rows.map((r) => ({ ts: r.ts, status: r.status, ...JSON.parse(r.data) }));
}

export function startSmartHistoryPolling(): { close: () => void } {
  const initial = setTimeout(() => void pollAllDisks(), FIRST_POLL_DELAY_MS);
  const interval = setInterval(() => void pollAllDisks(), POLL_MS);
  initial.unref?.();
  interval.unref?.();
  return {
    close: () => {
      clearTimeout(initial);
      clearInterval(interval);
    },
  };
}
