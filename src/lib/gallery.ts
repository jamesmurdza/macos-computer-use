import { downloadRunArtifact, listRunIds, uploadRunArtifact } from "./storage";

/**
 * Writer side of the gallery index, stored as a single JSON object in R2 (`index.json`). The
 * reader (a completely separate app -- see `../../gallery/`, deployed as its own Vercel project,
 * sharing no code with this one) has its own copy of this `GalleryEntry` shape in
 * `gallery/src/lib/gallery.ts`; keep the two in sync if this ever changes, since `index.json`'s
 * shape is the entire contract between them.
 *
 * This briefly lived in Cloudflare KV instead (see git history / commit "Move the gallery index
 * from an R2 JSON file to Cloudflare KV" and its revert) -- moved back to R2 on reflection:
 *   - The only thing KV offered was O(1) writes instead of a full-bucket rescan, but that's a
 *     property of *incremental read-modify-write*, not of KV specifically -- `addRunToGalleryIndex`
 *     below gets the same O(1) writes against a plain R2 object.
 *   - R2 is strongly consistent; Cloudflare KV is only eventually consistent (writes can take up
 *     to ~60s to reach other edge locations). Moving to KV would have made the gallery *less*
 *     immediately live, not more.
 *   - A public R2 URL needs zero credentials to read (see `gallery/`'s README); Cloudflare's KV
 *     REST API has no anonymous read mode, so using it would have given the otherwise
 *     credential-free gallery app a real secret to protect, for no corresponding benefit here.
 *
 * Entries deliberately store references (keys into the R2 bucket), not resolved URLs, so the
 * index stays valid regardless of which URL scheme (public vs presigned) a reader ends up using.
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
  /** Exactly `meta.json`'s `modelChoice` -- e.g. `"haiku"` or `"openrouter:qwen/qwen3.7-flash"`,
   * no lookup table needed to know what actually ran. */
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Estimated USD cost against current list price -- see src/lib/cost.ts's own caveats
   * (undefined, not 0, when pricing couldn't be determined). */
  costUsd?: number;
  /** "ok" (finished normally) or "error" (crashed, or killed -- e.g. SIGTERM after being judged
   * unproductive; still has a real, playable recording up to that point). Every run with a video
   * is listed regardless of this -- an incomplete run is still real output worth being able to
   * watch -- so the reader uses this only to show a badge, never to filter. */
  status: "ok" | "error";
}

/** The subset of tools/agent-run.ts's meta.json this cares about. */
interface RunMeta {
  runId: string;
  prompt: string;
  modelChoice: string;
  videoStartedAt?: number;
  videoEndedAt?: number;
  videoFile?: string;
  status: "ok" | "error";
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

const INDEX_KEY = "index.json";

function sortNewestFirst(entries: GalleryEntry[]): GalleryEntry[] {
  return [...entries].sort((a, b) => b.date.localeCompare(a.date));
}

async function readIndex(): Promise<GalleryEntry[]> {
  const raw = await downloadRunArtifact(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as GalleryEntry[];
  } catch {
    return []; // corrupt object -- treat as empty rather than throw; rebuildGalleryIndex() can repair it
  }
}

async function writeIndex(entries: GalleryEntry[]): Promise<void> {
  await uploadRunArtifact(INDEX_KEY, new TextEncoder().encode(JSON.stringify(entries, null, 2)), "application/json");
}

function metaToEntry(runId: string, meta: RunMeta): GalleryEntry | undefined {
  // A video is the one hard requirement -- there's nothing to show without it. status is *not*
  // filtered on: a run that errored or got killed mid-task still has a real recording of whatever
  // it actually did, and that's the user's output to see, not something for this tool to hide on
  // its own judgment (see CLAUDE.md's "never delete/withhold a run without being asked" rule --
  // the same principle applies to keeping it out of the gallery).
  if (!meta.videoFile || !meta.videoStartedAt || !meta.videoEndedAt) return undefined;
  return {
    runId,
    description: meta.prompt?.trim() || "(no description)",
    date: new Date(meta.videoStartedAt).toISOString(),
    durationMs: meta.videoEndedAt - meta.videoStartedAt,
    videoKey: `runs/${runId}/${meta.videoFile}`,
    thumbnailKey: `runs/${runId}/thumbnail.jpg`,
    model: meta.modelChoice,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    costUsd: meta.costUsd,
    status: meta.status,
  };
}

/**
 * The fast, normal path: called once per `agent-run.ts` invocation. Reads the current index,
 * replaces any existing entry for this `runId` (idempotent if a run is ever retried/re-uploaded)
 * or appends a new one, and writes the whole array back -- two R2 calls total, regardless of how
 * many runs have ever happened, instead of `rebuildGalleryIndex()`'s O(n) full-bucket rescan.
 *
 * Does nothing (returns the unchanged index) only if `meta` is missing a real video -- there's
 * nothing to play in that case. A failed or killed run with a real recording is still included
 * (flagged via `status`, never hidden); see metaToEntry().
 *
 * Trade-off, worth remembering: this is a read-modify-write against one shared object, so two
 * `agent-run.ts` processes finishing at the exact same moment could race and one entry could be
 * dropped. Unlikely for a personal tool running one recorded session at a time, and recoverable
 * either way -- `rebuildGalleryIndex()` regenerates the index from R2's `meta.json` files (the
 * actual ground truth) if that ever happens.
 */
export async function addRunToGalleryIndex(runId: string, meta: RunMeta): Promise<GalleryEntry[]> {
  const entry = metaToEntry(runId, meta);
  if (!entry) return readIndex();

  const current = await readIndex();
  const next = sortNewestFirst([...current.filter((e) => e.runId !== runId), entry]);
  await writeIndex(next);
  return next;
}

/**
 * Repair/backfill tool: rebuild `index.json` from scratch by scanning every `runs/<id>/meta.json`
 * in the bucket -- the ground truth each run itself already wrote, independent of whatever
 * `index.json` currently says. Useful for backfilling runs recorded before this index existed, or
 * recovering from a lost/corrupted index or a dropped concurrent-write race (see
 * `addRunToGalleryIndex`). Not part of the normal per-run path -- that's `addRunToGalleryIndex()`,
 * an O(1) incremental write; this is an explicit O(n) maintenance operation, run by hand via
 * tools/rebuild-gallery-index.ts.
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
    const entry = metaToEntry(runId, meta);
    if (entry) entries.push(entry);
  }

  const sorted = sortNewestFirst(entries);
  await writeIndex(sorted);
  return sorted;
}
