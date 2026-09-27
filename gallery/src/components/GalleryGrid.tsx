"use client";

import { useEffect, useRef, useState } from "react";
import type { GalleryEntryResolved } from "../lib/gallery";
import { formatCost, formatDate, formatDuration } from "../lib/gallery";
import { captionAt, parseCaptions, type CaptionEntry } from "../lib/captions";

const PLAYBACK_SPEEDS = [0.5, 1, 1.5, 2, 4];
const DEFAULT_SPEED = 2;

/**
 * Every run gets a real permalink at `/runs/<runId>` (see that route's page.tsx -- it renders this
 * same grid, server-side, with the matching entry pre-selected so a shared link, a refresh, and a
 * crawler all see the right thing with no client-side JS required).
 *
 * On top of that, clicking a card from the grid opens the same modal *without* a full page
 * navigation -- feels instant, preserves scroll position -- by pushing the permalink URL onto
 * history ourselves (`history.pushState`) instead of using a <Link>. Closing pops back to `/`.
 * Browser back/forward is handled by re-deriving the selected run from the URL on `popstate`
 * rather than trusting whatever's already in state, so the two ways of getting to a given
 * URL (direct load vs. client-side click) end up in the exact same state.
 */
export function GalleryGrid({ entries, initialRunId }: { entries: GalleryEntryResolved[]; initialRunId?: string }) {
  const [selected, setSelected] = useState<GalleryEntryResolved | null>(
    () => entries.find((e) => e.runId === initialRunId) ?? null,
  );

  useEffect(() => {
    document.title = selected ? `${selected.description} — Recordings` : "Recordings";
  }, [selected]);

  useEffect(() => {
    const onPopState = () => {
      const match = /^\/runs\/([^/]+)/.exec(window.location.pathname);
      setSelected(match ? (entries.find((e) => e.runId === match[1]) ?? null) : null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [entries]);

  function open(entry: GalleryEntryResolved) {
    setSelected(entry);
    window.history.pushState(null, "", `/runs/${entry.runId}`);
  }

  function close() {
    setSelected(null);
    window.history.pushState(null, "", "/");
  }

  return (
    <>
      <div className="gallery-grid">
        {entries.map((e) => (
          <button key={e.runId} className="gallery-card" onClick={() => open(e)}>
            <span className="gallery-thumb">
              {/* Plain <img>, not next/image: external R2 URLs, no image-domain config needed for a personal tool */}
              <img src={e.thumbnailUrl} alt="" loading="lazy" onError={(ev) => (ev.currentTarget.style.visibility = "hidden")} />
              <span className="gallery-duration">{formatDuration(e.durationMs)}</span>
              {e.status === "error" && <span className="gallery-badge-incomplete">Incomplete</span>}
            </span>
            <span className="gallery-meta">
              <span className="gallery-desc">{e.description}</span>
              <span className="gallery-date">{formatDate(e.date)}</span>
            </span>
          </button>
        ))}
      </div>

      {selected && <RunModal key={selected.runId} entry={selected} onClose={close} />}
    </>
  );
}

/** The video modal, split out from GalleryGrid purely for readability -- this is where the
 * events.jsonl-driven caption overlay lives. */
function RunModal({ entry, onClose }: { entry: GalleryEntryResolved; onClose: () => void }) {
  const [showCaptions, setShowCaptions] = useState(true);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [captions, setCaptions] = useState<CaptionEntry[]>([]);
  const [currentCaption, setCurrentCaption] = useState("");
  const [exportState, setExportState] = useState<"idle" | "exporting" | "error">("idle");
  const videoRef = useRef<HTMLVideoElement>(null);

  // Applies on mount too (not just on change) so DEFAULT_SPEED actually takes effect -- the
  // `defaultPlaybackRate` DOM property exists for this, but only takes effect before the media
  // starts loading, which autoPlay races against; setting `playbackRate` directly here is what
  // Chromium/Safari both actually honor once playback has begun.
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    let cancelled = false;
    // Same-origin proxy, not entry.eventsUrl directly -- R2's public domain sends no CORS headers,
    // so a browser fetch() straight to it would be blocked (see api/events/[runId]/route.ts).
    fetch(`/api/events/${entry.runId}`)
      .then((res) => (res.ok ? res.text() : ""))
      .then((text) => {
        if (!cancelled && text) setCaptions(parseCaptions(text));
      })
      .catch(() => {}); // captions are a nice-to-have -- a fetch failure just means no overlay, not a broken modal
    return () => {
      cancelled = true;
    };
  }, [entry.runId]);

  // Server-side burn-in (see api/export/[runId]/route.ts): the on-page overlay above is just a
  // DOM element floating over the <video>, never part of the actual pixels, so downloading the
  // R2 video directly would have no captions in it at all. This re-encodes with them burned in
  // and hands back a normal mp4 download -- no polling for progress (ffmpeg doesn't report any
  // partway through a single fetch), just an indeterminate spinner for however long the request
  // takes.
  async function handleExport() {
    setExportState("exporting");
    try {
      const res = await fetch(`/api/export/${entry.runId}?videoKey=${encodeURIComponent(entry.videoKey)}`);
      if (!res.ok) throw new Error(`export failed with status ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${entry.runId}-captioned.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportState("idle");
    } catch (err) {
      console.error("video export failed:", err);
      setExportState("error");
      setTimeout(() => setExportState("idle"), 3000);
    }
  }

  return (
    <div className="gallery-modal-overlay" onClick={onClose}>
      <div className="gallery-modal" onClick={(ev) => ev.stopPropagation()}>
        <button className="gallery-modal-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
        <div className="gallery-video-wrap">
          <video
            ref={videoRef}
            src={entry.videoUrl}
            controls
            autoPlay
            onTimeUpdate={(ev) => setCurrentCaption(captionAt(captions, ev.currentTarget.currentTime * 1000))}
          />
          {showCaptions && currentCaption && <div className="gallery-caption">{currentCaption}</div>}
        </div>
        <div className="gallery-modal-meta">
          <div className="gallery-modal-meta-text">
            <span className="gallery-desc">{entry.description}</span>
            <span className="gallery-date">
              {formatDate(entry.date)} · {formatDuration(entry.durationMs)}
            </span>
            {entry.model && (
              <span className="gallery-run-meta">
                {entry.model}
                {entry.costUsd !== undefined && <> · ~{formatCost(entry.costUsd)}</>}
                {entry.status === "error" && <> · <span className="gallery-badge-incomplete-inline">didn't finish</span></>}
              </span>
            )}
          </div>
          <div className="gallery-modal-controls">
            <button
              type="button"
              className="gallery-export-button"
              onClick={handleExport}
              disabled={exportState === "exporting"}
            >
              {exportState === "exporting" ? (
                <>
                  <span className="gallery-spinner" aria-hidden="true" />
                  Exporting…
                </>
              ) : exportState === "error" ? (
                "Export failed — retry"
              ) : (
                "Download video"
              )}
            </button>
            <select
              className="gallery-speed-select"
              value={speed}
              onChange={(ev) => setSpeed(Number(ev.target.value))}
              aria-label="Playback speed"
            >
              {PLAYBACK_SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
            <label className="gallery-caption-toggle">
              Captions
              <input type="checkbox" checked={showCaptions} onChange={(ev) => setShowCaptions(ev.target.checked)} />
              <span className="gallery-toggle-track">
                <span className="gallery-toggle-thumb" />
              </span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
