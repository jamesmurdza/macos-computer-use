"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GalleryEntryResolved } from "../lib/gallery";
import { formatCost, formatDate, formatDuration } from "../lib/gallery";
import { captionAt, parseCaptions, type CaptionEntry } from "../lib/captions";

const PLAYBACK_SPEEDS = [0.5, 1, 1.5, 2, 4];
const DEFAULT_SPEED = 2;
const ALL_MODELS = "all";

// Rough char-count heuristic for "does this description need a `more` toggle" -- we don't measure
// actual rendered line count (would need a ref + layout pass), so this just approximates whether a
// description would exceed 2 lines at the modal's font-size/width. Good enough for a "more" affordance,
// not meant to be pixel-exact.
const DESC_TRUNCATE_THRESHOLD = 140;

function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function CaptionsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M9.8 10.8c-.5-.6-1.2-.9-2-.9-1.4 0-2.5 1-2.5 2.3s1.1 2.3 2.5 2.3c.8 0 1.5-.3 2-.9" />
      <path d="M17.7 10.8c-.5-.6-1.2-.9-2-.9-1.4 0-2.5 1-2.5 2.3s1.1 2.3 2.5 2.3c.8 0 1.5-.3 2-.9" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 1 2.6 6.3" />
      <path d="M3 21v-6h6" />
    </svg>
  );
}

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
  const [modelFilter, setModelFilter] = useState<string>(ALL_MODELS);

  // Sorted, deduped -- whatever models actually show up in this gallery, not a fixed list, so it
  // never drifts out of sync with what's really there (new models just start appearing on their
  // own). Permalink lookups below (initial state, popstate) deliberately search the *unfiltered*
  // `entries`, not this -- a direct link to a run should always open it regardless of which
  // filter happens to be selected.
  const models = useMemo(() => Array.from(new Set(entries.map((e) => e.model).filter(Boolean))).sort(), [entries]);
  const visibleEntries = modelFilter === ALL_MODELS ? entries : entries.filter((e) => e.model === modelFilter);

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
      <div className="gallery-header">
        <h1 className="gallery-title">Recordings</h1>
        {models.length > 1 && (
          <select
            className="gallery-model-filter"
            value={modelFilter}
            onChange={(ev) => setModelFilter(ev.target.value)}
            aria-label="Filter by model"
          >
            <option value={ALL_MODELS}>All models</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
      </div>

      {visibleEntries.length === 0 ? (
        <p className="gallery-empty">No recordings for this model.</p>
      ) : (
        <div className="gallery-grid">
          {visibleEntries.map((e) => (
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
      )}

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
  const [descExpanded, setDescExpanded] = useState(false);
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

  const descIsLong = entry.description.length > DESC_TRUNCATE_THRESHOLD;

  return (
    <div className="gallery-modal-overlay" onClick={onClose}>
      <div className="gallery-modal" onClick={(ev) => ev.stopPropagation()}>
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
            <div className="gallery-desc-wrap">
              <span
                className={`gallery-desc${descExpanded ? " gallery-desc-expanded" : ""}${descIsLong ? " gallery-desc-has-toggle" : ""}`}
              >
                {entry.description}
              </span>
              {descIsLong && (
                <button
                  type="button"
                  className="gallery-desc-toggle"
                  onClick={() => setDescExpanded((v) => !v)}
                  aria-expanded={descExpanded}
                  aria-label={descExpanded ? "Show less" : "Show full description"}
                  title={descExpanded ? "Show less" : "Show full description"}
                >
                  …
                </button>
              )}
            </div>
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
              className={`gallery-icon-button${exportState === "error" ? " gallery-icon-button-error" : ""}`}
              onClick={handleExport}
              disabled={exportState === "exporting"}
              aria-label={exportState === "error" ? "Export failed — retry" : "Download video"}
              title={exportState === "error" ? "Export failed — retry" : "Download video"}
            >
              {exportState === "exporting" ? (
                <span className="gallery-spinner" aria-hidden="true" />
              ) : exportState === "error" ? (
                <RetryIcon />
              ) : (
                <DownloadIcon />
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
            <button
              type="button"
              className={`gallery-icon-button${showCaptions ? " gallery-icon-button-active" : ""}`}
              onClick={() => setShowCaptions((v) => !v)}
              aria-label="Toggle captions"
              aria-pressed={showCaptions}
              title="Toggle captions"
            >
              <CaptionsIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
