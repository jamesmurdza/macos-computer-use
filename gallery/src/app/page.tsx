import { GalleryPageBody } from "../components/GalleryPageBody";

// Always fetch a fresh index.json -- this is a dashboard over what's actually in the bucket right
// now, not something that benefits from Next.js's default static/ISR caching.
export const dynamic = "force-dynamic";

export default function GalleryPage() {
  return <GalleryPageBody />;
}
