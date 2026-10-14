import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StoredLayout } from "./shared/chassis-types.js";

// Same config-storage convention as config.ts's CONFIG_PATH.
const LAYOUT_PATH =
  process.env.BAYWATCH_LAYOUT ??
  "/boot/config/plugins/unraid-baywatch/layout.json";

export function loadLayoutConfig(): StoredLayout | null {
  if (!existsSync(LAYOUT_PATH)) return null;
  return JSON.parse(readFileSync(LAYOUT_PATH, "utf-8"));
}

export function saveLayoutConfig(config: StoredLayout): void {
  mkdirSync(dirname(LAYOUT_PATH), { recursive: true });
  writeFileSync(LAYOUT_PATH, JSON.stringify(config, null, 2));
}
