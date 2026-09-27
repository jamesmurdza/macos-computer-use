/**
 * Server-only: takes a downloaded run video plus its parsed caption timeline (see captions.ts)
 * and produces a new mp4 with the captions burned into the pixels, styled to match the on-page
 * `.gallery-caption` overlay (see globals.css) as closely as ffmpeg reasonably allows.
 *
 * Why ASS/libass and not drawtext: drawtext would be the more obvious choice (per-caption filter
 * with an `enable='between(t,a,b)'` window), but the `ffmpeg-static` binary this project depends
 * on is compiled *without* the drawtext filter (verified directly -- `ffmpeg -filters` lists
 * `subtitles`/`ass` but not `drawtext`). `subtitles` (libass) is available, so captions are
 * expressed as a generated .ass subtitle script instead, with one Dialogue line per caption
 * timed exactly like the overlay's captionAt() lookup: from this entry's elapsedMs to the next
 * entry's (or to a fixed 24h ceiling for the last one -- irrelevant once the video itself ends).
 *
 * PlayResX/PlayResY are pinned to a fixed virtual canvas (1280x720) rather than the source
 * video's real resolution (which would need an ffprobe call -- ffmpeg-static ships ffmpeg only,
 * not ffprobe): libass scales every style value in the script proportionally to the actual frame
 * size at render time, so a fixed virtual canvas still renders correctly at whatever resolution
 * the recording actually is.
 *
 * The font is bundled at `assets/fonts/DejaVuSans.ttf` (see LICENSE.txt there) and handed to
 * libass via `fontsdir` rather than relied on system-installed/fontconfig-resolved -- there's no
 * guarantee the deploy target has *any* fonts installed otherwise.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { CaptionEntry } from "./captions";

const FONT_DIR = path.join(process.cwd(), "assets/fonts");
const FONT_FAMILY = "DejaVu Sans";

// Matches .gallery-caption's look: off-white text (#ece6da) on a ~72%-opaque near-black box
// (rgba(10,9,8,.72)), centered, near the bottom. ASS colours are &HAABBGGRR (alpha first, then
// blue/green/red, all inverted-alpha: 00 = opaque, FF = transparent).
const STYLE = [
  "Caption", // Name
  FONT_FAMILY, // Fontname
  "32", // Fontsize (relative to the 1280x720 virtual canvas below)
  "&H00DAE6EC", // PrimaryColour (text)
  "&H00DAE6EC", // SecondaryColour
  "&H4708090A", // OutlineColour (also used as the box border colour under BorderStyle 3)
  "&H4708090A", // BackColour (box fill)
  "0", // Bold
  "0", // Italic
  "0", // Underline
  "0", // StrikeOut
  "100", // ScaleX
  "100", // ScaleY
  "0", // Spacing
  "0", // Angle
  "3", // BorderStyle: 3 = opaque box behind the text (not just an outline)
  "8", // Outline: box padding under BorderStyle 3
  "0", // Shadow
  "2", // Alignment: bottom-center (numpad layout)
  "40", // MarginL
  "40", // MarginR
  "60", // MarginV -- distance from the bottom edge, echoing the overlay's `bottom: 48px`
  "1", // Encoding
].join(",");

/** `H:MM:SS.CC` -- the timestamp format ASS Dialogue lines require (centiseconds, not millis). */
function toAssTimestamp(ms: number): string {
  const totalCs = Math.max(0, Math.round(ms / 10));
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** Neutralizes the two things that mean something special inside an ASS Text field -- a literal
 * newline would break the one-Dialogue-per-line file format, and `{`/`}` would be parsed as an
 * override-tag block (e.g. a tool summary that happens to contain "{foo}" could otherwise hide
 * text or crash the style). Commas need no escaping: libass only splits Dialogue's first N-1
 * fields on comma and takes the rest of the line as Text verbatim. */
function sanitizeAssText(s: string): string {
  return s.replace(/\r\n|\r|\n/g, "\\N").replace(/[{}]/g, "");
}

const END_OF_TIME_MS = 24 * 60 * 60 * 1000; // last caption's End -- harmless once the video itself ends first

function buildAssScript(captions: CaptionEntry[]): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ${STYLE}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const lines = captions
    .filter((c) => c.text.trim())
    .map((c, i) => {
      const start = c.elapsedMs;
      const end = i + 1 < captions.length ? Math.max(captions[i + 1].elapsedMs, start + 50) : END_OF_TIME_MS;
      return `Dialogue: 0,${toAssTimestamp(start)},${toAssTimestamp(end)},Caption,,0,0,0,,${sanitizeAssText(c.text)}`;
    });

  return `${header}\n${lines.join("\n")}\n`;
}

/** Escapes a path for use inside an ffmpeg filtergraph option value -- colons and backslashes are
 * filtergraph syntax, so a path containing either would otherwise get misparsed. Paths here are
 * always ones this module generated itself (a mkdtemp() dir on Linux), so this is defense in
 * depth rather than something expected to ever actually fire. */
function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** Runs ffmpeg to burn `captions` into `inputPath`, writing an mp4 to `outputPath`. Both paths are
 * plain filesystem paths (the caller owns fetching the source video and cleaning up the temp
 * dir). Re-encodes video (libx264) since burning text into frames requires it either way; copies
 * -- or rather transcodes to aac -- whatever audio is present, and is a no-op if there's none. */
export function burnCaptions(inputPath: string, assPath: string, outputPath: string): Promise<void> {
  const args = [
    "-y",
    "-i",
    inputPath,
    "-vf",
    `subtitles=filename=${escapeFilterValue(assPath)}:fontsdir=${escapeFilterValue(FONT_DIR)}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg-static did not resolve a binary for this platform"));
      return;
    }
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000); // keep the tail -- that's where the actual error is
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
    });
  });
}

export { buildAssScript };
