import { createServer } from "node:http";
import { loadSettings, saveSettings } from "./config.js";
import { loadLayoutConfig, saveLayoutConfig } from "./layout.js";
import { getDisks } from "./graphql/client.js";
import { startLocate, stopLocate, stopAllLocate, activeLocateDevices } from "./locate.js";
import { startNginxSelfHeal } from "./nginx.js";
import { startSmartHistoryPolling, getLatestStatuses, getHistory } from "./smart-history.js";
import { previewImport } from "./classic-import.js";
import { enrichWithArrayState } from "./array-state.js";
import { saveLogo, readLogo, logoFilename } from "./logos.js";
import { sampleActivity } from "./disk-activity.js";

// Deliberately no web framework - still just node:http. Routes beyond the
// health check are proxied at /plugins/unraid-baywatch/api/ (see
// nginx.ts, which strips that prefix before forwarding here).
const PORT = Number(process.env.PORT ?? 3838);

// fetch()'s own thrown TypeError (e.g. "TypeError: fetch failed" for a TLS
// handshake/cert rejection) carries the actually-useful detail on `.cause`,
// which plain String(err) drops entirely - confirmed live: this hid a real
// self-signed-cert misconfiguration behind a message that gave no hint what
// was actually wrong.
function describeError(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  return cause ? `${String(err)}: ${String(cause)}` : String(err);
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  // Only the smart-history routes need query-string parsing (?serial=...) -
  // every other route below is still a plain req.url equality check.
  const url = new URL(req.url ?? "/", "http://internal");

  if (req.url === "/health") {
    const settings = loadSettings();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, configured: settings !== null }));
    return;
  }

  // apiKey never round-trips back to the browser once saved - GET only says
  // whether one is set, matching how a secret field is normally handled.
  // POST omitting/blanking apiKey keeps whatever's already saved, so a user
  // can update just graphqlUrl (or vice versa) without re-pasting the key.
  if (req.url === "/settings" && req.method === "GET") {
    const settings = loadSettings();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ graphqlUrl: settings?.graphqlUrl ?? "", apiKeySet: !!settings?.apiKey }));
    return;
  }

  if (req.url === "/settings" && req.method === "POST") {
    try {
      const { apiKey, graphqlUrl } = JSON.parse(await readBody(req));
      if (typeof graphqlUrl !== "string" || !graphqlUrl.trim()) {
        throw new Error("graphqlUrl is required");
      }
      const existing = loadSettings();
      const nextApiKey = typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : existing?.apiKey;
      if (!nextApiKey) throw new Error("apiKey is required");
      saveSettings({ apiKey: nextApiKey, graphqlUrl: graphqlUrl.trim() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
    return;
  }

  if (req.url === "/layout" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(loadLayoutConfig()));
    return;
  }

  if (req.url === "/layout" && req.method === "POST") {
    try {
      const config = JSON.parse(await readBody(req));
      if (!config?.layout || !config?.logos) throw new Error("expected {layout, logos}");
      saveLayoutConfig(config);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
    return;
  }

  if (req.url === "/disks" && req.method === "GET") {
    const settings = loadSettings();
    if (!settings) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not configured - no unraid-api URL/key saved yet" }));
      return;
    }
    try {
      const disks = await getDisks(settings);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(enrichWithArrayState(disks)));
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: describeError(err) }));
    }
    return;
  }

  // Deliberately separate from /disks: this reads local /sys/block/*/stat
  // files directly (see disk-activity.ts), not unraid-api/GraphQL, so it
  // stays cheap enough for the frontend to poll every second or two for a
  // real activity-LED effect - /disks itself can take 20+ seconds on a big
  // array and is only ever fetched once.
  if (url.pathname === "/activity" && req.method === "GET") {
    const devices = (url.searchParams.get("devices") ?? "").split(",").filter(Boolean);
    const result: Record<string, boolean> = {};
    for (const device of devices) result[device] = sampleActivity(device);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.url === "/locate" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ devices: activeLocateDevices() }));
    return;
  }

  if (req.url === "/locate" && req.method === "POST") {
    try {
      const { device, action } = JSON.parse(await readBody(req));
      if (action === "start") startLocate(device);
      else if (action === "stop") stopLocate(device);
      else if (action === "stopAll") stopAllLocate();
      else throw new Error('action must be "start", "stop", or "stopAll"');
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, devices: activeLocateDevices() }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
    return;
  }

  if (url.pathname === "/smart-history/latest" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(getLatestStatuses()));
    return;
  }

  if (url.pathname === "/smart-history" && req.method === "GET") {
    const serial = url.searchParams.get("serial");
    if (!serial) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "expected ?serial=<serialNum>" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(getHistory(serial)));
    return;
  }

  if (url.pathname === "/classic-import/preview" && req.method === "GET") {
    try {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await previewImport()));
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: describeError(err) }));
    }
    return;
  }

  // Local-asset logos (user-uploaded SVGs), as an alternative to a hotlinked
  // URL, for both tray-skin logos (Settings) and drive-brand logos (Drive
  // Identity) - one upload/serve mechanism, kind distinguishes the two only
  // for filename namespacing (see logos.ts).
  if (url.pathname === "/logos" && req.method === "POST") {
    try {
      const { kind, id, svg } = JSON.parse(await readBody(req));
      if (kind !== "skin" && kind !== "brand") throw new Error('kind must be "skin" or "brand"');
      saveLogo(kind, id, svg);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: `/logos/${logoFilename(kind, id)}` }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
    return;
  }

  if (url.pathname.startsWith("/logos/") && req.method === "GET") {
    const svg = readLogo(url.pathname.slice("/logos/".length));
    if (svg === null) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "image/svg+xml" });
    res.end(svg);
    return;
  }

  res.writeHead(404);
  res.end();
});

// Loopback only: the UI reaches the daemon through the nginx proxy in
// nginx.ts, which already points at 127.0.0.1. None of the routes above
// check auth, so binding every interface would let any host on the network
// rewrite settings.json (graphqlUrl/apiKey), layout.json and logos/.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`unraid-baywatch listening on 127.0.0.1:${PORT}`);
  // Only worth registering with nginx once we're actually listening -
  // otherwise a reload could point it at a port nothing answers on yet.
  startNginxSelfHeal();
  startSmartHistoryPolling();
});
