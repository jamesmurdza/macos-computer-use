# Future improvements for the agent

Candidate ideas for extending `src/lib/sandbox.ts`/`src/lib/agent.ts`. Framed around one question:
what makes this the most capable, general-purpose computer-use agent possible — not "what would
have fixed yesterday's one demo task." That task surfaced some of these ideas and is cited as
evidence where relevant, but it's not the yardstick each idea is graded against; a good idea here
should make the agent better at tasks nobody's tried yet, not just the W-9 form.

## The core idea: match the automation surface to the task, not one universal method

Right now the agent has exactly one way to do anything: read the accessibility tree, click/type by
label. That's a reasonable universal fallback, but it's the least reliable option available for
most tasks — it's simulating a human using a GUI, with all the ambiguity that implies (elements
with no stable identity, focus that silently moves, dialogs that block other dialogs). For a lot of
real work, a more direct surface already exists and should be preferred:

- **A scriptable app's own automation interface** (AppleScript / a scripting dictionary) is more
  reliable than clicking through its GUI whenever the app supports it — atomic, unambiguous,
  no race with a popup, no "which window is this."
- **A web page's DOM** (via something like Playwright) is more reliable than clicking through a
  rendered browser view — real selectors, real waiting, no dependency on the accessibility bridge
  translating web content into AX nodes at all.
