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

## Debugging GUI-automation reliability (agent-run.ts / the accessibility harness)

Spent 2026-09-27 chasing why the taxes/W-9 demo kept failing across several models. Brief version
of what actually worked, for whoever (probably me) picks this up next with no memory of it:

- **A screenshot is ground truth; the accessibility tree and the model's own summary are not.**
  Every real bug this session (a checkbox with no accessible element, a save that silently left
  two fields empty, a "not interactable" claim contradicted by the model's own prior successful
  click) was only actually confirmed by cropping and zooming a real screenshot. Don't trust
  `status: "ok"` or a model's "I completed it" -- check the artifact.
- **When several different models all fail the same task in different-looking ways, stop
  swapping models and go read the raw `uiTree()` data first.** It's almost always a shared harness
  gap, not N separate model weaknesses. `src/lib/sandbox.ts` already has `nearLabel` (click by
  proximity to a stable on-screen label instead of a shifting numeric index -- use this for any
  form with repeated identical field labels), `frontmost`/`zIndex` on windows (which window is
  actually on top, when an app has several), and `verified: false` on `type_text` (whether the
  typed text actually landed anywhere). If a new bug smells like these, check whether one of these
  already covers it before adding a new prompt workaround.
- **Before spending money on a new model, check its context window and price from a live
  OpenRouter catalog query (`GET /v1/models`), not memory.** This harness resends the full
  accessibility tree every step, so a long task can blow past a small context window (verified: a
  131K-token model died mid-task) well before it ever demonstrates whether it's actually capable.
- **Comparing models is only fair if the harness/prompt is frozen first**, then run every
  candidate in parallel against the identical setup. Sequential trials while also fixing bugs in
  between aren't a real comparison, just a debugging log.
- **Multiple sandboxes (2 max, per the reservation) save wall-clock time, not money or attention.**
  Running two at once is worth it, but don't let it mean checking either one's result less
  carefully than you would a single run.
- Throwaway verification scripts go in `tools/_probe-*.ts`, get deleted the moment they've answered
  the question (per the deletion-rule note above -- these are mine, not the user's deliverable).
  Verify a hypothesis against a real sandbox this way *before* writing it into a system prompt or
  permanent code -- I nearly shipped a wrong claim ("clicking a checkbox doesn't move focus") into
  the system prompt and caught it only by testing it first.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
