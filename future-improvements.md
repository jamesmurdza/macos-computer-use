# Future improvements for the GUI-automation agent

Candidate ideas for extending `src/lib/sandbox.ts`/`src/lib/agent.ts`, discussed while debugging
the agent's reliability on multi-step GUI tasks. None of these are committed plans — they're
options, with an honest assessment of each, for whoever picks this up next to prioritize.

## Ranked by likely impact

### 1. Vision (screenshots) + a coordinate-click tool

The agent currently reasons entirely from a pruned accessibility-tree JSON summary. Every real bug
found while debugging this session's task was actually confirmed by looking at a real screenshot,
not the tree — a checkbox with no accessible glyph, silently-empty form fields, a system popup
sitting on top of a functional dialog, a stray extra window causing confusion. The agent never gets
to see any of that; it only gets the tree's version of events.

Giving the agent an actual screenshot (likely alongside, not instead of, the tree summary) would
plausibly prevent or shorten a large share of this failure class. **This needs to ship paired with
a raw `x, y` coordinate-click tool** (`sandbox.mouse.click()` already exists at the `sandbox.ts`
level, just isn't exposed to the agent) — seeing a problem visually is only useful if the model can
then act on what it saw, and today's only click primitive is label-based.

Open questions before building:
- Cost/latency: images are token-heavy; decide whether every step gets a screenshot or only on
  request/failure (e.g. after an `ambiguous`/`not-found` result, or when the model asks).
- Whether to downscale/crop before sending, given screen resolution vs. model vision limits.

### 2. A general AppleScript / scripting-dictionary execution tool

Doesn't help the PDF-field-identity problem (a PDF form field is unlikely to be any more exposed
via an app's scripting dictionary than via the accessibility tree — same underlying surface). But
it's a strong candidate fix for a *separate*, repeatedly-observed failure class: multi-step native
Save/Save-As flows going wrong — duplicate-window pileups, filename-collision dialogs, File-menu
hunting, `cmd+q` discarding unsaved work. Many of these are exactly the kind of file/document
operations AppleScript performs atomically and unambiguously (e.g. a single
`tell application "Preview" to save document 1 in file "..."`-style command, no GUI race with a
popup, no ambiguity about which window is which).

Low implementation lift: `runAppleScript()` already exists in `sandbox.ts`, currently only used
internally for app activation. Exposing a general-purpose version as an agent tool (with whatever
guardrails make sense — e.g. restricting to a small set of apps/verbs, or none at all) is mostly a
matter of deciding the interface and the safety boundary, not building new plumbing.

Worth scoping which apps/operations benefit most before generalizing — Preview and Finder's
scripting dictionaries are worth checking concretely first.

### 3. AX-tree diffing instead of resending the full tree every step

Idea: instead of every action's result (and every `read_accessibility_tree` call) carrying the full
pruned tree summary, show only what changed since some prior point. This would shrink token usage
substantially during the repetitive, same-screen phase of a task (e.g. filling in one form field
after another), which is exactly where today's runs spent the most steps and tokens. It would also
make "did my last action actually do anything" much harder to misreport — a diff showing nothing
changed is a stronger, more legible signal than the model having to notice a field is still empty
inside a large, mostly-unchanged JSON blob.

This directly addresses the one confirmed *hard* infrastructure failure seen while debugging (a
model's context window filling up mid-task from repeated full-tree dumps), separate from any
model-reliability question.

**Prerequisite to verify before building anything:** whether an element's `id` in the raw
`uiTree()` response is stable for "the same visual element" across two separate calls, or
regenerated fresh each read. If it's the latter, diffing degenerates into fuzzy-matching elements
by label/role/position between snapshots — an unreliable heuristic that could introduce a new class
of false-changed/false-unchanged bugs on top of the ones this would fix. Check this against a real
sandbox first; the whole idea rests on it.

Real risks even if identity turns out to be stable:
- **Losing full-state visibility at exactly the moments it matters most** — right after a
  multi-window Save flow, or when an unexpected popup appears, the model likely needs the *whole*
  current screen, not a delta from an arbitrary earlier point (especially once there's been
  navigation to a totally different screen in between — a "diff" against that is closer to noise
  than to a diff).
- **Benefit is task-shape-dependent, not universal** — big win during repetitive same-screen steps,
  little to no win during navigation-heavy phases (opening apps, switching windows) where most of
  the screen changes anyway.

**Suggested design if pursued, to manage the above risk:** don't diff everything uniformly. Keep
`read_accessibility_tree` (an explicit request) always returning the full current state — an
explicit "what's on screen now" call should get ground truth, not a delta. Make only the automatic
`screen` field attached to an *action's* result (click/type/press) a diff against the state
immediately before that action — "what changed as a result of what I just did" is naturally
diff-shaped and is exactly the self-verification question that matters, without giving up full
visibility on demand.

## Lower priority (discussed and considered, but not well-motivated by observed failures)

### A menu explorer ability

Would let the agent list an app's full menu structure in one call instead of click-menu-then-read
(2 steps). Real, but marginal — no observed failure this session was actually caused by menu
discovery being slow or unreliable; every menu item needed was reachable in the existing 2-step
pattern. Convenience, not a fix for a real bottleneck.

### A list-available-applications ability

Would let the agent discover installed apps without guessing names. Not motivated by anything
observed — every task specified its apps explicitly and `open_app` resolved them without issue.
Might matter for more open-ended/exploratory tasks that haven't been tried yet, but there's no
current evidence it would move the needle on the failures actually seen.

## Notes for whoever picks this up

- None of the above should be built speculatively — per this repo's own debugging guide
  (`agent-debugging-guide.md`), verify the specific hypothesis each idea depends on against a real
  sandbox before writing permanent code (especially true for #3's identity-stability question).
- #1 and #2 target genuinely different failure classes (visual/state-detection gaps vs. multi-step
  native-dialog flakiness) and aren't mutually exclusive — both are worth having eventually.
- #3 is the one most directly tied to a hard, reproducible infrastructure failure (a context-window
  ceiling) rather than a reliability/convenience question, which may argue for prioritizing it
  despite the open technical risk, if long-running tasks on smaller-context models are a priority.
