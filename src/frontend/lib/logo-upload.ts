// Shared by Settings.svelte (tray-skin logos) and DriveIdentity.svelte
// (drive-brand logos) - a hotlinked URL only works for a publicly reachable
// image, so this lets a user upload their own SVG instead; the daemon
// stores it under /boot/config/plugins/.../logos and serves it back itself
// (see src/logos.ts), and the resulting served path is used exactly like
// any other logo URL from here on - no separate "local asset" concept
// downstream of this.

const API_BASE = "/plugins/unraid-baywatch/api";

export async function uploadLogoFile(
  kind: "skin" | "brand",
  id: string,
  file: File,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  let svg: string;
  try {
    svg = await file.text();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const res = await fetch(`${API_BASE}/logos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, id, svg }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, url: `${API_BASE}${data.url}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
