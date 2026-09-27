"use client";

import { useState } from "react";
import type { GalleryEntryResolved } from "../lib/gallery";
import { formatDate, formatDuration } from "../lib/gallery";

export function GalleryGrid({ entries }: { entries: GalleryEntryResolved[] }) {
  const [selected, setSelected] = useState<GalleryEntryResolved | null>(null);

  return (
    <>
      <div className="gallery-grid">
        {entries.map((e) => (
          <button key={e.runId} className="gallery-card" onClick={() => setSelected(e)}>
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
        <div className="gallery-modal-overlay" onClick={() => setSelected(null)}>
          <div className="gallery-modal" onClick={(ev) => ev.stopPropagation()}>
            <button className="gallery-modal-close" onClick={() => setSelected(null)} aria-label="Close">
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
