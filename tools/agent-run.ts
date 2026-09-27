/**
 * Headless, recorded production run: drives the exact same production streamAgent() as
 * tools/agent-harness.ts, but additionally:
 *   - records the sandbox's screen for the whole run (sandbox.recording.start/stop + download),
 *   - writes a structured, timestamped JSONL log of every agent event,
 *   - captures a thumbnail screenshot of wherever the run ended up,
 *   - uploads the video, the log, the thumbnail, and a small metadata file to Cloudflare R2,
 *   - adds this run to the gallery index, a JSON object also in R2 (see src/lib/gallery.ts),
 * so a later tool can overlay the log onto the video, and so every recorded run shows up in the
 * gallery without any manual step.
 *
 * This is a sibling to agent-harness.ts, not a replacement for it: the harness stays a fast,
 * credential-light dev-iteration tool (just USE_COMPUTER_* and ANTHROPIC_API_KEY). This script needs
 * the extra CF_* credentials and takes longer (it downloads/uploads a video), so it's the
 * "production-style" headless path. If CF_* isn't set, it still runs end-to-end and leaves every
 * artifact under /tmp/logs/runs/<runId>/ -- it just skips the upload step.
 *
 * Usage:  npx tsx tools/agent-run.ts "use xcode to make and run a hello world script"
 *         MODEL=sonnet npx tsx tools/agent-run.ts "open safari and go to example.com"
 *         MODEL=openrouter:qwen/qwen3.7-flash npx tsx tools/agent-run.ts "..."  # needs OPENROUTER_API_KEY
 *         RESOLUTION=1280x720 npx tsx tools/agent-run.ts "..."   # override the default resolution
 *         RESOLUTION=native npx tsx tools/agent-run.ts "..."     # keep the sandbox's native 1920x1080
 *
 * AGENT_RUN_ANTHROPIC_API_KEY / CF_PUBLIC_BASE_URL: see below, right after the `.env` load.
 *
 * Every run records which model actually made it (`modelChoice`, exactly as passed -- e.g.
 * `"haiku"` or `"openrouter:qwen/qwen3.7-flash"`, no lookup table needed later) plus token counts
 * and an estimated USD cost (src/lib/cost.ts) in both events.jsonl's run-end line and meta.json,
 * and the gallery surfaces model + cost under the video (see src/lib/gallery.ts).
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
 *
 * Killing an unproductive run: send SIGTERM/SIGINT (a plain `kill <pid>` or Ctrl-C) rather than
 * SIGKILL (`kill -9`) -- SIGTERM/SIGINT are caught here to abort the agent loop and run the exact
 * same recording-stop/download/upload cleanup a normal finish does (status ends up "error", so it
 * won't appear in the public gallery, but the video/log/meta are all still saved). SIGKILL can't
 * be caught by any process, so it always loses the recording; a second SIGTERM/SIGINT forces an
 * immediate exit too, for the rare case where the in-flight tool call itself is hung.
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

const { streamAgent, MAX_AGENT_STEPS } = await import("../src/lib/agent.js");
const { createSandbox } = await import("../src/lib/sandbox-handle.js");
const { downloadRecording, setDisplayResolution, takeScreenshot } = await import("../src/lib/sandbox.js");
const { uploadRunArtifact, getRunArtifactUrl, publicRunArtifactUrl } = await import("../src/lib/storage.js");
const { addRunToGalleryIndex } = await import("../src/lib/gallery.js");
const { isModelSelector, DEFAULT_MODEL_CHOICE } = await import("../src/lib/llm.js");
const { getModelPricing, estimateCost } = await import("../src/lib/cost.js");

/**
 * Applied automatically unless RESOLUTION says otherwise -- keeps recorded video files smaller
 * than the sandbox's native 1920x1080 by default. One of 11 verified usable modes this virtual
 * display supports (see testing.md's "Display resolution" section for the full list).
 */
const DEFAULT_RESOLUTION = { width: 1280, height: 960 };

