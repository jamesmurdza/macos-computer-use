# macOS Computer Use

A Next.js app that drives a real macOS sandbox ([use.computer](https://use.computer)) with a
Claude agent. Type an instruction, and the agent reads the screen, then clicks, types, and presses
keys until it's done.

https://github.com/user-attachments/assets/18f4f71f-090d-4172-8bbb-d9f7a57ad7d6

## Features

- Built on the [Vercel AI SDK](https://sdk.vercel.ai/), giving access to
  [100+ models](https://ai-sdk.dev/providers/ai-sdk-providers) across every major provider
- Drives a real macOS sandbox via mouse, keyboard, and app launching — no shell or scripting shortcuts
- Sees the screen through macOS's accessibility API — no screenshots, no vision model, just a
  JSON tree of on-screen elements
- Live view of the sandbox's screen next to the chat
- Streams tool calls, results, and replies live as the agent works
- Stateless server: sandboxes are created automatically and self-delete after a couple minutes of
  inactivity
- Headless mode (`tools/agent-run.ts`): drive the agent from the CLI instead of the web app, with
  the whole run recorded to video and logged to a timestamped JSONL file — optionally uploaded to
  Cloudflare R2 for later review

## How the agent works

The agent drives the sandbox purely through its GUI, the way a person would. It uses helper
functions built on macOS's accessibility API to read the screen and perform actions. Claude is
given five tools, all bound to the current sandbox:

- `read_accessibility_tree` — Returns a pruned JSON summary of what's on screen, annotated with
  roles and labels. OS chrome (the Dock, Notification Center, etc.) is filtered out.
- `open_app` — Launches or focuses an app and waits until it presents a window.
- `click_element` — Clicks an on-screen element by label. It uses a real mouse click at the
  element's position (rather than accessibility actions), which works for SwiftUI apps as well as
  standard ones.
- `type_text` — Types into whatever control currently has keyboard focus.
- `press_keys` — Presses a key or hotkey combo (e.g. `cmd+s`).

The system prompt steers it through a simple loop — **look, act, look** — and most action tools
return the updated screen right after acting, so the model rarely needs a separate read in
between. A turn runs for up to 40 tool-calling steps before it's cut off as a runaway guard.

## LLM support

The agent talks to the model through the [Vercel AI SDK](https://sdk.vercel.ai/), which supports
[100+ models](https://ai-sdk.dev/providers/ai-sdk-providers) across every major provider.

To change the model:

1. Install the provider's AI SDK package, e.g. `npm install @ai-sdk/openai`.
2. In `src/lib/llm.ts`, change `MODEL_IDS` to the model id(s) you want.
3. In `src/lib/agent.ts`, swap the import and the `model:` line:

   ```ts
   import { openai } from "@ai-sdk/openai";
   // ...
   model: openai(MODEL_IDS[modelChoice]),
   ```

The rest of the code — the tool-calling loop, tool definitions, and streaming — all work the
same regardless of provider.

## Requirements

- Node.js 22+
- A [use.computer](https://use.computer) API key and an active Mac mini reservation
- An [Anthropic](https://www.anthropic.com/) API key (or another provider's, see [LLM support](#llm-support))

## Setup

```bash
npm install
```

Create a `.env` file in the project root:

```
USE_COMPUTER_API_KEY=uc_live_...
USE_COMPUTER_RESERVATION_ID=...
ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). A sandbox is created automatically on first
load.

For a production build:

```bash
npm run build
npm start
```

## Headless runs

To drive the agent from the command line instead of the web app — useful for scripting, or for
recording a session to review later:

```bash
npx tsx tools/agent-run.ts "use xcode to make and run a hello world script"
```

This creates its own sandbox, records the whole run as video (native to the use.computer gateway —
no extra setup) and writes a timestamped JSONL log of every tool call, result, and reply.
Everything is saved locally to `/tmp/logs/runs/<runId>/`, and — if these four extra vars are set in
`.env` — also uploaded to a Cloudflare R2 bucket:

```
CF_ACCOUNT_ID=...
CF_ACCESS_KEY_ID=...
CF_SECRET_ACCESS_KEY=...
CF_BUCKET=...
```

Optional: `MODEL=sonnet` picks a model, `RESOLUTION=1280x720` shrinks the recorded video,
`AGENT_RUN_ANTHROPIC_API_KEY` uses a different Anthropic key for this script only (kept out of
`ANTHROPIC_API_KEY`, which the web app auto-loads from `.env`), and `CF_PUBLIC_BASE_URL` (a
bucket's public `pub-*.r2.dev` domain) prints plain permanent links instead of presigned ones.
Without the CF vars, it still runs end-to-end and just skips the upload. If `CF_API_TOKEN` and
`CF_KV_NAMESPACE_ID` are also set, each run is added to the gallery index (see below) too. See
[testing.md](testing.md) for the JSONL log's schema and more detail.

## Recordings gallery

Every successful `agent-run.ts` run adds itself to a small index in Cloudflare KV (one incremental
write, not a rescan of the whole bucket). A **separate, standalone app** in [`gallery/`](gallery/)
reads that index and renders a clean grid — thumbnail, prompt as description, date, YouTube-style
duration badge; click one to play the recording. It's a fully independent Next.js app on purpose —
no shared dependencies, no shared code, meant to be deployed as its own Vercel project (this app
and the gallery don't need to run on the same host, or even both be deployed at all). Note that,
unlike this app, the gallery *does* hold a real credential (a Cloudflare API Token for KV reads) —
see [`gallery/README.md`](gallery/README.md) for why and for setup.

## Test

```bash
npm run typecheck    # TypeScript
npm run test:unit    # unit tests, no network
npm run test:int     # integration tests against a real sandbox + Claude
npm run test:e2e     # sandbox scenario tests
npm run test:e2e:web # Playwright, drives the page against a real server
```

See [testing.md](testing.md) for more detail.
