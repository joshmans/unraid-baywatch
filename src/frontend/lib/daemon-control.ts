// Controls the Node daemon from OUTSIDE its own API, via a PHP endpoint
// served by Unraid's own always-running nginx/php-fpm - the whole point of
// this module only matters when the daemon's own /plugins/.../api/* proxy
// is unreachable, so it can never depend on that API being up.
//
// Auth: window.BAYWATCH_PAGE is set by BayWatch.page's
// embedded PHP, carrying Unraid's own CSRF token - the same pattern a real
// installed plugin (unraid-zram-card) uses for exactly this, confirmed
// against that plugin's actual .page/.php files rather than invented here.

declare global {
  interface Window {
    BAYWATCH_PAGE?: { CSRF: string; API: string };
  }
}

export interface DaemonStatus {
  running: boolean;
  port: number;
}

export interface DaemonActionResult {
  ok: boolean;
  message?: string;
}

function pageContext(): { CSRF: string; API: string } | null {
  return window.BAYWATCH_PAGE ?? null;
}

async function call(action: string, params: Record<string, string> = {}): Promise<any> {
  const ctx = pageContext();
  if (!ctx) {
    // Not served through Unraid's .page pipeline (e.g. the browser-harness/
    // local-dev setups used throughout this project) - there's no daemon
    // to control this way in that environment.
    throw new Error("daemon control isn't available outside a real Unraid install");
  }
  const query = new URLSearchParams({ action, csrf_token: ctx.CSRF, ...params });
  const res = await fetch(`${ctx.API}?${query}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getDaemonStatus(): Promise<DaemonStatus | null> {
  try {
    const result = await call("status");
    return { running: !!result.running, port: Number(result.port) || 3838 };
  } catch {
    return null;
  }
}

export async function startDaemon(): Promise<DaemonActionResult> {
  try {
    const result = await call("start");
    return { ok: !!result.success, message: result.message };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function stopDaemon(): Promise<DaemonActionResult> {
  try {
    const result = await call("stop");
    return { ok: !!result.success, message: result.message };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function setDaemonPort(port: number): Promise<DaemonActionResult> {
  try {
    const result = await call("set-port", { port: String(port) });
    return { ok: !!result.success, message: result.message };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
