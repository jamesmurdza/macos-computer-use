# Computer Use Gallery

A minimal, standalone gallery of recorded [macos-computer-use](../README.md) agent runs: a grid of
thumbnails with a short description, date, and YouTube-style duration badge; click one to play the
recording.

This is a **completely separate app** from the main project on purpose — no shared dependencies,
no shared code, no shared credentials. It only ever does a plain public `fetch()` against a
Cloudflare R2 bucket's public URL. The two apps are meant to be deployed as two separate Vercel
projects (or not deployed together at all).

## How it connects to the main app

`../tools/agent-run.ts` (in the main project) uploads each recorded run's video/log/thumbnail to
R2 and maintains a single `index.json` there listing every run. This app reads that same
`index.json` — that's the *entire* contract between the two codebases. See
`../src/lib/gallery.ts`'s `rebuildGalleryIndex()` for the writer, and `src/lib/gallery.ts` here
(same shape, deliberately duplicated rather than shared) for the reader.

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
R2_PUBLIC_BASE_URL=https://pub-xxxxxxxxxxxx.r2.dev
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

Point a Vercel project's Root Directory at this `gallery/` folder and set `R2_PUBLIC_BASE_URL` in
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
