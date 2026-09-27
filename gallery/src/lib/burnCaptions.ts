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
 * Why the box is a hand-drawn shape and not ASS's own BorderStyle-3 box: that auto-box (what an
 * earlier version of this file used) has square corners -- standard ASS/libass has no "round the
 * box corners" style field at all. Getting *rounded* corners means drawing the box ourselves as
 * an ASS vector shape (the `\p` "drawing" override tag: `m`/`l`/`b` path commands, same idea as an
 * SVG path), sized to fit each caption's actual rendered text. That sizing is the fiddly part --
 * text width varies per caption and depends on font metrics this module has no independent way to
 * compute -- so `measureCaptionBoxes()` below does a cheap first ffmpeg pass that renders each
 * caption off-screen (no video encoding, `-f null`) and reads back its rendered pixel bounds via
 * the `bbox` filter, which *is* available in this ffmpeg-static build. The real burn-in pass then
 * draws a rounded rectangle sized from those measurements on a layer behind the (otherwise
 * unstyled -- no more auto-box) text.
 *
 * PlayResX/PlayResY are pinned to a fixed virtual canvas (1280x720) for both passes rather than
 * the source video's real resolution (which would need an ffprobe call -- ffmpeg-static ships
 * ffmpeg only, not ffprobe): libass scales every style value, plus the `\pos`/`\p` drawing
 * coordinates computed below, proportionally to the actual frame size at render time -- so
 * measuring and drawing in fixed 1280x720 units still ends up correct at whatever resolution the
 * recording actually is, as long as both passes agree on that same virtual canvas (they do).
 *
 * The font is bundled at `assets/fonts/DejaVuSans.ttf` (see LICENSE.txt there) and handed to
 * libass via `fontsdir` rather than relied on system-installed/fontconfig-resolved -- there's no
 * guarantee the deploy target has *any* fonts installed otherwise.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { CaptionEntry } from "./captions";

const FONT_DIR = path.join(process.cwd(), "assets/fonts");
const FONT_FAMILY = "DejaVu Sans";
const PLAY_RES_X = 1280;
const PLAY_RES_Y = 720;
const MARGIN_L = 40;
const MARGIN_R = 40;
const MARGIN_V = 60; // distance from the bottom edge, echoing the overlay's `bottom: 48px`

// Matches .gallery-caption's off-white text (#ece6da); box fill (rgba(10,9,8,.72)) is applied
// separately below as inline override tags on the hand-drawn box shape, not through this style.
// ASS colours are &HAABBGGRR (alpha first, then blue/green/red, inverted-alpha: 00 = opaque).
const TEXT_STYLE = [
  "Caption", // Name
  FONT_FAMILY, // Fontname
  "32", // Fontsize (relative to the PlayRes canvas above)
  "&H00DAE6EC", // PrimaryColour (text)
  "&H00DAE6EC", // SecondaryColour
  "&H00000000", // OutlineColour (unused -- Outline is 0 below)
  "&H00000000", // BackColour (unused -- BorderStyle 1, no auto-box)
  "0", // Bold
  "0", // Italic
  "0", // Underline
  "0", // StrikeOut
  "100", // ScaleX
  "100", // ScaleY
  "0", // Spacing
  "0", // Angle
  "1", // BorderStyle: 1 = outline only, and Outline is 0 -- i.e. no box, just glyphs
  "0", // Outline
  "0", // Shadow
  "2", // Alignment: bottom-center (numpad layout)
  String(MARGIN_L),
  String(MARGIN_R),
  String(MARGIN_V),
  "1", // Encoding
].join(",");

const STYLE_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: ${PLAY_RES_X}
PlayResY: ${PLAY_RES_Y}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ${TEXT_STYLE}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

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

/** Windows for each caption -- from this entry's elapsedMs to the next entry's (or to a fixed 24h
 * ceiling for the last one, harmless once the video itself ends first). Shared by the measurement
 * pass and the real burn-in pass so both agree on how long each caption is "active" for -- not
 * that duration affects wrapping/width, but it keeps the two scripts structurally identical. */
