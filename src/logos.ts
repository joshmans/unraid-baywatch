import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

// Same config-storage convention as config.ts/layout.ts - survives reboots,
// unlike anything under /tmp.
const LOGOS_DIR = process.env.BAYWATCH_LOGOS_DIR ?? "/boot/config/plugins/unraid-baywatch/logos";

// Never accepted from free-text user input - kind/id always come from a
// fixed, known set (a tray-skin id from trayskins.ts's directory listing, or
// a brand id from brand.ts's KNOWN_BRANDS), but validated again here anyway
// (defense in depth) since this becomes a filesystem path. No dots, slashes,
// or anything else that could mean "parent directory" or "not actually an
// svg file this route serves".
const SAFE_ID = /^[a-z0-9-]+$/;
const MAX_SVG_BYTES = 262144; // 256KB - an SVG logo has no business being bigger than this

export function logoFilename(kind: "skin" | "brand", id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`invalid logo id: ${JSON.stringify(id)}`);
  return `${kind}-${id}.svg`;
}

export function saveLogo(kind: "skin" | "brand", id: string, svg: string): void {
  const trimmed = svg.trim();
  if (!trimmed.startsWith("<svg") && !trimmed.startsWith("<?xml")) {
    throw new Error("doesn't look like an SVG file (must start with <svg or <?xml)");
  }
  if (Buffer.byteLength(trimmed, "utf-8") > MAX_SVG_BYTES) {
    throw new Error(`SVG too large - ${MAX_SVG_BYTES / 1024}KB max`);
  }
  mkdirSync(LOGOS_DIR, { recursive: true });
  writeFileSync(`${LOGOS_DIR}/${logoFilename(kind, id)}`, trimmed);
}

/** Filename here is whatever the /logos/:filename route matched, not user-supplied JSON - same SAFE_ID + fixed ".svg" suffix validation either way, since it still becomes a filesystem path. */
export function readLogo(filename: string): string | null {
  const match = filename.match(/^(skin|brand)-([a-z0-9-]+)\.svg$/);
  if (!match) return null;
  const path = `${LOGOS_DIR}/${filename}`;
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}
