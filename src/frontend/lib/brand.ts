// Best-effort drive-manufacturer detection from unraid-api's raw vendor/model
// strings - never exact (rebadged/OEM drives, generic "ATA"/"SATA SSD"
// vendor strings that carry no real brand info at all), which is exactly
// why Settings/DriveIdentity.svelte lets a user override it per bay rather
// than trusting this blindly. Patterns checked against real device
// strings seen on a live box this session (HITACHI/HGST SAS drives, SPCC
// SATA/NVMe SSDs, Micron NVMe, Seagate SAS) plus other common brands.

export interface BrandMeta {
  id: string;
  name: string;
}

export const KNOWN_BRANDS: BrandMeta[] = [
  { id: "seagate", name: "Seagate" },
  { id: "wd", name: "Western Digital" },
  { id: "hgst", name: "HGST / Hitachi" },
  { id: "toshiba", name: "Toshiba" },
  { id: "samsung", name: "Samsung" },
  { id: "micron", name: "Micron / Crucial" },
  { id: "kingston", name: "Kingston" },
  { id: "sandisk", name: "SanDisk" },
  { id: "intel", name: "Intel" },
  { id: "kioxia", name: "Kioxia" },
  { id: "silicon-power", name: "Silicon Power" },
  { id: "ibm", name: "IBM" },
];

const BRAND_PATTERNS: [RegExp, string][] = [
  [/seagate|barracuda|constellation|exos|ironwolf|\bst\d{3,}/i, "seagate"],
  [/western digital|\bwdc?\b/i, "wd"],
  [/hgst|hitachi|\bhuh\d|\bh0h/i, "hgst"],
  [/toshiba/i, "toshiba"],
  [/samsung/i, "samsung"],
  [/micron|crucial|mtfd/i, "micron"],
  [/kingston/i, "kingston"],
  [/sandisk/i, "sandisk"],
  [/\bintel\b/i, "intel"],
  [/kioxia/i, "kioxia"],
  [/spcc|silicon power/i, "silicon-power"],
  [/\bibm/i, "ibm"],
];

/** Returns a KNOWN_BRANDS id, or undefined if neither string matches anything recognized (e.g. a generic "ATA"/"SATA SSD" vendor string that carries no real brand info). */
export function detectBrand(vendor: string | undefined, model: string | undefined): string | undefined {
  const v = (vendor ?? "").trim();
  const m = (model ?? "").trim();
  // The vendor string alone first (an explicit vendor such as "IBM-207x" beats whatever the OEM model
  // prefix says), then the model alone, then both together. Matching only the joined string broke the
  // start-anchored model patterns (ST..., HUH...): SATA drives have an empty vendor, so the joined
  // string began with a space and those patterns never matched.
  for (const text of [v, m, `${v} ${m}`.trim()]) {
    if (!text) continue;
    for (const [pattern, id] of BRAND_PATTERNS) {
      if (pattern.test(text)) return id;
    }
  }
  return undefined;
}

export function brandName(id: string | undefined): string | undefined {
  return KNOWN_BRANDS.find((b) => b.id === id)?.name;
}

/**
 * A bay's logo, in priority order: (1) a manual per-bay brand override, (2)
 * the drive's auto-detected brand, (3) the tray skin's own configured logo
 * (the pre-existing, skin-keyed LogoConfig) as a fallback for an empty bay
 * or an undetected brand - per explicit direction: "drive-brand wins, skin
 * is fallback, also the ability to set it per-tray when the user knows the
 * brand."
 */
export function resolveBayLogo(
  bayId: string,
  vendor: string | undefined,
  model: string | undefined,
  manufacturerOverrides: Record<string, string>,
  brandLogos: Record<string, string>,
  skinLogoUrl: string | null,
): string | null {
  const brandId = manufacturerOverrides[bayId] ?? detectBrand(vendor, model);
  if (brandId && brandLogos[brandId]) return brandLogos[brandId];
  return skinLogoUrl;
}
