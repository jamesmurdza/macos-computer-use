import { getKvValue, putKvValue } from "./kv";
import { downloadRunArtifact, listRunIds } from "./storage";

/**
 * Writer side of the gallery index, stored as a single JSON value in Cloudflare KV (see kv.ts).
 * The reader (a completely separate app -- see `../../gallery/`, deployed as its own Vercel
 * project, sharing no code with this one) has its own copy of this `GalleryEntry` shape in
 * `gallery/src/lib/gallery.ts`; keep the two in sync if this ever changes, since the KV value's
 * shape is the entire contract between them. (Unlike before KV, the two apps do now both need a
 * Cloudflare credential -- ideally two different, separately-scoped tokens; see gallery/README.md.)
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

const INDEX_KV_KEY = "index";

function sortNewestFirst(entries: GalleryEntry[]): GalleryEntry[] {
  return [...entries].sort((a, b) => b.date.localeCompare(a.date));
}

async function readIndex(): Promise<GalleryEntry[]> {
  const raw = await getKvValue(INDEX_KV_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as GalleryEntry[];
  } catch {
    return []; // corrupt value -- treat as empty rather than throw; rebuildGalleryIndex() can repair it
  }
}

function metaToEntry(runId: string, meta: RunMeta): GalleryEntry | undefined {
  if (meta.status !== "ok" || !meta.videoFile || !meta.videoStartedAt || !meta.videoEndedAt) return undefined;
  return {
    runId,
    description: meta.prompt?.trim() || "(no description)",
    date: new Date(meta.videoStartedAt).toISOString(),
    durationMs: meta.videoEndedAt - meta.videoStartedAt,
    videoKey: `runs/${runId}/${meta.videoFile}`,
    thumbnailKey: `runs/${runId}/thumbnail.jpg`,
  };
}

/**
 * The fast, normal path: called once per `agent-run.ts` invocation. Reads the current index,
 * replaces any existing entry for this `runId` (idempotent if a run is ever retried/re-uploaded)
 * or appends a new one, and writes the whole array back -- two KV calls total, regardless of how
 * many runs have ever happened, instead of `rebuildGalleryIndex()`'s O(n) full-bucket rescan.
 *
 * Does nothing (returns the unchanged index) if `meta` doesn't describe a displayable run (failed,
 * or missing a video) -- a failed run isn't something worth showing in a gallery of "what the
 * agent did".
 *
 * Trade-off, worth remembering: this is a read-modify-write against one shared KV value, so two
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
  await putKvValue(INDEX_KV_KEY, JSON.stringify(next));
  return next;
}

/**
 * Repair/backfill tool: rebuild the KV index from scratch by scanning every `runs/<id>/meta.json`
 * in the bucket -- the ground truth each run itself already wrote, independent of whatever's
 * currently in KV. Useful for backfilling runs recorded before this index existed, or recovering
 * from a lost/corrupted KV value or a dropped concurrent-write race (see `addRunToGalleryIndex`).
 * Not part of the normal per-run path -- that's `addRunToGalleryIndex()`, an O(1) incremental
 * write; this is an explicit O(n) maintenance operation, run by hand via
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
  await putKvValue(INDEX_KV_KEY, JSON.stringify(sorted));
  return sorted;
}
