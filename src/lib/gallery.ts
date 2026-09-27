import { downloadRunArtifact, listRunIds, publicRunArtifactUrl, uploadRunArtifact } from "./storage";

/** One card in the `/gallery` page -- deliberately just references (keys), not resolved URLs, so
 * the index stays valid regardless of which URL scheme (public vs presigned) a reader ends up
 * using. */
export interface GalleryEntry {
  runId: string;
  /** The prompt, as typed -- short imperative instructions ("open Safari and load the New York
   * Times") already read as a description; no separate summarization step. */
  description: string;
  /** ISO 8601, from the run's `videoStartedAt`. */
  date: string;
  durationMs: number;
  videoKey: string;
  thumbnailKey: string;
}

/** The subset of tools/agent-run.ts's meta.json this cares about. */
interface RunMeta {
  runId: string;
  prompt: string;
  videoStartedAt?: number;
  videoEndedAt?: number;
  videoFile?: string;
  status: "ok" | "error";
}

const INDEX_KEY = "index.json";

/**
 * Rebuild `index.json` from scratch by scanning every `runs/<id>/meta.json` in the bucket, rather
 * than incrementally patching a previous index. For a personal tool making a handful of runs, the
 * extra list+get calls are cheap, and rebuilding from the meta.json files (ground truth already
 * written per run) avoids read-modify-write races and self-heals if a run's files were ever
 * deleted or edited by hand -- there's no separate "index" state that can drift from reality.
 *
 * Only runs that finished cleanly (`status: "ok"`) with a video are included -- a failed run isn't
 * something worth showing in a gallery of "what the agent did".
 *
 * Requires R2 write credentials (via storage.ts's `client()`), so this only ever runs from
 * tools/agent-run.ts, never from the web app.
 */
export async function rebuildGalleryIndex(): Promise<GalleryEntry[]> {
  const runIds = await listRunIds();
  const entries: GalleryEntry[] = [];

  for (const runId of runIds) {
    const raw = await downloadRunArtifact(`runs/${runId}/meta.json`);
    if (!raw) continue;
    let meta: RunMeta;
    try {
      meta = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      continue; // corrupt/partial meta.json -- skip rather than fail the whole rebuild
    }
    if (meta.status !== "ok" || !meta.videoFile || !meta.videoStartedAt || !meta.videoEndedAt) continue;

    entries.push({
      runId,
      description: meta.prompt?.trim() || "(no description)",
      date: new Date(meta.videoStartedAt).toISOString(),
      durationMs: meta.videoEndedAt - meta.videoStartedAt,
      videoKey: `runs/${runId}/${meta.videoFile}`,
      thumbnailKey: `runs/${runId}/thumbnail.jpg`,
    });
  }

  entries.sort((a, b) => b.date.localeCompare(a.date)); // newest first, YouTube-style

  await uploadRunArtifact(INDEX_KEY, new TextEncoder().encode(JSON.stringify(entries, null, 2)), "application/json");
  return entries;
}

export interface GalleryEntryResolved extends GalleryEntry {
  videoUrl: string;
  thumbnailUrl: string;
}

/**
 * Read `index.json` for the `/gallery` page -- a plain public `fetch()` against
 * `R2_PUBLIC_BASE_URL`, no R2 credentials involved at all (the web app never holds any). Returns
 * `configured: false` if that var isn't set, so the page can render a clear setup message instead
 * of a confusing empty gallery.
 */
export async function loadGalleryIndex(): Promise<{ configured: boolean; entries: GalleryEntryResolved[] }> {
  const base = process.env.R2_PUBLIC_BASE_URL;
  if (!base) return { configured: false, entries: [] };

  const url = publicRunArtifactUrl(INDEX_KEY)!;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    // No runs recorded yet (index.json never created) is the common case of a 404 here -- not an
    // error worth surfacing differently from "zero entries".
    return { configured: true, entries: [] };
  }
  const raw = (await res.json()) as GalleryEntry[];
  const entries = raw.map((e) => ({
    ...e,
    videoUrl: publicRunArtifactUrl(e.videoKey)!,
    thumbnailUrl: publicRunArtifactUrl(e.thumbnailKey)!,
  }));
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
