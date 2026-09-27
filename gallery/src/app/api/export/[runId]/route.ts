import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { buildAssScript, burnCaptions, measureCaptionBoxes } from "../../../../lib/burnCaptions";
import { parseCaptions } from "../../../../lib/captions";

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
    const outputPath = path.join(dir, "output.mp4");

    // The box each caption gets drawn in is sized to actually fit its text (for rounded corners
    // that hug the words rather than a fixed guess) -- measureCaptionBoxes renders each caption
    // off-screen first to read back real pixel dimensions. See burnCaptions.ts's module doc.
    const [, boxes] = await Promise.all([
      writeFile(inputPath, Buffer.from(await videoRes.arrayBuffer())),
      measureCaptionBoxes(captions, dir),
    ]);
    await writeFile(assPath, buildAssScript(captions, boxes), "utf8");

    await burnCaptions(inputPath, assPath, outputPath);

    const output = await readFile(outputPath);
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
