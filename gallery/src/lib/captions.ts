/**
 * Turns a run's raw events.jsonl (see the main project's tools/agent-run.ts for the exact shapes
 * written) into a sparse timeline of short caption strings, keyed by the same `elapsedMs` the
 * video is recorded against -- so a caption overlay can look up "what was the agent doing at this
 * point in the video" with simple linear scan (timelines here are a few dozen entries at most, no
 * need for anything cleverer).
 *
 * Deliberately only surfaces `tool-call` (using its `input.summary` -- already written as a short
 * present-tense description meant to be shown live, e.g. "Opening TextEdit"), `tool-error`, and
 * the final `run-end` reply -- not `tool-result` (redundant with the next caption) or `text` (too
 * fragmented, streamed token-by-token).
 */
export interface CaptionEntry {
  elapsedMs: number;
  text: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function parseCaptions(jsonl: string): CaptionEntry[] {
  const entries: CaptionEntry[] = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // a partial last line (crash mid-write) or otherwise corrupt -- skip, don't fail the whole overlay
    }
    const elapsedMs = ev.elapsedMs;
    if (typeof elapsedMs !== "number") continue;

    if (ev.t === "tool-call") {
      const input = ev.input as { summary?: string } | undefined;
      const text = input?.summary || (typeof ev.tool === "string" ? ev.tool : "Working…");
      entries.push({ elapsedMs, text });
    } else if (ev.t === "tool-error") {
      entries.push({ elapsedMs, text: `Error: ${truncate(String(ev.error ?? "unknown error"), 100)}` });
    } else if (ev.type === "run-end") {
      const reply = typeof ev.reply === "string" ? ev.reply.trim() : "";
      entries.push({ elapsedMs, text: reply ? truncate(reply, 160) : ev.status === "error" ? "Run failed" : "Done" });
    }
  }

  return entries.sort((a, b) => a.elapsedMs - b.elapsedMs);
}

/** The caption active at `ms` -- the last entry at or before this point, or "" before the first. */
export function captionAt(captions: CaptionEntry[], ms: number): string {
  let text = "";
  for (const c of captions) {
    if (c.elapsedMs > ms) break;
    text = c.text;
  }
  return text;
}
