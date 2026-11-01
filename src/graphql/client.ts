import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { request as httpRequest } from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { Settings } from "../config.js";
import { ARRAY_QUERY, type ArrayResult } from "./queries.js";

// unraid-api's own GraphQL endpoint is served over HTTPS with Unraid's
// self-signed certificate, which never verifies against the system trust
// store. The rc.d script used to work around that by setting
// NODE_TLS_REJECT_UNAUTHORIZED=0 for the whole process, which also silently
// disabled certificate checking for anything else Node did (any host, not
// just this one request) - flagged by the CA security review that landed
// the loopback-binding fix in #4. Doing the POST by hand with node:https
// lets certificate checking be skipped only for this one request.
//
// The test is "graphqlUrl points at this machine", not "is 127.0.0.1": the
// Settings tab pre-fills graphqlUrl from the address the browser used
// (guessGraphqlUrl), normally the server's own LAN address or hostname. Its
// certificate is just as self-signed, and a connection to one of this
// machine's own addresses never leaves the machine, so a certificate check
// has nothing to protect against. Requiring a loopback literal broke every
// install that kept the pre-filled URL ("self-signed certificate", /disks
// answered 502). Anything that resolves elsewhere still gets normal TLS
// verification.
//
// A hostname is resolved once here and the connection is then pinned to the
// address that was checked, so DNS cannot answer "local" for the check and
// "remote" for the connection.
const insecureLocalAgent = new HttpsAgent({ rejectUnauthorized: false });

function normalizeAddress(address: string): string {
  return address.replace(/%.*$/, "").replace(/^::ffff:/i, "").toLowerCase();
}

/** The address to connect to if every address `hostname` resolves to is loopback or one of this machine's own; null otherwise. */
export async function resolveThisMachine(hostname: string): Promise<string | null> {
  const host = hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      return null;
    }
  }
  if (addresses.length === 0) return null;

  const own = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) own.add(normalizeAddress(entry.address));
  }
  const isOwn = (raw: string) => {
    const address = normalizeAddress(raw);
    return address === "::1" || address.startsWith("127.") || own.has(address);
  };
  return addresses.every(isOwn) ? addresses[0] : null;
}

function pinnedLookup(address: string) {
  const family = isIP(address);
  return (_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

async function postJson(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const doRequest = isHttps ? httpsRequest : httpRequest;
  const payload = Buffer.from(body, "utf-8");

  const options: Record<string, unknown> = {
    method: "POST",
    headers: { ...headers, "Content-Length": payload.length },
  };
  const localAddress = isHttps ? await resolveThisMachine(target.hostname) : null;
  if (localAddress) {
    options.agent = insecureLocalAgent;
    options.lookup = pinnedLookup(localAddress);
  }

  return new Promise((resolve, reject) => {
    const req = doRequest(target, options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

export async function queryUnraidApi<T>(
  settings: Settings,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await postJson(
    settings.graphqlUrl,
    {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
    },
    JSON.stringify({ query, variables }),
  );

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`unraid-api request failed: ${res.status}`);
  }

  const { data, errors } = JSON.parse(res.text) as { data?: T; errors?: unknown[] };
  if (errors?.length) {
    throw new Error(`unraid-api returned errors: ${JSON.stringify(errors)}`);
  }
  return data as T;
}

export async function getArray(settings: Settings): Promise<ArrayResult> {
  const { array } = await queryUnraidApi<{ array: ArrayResult }>(settings, ARRAY_QUERY);
  return array;
}