function captionWindows(captions: CaptionEntry[]): { start: number; end: number }[] {
  const END_OF_TIME_MS = 24 * 60 * 60 * 1000;
  return captions.map((c, i) => ({
    start: c.elapsedMs,
    end: i + 1 < captions.length ? Math.max(captions[i + 1].elapsedMs, c.elapsedMs + 50) : END_OF_TIME_MS,
  }));
}

export interface CaptionBox {
  width: number;
  height: number;
  /** The measured ink's distance from the frame's *top* edge, in PlayRes units -- see the box
   * positioning note in buildAssScript() for why this (and not MarginV) is what the box's
   * vertical position is actually built from. */
  top: number;
}

const BBOX_LOG_RE = /n:(\d+)\s+pts:\S+\s+pts_time:\S+\s+x1:-?\d+\s+x2:-?\d+\s+y1:(-?\d+)\s+y2:-?\d+\s+w:(\d+)\s+h:(\d+)/g;

/** Renders each caption's text alone (no box, 1-second-per-caption slots on a throwaway black
 * canvas, no video encoding) and reads back its actual rendered pixel bounds via the `bbox`
 * filter, so the real pass can draw a box that actually fits the text -- reusing the exact same
 * font/size/margins/wrap style as the real render (see module doc) so the measurement is accurate
 * for wrapped multi-line captions too, not just single lines. Falls back to a rough
 * characters-times-average-width estimate for any caption this fails to measure (e.g. a caption
 * that renders no visible glyphs at all), so one odd caption can't fail the whole export. */
