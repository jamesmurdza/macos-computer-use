import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { buildAssScript, burnCaptions } from "../../../../lib/burnCaptions";
import { parseCaptions } from "../../../../lib/captions";
import { computeKeepSegments, detectFreezes, FREEZE_THRESHOLD_SEC, GRACE_SEC, probeVideo, trimPauses } from "../../../../lib/trimPauses";

export const runtime = "nodejs";
// Re-encoding is CPU-bound and roughly proportional to video length -- these recordings are all
// short agent runs (see tools/agent-run.ts upstream), but give it real headroom over the
// framework's low single-digit-second default rather than tune it right up against typical runs.
export const maxDuration = 300;

/**
 * Downloads a run's video + events.jsonl (same public R2 objects the gallery already plays/
 * fetches -- see api/events/[runId]/route.ts for why this proxies rather than fetching R2
 * directly from the browser), burns the derived caption timeline into the video with ffmpeg, and
 * streams the result back as a download. No R2 write credentials involved -- and none needed:
 * this reads the public objects, transforms them in a scratch temp dir, and returns bytes. Nothing
 * is written back to R2 or any other durable store.
 *
 * `videoKey` comes from the client's already-resolved `GalleryEntry.videoKey` (its extension
 * varies -- mp4/mov/webm, see KNOWN_VIDEO_EXTENSIONS in tools/agent-run.ts -- so, unlike
 * events.jsonl's fixed-name convention, it can't be reconstructed from `runId` alone).
 *
 * After the captions are burned in, a last pass (see trimPauses.ts) shortens any stretch that's
 * frozen for FREEZE_THRESHOLD_SEC or longer down to just its first GRACE_SEC -- deliberately run
 * on the captioned video, not the raw one, so a caption change counts as "something happened" and
 * ends a pause there rather than letting it run through to the next real visual change.
 */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const videoKey = new URL(req.url).searchParams.get("videoKey");
  const base = process.env.CF_PUBLIC_BASE_URL;
  if (!base) return new NextResponse("CF_PUBLIC_BASE_URL is not set", { status: 500 });
  if (!videoKey) return new NextResponse("Missing videoKey", { status: 400 });

  const trimmedBase = base.replace(/\/+$/, "");
  const videoUrl = `${trimmedBase}/${videoKey}`;
  const eventsUrl = `${trimmedBase}/runs/${encodeURIComponent(runId)}/events.jsonl`;

  const [videoRes, eventsRes] = await Promise.all([
    fetch(videoUrl, { cache: "no-store" }),
    fetch(eventsUrl, { cache: "no-store" }),
  ]);
  if (!videoRes.ok) return new NextResponse("Video not found", { status: videoRes.status });

  // No events.jsonl (or it 404s) just means no captions to burn in -- still worth producing a
  // (re-encoded, but otherwise unchanged) download rather than failing the whole export.
  const captions = eventsRes.ok ? parseCaptions(await eventsRes.text()) : [];

  const dir = await mkdtemp(path.join(tmpdir(), "gallery-export-"));
  try {
    const inputPath = path.join(dir, "input");
    const assPath = path.join(dir, "captions.ass");
    const captionedPath = path.join(dir, "captioned.mp4");
    const trimmedPath = path.join(dir, "trimmed.mp4");

    await Promise.all([
      writeFile(inputPath, Buffer.from(await videoRes.arrayBuffer())),
      writeFile(assPath, buildAssScript(captions), "utf8"),
    ]);

    await burnCaptions(inputPath, assPath, captionedPath);

    const { durationSec, hasAudio } = await probeVideo(captionedPath);
    const freezes = await detectFreezes(captionedPath, FREEZE_THRESHOLD_SEC, durationSec);
    const keepSegments = computeKeepSegments(freezes, GRACE_SEC, durationSec);

    // Nothing was actually frozen long enough to trim -- skip the extra re-encode and just ship
    // the captioned video as-is (a single [0, durationSec] "keep segment" covers the whole thing).
    const finalPath =
      keepSegments.length === 1 && keepSegments[0].start === 0 && keepSegments[0].end === durationSec
        ? captionedPath
        : trimmedPath;
    if (finalPath === trimmedPath) await trimPauses(captionedPath, trimmedPath, keepSegments, hasAudio);

    const output = await readFile(finalPath);
    return new NextResponse(output, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${runId}-captioned.mp4"`,
      },
    });
  } catch (err) {
    console.error(`export failed for run ${runId}:`, err);
    return new NextResponse("Export failed", { status: 500 });
  } finally {
    // Always the scratch temp dir this request created -- never touches R2 or anything durable.
    await rm(dir, { recursive: true, force: true });
  }
}
