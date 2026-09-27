import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { requireEnv } from "./env";

/**
 * Durable storage for headless-run artifacts (video + event log + metadata; see
 * tools/agent-run.ts), backed by Cloudflare R2. R2 speaks the S3 API, so the standard
 * `@aws-sdk/client-s3` works unmodified against it -- just a different endpoint/region -- and R2
 * has no egress fees, which matters here since artifacts get pulled back down repeatedly while
 * building whatever later tool overlays the log onto the video.
 *
 * Not used by the Next.js web app (nothing there persists runs today); this exists purely for the
 * headless recorded-run path.
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

/** A presigned GET URL for `key`, so a run's video/log can be fetched later without making the
 * bucket public. Defaults to 7 days -- generous for someone coming back to review a run, well
 * under the presigner's hard cap for SigV4 URLs (7 days). */
export async function getRunArtifactUrl(key: string, expiresInSeconds = 7 * 24 * 60 * 60): Promise<string> {
  const command = new GetObjectCommand({ Bucket: requireEnv("R2_BUCKET"), Key: key });
  return getSignedUrl(client(), command, { expiresIn: expiresInSeconds });
}