export async function measureCaptionBoxes(captions: CaptionEntry[], dir: string): Promise<CaptionBox[]> {
  if (captions.length === 0) return [];
  if (!ffmpegPath) throw new Error("ffmpeg-static did not resolve a binary for this platform");

  const lines = captions.map(
    (c, i) => `Dialogue: 0,${toAssTimestamp(i * 1000)},${toAssTimestamp((i + 1) * 1000)},Caption,,0,0,0,,${sanitizeAssText(c.text)}`,
  );
  const probeAssPath = path.join(dir, "probe.ass");
  await writeFile(probeAssPath, `${STYLE_HEADER}\n${lines.join("\n")}\n`, "utf8");

  const args = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=black:s=${PLAY_RES_X}x${PLAY_RES_Y}:r=1:d=${captions.length}`,
    "-vf",
    `subtitles=filename=${escapeFilterValue(probeAssPath)}:fontsdir=${escapeFilterValue(FONT_DIR)},bbox=min_val=16`,
    "-f",
    "null",
    "-loglevel",
    "info",
    "-",
  ];

  const stderr = await new Promise<string>((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, args, { stdio: ["ignore", "ignore", "pipe"] });
    let out = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", () => resolve(out));
  });

  const measured = new Map<number, CaptionBox>();
  for (const m of stderr.matchAll(BBOX_LOG_RE)) {
    const n = Number(m[1]);
    const top = Number(m[2]);
    const width = Number(m[3]);
    const height = Number(m[4]);
    if (width > 0 && height > 0) measured.set(n, { width, height, top });
  }
  return captions.map((c, i) => measured.get(i) ?? estimateBoxFallback(c.text));
}

/** Used only when the measurement pass above didn't get a reading for a given caption --
 * ~13.5px/character at Fontsize 32 is roughly what DejaVu Sans averages out to for the kind of
 * short present-tense phrases these captions actually are (verified against several real
 * measurements), which is close enough for a rarely-hit fallback path. `top` has no real
 * measurement to fall back on either, so it guesses from MarginV the way the box's position used
 * to be computed everywhere (see buildAssScript()) -- approximate, but only ever hit for a
 * caption whose text rendered no visible glyphs at all. */
function estimateBoxFallback(text: string): CaptionBox {
  const height = 30;
  return { width: Math.round(text.length * 13.5), height, top: PLAY_RES_Y - MARGIN_V - height };
}

const BOX_PAD_X = 18;
const BOX_PAD_Y = 10;
const BOX_RADIUS = 10; // deliberately small -- a soft edge, not a pill shape
const BOX_FILL = "\\1c&H08090A&\\1a&H47&"; // rgba(10,9,8,.72) as ASS override tags: \1c is &HBBGGRR&, \1a is &HAA&

/** An ASS vector "drawing" path (the `\p` override tag) for a rounded rectangle `w`x`h`, corner
 * radius `r`, in its own local coordinate space (top-left at local 0,0 -- positioned on the page
 * separately via `\pos`). Each corner is a cubic bezier approximating a quarter circle; `kappa`
 * is the standard control-point-offset constant for that approximation. */
function roundedRectPath(w: number, h: number, r: number): string {
  const k = Math.round(r * 0.5523);
  return [
    `m ${r} 0`,
    `l ${w - r} 0`,
    `b ${w - r + k} 0 ${w} ${k} ${w} ${r}`,
    `l ${w} ${h - r}`,
    `b ${w} ${h - r + k} ${w - k} ${h} ${w - r} ${h}`,
    `l ${r} ${h}`,
    `b ${r - k} ${h} 0 ${h - k} 0 ${h - r}`,
    `l 0 ${r}`,
    `b 0 ${k} ${k} 0 ${r} 0`,
  ].join(" ");
}

/** Builds the real burn-in .ass: for each caption, a Layer-0 rounded-box shape (sized from
 * `boxes`, `measureCaptionBoxes()`'s output) directly behind a Layer-1 plain-text Dialogue line --
 * ASS draws higher layers on top, so the box sits behind the glyphs. The text line is positioned
 * by the ordinary Alignment/MarginV style fields (same as before, and libass handles its wrapping
 * exactly as measured); the box line instead sets an explicit `\pos` since its size and centering
 * come from the measurement pass, not from the style.
 *
 * The box's vertical position is built from `box.top` (the ink's actual measured offset from the
 * frame's top edge), not from `PLAY_RES_Y - MARGIN_V` the way an earlier version of this function
 * computed it -- that assumed the rendered text's bottom pixel sits exactly on the MarginV line,
 * which is only true for a string with descenders (g/y/p/...) reaching all the way down to what
 * libass reserves for them. A string without one (most of these captions, e.g. "Clicking the Save
 * button") renders with its ink sitting *above* that line by the unused descender gap, which
 * pushed the padding this function adds asymmetric -- looked like extra margin on top and none on
 * the bottom. Anchoring off the real measured ink position instead makes the padding symmetric
 * regardless of which letters happen to be in a given caption. */
export function buildAssScript(captions: CaptionEntry[], boxes: CaptionBox[]): string {
  const windows = captionWindows(captions);
  const lines: string[] = [];

  captions.forEach((c, i) => {
    if (!c.text.trim()) return;
    const { start, end } = windows[i];
    const startTs = toAssTimestamp(start);
    const endTs = toAssTimestamp(end);

    const box = boxes[i] ?? estimateBoxFallback(c.text);
    const boxW = box.width + BOX_PAD_X * 2;
    const boxH = box.height + BOX_PAD_Y * 2;
    const boxX = Math.round((PLAY_RES_X - boxW) / 2);
    const boxY = Math.round(box.top - BOX_PAD_Y);
    const path = roundedRectPath(boxW, boxH, BOX_RADIUS);
    lines.push(`Dialogue: 0,${startTs},${endTs},Caption,,0,0,0,,{\\an7\\pos(${boxX},${boxY})\\p1${BOX_FILL}}${path}{\\p0}`);

    lines.push(`Dialogue: 1,${startTs},${endTs},Caption,,0,0,0,,${sanitizeAssText(c.text)}`);
  });

  return `${STYLE_HEADER}\n${lines.join("\n")}\n`;
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
