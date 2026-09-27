/**
 * Reads the `index.json` that the (separate) macos-computer-use repo's `tools/agent-run.ts`
 * maintains in R2 (see that repo's `src/lib/gallery.ts` -- `addRunToGalleryIndex()`/
 * `rebuildGalleryIndex()` write exactly this shape). The two apps share no code or dependency --
 * this is the entire contract between them, so keep `GalleryEntry` in sync with the writer if that
 * shape ever changes.
 *
 * This briefly read from Cloudflare KV instead (see git history) -- moved back to a plain public
 * R2 URL on reflection: KV's REST API has no anonymous read mode, so it would have given this
 * otherwise fully credential-free app a real secret to protect, and KV is only eventually
 * consistent (unlike R2's strong consistency) for no offsetting benefit in this case. This app
 * never holds R2 credentials at all: it only ever does a plain public `fetch()` against
 * `CF_PUBLIC_BASE_URL`, which must point at the bucket's public access domain (a `pub-*.r2.dev`
 * URL, or a custom domain).
 */
export interface GalleryEntry {
  runId: string;
  description: string;
  /** ISO 8601. */
  date: string;
  durationMs: number;
  videoKey: string;
  thumbnailKey: string;
  /** Exactly what the writer's `modelChoice` was -- e.g. `"haiku"` or
   * `"openrouter:qwen/qwen3.7-flash"`, no lookup table needed to know what actually ran. */
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Estimated USD cost against current list price, not the exact amount billed. Absent (not 0)
   * when the writer couldn't determine pricing for that model. */
  costUsd?: number;
}

export interface GalleryEntryResolved extends GalleryEntry {
  videoUrl: string;
  thumbnailUrl: string;
}

const INDEX_KEY = "index.json";

function publicUrl(key: string): string {
  const base = process.env.CF_PUBLIC_BASE_URL;
  if (!base) throw new Error("CF_PUBLIC_BASE_URL is not set");
  return `${base.replace(/\/+$/, "")}/${key}`;
}

/** `configured: false` when `CF_PUBLIC_BASE_URL` isn't set, so the page can render a setup
 * message instead of a confusing empty gallery. A 404 (no runs recorded yet) is treated as zero
 * entries, not an error. */
export async function loadGalleryIndex(): Promise<{ configured: boolean; entries: GalleryEntryResolved[] }> {
  if (!process.env.CF_PUBLIC_BASE_URL) return { configured: false, entries: [] };

  const res = await fetch(publicUrl(INDEX_KEY), { cache: "no-store" });
  if (!res.ok) return { configured: true, entries: [] };

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

/** "$0.0046" / "$1.20" -- these runs are cheap enough that a fixed 2-decimal format would round
 * most of them to "$0.00", so anything under a dime gets 4 decimals instead. */
export function formatCost(costUsd: number): string {
  return costUsd < 0.1 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}
