/**
 * Reads the gallery index that the (separate) macos-computer-use repo's `tools/agent-run.ts`
 * maintains -- a single JSON value in Cloudflare KV (see that repo's `src/lib/gallery.ts` --
 * `addRunToGalleryIndex()`/`rebuildGalleryIndex()` write exactly this shape, key `"index"`). The
 * two apps share no code or dependency -- this is the entire contract between them, so keep
 * `GalleryEntry` in sync with the writer if that shape ever changes.
 *
 * Unlike the video/thumbnail files (still plain R2, read via a public URL, no credentials), the KV
 * index read *does* require a real credential: Cloudflare's KV REST API has no public/anonymous
 * read mode the way an R2 bucket's public domain does -- every request needs a Bearer token. This
 * app was previously fully credential-free; it no longer is, by necessity of using KV instead of a
 * public JSON file. Use a KV-read-scoped Cloudflare API Token here if possible, not the same
 * write-capable one `agent-run.ts` uses, to keep this app's blast radius as small as it can be.
 *
 * Also worth knowing: Workers KV is *eventually consistent* (Cloudflare's docs: a write can take
 * up to 60s to propagate to edge locations other than the one it was written from), unlike R2's
 * strong consistency. A page load right after a run finishes may occasionally show slightly stale
 * data for up to about a minute.
 */
export interface GalleryEntry {
  runId: string;
  description: string;
  /** ISO 8601. */
  date: string;
  durationMs: number;
  videoKey: string;
  thumbnailKey: string;
}

export interface GalleryEntryResolved extends GalleryEntry {
  videoUrl: string;
  thumbnailUrl: string;
}

const REQUIRED_ENV = ["CF_ACCOUNT_ID", "CF_API_TOKEN", "CF_KV_NAMESPACE_ID", "CF_PUBLIC_BASE_URL"] as const;

function isConfigured(): boolean {
  return REQUIRED_ENV.every((k) => !!process.env[k]);
}

function publicUrl(key: string): string {
  const base = process.env.CF_PUBLIC_BASE_URL!;
  return `${base.replace(/\/+$/, "")}/${key}`;
}

function kvIndexUrl(): string {
  const accountId = process.env.CF_ACCOUNT_ID;
  const namespaceId = process.env.CF_KV_NAMESPACE_ID;
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/index`;
}

/** `configured: false` when any of `REQUIRED_ENV` isn't set, so the page can render a setup
 * message instead of a confusing empty gallery. A 404 (no runs recorded yet) or any other
 * non-2xx response is treated as zero entries rather than thrown -- logged server-side for
 * debugging, but a misconfigured token shouldn't crash the page for a visitor. */
export async function loadGalleryIndex(): Promise<{ configured: boolean; entries: GalleryEntryResolved[] }> {
  if (!isConfigured()) return { configured: false, entries: [] };

  const res = await fetch(kvIndexUrl(), {
    headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status !== 404) console.error(`Gallery KV index fetch failed: HTTP ${res.status} ${await res.text()}`);
    return { configured: true, entries: [] };
  }

  const raw = (await res.json()) as GalleryEntry[];
  const entries = raw.map((e) => ({ ...e, videoUrl: publicUrl(e.videoKey), thumbnailUrl: publicUrl(e.thumbnailKey) }));
  return { configured: true, entries };
}

/** "4:31" / "1:04:31" -- YouTube-style duration, no leading zero on the first group. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 27, 2026" -- deliberately UTC-based (not `toLocaleDateString`), so a card renders the same
 * string during server-side render and client hydration regardless of either side's timezone. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
