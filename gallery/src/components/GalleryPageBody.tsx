import { loadGalleryIndex } from "../lib/gallery";
import { GalleryGrid } from "./GalleryGrid";

/**
 * Shared between `/` and `/runs/[runId]` (see those pages) -- both render the exact same grid,
 * the only difference is which run (if any) the modal should be pre-opened to on load, so a
 * `/runs/[runId]` URL is a real permalink: load it directly, refresh it, share it, and the same
 * run's modal is showing, on top of the same grid, every time.
 */
export async function GalleryPageBody({ initialRunId }: { initialRunId?: string }) {
  const { configured, entries } = await loadGalleryIndex();

  // The title lives inside GalleryGrid (alongside the model filter dropdown -- see there) once
  // there are entries to show; these two early-out states never render that dropdown, so they
  // need their own copy of it.
  return (
    <main className="gallery">
      {!configured ? (
        <>
          <h1 className="gallery-title">Recordings</h1>
          <p className="gallery-empty">
            Set <code>CF_PUBLIC_BASE_URL</code> to your bucket&apos;s public domain (e.g. a{" "}
            <code>pub-*.r2.dev</code> URL) to enable this page.
          </p>
        </>
      ) : entries.length === 0 ? (
        <>
          <h1 className="gallery-title">Recordings</h1>
          <p className="gallery-empty">No recordings yet.</p>
        </>
      ) : (
        <GalleryGrid entries={entries} initialRunId={initialRunId} />
      )}
    </main>
  );
}