function parseResolution(v: string | undefined): { width: number; height: number } | undefined {
  if (v === undefined) return DEFAULT_RESOLUTION;
  const trimmed = v.trim();
  if (trimmed.toLowerCase() === "native") return undefined; // explicit opt-out -- keep the sandbox's native 1920x1080
  const m = /^(\d+)x(\d+)$/.exec(trimmed);
  if (!m) throw new Error(`RESOLUTION must look like "1280x720" or "native" (to skip resizing), got "${v}"`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

const KNOWN_VIDEO_EXTENSIONS: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
function extensionFor(contentType: string): string {
  return KNOWN_VIDEO_EXTENSIONS[contentType] ?? contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "bin";
}

const R2_VARS = ["CF_ACCOUNT_ID", "CF_ACCESS_KEY_ID", "CF_SECRET_ACCESS_KEY", "CF_BUCKET"];
const haveR2 = R2_VARS.every((k) => !!process.env[k]);

const prompt = process.argv.slice(2).join(" ") || "use xcode to make and run a hello world script";
// isModelSelector (not isModelChoice) -- also accepts "openrouter:provider/model-id" for
// experimenting with cheaper/alternative models; see src/lib/llm.ts.
const modelChoice = isModelSelector(process.env.MODEL) ? process.env.MODEL : DEFAULT_MODEL_CHOICE;
const resolution = parseResolution(process.env.RESOLUTION);
// Raise the step budget for a deliberately long, multi-app headless demo -- e.g.
// MAX_STEPS=150 npx tsx tools/agent-run.ts "...". Only ever read here, not by the web app, so its
// default (MAX_AGENT_STEPS) is unaffected regardless of what this script is asked to do.
const maxSteps = process.env.MAX_STEPS ? Number(process.env.MAX_STEPS) : MAX_AGENT_STEPS;
if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error(`MAX_STEPS must be a positive integer, got "${process.env.MAX_STEPS}"`);

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
    `${resolution ? `\nRESOLUTION: ${resolution.width}x${resolution.height}` : ""}` +
    `${maxSteps !== MAX_AGENT_STEPS ? `\nMAX_STEPS: ${maxSteps} (default ${MAX_AGENT_STEPS})` : ""}\n${"-".repeat(70)}`,
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
let inputTokens: number | undefined;
let outputTokens: number | undefined;

/**
 * Whoever's driving this run (a human watching it live, or another Claude instance monitoring a
 * batch of these) needs to be able to kill a run that's stopped being productive without losing
 * the recording -- a plain `kill <pid>` sends SIGTERM, and Node's default response to an
 * unhandled SIGTERM is to terminate immediately, skipping the `finally` block below entirely
 * (verified against a real run: the sandbox was left dangling, still "active", with its recording
 * never stopped -- by the time anyone went back for it, the sandbox had already been reaped and
 * the video was gone for good). Catching the signal and aborting the in-flight streamAgent() call
 * instead lets that same `finally` block run normally, so the recording still gets
 * stopped/downloaded/uploaded and the sandbox still gets closed -- the run just ends with
 * status "error" (not added to the public gallery index, but the raw artifacts are preserved in
 * R2 and locally, same as any other failed run) instead of "ok".
 *
 * A second signal forces an immediate exit -- e.g. if the in-flight tool call's own HTTP request
 * to the sandbox is itself hung and the abort doesn't unblock it quickly enough to matter.
 */
const abortController = new AbortController();
let killSignal: NodeJS.Signals | undefined;
function handleKillSignal(signal: NodeJS.Signals): void {
  if (killSignal) {
    console.error(`\nReceived ${signal} again -- forcing immediate exit (recording may be lost).`);
    process.exit(1);
  }
  killSignal = signal;
  console.error(`\nReceived ${signal} -- aborting the agent loop so the recording is stopped/saved before exit...`);
  abortController.abort();
}
process.on("SIGTERM", handleKillSignal);
process.on("SIGINT", handleKillSignal);

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
  for await (const ev of streamAgent({ prompt, modelChoice, sandboxRef, history: [], maxSteps, signal: abortController.signal })) {
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
      inputTokens = ev.usage?.inputTokens;
      outputTokens = ev.usage?.outputTokens;
      console.log(`${"-".repeat(70)}\n[${t}s] DONE -- ${stepCount} tool call(s)`);
    }
  }
  console.log(`\nREPLY: ${replyBuf.trim() || "(none)"}`);
} catch (err) {
  status = "error";
  errorMessage = err instanceof Error ? err.message : String(err);
  console.error("RUN FAILED:", errorMessage);
} finally {
  // streamAgent() treats an aborted signal as a clean-ish shutdown internally (it yields a normal
  // "done" event rather than throwing -- see its own doc comment), so a killed run would
  // otherwise fall through with status still "ok" even though the task never actually finished.
  // Override explicitly, using killSignal (set synchronously by the signal handler above) rather
  // than relying on an exception that may never come.
  if (killSignal) {
    status = "error";
    errorMessage = `Terminated by ${killSignal} after ${stepCount} step(s) (recording preserved below).`;
    console.error(`\n${errorMessage}`);
  }

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

  // Cost is an estimate against current list price (fetched live for openrouter: models, since
  // OpenRouter's pricing API is public with no auth needed -- verified directly), not the exact
  // amount actually billed. undefined (not 0) when pricing can't be determined, so it reads as
  // "unknown" rather than misleadingly "free" downstream.
  let costUsd: number | undefined;
  const pricing = await getModelPricing(modelChoice).catch(() => undefined);
  if (pricing) costUsd = estimateCost({ inputTokens, outputTokens }, pricing);
  console.log(
    `\ntokens: ${inputTokens ?? "?"} in / ${outputTokens ?? "?"} out` +
      (costUsd !== undefined ? ` -- ~$${costUsd.toFixed(4)} (${modelChoice})` : ""),
  );

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
    inputTokens,
    outputTokens,
    costUsd,
  });

  const meta = {
    runId,
    prompt,
    modelChoice,
    maxSteps,
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
    inputTokens,
    outputTokens,
    costUsd,
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
      // Prefer a plain public URL (permanent, no expiry) when CF_PUBLIC_BASE_URL is set (the
      // bucket's public "pub-*.r2.dev" domain or a custom domain); fall back to a presigned URL
      // otherwise, which works against a private bucket with no public access configured at all.
      const eventsUrl = publicRunArtifactUrl(`${prefix}/events.jsonl`) ?? (await getRunArtifactUrl(`${prefix}/events.jsonl`));
      const videoUrl = videoFile ? (publicRunArtifactUrl(`${prefix}/${videoFile}`) ?? (await getRunArtifactUrl(`${prefix}/${videoFile}`))) : undefined;
      console.log(`\nuploaded to r2://${process.env.CF_BUCKET}/${prefix}/`);
      console.log(`  events: ${eventsUrl}`);
      if (videoUrl) console.log(`  video:  ${videoUrl}`);

      // Add this run to the gallery index (index.json, also in R2 -- see src/lib/gallery.ts) --
      // an O(1) incremental write, not the full-bucket rebuild tools/rebuild-gallery-index.ts does.
      try {
        const entries = await addRunToGalleryIndex(runId, meta);
        console.log(`gallery index updated: ${entries.length} run(s) total`);
      } catch (err) {
        console.error("Failed to update the gallery index (this run's own artifacts are still uploaded fine):", err instanceof Error ? err.message : err);
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
