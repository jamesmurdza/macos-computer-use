# Testing Guide

## Environment Setup
- Package manager: npm (Node 22, ESM project, Next.js App Router)
- Required env vars (put them in `.env` — Next.js loads it automatically for `npm run dev`/`build`/`start`; `tests/setup.ts` loads it the same way via Node's `process.loadEnvFile` for the test runner):
  - `USE_COMPUTER_API_KEY` — use.computer account key (`uc_live_...`)
  - `USE_COMPUTER_RESERVATION_ID` — an active Mac mini reservation; the code never reserves
  - `ANTHROPIC_API_KEY` — Claude, for the Playwright test and the app itself
  - `USE_COMPUTER_BASE_URL` — optional, defaults to `https://api.use.computer`
  - Only needed for `tools/agent-run.ts` (see "Headless recorded runs" below), not the web app:
    `CF_ACCOUNT_ID`, `CF_ACCESS_KEY_ID`, `CF_SECRET_ACCESS_KEY`, `CF_BUCKET` — a Cloudflare R2
    bucket + API token (Object Read & Write) to upload run artifacts to. Without these,
    `agent-run.ts` still runs end-to-end and just skips the upload step.
  - `agent-run.ts`-only, optional: `AGENT_RUN_ANTHROPIC_API_KEY` — takes priority over
    `ANTHROPIC_API_KEY` for this script only. Deliberately a different name: Next.js auto-loads
    `.env`'s `ANTHROPIC_API_KEY` for `npm run dev`/`build`/`start`, so a key meant only for
    headless recorded runs (e.g. one on a separate budget/quota) needs a different name to stay
    structurally invisible to the web app, not just "remember not to use it there."
  - `CF_PUBLIC_BASE_URL` — optional for `agent-run.ts` (prints plain permanent public URLs for the
    video/log instead of presigned ones). Not used by this web app at all; it's the one env var
    the completely separate `gallery/` app needs (see its own README) to read `index.json` and
    serve video/thumbnail files.
  - `agent-run.ts`-only, optional: `OPENROUTER_API_KEY` — lets `MODEL` be
    `openrouter:<provider>/<model-id>` (e.g. `openrouter:qwen/qwen3.7-flash`) instead of one of the
    three built-in Anthropic choices, routed through the AI SDK's OpenRouter provider. Not read at
    all unless an `openrouter:` selector is actually used, and not accepted by the web app's own
    model dropdown/route validation at all (that stays limited to `opus`/`sonnet`/`haiku`) — this
    is a `tools/agent-run.ts`-only escape hatch for trying other models' cost/quality tradeoffs.
- Database: none
- Services: use.computer gateway (real macOS VM on the reserved Mac) and the Anthropic API. No mocks anywhere.
- Only 2 VMs can exist at once on the reservation, so never run two sandbox-creating suites in parallel.

## Running Tests

### Unit Tests
Command: `npm run test:unit`
Location: `tests/unit/` — pure functions in `tests/unit/*.test.ts`, plus route-handler tests in
`tests/unit/routes/*.test.ts` that import each `GET`/`POST` directly from `src/app/api/*/route.ts`
and call it with a constructed `Request` (no server, no network — `resolveSandbox`/`streamAgent`/etc.
are mocked via `vi.mock`).

### Integration Tests (real sandbox)
Command: `npm run test:int`
Location: `tests/integration/`
- `sandbox-handle.int.test.ts` — the load-bearing test for the whole stateless design: proves
  `attachSandbox()` reconnects to an existing sandbox using nothing but its id (no host/vncUrl
  needed), and that `withSandbox()` recreates a sandbox after an out-of-band delete.
- `sandbox-resolution.int.test.ts` — proves `setDisplayResolution()`/`listDisplayResolutions()`
  (src/lib/sandbox.ts) actually change/report the sandbox's rendered resolution
  (1920x1080 → 1280x720 confirmed via `displayInfo()`), with no GUI automation involved.

### E2E Tests (Playwright, the web page)
Command: `npm run test:e2e:web` (needs a real sandbox + `ANTHROPIC_API_KEY` for the full agent-turn test)
Setup: `npx playwright install chromium`
Base URL: `http://localhost:3000` — `playwright.config.ts` starts the app itself: `next dev` locally,
`next build && next start` in CI (`CI=true`) for parity with what's actually deployed.
Location: `tests/e2e/web.spec.ts` — targets the React app's real DOM ids (`#chip`, `#vnc`, `#messages`,
`#prompt`, `#send`, `#sysinfo-overlay`, …). No visual-regression snapshots (would need a first real
run against a live sandbox to record a baseline).

