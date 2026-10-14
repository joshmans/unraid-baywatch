import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Matches the config-storage convention used by /boot/config/plugins/<name>
// in the original PHP plugin (unraid-disklocation), for continuity - this
// service isn't otherwise related to that codebase.
const CONFIG_PATH =
  process.env.BAYWATCH_CONFIG ??
  "/boot/config/plugins/unraid-baywatch/settings.json";

export interface Settings {
  /** unraid-api API key, generated via `unraid-api apikey --create`. */
  apiKey: string;
  /** unraid-api GraphQL endpoint, normally the local box's own address. */
  graphqlUrl: string;
}

export function loadSettings(): Settings | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

export function saveSettings(settings: Settings): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(settings, null, 2));
}
