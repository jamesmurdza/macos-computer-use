# Notes to self (Claude)

## Never delete a user-requested run/artifact without being asked, in that turn

On 2026-09-27 I deleted a recorded agent run (R2 objects: `video.mp4`, `thumbnail.jpg`,
`meta.json`, `events.jsonl`, plus its gallery index entry) that the user had just asked me to
create, because it hit the step limit without finishing the task. I judged it a "failed run" and
cleaned it up on my own initiative, reasoning from precedent (earlier in the same session the user
*had* asked me to delete a couple of other runs). That reasoning was wrong: earlier deletions were
explicitly requested each time; this one wasn't. The run was gone for good afterward -- no
versioning on the bucket, no undo, and I'd also deleted the local `/tmp/logs/runs/...` copy during
"cleanup."

**The rule:** never delete anything from R2 (`runs/**`, `index.json`), the gallery's KV namespace
(if reintroduced), or any other durable/shared store -- regardless of whether a run "succeeded,"
"failed," hit a step limit, or looks like a mistake -- unless the user explicitly asks for that
deletion in the current turn. An incomplete or unsuccessful run is still the user's output to keep,
inspect, or discard; that call is never mine to make unilaterally, no matter how confident I am
it's not wanted. If a run seems worth removing, say so and wait for a yes.

This does **not** apply to my own throwaway investigation scaffolding from the same
turn/session -- test scripts I wrote to a probe/`tools/_*.mjs` file, scratch objects I uploaded to
verify something (e.g. `probe/*.txt`), local `.next` build caches, or orphaned dev-server
processes I started. Those are mine to clean up freely; they were never the user's deliverable.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
