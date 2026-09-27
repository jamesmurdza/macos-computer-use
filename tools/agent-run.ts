/**
 * Headless, recorded production run: drives the exact same production streamAgent() as
 * tools/agent-harness.ts, but additionally:
 *   - records the sandbox's screen for the whole run (sandbox.recording.start/stop + download),
 *   - writes a structured, timestamped JSONL log of every agent event,
 *   - captures a thumbnail screenshot of wherever the run ended up,
 *   - uploads the video, the log, the thumbnail, and a small metadata file to Cloudflare R2,
 *   - rebuilds a bucket-wide index.json the /gallery page reads (see src/lib/gallery.ts),
 * so a later tool can overlay the log onto the video, and so every recorded run shows up in the
 * gallery without any manual step.
 *
 * This is a sibling to agent-harness.ts, not a replacement for it: the harness stays a fast,
 * credential-light dev-iteration tool (just USE_COMPUTER_* and ANTHROPIC_API_KEY). This script needs
 * the extra R2_* credentials and takes longer (it downloads/uploads a video), so it's the
 * "production-style" headless path. If R2_* isn't set, it still runs end-to-end and leaves every
 * artifact under /tmp/logs/runs/<runId>/ -- it just skips the upload step.
 *
 * Usage:  npx tsx tools/agent-run.ts "use xcode to make and run a hello world script"
 *         MODEL=sonnet npx tsx tools/agent-run.ts "open safari and go to example.com"
 *         RESOLUTION=1280x720 npx tsx tools/agent-run.ts "..."   # shrink the recorded video
 *
 * AGENT_RUN_ANTHROPIC_API_KEY / R2_PUBLIC_BASE_URL: see below, right after the `.env` load.
 *
 * Every JSONL line's `elapsedMs` is measured from the exact moment the recording actually
 * started (right after `recording.start()` resolves), not from process start or prompt time --
 * that's the number a later overlay tool should seek the video by.
 *
 * Known limitation: if the sandbox rotates mid-run (its own idle timeout, extremely unlikely
 * given this keeps actively driving it), the recording lives on the now-unreachable original
 * sandbox and cannot be stopped/downloaded through the new one -- this is detected and reported
 * (not silently swallowed), but the video itself is lost in that case. The event log and metadata
 * are still written and uploaded either way.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

if (existsSync(".env")) process.loadEnvFile(".env");

/**
 * Deliberately a different name from ANTHROPIC_API_KEY: `npm run dev`/`build`/`start` (Next.js)
 * auto-load `.env`'s `ANTHROPIC_API_KEY` for the web app, so a key meant only for headless
 * recorded runs needs a different name to stay structurally invisible to the web app -- not just
 * "don't set it there." Falls back to plain `ANTHROPIC_API_KEY` so this still works with no extra
 * setup for anyone who doesn't care about the distinction. This only ever mutates this script's
 * own process env (a separate OS process from any running `next dev`), never the `.env` file.
 */
const anthropicKey = process.env.AGENT_RUN_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey;

const { streamAgent } = await import("../src/lib/agent.js");
const { createSandbox } = await import("../src/lib/sandbox-handle.js");
const { downloadRecording, setDisplayResolution, takeScreenshot } = await import("../src/lib/sandbox.js");
const { uploadRunArtifact, getRunArtifactUrl, publicRunArtifactUrl } = await import("../src/lib/storage.js");
const { rebuildGalleryIndex } = await import("../src/lib/gallery.js");
const { isModelChoice, DEFAULT_MODEL_CHOICE } = await import("../src/lib/llm.js");

