# Debugging and Improving the GUI-Automation Agent

A guide for working on this repo's core loop: an LLM driving a real macOS sandbox through
`src/lib/sandbox.ts`'s accessibility-tree tools (`read_accessibility_tree`, `click_element`,
`type_text`, `press_keys`, `open_app`), orchestrated by `src/lib/agent.ts` and exercised headlessly
via `tools/agent-run.ts`. Rules and guidelines, not a log of any particular incident.

## 1. Ground truth, in order of trust

When something looks wrong (a field is empty, a click didn't work, a run failed), verify in this
order — each one is more trustworthy than the last:

1. **A real screenshot of the sandbox at the relevant moment**, cropped and zoomed into the exact
   region in question. This is the actual, final source of truth: what a person looking at the
   screen would see. `takeScreenshot()` (or `agent-run.ts`'s saved `thumbnail.jpg`) gives you this.
2. **The raw, unpruned `sandbox.uiTree()` response**, not the pruned/truncated summary the model
   sees. Dump specific nodes and print every key present — don't assume a property exists or means
   what its name suggests without checking a real example.
3. **The tool-call/tool-result pairs in `events.jsonl`**, matched by step number to whatever claim
   you're checking. A model's final summary is a *claim about* what happened, generated after the
   fact — it is not a record of what happened.
4. **The model's own final report.** Useful for understanding what it *believes* happened and
   where it thinks it got stuck, but never sufficient on its own to conclude a run succeeded,
   failed, or hit a genuine technical wall. Treat every specific factual claim in it ("the checkbox
   didn't respond," "the dialog isn't interactable," "I saved the file") as a hypothesis to check
   against (1)–(3), not a fact.

**Never skip straight to (4).** A run reporting success or failure is the least informative signal
you have about whether it actually succeeded or failed — models confidently misreport both
directions (claiming success on empty fields, and claiming failure right after a successful
action) often enough that it must always be checked, not spot-checked.

This applies to your own hypotheses too, not just the model's. Before writing a claim into a
system prompt or shipping a code change based on an assumption about how some UI or API behaves,
test it directly against a real sandbox first. An assumption that "feels obviously true" is exactly
the kind of thing worth five minutes of verification before it becomes permanent guidance that
every future run inherits.

## 2. Where to look first when a task fails

When an agent run fails or behaves strangely, work in this order:

1. **Is this the *first* time this task/shape of task has failed?** If yes, investigate this run
   specifically — read its screenshots and events.jsonl, form a hypothesis, verify it with a
   targeted probe (see §5).
2. **Have multiple different models failed the same task, in different-looking ways?** This is a
   strong signal to stop iterating on prompts or swapping models and instead go inspect what the
   harness is actually handing the model — the raw accessibility tree, the tool definitions, the
   system prompt's instructions for this task shape. Different models failing differently at the
   same task usually means the *data* they're all working from has a gap, not that N unrelated
   model weaknesses happen to collide on one task.
3. **Check whether an existing primitive already solves it** before adding a new one. This
   codebase's `clickElement()` already has:
   - `nearLabel` — resolve an ambiguous match (several elements sharing one generic label, e.g. a
     form's repeated `"(empty text field)"`) by proximity to another, stable, already-on-screen
     label, instead of a numeric index into a list whose membership shifts as fields get filled.
   - `clickOffsetLeftPx` — click a fixed offset from a matched element's own edge, for widgets
     (like some PDF form checkboxes) whose real clickable glyph has no accessible element of its
     own, only an adjacent disabled text description.
   - Window-level `frontmost`/`zIndex` — which window is actually on top, when an app has more
     than one open (common after any "duplicate" or "new window" action).
   - `type_text`'s `verified: false` — whether typed text actually landed in some on-screen field's
     value afterward, versus just having been dispatched as keystrokes.

   If a new bug smells like one of these ("the model keeps clicking the wrong instance of
   something," "multiple windows are confusing it," "it thinks text landed somewhere it didn't"),
   reach for the existing mechanism before writing a bespoke workaround.
4. **Only write a new harness primitive when none of the above fit.** Prefer extending
   `sandbox.ts`'s real capabilities (a new click/type/read option, backed by real geometry or
   real tree data) over adding another paragraph to the system prompt. A prompt instruction is
   advice a model can ignore, misapply, or forget under pressure; a harness primitive is a
   guarantee.

## 3. Working with the accessibility tree data model

- The raw gateway data is a large, mostly-irrelevant tree. `uiTreeSummary()` prunes and caps it —
  when debugging, always check both the pruned view (what the model actually sees) *and* the raw
  view (what's actually available) separately, since a bug can live in either: the data might
  genuinely be missing, or it might exist raw but get pruned/truncated/mis-ordered away.
- Don't assume an element property means what its name suggests. Verify empirically — e.g. don't
  assume a `z_index`-shaped field sorts high-to-low or low-to-high without checking a real example
  where you control which window should be on top.
- Some real UI elements (especially non-native ones, like PDF form widgets rendered by Preview)
  have **no distinguishing accessible identity at all** — no name, no description, sometimes no
  real role. When that's the case, stop looking for a labeling fix and reach for what *does* stay
  stable: on-screen geometry (`bbox`), and proximity to something nearby that *does* have a stable
  label.
- A numeric index into a filtered list of matches is only stable if that list's membership is
  stable. If items can drop out of the list (e.g. an empty field becomes non-empty and gets a real
  label), the index silently means something different next time — this is a general trap, not
  specific to any one form or app.
- When an app can end up with more than one window (duplicates, new-document shortcuts, spawned
  dialogs), never assume the first/only/most-recently-mentioned window is the one a click will
  land in. Check which one is actually frontmost.

## 4. Writing and changing the system prompt

- Every instruction added to `AGENT_SYSTEM_PROMPT` should be something you have personally verified
  against a real sandbox, not something that sounds plausible. If you can't verify it directly
  (e.g. you're relying on a model's report of some UI behavior), say so explicitly in the prompt's
  comment/rationale rather than stating it as settled fact — and go verify it before the next
  session relies on it.
- Prefer teaching a general *technique* ("use nearLabel to anchor to a stable nearby label") over a
  specific *fact* ("field 5 is the address field"). Facts about one form don't transfer; techniques
  do.
- When a prompt instruction turns out to be wrong (not just incomplete), fix the wrong claim
  itself, don't just add a caveat on top of it. A prompt with two contradictory instructions is
  worse than one with a single correct one.
- Keep instructions actionable and falsifiable: "if X status appears, do Y" is better than "be
  careful about X." A model can execute a concrete branch; it can't reliably act on vague caution.

## 5. Probing and verifying against a real sandbox

- Throwaway investigation/verification scripts belong in `tools/_probe-*.ts` — never committed,
  deleted as soon as they've answered the question they were written for. They are not the user's
  deliverable and shouldn't accumulate in the repo.
- Design probes to produce a **decisive, unambiguous** answer, not a plausible-looking one. If
  you're checking "does X toggle a checkbox," take a screenshot before and after and diff them
  visually — don't infer success from a tool call's status alone.
- When reverse-engineering an opaque, multi-step UI behavior (e.g. an unknown tab/focus order
  across many fields), design one experiment that distinguishes every step at once — e.g. type a
  distinct marker at each step, then read the final state once — rather than trying to infer the
  whole sequence from a single ambiguous run.
- Before running a probe (or a real agent run) against a sandbox, check slot availability first —
  the reservation caps concurrent sandboxes; launching without checking risks a confusing
  "no warm VMs available" failure that looks like a bug in whatever you were testing.
- Clean up anything you provision for a probe (sandboxes, uploaded scratch files) as soon as you're
  done with it, and don't leave a probe's process running past when you actually need its result —
  an orphaned sandbox silently occupies a slot that a later real run then can't get.

## 6. Choosing and comparing models

- Look up context window and pricing from a **live** model catalog query before choosing a model
  to try, not from memory — catalogs change, and memory is often stale or simply wrong about
  exact numbers.
- This harness resends a full accessibility-tree summary on every step, so token volume per run
  scales with step count, not just task complexity. A model with a small context window can fail
  purely on volume, well before it's had a chance to demonstrate whether it's actually capable of
  the task — check context window against the harness's typical per-step JSON size before spending
  money finding this out the hard way.
- A fair comparison between models requires the harness and prompt to be **frozen** for the
  duration of the comparison. If you're actively fixing bugs, you're not comparing models yet —
  you're debugging, and any model differences you observe are confounded by whatever changed
  underneath them. Only compare models once you're confident the harness itself isn't the variable.
- Run comparisons in parallel against the identical setup, and give each candidate more than one
  sample before concluding anything about its reliability — a single run tells you almost nothing
  about whether a failure (or success) was typical or a fluke. Model behavior on long, multi-step
  GUI tasks is often more stochastic than it looks from a single trace.
- Don't let cost be a surprise. Cost scales primarily with token volume × price, not with whether a
  run "worked" — an expensive model isn't necessarily doing more work, and a cheap model failing
  repeatedly can still add up. Check both dimensions before assuming one model choice is obviously
  cheaper in practice.

## 7. Running multiple sandboxes at once

- Concurrency here saves **wall-clock time only** — total token/dollar cost is the same whether
  runs happen in parallel or in sequence. Use it to get through more experiments per unit of your
  own time, not as a cost-saving measure.
- The reservation caps concurrent sandboxes (check current capacity before assuming it's free);
  plan investigations around that ceiling rather than assuming unlimited parallelism.
- Running more than one thing at once raises your own risk of under-verifying each individual
  result — apply the exact same ground-truth-checking discipline (§1) to every concurrent run,
  not just to whichever one looks most interesting as it's happening. Two half-checked results are
  worse than one fully-checked one.
- Parallel runs of the *same* setup are also a cheap way to sample variance (does this fail the
  same way every time, or differently each time?) — worth doing even outside of formal model
  comparisons, since a single run can't tell you whether its failure mode is typical.

## 8. General principles

- Prefer fixing the shared substrate (harness code, tree data, system prompt) over accumulating
  per-task or per-model special cases. A fix that only helps one specific form or one specific
  model is a workaround; a fix that helps any task shaped like the one you're looking at is a real
  improvement.
- When you're unsure whether something is a real, general bug or an artifact of one unusual run,
  the answer is to gather more evidence (another run, a targeted probe), not to guess. Cheap
  verification is almost always available in this environment — use it before committing to either
  a diagnosis or a fix.
- Be honest in status reports about what's actually been verified versus assumed. "Verified against
  a real sandbox" and "should work based on the code" are different claims — don't blur them,
  to yourself or to whoever you're reporting to.
