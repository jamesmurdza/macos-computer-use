/**
 * Server-only: shortens a video's dead air -- any stretch where nothing visibly changes for at
 * least FREEZE_THRESHOLD_SEC keeps only its first GRACE_SEC and has the rest cut out.
 *
 * Deliberately runs on the *captioned* video (see api/export/[runId]/route.ts -- this is the last
 * step, after burnCaptions), not the raw recording, and that's on purpose, not an oversight: a
 * caption changing while the screen itself hasn't moved yet still counts as "something happened"
 * and should end the pause there, splitting it into two rather than treating it as one long
 * freeze straight through. Running on the raw video would miss that -- verified directly, a
 * caption-only change (screen otherwise identical) really does end an `ffmpeg freezedetect` freeze
 * at exactly that frame. Doing this after the burn-in also sidesteps ever needing to re-map
 * caption timestamps: whatever's on screen (including caption text) when a stretch gets cut is
 * simply gone, the same as any other frame -- there's no separate timeline left to keep in sync.
 *
 * `select`+`setpts` (video) and `aselect`+`asetpts` (audio, when present) do the actual cutting in
 * one pass: a single boolean expression ORing together every kept [start,end) range picks which
 * frames survive, and `setpts` recomputes timestamps so the survivors play back with no gap where
 * the cut material used to be.
 */
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

export const FREEZE_THRESHOLD_SEC = 1; // a stretch must be frozen this long to count as a "pause"
export const GRACE_SEC = 1; // ...and keeps this much of itself before the cut

export interface Freeze {
  start: number;
  end: number;
}

export interface VideoInfo {
  durationSec: number;
  hasAudio: boolean;
}

function runFfmpeg(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg-static did not resolve a binary for this platform"));
      return;
    }
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stderr }));
  });
}

/** `ffmpeg -i <path>` with no output errors out (nothing to encode to), but not before printing
 * the input's banner -- duration and stream list -- to stderr. Cheaper than shipping ffprobe just
 * for this (ffmpeg-static doesn't bundle it), and this project already leans on reading ffmpeg's
 * stderr for structured info (see measureCaptionBoxes()'s history in burnCaptions.ts's git log). */
export async function probeVideo(path: string): Promise<VideoInfo> {
  const { stderr } = await runFfmpeg(["-i", path]);
  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!durationMatch) throw new Error(`couldn't read duration from ffmpeg's output for ${path}`);
  const [, h, m, s] = durationMatch;
  const durationSec = Number(h) * 3600 + Number(m) * 60 + Number(s);
  const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(stderr);
  return { durationSec, hasAudio };
}

const FREEZE_START_RE = /freeze_start:\s*([\d.]+)/g;
const FREEZE_END_RE = /freeze_end:\s*([\d.]+)/g;

/** Runs `freezedetect` over `path` and returns every stretch of at least `thresholdSec` where the
 * frame doesn't change. If the video is still frozen when it ends, freezedetect never emits that
 * freeze's `freeze_end` (there's no "motion resumed" event to report) -- `durationSec` closes that
 * last freeze out at the end of the video instead of dropping it. */
export async function detectFreezes(path: string, thresholdSec: number, durationSec: number): Promise<Freeze[]> {
  const { stderr } = await runFfmpeg(["-i", path, "-vf", `freezedetect=d=${thresholdSec}`, "-f", "null", "-loglevel", "info", "-"]);
  const starts = [...stderr.matchAll(FREEZE_START_RE)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(FREEZE_END_RE)].map((m) => Number(m[1]));
  return starts.map((start, i) => ({ start, end: ends[i] ?? durationSec }));
}

/** Turns the *removed* ranges (each freeze, minus its opening `graceSec`) into the *kept* ranges
 * `trimPauses()` actually needs -- the complement of those removals across [0, durationSec]. */
export function computeKeepSegments(freezes: Freeze[], graceSec: number, durationSec: number): Freeze[] {
  const kept: Freeze[] = [];
  let cursor = 0;
  for (const freeze of freezes) {
    const cutStart = Math.min(freeze.start + graceSec, freeze.end); // never cuts more than the freeze itself
    if (cutStart > cursor) kept.push({ start: cursor, end: cutStart });
    cursor = Math.max(cursor, freeze.end);
  }
  if (durationSec > cursor) kept.push({ start: cursor, end: durationSec });
  return kept;
}

/** Re-encodes `inputPath` to `outputPath`, keeping only `segments` (see computeKeepSegments()) and
 * closing the gaps between them. A no-op (segments covering the whole video) is never worth
 * calling this for -- the caller skips straight to serving the untrimmed file instead. */
export async function trimPauses(inputPath: string, outputPath: string, segments: Freeze[], hasAudio: boolean): Promise<void> {
  const ranges = segments.map((s) => `between(t,${s.start},${s.end})`).join("+");
  const args = ["-y", "-i", inputPath, "-vf", `select='${ranges}',setpts=N/FRAME_RATE/TB`];
  if (hasAudio) args.push("-af", `aselect='${ranges}',asetpts=N/SR/TB`);
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "128k");
  args.push("-movflags", "+faststart", outputPath);

  const { code, stderr } = await runFfmpeg(args);
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-8000)}`);
}