function parseResolution(v: string | undefined): { width: number; height: number } | undefined {
  if (!v) return undefined;
  const m = /^(\d+)x(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`RESOLUTION must look like "1280x720", got "${v}"`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

const KNOWN_VIDEO_EXTENSIONS: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
function extensionFor(contentType: string): string {
  return KNOWN_VIDEO_EXTENSIONS[contentType] ?? contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "bin";
}

const R2_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
const haveR2 = R2_VARS.every((k) => !!process.env[k]);

const prompt = process.argv.slice(2).join(" ") || "use xcode to make and run a hello world script";
const modelChoice = isModelChoice(process.env.MODEL) ? process.env.MODEL : DEFAULT_MODEL_CHOICE;
const resolution = parseResolution(process.env.RESOLUTION);

const runId = randomUUID();
const localDir = `/tmp/logs/runs/${runId}`;
mkdirSync(localDir, { recursive: true });
const eventsPath = `${localDir}/events.jsonl`;

/** `elapsedMs` is filled in by the caller once `videoStartedAt` is known; before that (there is
 * no "before recording starts" event here in practice) it's just omitted. */
function logEvent(record: Record<string, unknown>): void {
  appendFileSync(eventsPath, `${JSON.stringify(record)}\n`);
}

/** Every AgentEvent carries a `sandbox: SandboxDescriptor`, and `vncUrl` embeds a live bearer
 * token in its query string (see testing.md: "contains the API key, so it is not printed by
 * default" -- agent-harness.ts follows the same rule). This log gets uploaded to R2, so strip it
 * before persisting rather than leaking a working sandbox credential into stored/shared artifacts. */
function withoutVncUrl<T extends { sandbox: { sandboxId: string; host: string; vncUrl: string } }>(
  ev: T,
): Omit<T, "sandbox"> & { sandbox: { sandboxId: string; host: string } } {
  const { vncUrl: _vncUrl, ...sandbox } = ev.sandbox;
  return { ...ev, sandbox };
}

console.log(
  `RUN ${runId}\nPROMPT: ${prompt}\nMODEL:  ${modelChoice}` +
    `${resolution ? `\nRESOLUTION: ${resolution.width}x${resolution.height}` : ""}\n${"-".repeat(70)}`,
);

const sandbox = await createSandbox();
const sandboxRef = { current: sandbox };
console.log(`sandbox: ${sandbox.sandboxId}`);

let recordingId: string | undefined;
let videoStartedAt: number | undefined;
let status: "ok" | "error" = "ok";
let errorMessage: string | undefined;
let stepCount = 0;
let replyBuf = "";

try {
  if (resolution) {
    const r = await setDisplayResolution(sandboxRef.current, resolution.width, resolution.height);
    console.log(`resolution: ${r.status}${r.size ? ` (${r.size.width}x${r.size.height})` : ""}${r.message ? ` -- ${r.message}` : ""}`);
  }

  recordingId = await sandboxRef.current.recording.start();
  videoStartedAt = Date.now();
  console.log(`recording: ${recordingId} (started)`);
  logEvent({ ts: videoStartedAt, elapsedMs: 0, type: "run-start", runId, prompt, modelChoice, sandboxId: sandbox.sandboxId, recordingId });

  const pending = new Map<string, { tool: string }>();
  for await (const ev of streamAgent({ prompt, modelChoice, sandboxRef, history: [] })) {
    const now = Date.now();
    const elapsedMs = now - videoStartedAt;
    logEvent({ ts: now, elapsedMs, ...withoutVncUrl(ev) });

    const t = (elapsedMs / 1000).toFixed(1).padStart(6);
    if (ev.t === "tool-call") {
      stepCount++;
      pending.set(ev.id, { tool: ev.tool });
      console.log(`[${t}s] #${stepCount} -> ${ev.tool}(${JSON.stringify(ev.input)})`);
    } else if (ev.t === "tool-result") {
      console.log(`[${t}s]         -> ${JSON.stringify(ev.output).slice(0, 300)}`);
    } else if (ev.t === "tool-error") {
      console.log(`[${t}s]         ERROR -> ${ev.error}`);
    } else if (ev.t === "text") {
      replyBuf += ev.text;
    } else if (ev.t === "error") {
      status = "error";
      errorMessage = ev.error;
      console.log(`[${t}s] STREAM ERROR: ${ev.error}`);
    } else if (ev.t === "done") {
      console.log(`${"-".repeat(70)}\n[${t}s] DONE -- ${stepCount} tool call(s)`);
    }
  }
  console.log(`\nREPLY: ${replyBuf.trim() || "(none)"}`);
} catch (err) {
  status = "error";
  errorMessage = err instanceof Error ? err.message : String(err);
  console.error("RUN FAILED:", errorMessage);
} finally {
  const rotated = sandboxRef.current.sandboxId !== sandbox.sandboxId;
  if (rotated) {
    console.warn(
      `\nWARNING: sandbox rotated mid-run (${sandbox.sandboxId} -> ${sandboxRef.current.sandboxId}). ` +
        `The recording lives on the original sandbox, which is gone -- it cannot be stopped or downloaded.`,
    );
  }

  let videoFile: string | undefined;
  let videoContentType: string | undefined;
  let videoFileSize: number | undefined;
  let thumbnailFile: string | undefined;

  // For the /gallery page: a small screenshot of wherever the run ended up, independent of the
  // recording itself (still works even if recording.start() never succeeded). Skipped when
  // rotated for the same reason video download is: `sandbox` is gone, only the new one exists.
  if (!rotated) {
    try {
      // `scale` is requested but not actually honored by the gateway as of use-computer-sdk
      // 0.1.13 (verified: still returns a full-resolution image) -- quality is turned down
      // instead to keep the thumbnail file small, since it's only ever shown at card size.
      const shot = await takeScreenshot(sandbox, { quality: 45, scale: 0.5 });
      thumbnailFile = "thumbnail.jpg";
      writeFileSync(`${localDir}/${thumbnailFile}`, shot);
      console.log(`wrote ${localDir}/${thumbnailFile} (${shot.length} bytes)`);
    } catch (err) {
      console.error("Failed to capture thumbnail:", err instanceof Error ? err.message : err);
    }
  }

  if (recordingId && !rotated) {
    try {
      const stopResult = await sandbox.recording.stop(recordingId);
      videoFileSize = stopResult.fileSize;
      console.log(`recording: stopped (${videoFileSize ?? "?"} bytes)`);

      const downloaded = await downloadRecording(sandbox, recordingId);
      videoContentType = downloaded.contentType;
      videoFile = `video.${extensionFor(downloaded.contentType)}`;
      writeFileSync(`${localDir}/${videoFile}`, downloaded.bytes);
      console.log(`wrote ${localDir}/${videoFile} (${downloaded.bytes.length} bytes, ${downloaded.contentType})`);
    } catch (err) {
      console.error("Failed to stop/download recording (event log is still intact):", err instanceof Error ? err.message : err);
    }
  }

  const videoEndedAt = Date.now();
  logEvent({
    ts: videoEndedAt,
    elapsedMs: videoStartedAt ? videoEndedAt - videoStartedAt : 0,
    type: "run-end",
    status,
    error: errorMessage,
    stepCount,
    reply: replyBuf.trim() || undefined,
    videoFileSize,
    sandboxRotated: rotated,
  });

  const meta = {
    runId,
    prompt,
    modelChoice,
    resolution,
    sandboxId: sandbox.sandboxId,
    recordingId,
    videoStartedAt,
    videoEndedAt,
    videoFile,
    videoContentType,
    videoFileSize,
    thumbnailFile,
    status,
    error: errorMessage,
    sandboxRotated: rotated,
  };
  writeFileSync(`${localDir}/meta.json`, JSON.stringify(meta, null, 2));
  console.log(`wrote ${localDir}/meta.json`);

  if (haveR2) {
    try {
      const prefix = `runs/${runId}`;
      await uploadRunArtifact(`${prefix}/events.jsonl`, readFileSync(eventsPath), "application/x-ndjson");
      await uploadRunArtifact(`${prefix}/meta.json`, readFileSync(`${localDir}/meta.json`), "application/json");
      if (videoFile) {
        await uploadRunArtifact(`${prefix}/${videoFile}`, readFileSync(`${localDir}/${videoFile}`), videoContentType ?? "application/octet-stream");
      }
      if (thumbnailFile) {
        await uploadRunArtifact(`${prefix}/${thumbnailFile}`, readFileSync(`${localDir}/${thumbnailFile}`), "image/jpeg");
      }
      // Prefer a plain public URL (permanent, no expiry) when R2_PUBLIC_BASE_URL is set (the
      // bucket's public "pub-*.r2.dev" domain or a custom domain); fall back to a presigned URL
      // otherwise, which works against a private bucket with no public access configured at all.
      const eventsUrl = publicRunArtifactUrl(`${prefix}/events.jsonl`) ?? (await getRunArtifactUrl(`${prefix}/events.jsonl`));
      const videoUrl = videoFile ? (publicRunArtifactUrl(`${prefix}/${videoFile}`) ?? (await getRunArtifactUrl(`${prefix}/${videoFile}`))) : undefined;
      console.log(`\nuploaded to r2://${process.env.R2_BUCKET}/${prefix}/`);
      console.log(`  events: ${eventsUrl}`);
      if (videoUrl) console.log(`  video:  ${videoUrl}`);

      // Rebuild the /gallery index from every run currently in the bucket (not just this one) --
      // see gallery.ts for why a full rebuild rather than an incremental patch.
      try {
        const entries = await rebuildGalleryIndex();
        console.log(`gallery index rebuilt: ${entries.length} run(s)`);
      } catch (err) {
        console.error("Failed to rebuild the gallery index (this run's own artifacts are still uploaded fine):", err instanceof Error ? err.message : err);
      }
    } catch (err) {
      console.error(`R2 upload failed (artifacts are still intact locally at ${localDir}):`, err instanceof Error ? err.message : err);
    }
  } else {
    console.log(`\n(${R2_VARS.join("/")} not all set -- skipping upload; artifacts are at ${localDir})`);
  }

  await sandboxRef.current.close();
  console.log("(sandbox closed)");
}
