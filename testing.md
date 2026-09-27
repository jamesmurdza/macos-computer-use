# Testing Guide

## Environment Setup
- Package manager: npm (Node 22, ESM project, Next.js App Router)
- Required env vars (put them in `.env` — Next.js loads it automatically for `npm run dev`/`build`/`start`; `tests/setup.ts` loads it the same way via Node's `process.loadEnvFile` for the test runner):
  - `USE_COMPUTER_API_KEY` — use.computer account key (`uc_live_...`)
  - `USE_COMPUTER_RESERVATION_ID` — an active Mac mini reservation; the code never reserves
  - `ANTHROPIC_API_KEY` — Claude, for the Playwright test and the app itself
  - `USE_COMPUTER_BASE_URL` — optional, defaults to `https://api.use.computer`
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
- `sandbox-resolution.int.test.ts` — proves `setDisplayResolution()` (src/lib/sandbox.ts) actually
  changes the sandbox's rendered resolution (1920x1080 → 1280x720), not just the Displays pane's
  own label.

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
| `setDisplayResolution()` (open Displays, click, settle) | ~20 s |

## Display resolution

Sandboxes are Apple `Virtualization.framework` VMs (`Model Identifier: VirtualMac2,1`, `Chip:
Apple M4 (Virtual)`), not bare-metal Mac minis, and boot at a fixed **1920x1080**. There is no
gateway API for this (`POST .../display/resize` and similar guesses all 404) and no in-guest CLI
(`displayplacer`/`m1ddc`/`ddcctl` are not installed) — but `System Settings > Displays` genuinely
re-renders the framebuffer at a smaller size when you pick one, exactly like a physical Mac.
`setDisplayResolution(sandbox, width, height)` in `src/lib/sandbox.ts` automates that pane using
the same `clickElement`/`runAppleScript` primitives the agent's own tools use. Verified against a
real sandbox with both `sandbox.displayInfo()` and an actual `screencapture` + `sips` pixel-size
check — not just the pane's own label. Confirmed options in the default (non-"Show all
resolutions") list: `1920x1080` (default), `1600x900`, `1280x720`; the helper flips on "Show all
resolutions" and retries once if the requested size isn't in that short list.

Caution: `use-computer-sdk`'s own `.d.ts` declares `MacOSSandbox.displayInfo()` as resolving to
`{width, height}` directly, but a real sandbox actually returns the gateway's raw `{ success,
size: { width, height } }` at runtime instead — the SDK's declared type does not match its actual
behavior here. `SandboxHandle.displayInfo()` matches the SDK's (wrong) declared type for
structural compatibility; anything consuming the result should defensively check for a nested
`size` too (see `setDisplayResolution`'s own handling).
