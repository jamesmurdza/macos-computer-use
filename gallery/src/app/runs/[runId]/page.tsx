import type { Metadata } from "next";
import { loadGalleryIndex } from "../../../lib/gallery";
import { GalleryPageBody } from "../../../components/GalleryPageBody";

// Same reasoning as the home page: always fetch a fresh index, this is a live dashboard.
export const dynamic = "force-dynamic";

interface Params {
  runId: string;
}

/** Nice link previews when a permalink gets shared (Slack, Twitter/X, iMessage, etc.) -- the
 * thumbnail as the OG image, the prompt as the title. Silently falls back to generic metadata if
 * the run isn't found (e.g. a stale link to a since-deleted run) rather than erroring. */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { runId } = await params;
  const { entries } = await loadGalleryIndex();
  const entry = entries.find((e) => e.runId === runId);
  if (!entry) return { title: "Recording not found — Recordings" };

  return {
    title: `${entry.description} — Recordings`,
    openGraph: { title: entry.description, images: [entry.thumbnailUrl] },
    twitter: { card: "summary_large_image", title: entry.description, images: [entry.thumbnailUrl] },
  };
}

export default async function RunPermalinkPage({ params }: { params: Promise<Params> }) {
  const { runId } = await params;
  return <GalleryPageBody initialRunId={runId} />;
}
