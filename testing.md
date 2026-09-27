# Testing Guide

## Environment Setup
- Package manager: npm (Node 22, ESM project, Next.js App Router)
- Required env vars (put them in `.env` — Next.js loads it automatically for `npm run dev`/`build`/`start`; `tests/setup.ts` loads it the same way via Node's `process.loadEnvFile` for the test runner):
  - `USE_COMPUTER_API_KEY` — use.computer account key (`uc_live_...`)
  - `USE_COMPUTER_RESERVATION_ID` — an active Mac mini reservation; the code never reserves
  - `ANTHROPIC_API_KEY` — Claude, for the Playwright test and the app itself
  - `USE_COMPUTER_BASE_URL` — optional, defaults to `https://api.use.computer`
  - Only needed for `tools/agent-run.ts` (see "Headless recorded runs" below), not the web app:
    `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` — a Cloudflare R2
    bucket + API token (Object Read & Write) to upload run artifacts to. Without these,
    `agent-run.ts` still runs end-to-end and just skips the upload step.
  - Also `agent-run.ts`-only, both optional:
    - `AGENT_RUN_ANTHROPIC_API_KEY` — takes priority over `ANTHROPIC_API_KEY` for this script only.
      Deliberately a different name: Next.js auto-loads `.env`'s `ANTHROPIC_API_KEY` for
      `npm run dev`/`build`/`start`, so a key meant only for headless recorded runs (e.g. one on a
      separate budget/quota) needs a different name to stay structurally invisible to the web app,
      not just "remember not to use it there."
    - `R2_PUBLIC_BASE_URL` — if the bucket has R2's public access enabled (its `pub-*.r2.dev`
      domain, or a custom domain), set this to it and `agent-run.ts` prints plain permanent public
      URLs for the video/log instead of presigned ones (which expire and are much longer).
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
RESOLUTION=1280x720 npx tsx tools/agent-run.ts "..."   # shrink the recorded video, see above
AGENT_RUN_ANTHROPIC_API_KEY=sk-ant-... npx tsx tools/agent-run.ts "..."   # kept out of the web app
```

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
  only if all four `R2_*` vars are set; a failed/skipped upload never loses data, it's still on
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
- Printed links prefer a plain public URL (`R2_PUBLIC_BASE_URL` set to the bucket's `pub-*.r2.dev`
  domain or a custom domain) over a presigned one -- shorter and permanent instead of expiring.
  Falls back to `getRunArtifactUrl()` (presigned, 7-day expiry) when that var isn't set, which
  still works against a bucket with no public access configured at all.
