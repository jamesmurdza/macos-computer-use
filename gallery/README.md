# Computer Use Gallery

A minimal, standalone gallery of recorded [macos-computer-use](../README.md) agent runs: a grid of
thumbnails with a short description, date, and YouTube-style duration badge; click one to play the
recording. Every run also has a real permalink at `/runs/<runId>` -- clicking a card updates the
URL to it without a full page reload (`history.pushState`, handled in `GalleryGrid.tsx`), and
loading that URL directly (a shared link, a refresh, a crawler) server-renders the same grid with
that run's modal already open, including proper Open Graph/Twitter card metadata (title + thumbnail
image) for link previews.

This is a **completely separate app** from the main project on purpose — no shared dependencies,
no shared code, no shared credentials. It only ever does a plain public `fetch()` against a
Cloudflare R2 bucket's public URL. The two apps are meant to be deployed as two separate Vercel
projects (or not deployed together at all).

## How it connects to the main app

`../tools/agent-run.ts` (in the main project) uploads each recorded run's video/log/thumbnail to
R2 and maintains a single `index.json` there listing every run. This app reads that same
`index.json` — that's the *entire* contract between the two codebases. See
`../src/lib/gallery.ts`'s `addRunToGalleryIndex()`/`rebuildGalleryIndex()` for the writer, and
`src/lib/gallery.ts` here (same `GalleryEntry` shape, deliberately duplicated rather than shared)
for the reader.

This briefly read from Cloudflare KV instead of `index.json` (see git history: "Move the gallery
index from an R2 JSON file to Cloudflare KV" and its revert). Moved back on reflection:
- The only actual win KV offered was O(1) writes instead of a full-bucket rescan per run — but
  that's a property of *incremental read-modify-write*, not of KV specifically. The main project's
  `addRunToGalleryIndex()` gets the identical O(1) write against a plain R2 object.
- Cloudflare's KV REST API has no public/anonymous read mode, unlike an R2 bucket's public domain,
  so using it would have given this otherwise fully credential-free app a real secret to hold, for
  no offsetting benefit.
- Workers KV is only *eventually* consistent (up to ~60s to propagate across edge locations); R2
  is strongly consistent. Moving to KV would have made the gallery *less* immediately live, not
  more — the opposite of the intent.

## Requirements

- Node.js 22+
- A Cloudflare R2 bucket with public access enabled (its `pub-*.r2.dev` domain, or a custom
  domain), already populated by running `agent-run.ts` in the main project at least once.

## Setup

```bash
npm install
```

Create a `.env` file:

```
CF_PUBLIC_BASE_URL=https://pub-xxxxxxxxxxxx.r2.dev
```

That's the only credential this app ever holds — a public URL, not a secret. It never sees R2's
actual access keys.

## Run

```bash
npm run dev
```

Open [http://localhost:3001](http://localhost:3001) (a different port from the main app's 3000, so
both can run locally at once).

For a production build:

```bash
npm run build
npm start
```

## Deploy

Point a Vercel project's Root Directory at this `gallery/` folder and set `CF_PUBLIC_BASE_URL` in
its environment variables — no other configuration needed. `next.config.ts` pins
`turbopack.root` to this directory so a sibling `package-lock.json` one level up (the main app's)
doesn't make Turbopack guess at a monorepo root.

## Notes from building this

- Verified against the real bucket end to end: ran `agent-run.ts` in the main project for real,
  then `npm run build && npm start` here and loaded the page — the run showed up with a working
  thumbnail and video.
- Verified visually with actual rendered screenshots (Playwright), not just by reading the CSS,
  in both light and dark mode. That's how a real bug got caught before shipping: the modal's close
  button was positioned with a negative offset outside `.gallery-modal`'s bounds, and that
  element's `overflow: auto` was silently clipping it to a barely-visible sliver. Fixed by keeping
  it inside the box, overlaid on the video's top-right corner instead of floating outside it.
- No test suite yet (`formatDuration`/`formatDate` are pure and worth unit-testing if this grows;
  `typecheck`/`build` are the only checks today).
