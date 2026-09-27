"use client";

import { useEffect, useState } from "react";
import type { GalleryEntryResolved } from "../lib/gallery";
import { formatDate, formatDuration } from "../lib/gallery";

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
            </span>
            <span className="gallery-meta">
              <span className="gallery-desc">{e.description}</span>
              <span className="gallery-date">{formatDate(e.date)}</span>
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="gallery-modal-overlay" onClick={close}>
          <div className="gallery-modal" onClick={(ev) => ev.stopPropagation()}>
            <button className="gallery-modal-close" onClick={close} aria-label="Close">
              &times;
            </button>
            <video src={selected.videoUrl} controls autoPlay />
            <div className="gallery-modal-meta">
              <span className="gallery-desc">{selected.description}</span>
              <span className="gallery-date">
                {formatDate(selected.date)} · {formatDuration(selected.durationMs)}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
