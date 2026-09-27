import { NextResponse } from "next/server";

/**
 * Same-origin proxy for a run's events.jsonl, so the client (GalleryGrid's caption overlay) can
 * `fetch()` it without hitting CORS -- verified directly: R2's public bucket domain sends no
 * `Access-Control-Allow-Origin` header at all, so a browser blocks reading the response body of a
 * direct cross-origin fetch to it (a `<video src>`/`<img src>` doesn't need CORS for display, but
 * a JS `fetch()` reading the body does). This route just re-fetches the same public URL
 * server-side (no credentials involved -- CF_PUBLIC_BASE_URL isn't a secret) and relays it, which
 * isn't subject to CORS since it's not a browser-initiated cross-origin request.
 *
 * `events.jsonl`'s path is a fixed convention (`runs/<runId>/events.jsonl`, see the main project's
 * tools/agent-run.ts) that never varies, unlike the video file's extension -- so this constructs
 * the key directly from `runId` rather than needing it stored in the gallery index.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const base = process.env.CF_PUBLIC_BASE_URL;
  if (!base) return new NextResponse("CF_PUBLIC_BASE_URL is not set", { status: 500 });

  const url = `${base.replace(/\/+$/, "")}/runs/${encodeURIComponent(runId)}/events.jsonl`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return new NextResponse("", { status: res.status });

  const text = await res.text();
  return new NextResponse(text, { headers: { "Content-Type": "application/x-ndjson" } });
}
