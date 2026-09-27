import { requireEnv } from "./env";

/**
 * Cloudflare Workers KV, accessed via Cloudflare's REST API (not the S3-compatible one R2 uses --
 * a completely different auth scheme). Used to store the gallery index (see gallery.ts) as one
 * JSON value, replacing what used to be an `index.json` object in R2.
 *
 * Auth is a Cloudflare API Token (`CF_API_TOKEN`, `Authorization: Bearer ...`), NOT the R2
 * Access Key ID/Secret Access Key pair in storage.ts -- verified directly (the R2 keys get a 401
 * against this API). `CF_ACCOUNT_ID` is shared with R2 (same Cloudflare account, not a secret);
 * `CF_KV_NAMESPACE_ID` is the namespace's internal id (not its display name), found via the
 * dashboard or `GET /accounts/{id}/storage/kv/namespaces`.
 *
 * Important caveat, worth knowing before leaning on this for "live" updates: Workers KV is
 * *eventually consistent* -- Cloudflare's own docs say a write can take up to 60s to propagate to
 * edge locations other than the one it was written from. R2 (S3-compatible) is strongly
 * consistent. So moving the gallery index from an R2 JSON object to a KV value trades away
 * read-after-write consistency; it does not, by itself, make updates appear faster or more "live".
 * What it does provide is a real O(1) incremental write per run, instead of the O(n) full-bucket
 * rescan `rebuildGalleryIndex()` (kept as a repair/backfill tool) does.
 */

const BASE = "https://api.cloudflare.com/client/v4";

function url(path: string): string {
  const accountId = requireEnv("CF_ACCOUNT_ID");
  const namespaceId = requireEnv("CF_KV_NAMESPACE_ID");
  return `${BASE}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}${path}`;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${requireEnv("CF_API_TOKEN")}`, ...extra };
}

/** Raw text value for `key`, or undefined if it doesn't exist. Throws on any other error. */
export async function getKvValue(key: string): Promise<string | undefined> {
  const res = await fetch(url(`/values/${encodeURIComponent(key)}`), { headers: headers() });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`KV get ${key} failed: HTTP ${res.status} ${await res.text()}`);
  return res.text();
}

/** Overwrite (or create) `key` with a raw text value. */
export async function putKvValue(key: string, value: string): Promise<void> {
  const res = await fetch(url(`/values/${encodeURIComponent(key)}`), {
    method: "PUT",
    headers: headers({ "Content-Type": "text/plain" }),
    body: value,
  });
  if (!res.ok) throw new Error(`KV put ${key} failed: HTTP ${res.status} ${await res.text()}`);
}
