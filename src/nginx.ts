import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFile } from "node:child_process";

// Unraid's real /etc/rc.d/rc.nginx regenerates conf.d/locations.conf from a
// hardcoded heredoc on every start/restart/reload/renew (confirmed by reading
// that script on a real box) - there is no plugin-registration hook, so any
// `include` line we append gets silently wiped the next time anything calls
// `rc.nginx reload` (e.g. the user changing Settings > Management Access),
// not just a one-off packaging quirk.
//
// The fix isn't a durable install step - there isn't one - it's to do what a
// real installed plugin (u-manager-companion) already does: treat our own
// long-running daemon as the thing responsible for the include line existing,
// the same way it's responsible for the API being up. On startup we ensure
// it's there and reload; then we watch locations.conf itself and re-heal
// within a fraction of a second any time it changes without our line in it,
// regardless of who or what triggered that regeneration.

const PLUGIN_NAME = "unraid-baywatch";
const DAEMON_PORT = Number(process.env.PORT ?? 3838);
const HEAL_DEBOUNCE_MS = 300;

const LOCATIONS_CONF_PATH = process.env.BAYWATCH_LOCATIONS_CONF ?? "/etc/nginx/conf.d/locations.conf";
const INCLUDE_PATH =
  process.env.BAYWATCH_NGINX_INCLUDE ??
  `/boot/config/plugins/${PLUGIN_NAME}/nginx/${PLUGIN_NAME}.conf`;
const NGINX_BIN = process.env.BAYWATCH_NGINX_BIN ?? "/usr/sbin/nginx";

function includeFileContent(): string {
  return `# Generated and kept in sync by src/nginx.ts - do not hand-edit, your
# changes will be overwritten the next time the daemon (re)starts or heals.
location /plugins/${PLUGIN_NAME}/api/ {
  proxy_pass http://127.0.0.1:${DAEMON_PORT}/;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
`;
}

function includeDirective(): string {
  return `include ${INCLUDE_PATH};`;
}

function includeLineIsPresent(): boolean {
  if (!existsSync(LOCATIONS_CONF_PATH)) return false;
  const wanted = includeDirective();
  return readFileSync(LOCATIONS_CONF_PATH, "utf-8")
    .split("\n")
    .some((line) => line.trim() === wanted);
}

/** Idempotent: only appends if our line isn't already present. Returns whether it made a change. */
function ensureIncludeAppended(): boolean {
  if (includeLineIsPresent()) return false;
  const current = existsSync(LOCATIONS_CONF_PATH) ? readFileSync(LOCATIONS_CONF_PATH, "utf-8") : "";
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(LOCATIONS_CONF_PATH, `${current}${separator}${includeDirective()}\n`);
  return true;
}

/** Idempotent: only (re)writes the include file if its content actually changed. Returns whether it wrote. */
function ensureIncludeFileWritten(): boolean {
  const content = includeFileContent();
  const previous = existsSync(INCLUDE_PATH) ? readFileSync(INCLUDE_PATH, "utf-8") : undefined;
  if (previous === content) return false;
  mkdirSync(dirname(INCLUDE_PATH), { recursive: true });
  writeFileSync(INCLUDE_PATH, content);
  return true;
}

function run(bin: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, (err, _stdout, stderr) => resolve({ ok: !err, stderr: String(stderr ?? "") }));
  });
}

/** Never reload on a config nginx itself would reject - a bad reload can take the whole webGUI down, not just this plugin. */
async function validatedReload(): Promise<void> {
  const check = await run(NGINX_BIN, ["-t"]);
  if (!check.ok) {
    console.error(`[nginx] config check failed, not reloading:\n${check.stderr}`);
    return;
  }
  // Raw nginx binary signal, not `/etc/rc.d/rc.nginx reload` - the latter is
  // exactly what regenerates locations.conf and wipes our line in the first
  // place, so using it here would immediately undo what we just did.
  const reload = await run(NGINX_BIN, ["-s", "reload"]);
  if (!reload.ok) {
    console.error(`[nginx] reload failed:\n${reload.stderr}`);
  } else {
    console.log("[nginx] reloaded");
  }
}

async function ensureIncludeAndReload(): Promise<void> {
  const wroteIncludeFile = ensureIncludeFileWritten();
  const appendedLine = ensureIncludeAppended();
  if (wroteIncludeFile || appendedLine) {
    await validatedReload();
  }
}

export interface NginxSelfHeal {
  close: () => void;
}

/**
 * Ensures our nginx include is registered, then watches locations.conf and
 * re-registers it any time something else's regeneration wipes it out.
 * A no-op on hosts with no real nginx to manage (local dev).
 */
export function startNginxSelfHeal(): NginxSelfHeal {
  if (process.env.BAYWATCH_DISABLE_NGINX_INTEGRATION === "1" || !existsSync(NGINX_BIN)) {
    return { close: () => {} };
  }

  void ensureIncludeAndReload();

  let debounceTimer: NodeJS.Timeout | undefined;
  const onLocationsConfChanged = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      if (!includeLineIsPresent()) {
        console.log("[nginx] our include line disappeared (locations.conf was regenerated) - healing");
        void ensureIncludeAndReload();
      }
    }, HEAL_DEBOUNCE_MS);
    debounceTimer.unref?.();
  };

  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(LOCATIONS_CONF_PATH, { persistent: false }, onLocationsConfChanged);
  } catch (err) {
    console.error(`[nginx] couldn't watch ${LOCATIONS_CONF_PATH}, self-heal disabled: ${err}`);
  }

  return {
    close: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher?.close();
    },
  };
}