- **The accessibility tree + GUI clicking** is the necessary fallback for everything that doesn't
  have a better surface: apps with no/poor scripting support, in-app content that isn't a real
  document (a PDF form's fields, a canvas-drawn UI), and — per below — possibly a fair number of
  Electron apps.

The ideas below mostly slot into one of these three tiers, plus a couple of cross-cutting
improvements to the fallback tier itself (since it'll never fully go away — plenty of real tasks
have no better surface than "click what a human would click"). Treating this as a tiered strategy,
not a flat list of independent features, is itself the main thing worth taking away.

**One real tension worth naming, not deciding here:** this repo's current purpose is a
human-watchable recording of an agent visibly driving a macOS sandbox (see the gallery). Leaning
hard into tier 1/2 (script it, don't click it) makes the agent more capable and reliable, but a
recording of AppleScript commands executing or a headless Playwright session doesn't show anything
interesting to watch — it's a different value proposition than "watch the agent use a computer."
Whether this project wants to optimize for capability or for a compelling human-watchable demo (or
find a shape that's both — e.g. only reaching for tier 1/2 when tier 3 has genuinely failed, or
running Playwright headed so it's still on screen) is a real product decision, not a technical one.

## Tier 1: native scripting access

### A general AppleScript / scripting-dictionary execution tool

The single biggest capability multiplier available for the lowest implementation cost.
`runAppleScript()` already exists in `sandbox.ts` (currently only used internally for app
activation) — exposing a general-purpose version as an agent tool is mostly an interface and
safety-boundary decision, not new plumbing. Once available, it unlocks reliable, atomic access to
anything a scriptable app exposes: Mail, Calendar, Finder file operations, Music, Photos, and any
third-party app with a real scripting dictionary — a large fraction of real "get something done on
a computer" tasks, most of which have nothing to do with GUI-clicking at all once you can just ask
the app to do the thing.

It also happens to fix a concrete, repeatedly-observed failure class from GUI-driving native
Save/Save-As flows (duplicate-window pileups, filename collisions, `cmd+q` discarding unsaved
work) — but that's a side benefit of the general capability, not the main case for building it.

Worth scoping which apps/operations benefit most by checking real scripting dictionaries directly
(`osascript -sdef`-equivalent) rather than assuming; dictionary quality varies a lot app to app.

## Tier 2: DOM-level web automation

### A Playwright-driven browser as a second automation modality

Web tasks — filling out a form, extracting data from a page, navigating a multi-step flow — are
plausibly the single most common category of real "computer use" task there is, independent of
anything about this repo's current demo. Driving a real DOM via Playwright (real selectors, real
waiting, no accessibility-bridge translation step at all) is a fundamentally more reliable modality
for that whole category than clicking through a rendered browser view, the same way tier 1 is more
reliable than clicking through a native app's GUI.

It doesn't help with content that isn't really part of a web page's DOM — a PDF rendered by a
browser's built-in viewer is native/plugin-rendered either way, so this wouldn't have changed
anything about a PDF-specific task. That's not a knock against the idea; it's just a different
category of task than the one that happened to be in front of us yesterday.

Concretely: some current flakiness (a skipped or mistimed click on Safari's search field derailing
a run's very first step) goes away entirely with a direct `page.goto(url)`, since there's no field
to click in the first place — a small illustration of the general point that a scripted surface
removes a whole class of GUI-timing bug outright rather than making it more reliable.

Needs a decision on when the agent reaches for this vs. driving Safari as an app (e.g. an explicit
"do this on this website" step vs. general browsing), and — see the tension noted above — whether
it runs headed (visible in the recording) or headless (faster, but invisible).

## Tier 3: strengthening the GUI/accessibility-tree fallback

This tier can't go away — plenty of apps and content genuinely have no better surface — so it's
worth investing in directly, not just treating as a last resort.

### Vision (screenshots) + a coordinate-click tool

The agent currently reasons entirely from a pruned accessibility-tree JSON summary, with no way to
see the actual screen. That's a real ceiling on the fallback tier specifically: every real bug
found while debugging yesterday's task was actually confirmed by looking at a real screenshot, not
the tree (a checkbox with no accessible glyph, silently-empty form fields, a system popup sitting
on top of a functional dialog, a stray extra window). Those are all instances of a general
category — accessibility data that's incomplete, stale, or misleading — that vision fixes directly,
for any app, not just the ones already tried.

**Needs to ship paired with a raw `x, y` coordinate-click tool** (`sandbox.mouse.click()` already
exists at the `sandbox.ts` level, just isn't exposed to the agent) — seeing a problem visually is
only useful if the model can act on what it saw, and today's only click primitive is label-based.

Open questions before building: cost/latency of sending images every step vs. on-demand (e.g. after
an `ambiguous`/`not-found` result); how much to downscale/crop first.

### AX-tree diffing instead of resending the full tree every step

Show only what changed since some prior point, instead of a full pruned-tree summary on every
action and every explicit read. Two distinct general benefits, independent of any one task: it cuts
token cost on any long-running task (this is what actually caused a real, hard failure yesterday —
a smaller-context model died mid-task from repeated full-tree dumps), and it makes "did my last
action actually do anything" much harder to misreport, since a diff showing nothing changed is a
far more legible signal than a model having to notice a field is still empty inside a large,
mostly-unchanged JSON blob.

**Prerequisite to verify before building anything:** whether an element's `id` in the raw
`uiTree()` response is stable for "the same visual element" across two separate calls, or
regenerated fresh each read. If it's the latter, diffing degenerates into fuzzy-matching elements
by label/role/position between snapshots — an unreliable heuristic that could introduce a new class
of false-changed/false-unchanged bugs. Check this against a real sandbox before designing anything
else; the whole idea rests on it.

Real risks even if identity turns out stable: losing full-state visibility at exactly the moments
it matters most (right after a multi-window flow, or when an unexpected popup appears — the model
needs the *whole* screen there, not a delta from an arbitrary earlier point), and the benefit being
task-shape-dependent (big during repetitive same-screen steps, small during navigation-heavy
phases where most of the screen changes anyway).

**Suggested design to manage that:** keep `read_accessibility_tree` (an explicit request) always
returning full current state — an explicit "what's on screen now" call should get ground truth, not
a delta. Make only the automatic `screen` field attached to an *action's* result (click/type/press)
a diff against the state immediately before that action, since "what changed as a result of what I
just did" is naturally diff-shaped and doesn't need the full picture to answer.

### Electron-app support

A large share of real-world macOS apps someone might actually want automated (Slack, VS Code,
Discord, Figma, Notion, and many others) are Electron apps — a Chromium web view in a native shell.
Chromium's accessibility bridge can expose a good AX tree when the app's own content has real ARIA
labeling, but plenty of Electron apps expose only a large, sparse, mostly-unlabeled tree — a
version of the same "no stable identity" problem seen with PDF form fields, potentially spanning an
entire app's UI rather than one form. If that holds generally, it's a meaningful gap in what the
fallback tier can actually cover.

**This is a hypothesis, not a finding.** Checked the base sandbox image directly: it has no
Electron apps installed at all (just Apple's own bundled apps, plus Xcode and iTerm), so real AX
tree quality on an actual Electron app hasn't been observed. Getting a real answer requires first
solving an untested prerequisite: installing a third-party app onto the sandbox at all (e.g. a
`.dmg`/`.pkg` download-and-install flow via Safari, never attempted). If the hypothesis holds, it's
a strong argument for vision as this tier's fallback-within-the-fallback — an Electron app with a
poor AX tree is exactly the case where "just look at the screen" degrades most gracefully.

### Smaller tooling additions

Two ideas that came up but aren't well-motivated as high priority, for completeness:

- **A menu explorer** (list an app's full menu structure in one call instead of click-then-read).
  Genuinely convenient, but marginal — nothing observed so far was actually bottlenecked on menu
  discovery, and the existing 2-step pattern already works.
- **A list-available-applications ability.** More plausible under a general-capability framing than
  it first looks — a genuinely general agent shouldn't have to be told exactly which app to use for
  a task category ("open my note-taking app" without knowing if that's Notes, Bear, or Obsidian) —
  but there's no evidence yet that this is actually a binding constraint on anything attempted so
  far, since every task specified its app explicitly.

## Notes for whoever picks this up

- Verify before building, always — per `agent-debugging-guide.md`. Two of the ideas above
  (AX-diffing's identity-stability question, Electron's AX-tree-quality question) are explicitly
  unconfirmed hypotheses, not findings, and shouldn't be treated as more certain than that.
- Tier 1 and tier 2 (AppleScript, Playwright) are architecturally similar moves — "use a more
  direct surface when one exists" — and are probably the highest-leverage, lowest-effort additions
  for general capability, precisely because they sidestep whole categories of GUI-ambiguity bug
  rather than making the GUI path incrementally more reliable.
- Tier 3's items (vision, AX-diffing, Electron handling) matter regardless of how far tier 1/2 goes,
  since GUI-driving some things is unavoidable — but they're a different kind of investment
  (hardening a fallback) than tier 1/2 (avoiding needing the fallback at all).
- Revisit the recording/demo tension explicitly before committing to how aggressively tier 1/2 get
  used by default — it's a real product decision, not something to default your way past.
