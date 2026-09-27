import { loadGalleryIndex } from "../../lib/gallery";
import { GalleryGrid } from "../../components/GalleryGrid";

export const metadata = { title: "Recordings — macOS Computer Use" };

// Always fetch a fresh index.json -- this page is a personal dashboard over what's actually in the
// bucket right now, not something that benefits from Next.js's default static/ISR caching.
export const dynamic = "force-dynamic";

export default async function GalleryPage() {
  const { configured, entries } = await loadGalleryIndex();

  return (
    <main className="gallery">
      <h1 className="gallery-title">Recordings</h1>

      {!configured ? (
        <p className="gallery-empty">
          Set <code>R2_PUBLIC_BASE_URL</code> to your bucket&apos;s public domain (e.g. a{" "}
          <code>pub-*.r2.dev</code> URL) to enable this page.
        </p>
      ) : entries.length === 0 ? (
        <p className="gallery-empty">
          No recordings yet — run <code>tools/agent-run.ts</code> to record one.
        </p>
      ) : (
        <GalleryGrid entries={entries} />
      )}
    </main>
  );
}
