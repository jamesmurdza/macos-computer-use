import { downloadRunArtifact, listRunIds, uploadRunArtifact } from "./storage";

/**
 * Writer side of the gallery index. The reader (a completely separate app -- see `../../gallery/`,
 * deployed as its own Vercel project with no shared code or credentials) has its own copy of this
 * `GalleryEntry` shape in `gallery/src/lib/gallery.ts`; keep the two in sync if this ever changes,
 * since `index.json` is the entire contract between them.
 *
 * Entries deliberately store references (keys), not resolved URLs, so the index stays valid
 * regardless of which URL scheme (public vs presigned) a reader ends up using.
 */
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
 * tools/agent-run.ts, never from any web app.
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
