# Computer Use Gallery

A minimal, standalone gallery of recorded [macos-computer-use](../README.md) agent runs: a grid of
thumbnails with a short description, date, and YouTube-style duration badge; click one to play the
recording.

This is a **completely separate app** from the main project on purpose — no shared dependencies,
no shared code. It reads a small index from Cloudflare KV and serves video/thumbnails from a
Cloudflare R2 bucket's public URL. The two apps are meant to be deployed as two separate Vercel
projects (or not deployed together at all).

## How it connects to the main app

`../tools/agent-run.ts` (in the main project) uploads each recorded run's video/log/thumbnail to
R2, and adds an entry for it to a single JSON value (key `"index"`) in Cloudflare KV. This app
reads that same KV value — that's the *entire* contract between the two codebases. See
`../src/lib/gallery.ts`'s `addRunToGalleryIndex()`/`rebuildGalleryIndex()` for the writer, and
`src/lib/gallery.ts` here (same `GalleryEntry` shape, deliberately duplicated rather than shared)
for the reader.

**This app is no longer fully credential-free.** It used to just be a public `fetch()` against an
R2 URL with nothing to leak. Cloudflare's KV REST API has no public/anonymous read mode the way an
R2 bucket's public domain does — every request needs a Bearer token, so this app now holds a real
Cloudflare API Token (server-side only, in `loadGalleryIndex()`, never sent to the browser). Use a
token scoped to KV read only if Cloudflare's permission granularity allows it, rather than reusing
`agent-run.ts`'s write-capable one, to keep this app's blast radius small.

Also worth knowing: Workers KV is *eventually consistent* (Cloudflare's docs: a write can take up
to 60s to propagate to edge locations other than the one it was written from), unlike R2's strong
consistency. A page load right after a run finishes may occasionally show slightly stale data for
up to about a minute — this instance is not more "live" than a public JSON file would have been,
just cheaper to update on the writer's side (see the main project's `src/lib/gallery.ts` for why).

## Requirements

- Node.js 22+
- A Cloudflare KV namespace, already populated by running `agent-run.ts` (or
  `tools/rebuild-gallery-index.ts`) in the main project at least once.
- A Cloudflare R2 bucket with public access enabled (its `pub-*.r2.dev` domain, or a custom
  domain), holding the actual video/thumbnail files.

## Setup

```bash
npm install
```

Create a `.env` file:

```
CF_ACCOUNT_ID=...
CF_API_TOKEN=...
CF_KV_NAMESPACE_ID=...
CF_PUBLIC_BASE_URL=https://pub-xxxxxxxxxxxx.r2.dev
```

- `CF_ACCOUNT_ID` — your Cloudflare account id (same value as the main project's).
- `CF_API_TOKEN` — a Cloudflare API Token (not R2's Access Key ID/Secret Access Key — a different
  auth scheme entirely, verified: R2 keys get a 401 against this API) with `Workers KV Storage`
  read (or edit) permission.
- `CF_KV_NAMESPACE_ID` — the namespace's internal id, not its display name. Find it under
  Workers & Pages → KV in the dashboard, or `GET /accounts/{id}/storage/kv/namespaces`.
- `CF_PUBLIC_BASE_URL` — the R2 bucket's public domain, for the actual video/thumbnail files.

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

Point a Vercel project's Root Directory at this `gallery/` folder and set the four env vars above
in its environment variables — no other configuration needed. `next.config.ts` pins
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
