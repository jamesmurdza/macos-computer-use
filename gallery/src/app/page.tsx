import { loadGalleryIndex } from "../lib/gallery";
import { GalleryGrid } from "../components/GalleryGrid";

// Always fetch a fresh index.json -- this is a dashboard over what's actually in the bucket right
// now, not something that benefits from Next.js's default static/ISR caching.
export const dynamic = "force-dynamic";

export default async function GalleryPage() {
  const { configured, entries } = await loadGalleryIndex();

  return (
    <main className="gallery">
      <h1 className="gallery-title">Recordings</h1>

      {!configured ? (
        <p className="gallery-empty">
          Set <code>CF_PUBLIC_BASE_URL</code> to your bucket&apos;s public domain (e.g. a{" "}
          <code>pub-*.r2.dev</code> URL) to enable this page.
        </p>
      ) : entries.length === 0 ? (
        <p className="gallery-empty">No recordings yet.</p>
      ) : (
        <GalleryGrid entries={entries} />
      )}
    </main>
  );
}
