import { GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { requireEnv } from "./env";

/**
 * Durable storage for headless-run artifacts (video + event log + metadata; see
 * tools/agent-run.ts), backed by Cloudflare R2. R2 speaks the S3 API, so the standard
 * `@aws-sdk/client-s3` works unmodified against it -- just a different endpoint/region -- and R2
 * has no egress fees, which matters here since artifacts get pulled back down repeatedly while
 * building whatever later tool overlays the log onto the video.
 *
 * The functions that need R2 credentials (`client()`-based) are only ever called from CLI tooling
 * (tools/agent-run.ts, src/lib/gallery.ts's `rebuildGalleryIndex()`) -- never from the Next.js web
 * app, which deliberately never holds R2 secret credentials at all. `publicRunArtifactUrl()` is
 * the one exception: it's pure string-joining against `R2_PUBLIC_BASE_URL` (not a secret), and the
 * `/gallery` page uses it to build links to a public bucket.
 */

/**
 * Built fresh per call rather than cached: this module is only ever used by a short-lived CLI
 * process (tools/agent-run.ts) making a handful of calls, so there's no real cost to it, and it
 * avoids a module-level singleton silently reusing stale credentials/config across calls.
 */
function client(): S3Client {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
}

/** Upload one artifact (video, JSONL log, or metadata JSON) to `R2_BUCKET` at `key`. */
export async function uploadRunArtifact(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: requireEnv("R2_BUCKET"),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Download one artifact's raw bytes, or undefined if `key` doesn't exist (any other error still
 * throws). Used to read back a run's own `meta.json` when rebuilding the gallery index. */
export async function downloadRunArtifact(key: string): Promise<Uint8Array | undefined> {
  try {
    const res = await client().send(new GetObjectCommand({ Bucket: requireEnv("R2_BUCKET"), Key: key }));
    return await res.Body?.transformToByteArray();
  } catch (err) {
    if (err instanceof NoSuchKey) return undefined;
    throw err;
  }
}

/** Every `<runId>` under the `runs/` prefix (one per completed `agent-run.ts` invocation that got
 * far enough to upload anything), derived from R2's "common prefixes" for a delimited listing --
 * no need to page through every object inside each run's folder just to enumerate the runs. */
export async function listRunIds(): Promise<string[]> {
  const runIds: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client().send(
      new ListObjectsV2Command({
        Bucket: requireEnv("R2_BUCKET"),
        Prefix: "runs/",
        Delimiter: "/",
        ContinuationToken: continuationToken,
      }),
    );
    for (const p of page.CommonPrefixes ?? []) {
      const runId = p.Prefix?.slice("runs/".length).replace(/\/$/, "");
      if (runId) runIds.push(runId);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return runIds;
}

/** A presigned GET URL for `key`, so a run's video/log can be fetched later without making the
 * bucket public. Defaults to 7 days -- generous for someone coming back to review a run, well
 * under the presigner's hard cap for SigV4 URLs (7 days). */
export async function getRunArtifactUrl(key: string, expiresInSeconds = 7 * 24 * 60 * 60): Promise<string> {
  const command = new GetObjectCommand({ Bucket: requireEnv("R2_BUCKET"), Key: key });
  return getSignedUrl(client(), command, { expiresIn: expiresInSeconds });
}

/**
 * Plain public URL for `key` when the bucket has R2's public access enabled (its `pub-*.r2.dev`
 * domain, or a custom domain) and `R2_PUBLIC_BASE_URL` is set to it -- permanent, no expiry, and
 * far shorter than a presigned URL. Returns undefined if that var isn't set, so callers should
 * fall back to `getRunArtifactUrl()`.
 */
export function publicRunArtifactUrl(key: string): string | undefined {
  const base = process.env.R2_PUBLIC_BASE_URL;
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/${key}`;
}
