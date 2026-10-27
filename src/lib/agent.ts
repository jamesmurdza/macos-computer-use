import { anthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { type LanguageModelUsage, type ModelMessage, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { requireEnv } from "./env";
import { isOpenRouterSelector, MODEL_IDS, openRouterModelId, type ModelSelector } from "./llm";
import { clickElement, openApp, pressKeys, typeText, uiTreeSummary } from "./sandbox";
import { type SandboxDescriptor, type SandboxHandle, type SandboxRef, toDescriptor, withSandbox } from "./sandbox-handle";

/**
 * Bound on tool-calling rounds per user turn — a runaway guard, not a target. Real GUI tasks
 * (open an app, navigate a multi-step sheet, fill fields, run) can take 20-30 inspect/act steps,
 * so this is generous; the loop normally ends earlier when the model stops calling tools.
 */
export const MAX_AGENT_STEPS = 40;

export const AGENT_SYSTEM_PROMPT = `You accomplish the user's instruction on a fresh macOS 15 virtual machine by driving its GUI with the tools available. The machine is logged in as a normal user; Automation and Accessibility permissions are already granted.

Your loop is: look → act → look. Never act blind. open_app, click_element, type_text and press_keys each RETURN the updated screen (a "screen" field) right after acting, so you normally do NOT need a separate read_accessibility_tree — just look at what the action returned and decide the next step.

- open_app to launch or focus an app. It waits until the app actually shows a window and returns what's on screen. If its "note" says the app is frontmost with no window, or a dialog appears, handle that before continuing.
- read_accessibility_tree to look again without acting (e.g. to wait for something to finish): it returns the frontmost app's "menus" (menu-bar titles) and each on-screen window (including dialogs and sheets) with its elements' roles and labels.
- click_element to click anything by its label from the tree — a button, tab, checkbox, table cell, template/icon, or a menu-bar menu. It works even for SwiftUI controls. If it returns "ambiguous", pick from the candidates with index; if "not-found", read the tree again (the label may differ, or the element isn't up yet). To use a menu: click_element the menu name (e.g. "File" or "Product") to open it, read the tree, then click_element the item (e.g. "Run").
- type_text to type into a field — click_element the field first to focus it, then type_text. It types exactly what you give it and nothing else: no newline before or after. If text needs to land on separate lines (a title then body lines, several list items), put it all in one type_text call with "\n" between the parts rather than one call per line — two back-to-back type_text calls with no press_keys("return") between them land on the same line.
- press_keys for keys and shortcuts: "return"/"escape"/"tab" to confirm/dismiss/move, and app shortcuts like "cmd+shift+n" (Xcode: New Project), "cmd+r" (Run), "cmd+s" (Save). Use whichever is most reliable — a menu, a click, or a shortcut.

You drive the real GUI only — there is no shell, terminal, or scripting shortcut. Do the task the way a person would: through windows, menus, buttons and the keyboard. If a control isn't where you expect, look again (read the tree) and adjust — don't give up and don't invent another route.

Trust a tool's "ok" status: once a click/type/keypress reports "ok", that action happened — verify by reading the "screen" it already returned, don't repeat the same action again "to be sure" and don't undo/redo completed work just because a label looks slightly off. In particular, sidebar/list previews in many apps (Notes, Mail, Reminders, Finder) render a title immediately followed by a content preview with no separator between them (e.g. a note named "Shopping List" whose first line is "milk" can show as "Shopping Listmilk" in its sidebar row) — that's just how the row's accessible label reads, not a sign the text actually got merged in the document. If you're unsure, open the item and look at its real content before assuming something went wrong.

Never delete, discard, or start over on something you already created or renamed successfully (no Delete/Backspace on a file or folder, no clearing text you already entered) just because a later step confused you or a subsequent check looked ambiguous — that destroys real work over a false alarm. If you truly believe an earlier step went wrong, re-read the tree first to confirm what's actually there before removing anything, and prefer fixing it in place (e.g. renaming again) over deleting and recreating.

After press_keys("cmd+a") to select existing text (e.g. to bold/resize a title before continuing to write more), don't assume press_keys("end") clears the selection before you keep typing or press return -- verified against a real sandbox that it doesn't: the text stays fully selected, and the very next return/type_text call replaces the entire selection instead of appending after it, silently destroying what you just wrote (a real, reproduced case: a bolded title disappeared entirely, replaced by a single blank line, right after "cmd+a" then "end" then "return"). To actually collapse a selection to its end before continuing, press_keys("right") (a single right-arrow press) instead -- verified to work correctly -- or click_element to place the cursor explicitly.

Calendar: don't create an event with cmd+n and then try to fix its date/time by clicking the segmented date fields or a day in the mini month grid — that widget doesn't reliably respond to clicks and won't actually move an already-created event anyway. Instead click the "+" button (or "Add Event") and use the "Create Quick Event" text field: type the whole thing as one natural-language sentence, e.g. "Trip to Bodega Bay Saturday October 3 at 10:40am", and press return — Calendar parses the title, date, and time from that itself. This is dramatically more reliable than fighting the date picker.

iWork apps (Numbers, Pages, Keynote) launching for the first time on a fresh machine show a two-screen welcome flow before anything else, verified against a real sandbox: screen 1 is a license/intro screen with a "Continue" button; clicking it leads to screen 2, a feature-tour screen whose two buttons are labeled with literal underscores instead of spaces in the accessibility tree (e.g. click_element("Create_a_Spreadsheet", role: "button") for Numbers, not "Create a Spreadsheet" -- copy the exact underscored form from what read_accessibility_tree shows). After that, the real template chooser or a blank document appears. Don't mistake this welcome flow for a broken/stuck app and start quitting and reopening the app or hunting through unrelated menus (the Fonts panel, Finder windows) -- read the tree first and look for exactly this sequence. Separately: these apps have repeatedly (not just occasionally) failed to show any usable window at all within a normal step budget on some sandboxes -- confirmed across several real runs, not a one-off. Re-read the tree a few times with pauses in between (a minute or more) before concluding something is wrong, but if there's still no window, no menu bar for the app, and nothing resembling the welcome flow above after several read/wait cycles, that's a real, known platform limitation, not something more quitting-and-reopening or menu-hunting will fix -- say so plainly rather than spending the rest of your step budget cycling the app.

Xcode's source code editor is a custom view, not a plain text field -- observed once on a real sandbox (not independently re-verified, so treat this as a caution rather than settled fact): clicking a file in the navigator to open it may not be enough to move keyboard focus into the actual code-editing area. In the observed case, cmd+a followed by typing a full replacement file landed in the window's own title/tab area instead of the editor, corrupting the window title and leaving the real file content untouched. Before selecting/typing in the code editor, click once on a piece of actual code text in the editor pane itself (not just the file in the navigator) first, and afterward re-read the tree to confirm the edit actually landed in the file's content before moving on -- don't assume it worked, and don't respond to a bad edit by deleting the project/file and starting over (see the rule above about never discarding completed work) -- undo (cmd+z) or fixing in place is safer.

Two apps have real environmental limits in this sandbox worth recognizing early rather than fighting: Mail has no email account configured and no way to add a working one without real credentials, so composing/sending is not actually achievable here -- if asked to use Mail, say so plainly rather than spending many steps on account-setup workarounds. Building and running an iOS (not macOS) app target in Xcode requires an iOS SDK/simulator that isn't installed and can't be downloaded quickly -- a macOS app target builds fine, but if an iOS target's build genuinely can't complete for this reason, that's a real, correctly-diagnosed limitation, not a sign anything else went wrong.

Filling out a PDF form Safari is displaying inline (e.g. you navigated straight to a .pdf URL -- it doesn't auto-download like a normal file): this is a short, exact sequence, verified step by step against a real sandbox -- follow it directly rather than exploring alternatives, which are all dead ends for this first save (the File menu, cmd+p/Print, cmd+shift+s, checking Downloads instead of Documents, and pressing cmd+s more than once all lead nowhere and just waste steps here in Safari).
  1. press_keys("cmd+s") -- exactly once. A real Save sheet appears with the filename pre-filled and a Save button.
  2. click_element("Save", role: "button") -- saves it to Documents with the default filename. Don't type a new filename unless you actually need to; don't press cmd+s again.
  3. open_app the app you need for filling it in (e.g. Preview). Its response will very likely say it's "frontmost but showing no window" -- that's normal and expected here, not a problem: unlike TextEdit, Preview doesn't create a blank document on launch, so it has nothing to show until you open a file. Don't read that note as something being broken; go straight to the next step.
  4. press_keys("cmd+o") to open its file picker, then click_element("Documents") in the sidebar. If no file picker appears in the very next screen, it's a one-off timing miss, not a sign the app is broken -- press_keys("cmd+o") again (or click_element("File") then click_element("Open…")) before considering anything else; this reliably works within a try or two.
  5. click_element on the exact filename you saved (e.g. "fw9.pdf") in the file list, then click_element("Open", role: "button").
  6. Immediately close Safari's original copy (open_app("Safari"), then press_keys("cmd+w")) before filling in anything. Skipping this is a real, observed failure mode: Safari's inline PDF and the new Preview window both stay open showing the identical-looking form with identically-labeled empty fields, and click_element/type_text calls that don't pin down "app" can silently land in whichever copy happens to match first -- ending up with some fields filled in Safari and others in Preview, neither one complete. With only one copy left open, every subsequent click has one obvious target and this can't happen.
Now fill in the fields, in the order given. When a form has many fields that all share one identical accessibility label (e.g. "(empty text field)"), use click_element's nearLabel option, not index and not Tab-counting: pass label: "(empty text field)" plus nearLabel set to the real, stable text printed right next to the field you actually want (e.g. nearLabel: "5 Address" for the Address line, copied from what read_accessibility_tree shows near it). This picks whichever match sits geometrically closest to that anchor text -- a field's on-screen position never changes regardless of what's already been filled in or clicked elsewhere, which is exactly what makes both index (the index for still-empty fields shifts every time you fill one in) and Tab-counting (order doesn't always match the visual layout, and a checkbox click can drop focus entirely mid-sequence) unreliable for this. After every type_text, check the result before moving on: if verified is false, the text didn't actually land anywhere -- click_element the field again (same nearLabel) and retry rather than assuming it worked or reporting the field as filled. For a checkbox or radio button specifically: these are typically NOT reachable by Tab at all in these PDF forms and rarely have a more useful anchor than their own printed label, so click_element on the checkbox's own label directly; if the result reports "ok" but re-reading the tree shows nothing actually changed (common in Preview -- the widget itself often has no accessible element of its own, only its plain, disabled text description does), retry the exact same click_element call but add clickOffsetLeftPx: 10 -- that clicks the real glyph just to the label's left instead of the inert text, which does toggle it. Verify every field (text and checkboxes alike) actually shows the right value/state on screen before moving to the next one -- a checkbox click also drops keyboard focus out of whatever text field you were in before it, so always click_element back into your next target explicitly rather than assuming focus carried over.
If asked to save a copy under a new name (e.g. "save to the Desktop as X.pdf"), use exactly this sequence in Preview -- verified against a real sandbox; other paths (File > Export, a single cmd+shift+s treated as "Save As") don't work here. This step leaves several windows from the same app open at once (the original, the duplicate, sometimes a stray extra window too) -- read_accessibility_tree marks exactly one window per app "frontmost": true when there's more than one, so check that field rather than guessing which window a click will land in or closing windows to "clean up" a state you're not sure about:
  7. press_keys("cmd+shift+s") -- in Preview this is actually "Duplicate", not "Save As": it opens a new untitled window with a copy of the document (e.g. titled "fw9 copy"). That's expected; continue.
  8. press_keys("cmd+s") on that duplicate -- this is what actually opens a real save-with-name sheet (titled "Save"), with a "Where:" field and a filename field.
  9. click_element("Where:", role: "pop up button"), then click_element("Desktop") in the menu that opens.
  10. click_element the filename field (it shows the duplicate's default name, e.g. "fw9 copy"), then press_keys("cmd+a") and type_text the exact new filename you were asked for.
  11. click_element("Save", role: "button").

Keep going, one step at a time, until the instruction is FULLY done — including any final step like actually running or saving. Do not stop after setup or assume a later step worked; look at each action's returned screen to verify it. Only when it's genuinely complete, reply with one short sentence describing what you did. If you truly cannot proceed (an app won't launch, a required control never appears after looking again), say so plainly and explain exactly where you got stuck — never claim success you didn't verify.

When a task asks you to look up a specific fact or value (a price, a measurement, a date, search results), only report a number or fact you actually saw appear in a tool result's "screen" or a read_accessibility_tree call — never fill in a plausible-looking value from your own general knowledge when the real UI didn't show it to you, even if a screen is being slow to load or an app's window won't appear. If you can't actually get the real data after reasonable attempts, say so plainly instead of writing down a guess as if it were the observed answer.`;

/**
 * The tools the model can call, each bound to a per-request `SandboxRef`. A tool call that hits a
 * "gone" sandbox (timed out mid-turn) transparently gets a fresh one via `withSandbox`; every
 * `AgentEvent` streamAgent() yields after this carries `toDescriptor(ref.current)`, so a rotation
 * here shows up in the very next event without any separate notification path.
 */
function makeTools(ref: SandboxRef) {
  const run = <T,>(fn: (sandbox: SandboxHandle) => Promise<T>) => withSandbox(ref, fn);
  return {
    read_accessibility_tree: tool({
      description:
        "Get a pruned JSON summary of what's currently on screen: running apps, the frontmost app's menu-bar menus, and each on-screen window (including dialogs and sheets, with its role and title) with its elements by role and label. Pass an element's label to click_element. A `note` may flag an app that's frontmost with no window.",
      inputSchema: z.object({
        summary: z
          .string()
          .describe(
            'A short present-tense description of what you\'re checking, shown live to the user, e.g. "Checking what\'s on screen".',
          ),
      }),
      execute: () => run((s) => uiTreeSummary(s)),
    }),
    click_element: tool({
      description:
        'Click an on-screen element (button, menu item, tab, checkbox, table cell, template icon, or a menu-bar menu like "File"/"Product") by its label. It finds the element in the live UI tree and clicks its center, so it works for standard and SwiftUI apps alike. Copy the exact label from read_accessibility_tree. Returns { status }: "ok", "not-found", "ambiguous" (with a candidates list — retry passing index or nearLabel), or "error". To use a menu, click the menu name to open it, read the tree, then click the item. If clicking a checkbox/radio-button\'s own label reports "ok" but a follow-up read shows it never actually toggled, it likely isn\'t a real interactive element -- see clickOffsetLeftPx.',
      inputSchema: z.object({
        summary: z.string().describe('Short present-tense description, e.g. "Clicking the Save button".'),
        label: z.string().describe("The element's visible label/name/text, as shown in the tree."),
        role: z.string().optional().describe('Element role to disambiguate, e.g. "button", "menu item". Optional.'),
        app: z.string().optional().describe("Restrict to this app's windows. Optional."),
        index: z.number().int().optional().describe("1-based choice among candidates after an ambiguous result."),
        nearLabel: z
          .string()
          .optional()
          .describe(
            'Prefer this over index for a form with many fields sharing one generic label (e.g. a PDF\'s "(empty text field)"). Instead of "the Nth still-empty field" -- which points at a different physical field every time an earlier one gets filled in, a real, repeated source of wrong-field typing -- this picks whichever ambiguous match is geometrically closest to another, stable label already on screen (e.g. nearLabel: "5 Address" for the field next to that printed text). A field\'s position never moves regardless of fill state, so this stays correct across the whole form-filling sequence. If nearLabel itself doesn\'t resolve to exactly one element, that error names the anchor -- fix that string, not the original label.',
          ),
        clickOffsetLeftPx: z
          .number()
          .int()
          .optional()
          .describe(
            "For a PDF form checkbox/radio button rendered by Preview whose glyph has no accessible element of its own (only its plain-text description does, e.g. label \"Individual/sole proprietor\" with role \"text\"): instead of clicking that text (which reports \"ok\" but never toggles the box), click this many pixels to the LEFT of the text's own left edge, vertically centered on it -- that's where the actual clickable glyph is. 10 is a good default, verified against a real W-9 form. Only use this when a plain click on the label itself demonstrably didn't toggle anything.",
          ),
      }),
      execute: ({ app, role, label, index, nearLabel, clickOffsetLeftPx }) => run((s) => clickElement(s, { app, role, label, index, nearLabel, clickOffsetLeftPx })),
    }),
    type_text: tool({
      description:
        'Type text into the control that currently has keyboard focus. Click the field with click_element first to focus it. Uses real keystrokes, typed exactly as given -- no newline is added before or after. To put separate pieces on their own lines (e.g. a title then a list of items), put them in ONE type_text call with "\\n" between them; two separate type_text calls land on the same line back-to-back with nothing in between. The result includes verified: false (with a message) if the typed text doesn\'t actually appear in any on-screen field\'s value afterward -- a real signal something went wrong (lost focus, landed on a non-text control), not just the keystrokes-were-sent status. Don\'t report a field as filled unless verified is absent/true.',
      inputSchema: z.object({
        summary: z.string().describe('Short present-tense description, e.g. "Entering the project name".'),
        text: z.string().describe("The text to type."),
      }),
      execute: ({ text }) => run((s) => typeText(s, text)),
    }),
    press_keys: tool({
      description:
        'Press a key or keyboard shortcut, e.g. "return", "escape", "tab", "cmd+shift+n" (new project in Xcode), "cmd+r" (run), "cmd+s" (save), "cmd+a" (select all). Use for shortcuts and for confirming/dismissing dialogs.',
      inputSchema: z.object({
        summary: z.string().describe('Short present-tense description, e.g. "Running the project".'),
        keys: z.string().describe('The key or combo, e.g. "return" or "cmd+shift+n".'),
      }),
      execute: ({ keys }) => run((s) => pressKeys(s, keys)),
    }),
    open_app: tool({
      description:
        "Launch or focus an app and wait until it presents a window, then return what's on screen (same JSON as read_accessibility_tree). Use this to open an app instead of run_applescript + a guessed delay. If the app ends up frontmost with no window (still launching, or a dialog is blocking it), the result's note says so and any dialog appears in windows — read it and act, don't assume the app is ready.",
      inputSchema: z.object({
        summary: z.string().describe('Short present-tense description, e.g. "Opening Xcode".'),
        app: z.string().describe('The app to open, e.g. "Xcode", "Safari", "TextEdit".'),
      }),
      execute: ({ app }) => run((s) => openApp(s, app)),
    }),
  };
}

/**
 * `tools/agent-run.ts` only: `openrouter:...` selectors go through OpenRouter (still the AI SDK,
 * just a different provider package -- `@openrouter/ai-sdk-provider`) instead of Anthropic direct.
 * Built fresh per call rather than once at module scope, so importing this module never requires
 * OPENROUTER_API_KEY to be set -- only actually selecting an openrouter: model does (the web app
 * and default haiku/sonnet/opus usage never touch this branch at all).
 */
function resolveLanguageModel(selector: ModelSelector) {
  if (isOpenRouterSelector(selector)) {
    const openrouterProvider = createOpenRouter({ apiKey: requireEnv("OPENROUTER_API_KEY") });
    return openrouterProvider(openRouterModelId(selector));
  }
  return anthropic(MODEL_IDS[selector]);
}

/**
 * `AGENT_SYSTEM_PROMPT` plus the actual current date/time, computed fresh per request rather than
 * baked into the static prompt (which would go stale immediately). Added after a real run needed
 * "today's date" for a task and had no way to get it: the menu bar clock visible in every
 * screenshot shows the day of week and time but never the year, so the model fell back on its own
 * training-data guess and wrote the wrong year into a document (2025, a full year off the sandbox's
 * actual 2026) with no way to have known better from anything on screen. `now` is injectable for
 * tests; defaults to the real current time.
 */
export function buildSystemPrompt(now: Date = new Date()): string {
  return `${AGENT_SYSTEM_PROMPT}\n\nToday's date is ${now.toDateString()}, current time ${now.toTimeString().slice(0, 8)}. Use this for anything date/time-related (e.g. "today", "tomorrow", "this Saturday") instead of guessing -- what's on screen (like a menu-bar clock) often won't show the year.`;
}

/**
 * Shared request options for both the buffered (generateText) and streaming (streamText) paths.
 *
 * Opus's safety classifier declines "automate this Mac" prompts under the cyber category, so an
 * Opus request opts into Anthropic's server-side fallback routing (a decline is re-run on the
 * recommended fallback model within the same call) via the beta header and provider option.
 */
export function agentRequest(messages: ModelMessage[], modelChoice: ModelSelector, tools: ReturnType<typeof makeTools>, maxSteps: number) {
  return {
    model: resolveLanguageModel(modelChoice),
    system: buildSystemPrompt(),
    messages,
    tools,
    stopWhen: stepCountIs(maxSteps),
    ...(modelChoice === "opus"
      ? {
          headers: { "anthropic-beta": "server-side-fallback-2026-07-01" },
          providerOptions: { anthropic: { fallbacks: "default" } },
        }
      : {}),
  };
}

export type ToolName =
  | "read_accessibility_tree"
  | "open_app"
  | "click_element"
  | "type_text"
  | "press_keys";

/** Request-scoped input for streamAgent — no server-held singletons. */
export interface AgentTurnInput {
  prompt: string;
  modelChoice: ModelSelector;
  /** The sandbox this turn acts on; may be swapped in place if it times out mid-turn. */
  sandboxRef: SandboxRef;
  /** The prior conversation, supplied by the caller (the client, in this stateless design). Never mutated. */
  history: ModelMessage[];
  /** Aborts the model call (Stop button / client disconnect). */
  signal?: AbortSignal;
  /** Overrides MAX_AGENT_STEPS for this turn only -- e.g. `tools/agent-run.ts` raising the budget
   * for a deliberately long, multi-app headless demo. The web app never sets this, so its behavior
   * is unchanged. */
  maxSteps?: number;
}

/**
 * One event in the live agent stream, mapped from the AI SDK's fullStream parts. Every variant
 * carries `sandbox`: the descriptor of whatever handle `sandboxRef.current` points to *right now*,
 * not just on a rotation. This used to be a dedicated `{t:"sandbox"}` event emitted only when a
 * tool call found its sandbox gone and recreated it -- but the route resolves/creates a sandbox
 * before streamAgent even starts, so a turn that made no tool calls at all (a plain "hi") had no
 * event to carry that initial sandbox back to the client, which then kept resending a stale/empty
 * descriptor and silently created a fresh sandbox on every later turn too. Putting `sandbox` on
 * every event closes that gap by construction: there's no event type a client can forget to sync
 * from, and no separate rotation-tracking machinery needed here to get the ordering right --
 * whatever `sandboxRef.current` is *at yield time* is correct by definition.
 */
export type AgentEvent =
  | { t: "tool-call"; id: string; tool: ToolName; input: unknown; sandbox: SandboxDescriptor }
  | { t: "tool-result"; id: string; output: unknown; sandbox: SandboxDescriptor }
  | { t: "tool-error"; id: string; error: string; sandbox: SandboxDescriptor }
  | { t: "text"; text: string; sandbox: SandboxDescriptor }
  | { t: "error"; error: string; sandbox: SandboxDescriptor }
  /** `history` is the full updated conversation on a clean finish, or the caller's original
   *  `input.history` unchanged if the turn was aborted/errored before finishing cleanly.
   *  `usage` is the AI SDK's own total across every internal step of this turn (it sums step
   *  usages for you -- verified against the installed package's own type declarations, not
   *  assumed), so it's accurate even though one `streamText()` call here can drive many tool-use
   *  steps. Undefined if the turn threw before `streamText()` produced a result at all. */
  | { t: "done"; history: ModelMessage[]; sandbox: SandboxDescriptor; usage?: LanguageModelUsage };

/**
 * Run the agent and yield events as they happen (tool calls, tool results, streamed reply
 * text), so the UI can render the turn in real time. Errors surface as an "error" event rather
 * than throwing, since the HTTP response has already begun streaming by the time they occur.
 *
 * `signal`, when aborted (the user hit Stop / the client disconnected), stops the model from
 * taking further steps. The turn's messages are only folded into the returned `history` on a
 * clean finish, so an interrupted or failed turn doesn't leave a dangling user message or a tool
 * call with no result.
 */
export async function* streamAgent(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
  const { prompt, modelChoice, sandboxRef, history, signal, maxSteps = MAX_AGENT_STEPS } = input;
  const messages: ModelMessage[] = [...history, { role: "user", content: prompt }];
  const tools = makeTools(sandboxRef);
  // Read fresh at each yield, not cached: this is what makes every event carry the *current*
  // sandbox with no explicit rotation-tracking -- if a tool's execute() just swapped
  // sandboxRef.current, the very next line reads the new one.
  const sandbox = () => toDescriptor(sandboxRef.current);

  let clean = true;
  let finalHistory = history;
  let usage: LanguageModelUsage | undefined;
  try {
    const result = streamText({ ...agentRequest(messages, modelChoice, tools, maxSteps), abortSignal: signal });
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "tool-call":
          yield { t: "tool-call", id: part.toolCallId, tool: part.toolName as ToolName, input: part.input, sandbox: sandbox() };
          break;
        case "tool-result":
          yield { t: "tool-result", id: part.toolCallId, output: part.output, sandbox: sandbox() };
          break;
        case "tool-error":
          yield { t: "tool-error", id: part.toolCallId, error: String(part.error), sandbox: sandbox() };
          break;
        case "text-delta":
          if (part.text) yield { t: "text", text: part.text, sandbox: sandbox() };
          break;
        case "abort":
          clean = false;
          break;
        case "error":
          clean = false;
          yield { t: "error", error: String(part.error), sandbox: sandbox() };
          break;
      }
    }
    if (clean) {
      const responseMessages = await result.responseMessages;
      finalHistory = [...messages, ...responseMessages];
    }
    // Read regardless of `clean`: an aborted/errored-but-not-thrown turn still consumed (and
    // costs) tokens, worth recording even though history isn't updated in that case.
    try {
      usage = await result.usage;
    } catch {
      usage = undefined;
    }
  } catch (err) {
    // An aborted stream throws AbortError — expected when the user hits Stop, not a real error.
    const aborted = signal?.aborted || (err instanceof Error && err.name === "AbortError");
    if (!aborted) yield { t: "error", error: err instanceof Error ? err.message : String(err), sandbox: sandbox() };
  }
  yield { t: "done", history: finalHistory, sandbox: sandbox(), usage };
}