### Sandbox Scenarios (real sandbox, vitest)
Command: `npm run test:e2e`
Location: `tests/e2e/` — one file per scenario (`gui-*.e2e.test.ts`), shared helpers in `tests/e2e/helpers.ts`.
Each file creates its own sandbox on the reservation (`useSandbox()`), dismisses the screen-recording
prompt, screenshots before and after into `test-results/<scenario>/`, verifies through System Events
or `uiTree()`, and deletes the sandbox. Pass `useSandbox({ dismissPrompt: false })` to keep the prompt.
Files run serially (`fileParallelism: false`) because the reservation allows 2 VMs at once.
Whole suite: 6 files, 10 tests, about 3 min. Missing env vars make the tests FAIL (never skip).

### Everything
Command: `npm test` (unit + integration + sandbox scenarios, serially) then `npm run test:e2e:web`. Also run `npm run typecheck`.

## Debugging Failed Tests
- Single file: `npx vitest run tests/e2e/gui-textedit.e2e.test.ts`
- Playwright headed: `npx playwright test --headed`; traces: `npx playwright show-trace test-results/*/trace.zip`
- Look at `test-results/before.jpg` and `test-results/after.jpg`
- Watch the VM live: log the sandbox's `vncUrl` (contains the API key, so it is not printed by default)
- A sandbox left running is reaped ~2 min after its last API/SSH/VNC activity (`ephemeral: true`)

## Known timings (mm010, macOS 15.4.1)
| Step | Time |
|---|---|
| create sandbox | ~2 s |
| JPEG screenshot (quality 80, ~100 KB) | 2-4 s |
| PNG screenshot via SDK (1.6 MB) | 30-60 s — avoid |
| upload + osascript (TextEdit) | 4-6 s |
| `setDisplayResolution()` (upload script, run over SSH) | ~1-2 s |

## Display resolution

Sandboxes are Apple `Virtualization.framework` VMs (`Model Identifier: VirtualMac2,1`, `Chip:
Apple M4 (Virtual)`), not bare-metal Mac minis, and boot at a fixed **1920x1080**. There is no
gateway API for this (`POST .../display/resize` and similar guesses all 404) and no pre-installed
CLI tool (`displayplacer`/`m1ddc`/`ddcctl` are absent).

`setDisplayResolution(sandbox, width, height)` / `listDisplayResolutions(sandbox)` in
`src/lib/sandbox.ts` change it directly via **CoreGraphics**, with no GUI automation at all: a
small Swift script (Xcode's command-line tools, already required by this product, ship `swift`)
is uploaded and run over SSH, calling `CGConfigureDisplayWithDisplayMode` inside a
`CGBeginDisplayConfiguration`/`CGCompleteDisplayConfiguration` transaction. Two things worth
knowing, both found by testing directly against a real sandbox:
- A bare `CGDisplaySetDisplayMode(display, mode, nil)` (no transaction) reports `.success` but
  silently does nothing here — the transaction form is required.
- The virtual display actually supports far more modes than System Settings' Displays pane shows
  by default: 11 usable modes from `800x600` up to `1920x1080` (`960x540`, `1024x576`, `1024x768`,
  `1280x720`, `1280x960`, `1344x756`, `1344x1008`, `1600x900`, `1600x1200` in between), vs. only 3
  shown without checking "Show all resolutions". `listDisplayResolutions()` returns the full set.

An earlier version of this drove System Settings' Displays pane by click (`clickElement` on the
`"{width} × {height}"` label) — it worked, but this CoreGraphics approach replaced it: ~1s instead
of ~20s, no dependence on an English-locale UI staying in the same place across macOS versions,
and it surfaces every mode instead of only the default short list.

Caution: `use-computer-sdk`'s own `.d.ts` declares `MacOSSandbox.displayInfo()` as resolving to
`{width, height}` directly, but a real sandbox actually returns the gateway's raw `{ success,
size: { width, height } }` at runtime instead — the SDK's declared type does not match its actual
behavior here. `SandboxHandle.displayInfo()` matches the SDK's (wrong) declared type for
structural compatibility; anything consuming the result should defensively check for a nested
`size` too (see `setDisplayResolution`'s own handling).

## Headless recorded runs

`tools/agent-run.ts` is a second headless entrypoint alongside `tools/agent-harness.ts` (the dev
iteration tool): it drives the same production `streamAgent()`, but additionally records the
sandbox's screen for the whole run, writes a structured JSONL event log, and uploads the video +
log + a metadata file to Cloudflare R2 — so a later tool can overlay the log onto the video.

```
npx tsx tools/agent-run.ts "use xcode to make and run a hello world script"
MODEL=sonnet npx tsx tools/agent-run.ts "open safari and go to example.com"
RESOLUTION=1280x720 npx tsx tools/agent-run.ts "..."   # override the default resolution
RESOLUTION=native npx tsx tools/agent-run.ts "..."     # keep the sandbox's native 1920x1080
AGENT_RUN_ANTHROPIC_API_KEY=sk-ant-... npx tsx tools/agent-run.ts "..."   # kept out of the web app
OPENROUTER_API_KEY=sk-or-... MODEL=openrouter:qwen/qwen3.7-flash npx tsx tools/agent-run.ts "..."
```

- Shrinks the sandbox to `DEFAULT_RESOLUTION` (1280x960 -- see "Display
  resolution" above) before starting the recording, unless `RESOLUTION` overrides it (a `WxH` value,
  or `native` to skip resizing and keep the sandbox at its native 1920x1080).
- Recording is native to the gateway (`sandbox.recording.start()/stop()`, confirmed a genuine
  `video/mp4` container via `downloadRecording()` in `src/lib/sandbox.ts`) — no ffmpeg, no Xvfb, no
  screenshot polling.
- Every `events.jsonl` line's `elapsedMs` is measured from the exact moment the recording actually
  started (`recording.start()` resolving), not process start or prompt time — that's the number an
  overlay tool should seek the video by. Each line is also written to disk immediately
  (`appendFileSync`, not buffered), so a crash mid-run still leaves a usable partial log.
- Every event's `sandbox.vncUrl` is stripped before logging — it embeds a live bearer token in its
  query string (same rule as the rest of this doc: "contains the API key, so it is not printed by
  default"), and this log gets uploaded to R2, so leaking it there would be worse than a console
  print.
- Artifacts always land locally first, at `/tmp/logs/runs/<runId>/` (`events.jsonl`, `meta.json`,
  `video.<ext>`, extension from the real download content-type) — the R2 upload happens last and
  only if all four `CF_*` vars are set; a failed/skipped upload never loses data, it's still on
  disk.
- If the sandbox rotates mid-run (its own idle timeout — unlikely, since the run keeps actively
  driving it), the recording lives on the now-unreachable original sandbox and can't be
  stopped/downloaded through the replacement; this is detected and reported (`meta.json`'s
  `sandboxRotated: true`, a console warning), not silently swallowed, but the video itself is lost
  in that case. The event log and metadata are still written and uploaded either way.
- Verified end-to-end against a real sandbox, including the failure path: killed the Anthropic
  call (no `ANTHROPIC_API_KEY`) mid-run and confirmed the recording was still stopped, downloaded
  (a valid, playable `.mp4`), and all artifacts written with `status: "error"` and the underlying
  message recorded. Also verified a full successful run (real prompt, real Anthropic key) with a
  real R2 bucket: both `video.mp4` and `events.jsonl` were downloaded back from their printed URLs
  and confirmed byte-identical to the local copies.
- Printed links prefer a plain public URL (`CF_PUBLIC_BASE_URL` set to the bucket's `pub-*.r2.dev`
  domain or a custom domain) over a presigned one -- shorter and permanent instead of expiring.
  Falls back to `getRunArtifactUrl()` (presigned, 7-day expiry) when that var isn't set, which
  still works against a bucket with no public access configured at all.
- Also captures a thumbnail (`thumbnail.jpg`, a JPEG screenshot of wherever the run ended up,
  quality 45) and uploads it alongside the video/log/meta. `takeScreenshot()`'s `scale` option is
  requested but not actually honored by the gateway as of `use-computer-sdk` 0.1.13 -- still
  returns a full-resolution image -- so quality is turned down instead to keep the file small.
- After every successful upload, adds this run to the gallery index with `src/lib/gallery.ts`'s
  `addRunToGalleryIndex()` -- an O(1) incremental read-modify-write against `index.json` (also in
  R2), not a rescan of the whole bucket.
- Records which model actually ran and what it cost: `meta.json` (and each gallery index entry)
  gets `modelChoice`/`model` (the exact selector used -- `"haiku"` or
  `"openrouter:qwen/qwen3.7-flash"`, whichever was passed via `MODEL`), plus `inputTokens`/
  `outputTokens` (from the AI SDK's `streamText()` result, which sums usage across every internal
  tool-calling step automatically) and an estimated `costUsd` when pricing is known for that model
  (`src/lib/cost.ts`: hardcoded list prices for the three Anthropic choices, a live lookup against
  OpenRouter's public, unauthenticated `/api/v1/models` pricing endpoint for `openrouter:`
  selectors). `costUsd` is an estimate against current list price, not the exact amount billed, and
  is left `undefined` (not `0`) rather than guessed when pricing can't be determined. The gallery
  app displays both underneath the video (see below).

## Recordings gallery

The gallery that reads `index.json` and displays it is a **separate app**, deliberately not part
of this codebase -- see [`gallery/README.md`](gallery/README.md) and its own docs for how it's
built, tested, and deployed. This repo's only connection to it is writing `index.json` and the
files it references (above); the two share no code, dependencies, or credentials.

### Gallery index storage: `index.json` in R2, and the `rebuildGalleryIndex()` repair tool

The gallery index (`GalleryEntry[]`, see `src/lib/gallery.ts`) is a single `index.json` object in
R2, updated incrementally rather than fully rebuilt on every run:

- `addRunToGalleryIndex(runId, meta)` -- the normal per-run path, called from `agent-run.ts`: one
  read, splice in this run's entry (replacing any existing entry for the same `runId`, so a
  retried/re-uploaded run doesn't duplicate), one write. O(1) regardless of history size.
- `rebuildGalleryIndex()` -- kept as an explicit **repair/backfill tool**
  (`tools/rebuild-gallery-index.ts`), not part of the normal path: rescans every `runs/<id>/`,
  re-derives each entry from that run's own `meta.json` (the actual ground truth), and overwrites
  the whole index. Use it to backfill runs recorded before this incremental scheme existed, or to
  recover from a lost/corrupted index or a dropped concurrent-write race in `addRunToGalleryIndex`.

This briefly lived in Cloudflare KV instead of R2 (a real, deliberate experiment -- verified the
integration end-to-end against a real namespace before deciding against it) and was moved back.
Worth recording why, since it's a genuine design decision and not just a reversion:
- The only actual win KV offered was the O(1)-write property above -- but that comes from
  *incremental read-modify-write*, not from KV specifically. A plain R2 object gets the identical
  O(1) write.
- Cloudflare's KV REST API has no public/anonymous read mode the way an R2 bucket's public domain
  does, so using it gave the otherwise fully credential-free `gallery/` app a real secret to hold,
  for no offsetting benefit.
- Workers KV is only **eventually consistent** (Cloudflare's own docs: a write can take up to 60s
  to propagate to edge locations other than the one it was written from); R2 (S3-compatible) is
  strongly consistent. Moving to KV would have made the gallery *less* immediately live, not more --
  it was already "live" in the sense that mattered, since the gallery re-fetches fresh data on
  every page load and the index updates the moment a run finishes, no manual step either way.
