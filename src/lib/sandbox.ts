import { Computer, type ExecResult, type MacOSSandbox } from "use-computer-sdk";
import { requireEnv } from "./env";
import type { SandboxHandle } from "./sandbox-handle";

export const SCRIPT_PATH = "/tmp/macos-computer-use.applescript";
const DEFAULT_BASE_URL = "https://api.use.computer";

export interface ScreenshotOptions {
  /** JPEG quality 1-100. Default 80 (~100 KB at 1920x1080). */
  quality?: number;
  /** Downscale factor, e.g. 0.5 for half size. */
  scale?: number;
}

/**
 * Create a macOS sandbox on the already-reserved Mac.
 * Reads USE_COMPUTER_API_KEY and USE_COMPUTER_RESERVATION_ID; never reserves.
 * Call dismissScreenRecordingPrompt() on the result before driving the GUI.
 */
export async function createSandboxFromEnv(): Promise<MacOSSandbox> {
  const apiKey = requireEnv("USE_COMPUTER_API_KEY");
  const reservationId = requireEnv("USE_COMPUTER_RESERVATION_ID");
  const computer = new Computer({ apiKey });
  return computer.create({ type: "macos", reservationId });
}

/**
 * Every fresh sandbox shows a macOS prompt ("bash" is requesting to bypass the system
 * private window picker...) owned by UserNotificationCenter, mid-screen. While it is up,
 * apps launched by AppleScript `activate` stay hidden and never become frontmost,
 * System Events keystrokes go to Finder, and the prompt lands in every screenshot.
 * Clicking its Allow button through System Events fixes all of that for the life of
 * the sandbox. Returns true when a prompt was dismissed, false when there was none.
 */
export const DISMISS_PROMPT_SCRIPT = `
tell application "System Events"
  if not (exists process "UserNotificationCenter") then return "absent"
  tell process "UserNotificationCenter"
    if (count of windows) is 0 then return "absent"
    if not (exists button "Allow" of window 1) then return "absent"
    click button "Allow" of window 1
  end tell
end tell
return "dismissed"
`;

export async function dismissScreenRecordingPrompt(sandbox: MacOSSandbox): Promise<boolean> {
  const result = await sandbox.execSsh(`osascript -e '${DISMISS_PROMPT_SCRIPT.trim()}'`);
  if (result.exitCode !== 0) throw new Error(`Dismissing the screen-recording prompt failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim() === "dismissed";
}

/** Upload an AppleScript block to the sandbox and run it with osascript. */
export async function runAppleScript(sandbox: SandboxHandle, script: string): Promise<ExecResult> {
  await sandbox.upload(new TextEncoder().encode(script), SCRIPT_PATH);
  return sandbox.execSsh(`osascript ${SCRIPT_PATH}`);
}

export interface SystemInfo {
  product: string;
  version: string;
  build: string;
  hostname: string;
  arch: string;
  model: string;
  cpus: string;
  memBytes: string;
  uptime: string;
}

/** One line per field, `key=value`, so the reply is trivial to parse even over a single SSH round trip. */
const SYSTEM_INFO_SCRIPT = [
  'echo "product=$(sw_vers -productName)"',
  'echo "version=$(sw_vers -productVersion)"',
  'echo "build=$(sw_vers -buildVersion)"',
  'echo "hostname=$(hostname)"',
  'echo "arch=$(uname -m)"',
  'echo "model=$(sysctl -n hw.model)"',
  'echo "cpus=$(sysctl -n hw.ncpu)"',
  'echo "memBytes=$(sysctl -n hw.memsize)"',
  "echo \"uptime=$(uptime | sed 's/^ *//')\"",
].join("\n");

/** Standard system info (macOS version, model, CPU/memory, hostname, uptime) via `sw_vers`/`sysctl`/`uptime` over SSH. */
export async function systemInfo(sandbox: SandboxHandle): Promise<SystemInfo> {
  const result = await sandbox.execSsh(SYSTEM_INFO_SCRIPT);
  if (result.exitCode !== 0) throw new Error(`Reading system info failed: ${result.stderr || result.stdout}`);
  const fields: Record<string, string> = {};
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const i = trimmed.indexOf("=");
    if (i === -1) continue;
    fields[trimmed.slice(0, i)] = trimmed.slice(i + 1);
  }
  return {
    product: fields.product ?? "",
    version: fields.version ?? "",
    build: fields.build ?? "",
    hostname: fields.hostname ?? "",
    arch: fields.arch ?? "",
    model: fields.model ?? "",
    cpus: fields.cpus ?? "",
    memBytes: fields.memBytes ?? "",
    uptime: fields.uptime ?? "",
  };
}

interface UiElementNode {
  name?: string | null;
  role?: string;
  description?: string | null;
  role_description?: string;
  value?: unknown;
  enabled?: boolean;
  /** Absolute screen rectangle [x1, y1, x2, y2] in pixels, when the node is on screen. */
  bbox?: number[];
  visible_bbox?: number[];
  children?: UiElementNode[];
}

interface UiWindowNode {
  name?: string | null;
  owner: string;
  role: string;
  is_on_screen?: boolean;
  /** The window's own on-screen rectangle. Used to filter a deeply-nested web page's accessibility
   * tree down to roughly what's actually visible right now -- see pruneElement()'s viewport param. */
  bounds?: { x: number; y: number; width: number; height: number };
  children?: UiElementNode[];
}

interface UiMenubarItem {
  title?: string | null;
  bounds?: { x: number; y: number; width: number; height: number };
}

interface UiTreeResponse {
  applications?: Array<{ info: { name: string; active: boolean }; windows: unknown[] }>;
  windows?: UiWindowNode[];
  menubar_items?: UiMenubarItem[];
}

interface PrunedElement {
  role: string;
  label?: string;
  enabled?: false;
  children?: PrunedElement[];
}

/**
 * Background OS chrome, not app windows a user would ask about. Observed empirically: Notification
 * Center's own panels (widgets like "Tips"/weather, shown even when nothing is actually open) can
 * dwarf the one window that matters in the char budget — e.g. one real Finder window vs. a widget
 * tree of unrelated marketing copy. Dock/Control Center windows are similarly irrelevant chrome.
 */
const SYSTEM_CHROME_OWNERS = new Set(["Notification Center", "Control Center", "Dock", "Window Server"]);

type Rect = { x: number; y: number; width: number; height: number };

/** Whether a [x1,y1,x2,y2] box has positive area and overlaps `viewport` at all. `undefined` bbox
 * (common for structural wrappers with no geometry of their own) is treated as "can't tell, don't
 * filter it out" -- only a box that's actually somewhere else on screen gets excluded. */
function intersectsViewport(bbox: number[] | undefined, viewport: Rect | undefined): boolean {
  if (!viewport || !Array.isArray(bbox) || bbox.length !== 4) return true;
  const [x1, y1, x2, y2] = bbox;
  if (!(x2 > x1 && y2 > y1)) return false; // zero/negative area -- collapsed or hidden
  return x1 < viewport.x + viewport.width && x2 > viewport.x && y1 < viewport.y + viewport.height && y2 > viewport.y;
}

/** Whether a [x1,y1,x2,y2] box sits entirely within `rect` (a few px of slop for rounding). Used
 * only to sanity-check a window's own `bounds` against its direct children's *raw* geometry -- see
 * reliableViewport()'s modal-sheet case, where a child can legitimately render outside the bounds
 * its nominal parent window reports. */
function isFullyContained(bbox: number[], rect: Rect, slop = 2): boolean {
  const [x1, y1, x2, y2] = bbox;
  return x1 >= rect.x - slop && y1 >= rect.y - slop && x2 <= rect.x + rect.width + slop && y2 <= rect.y + rect.height + slop;
}

/**
 * A window's own `bounds` is usually a trustworthy viewport (verified against a real Safari
 * window), but not always:
 *
 * - Finder's Desktop icon layer reports itself as a ~window~ whose `bounds` is a tiny sliver (e.g.
 *   88x21 px, evidently some incidental UI detail's rect, not the desktop's own area) while its
 *   actual child content spans the full screen -- verified against a real sandbox right after
 *   creating a desktop folder. Filtering that child against the reported 88x21 rect would make the
 *   new folder's own icon (and its in-progress rename field) vanish from the tree entirely, right
 *   when the model most needs to see it.
 * - A modal sheet (e.g. TextEdit's Save panel) is reported as nested *inside* its owning document
 *   window's children, but can render wider than that window and centered differently -- verified
 *   against a real sandbox: a Save sheet's own raw bbox was `[75, 145, 955, 593]` while the document
 *   window underneath it claimed bounds of only `[213, 77, +603, +505]` (i.e. x 213-816). Filtering
 *   the sheet's own children (its whole location sidebar -- Desktop, Documents, ...) against the
 *   *document window's* bounds clipped out everything left of x=213, which silently deleted the
 *   entire sidebar's labels from the tree (the one control needed to actually choose a save
 *   location). Note this must be checked against the child's raw `bbox`, not `visible_bbox`: macOS
 *   itself already clipped the sheet's own `visible_bbox` to match the window, which is exactly the
 *   deceptive value that would hide this case if used here.
 *
 * Either way, skip filtering for that window rather than risk hiding real on-screen content because
 * of one untrustworthy rectangle.
 */
function reliableViewport(w: UiWindowNode): Rect | undefined {
  const b = w.bounds;
  if (!b || b.width <= 0 || b.height <= 0) return undefined;
  const windowArea = b.width * b.height;
  if (windowArea < 10_000) return undefined; // smaller than ~100x100 -- not plausible as a real content viewport
  for (const c of w.children ?? []) {
    const rawBox = c.bbox;
    if (Array.isArray(rawBox) && rawBox.length === 4 && !isFullyContained(rawBox, b)) {
      return undefined; // a direct child (e.g. a modal sheet) isn't fully contained by its own window
    }
    const cb = c.visible_bbox ?? c.bbox;
    if (!Array.isArray(cb) || cb.length !== 4) continue;
    const childArea = Math.max(0, cb[2] - cb[0]) * Math.max(0, cb[3] - cb[1]);
    if (childArea > windowArea * 4) return undefined; // a direct child far bigger than its own window
  }
  return b;
}

/**
 * role/label/children only — drops ids, geometry, and structural wrappers with nothing in them.
 *
 * `viewport`, when given, additionally drops a node's *label* (treating it the same as having no
 * label at all) if its own bbox is off-screen -- verified against a real, loaded Wikipedia page:
 * without this, a rendered web page's actual paragraph text sits 15-18 levels deep in nested
 * generic groups, so reaching it at all needs a much deeper walk than any native app dialog ever
 * does, and a deep walk with no visibility filter blows the char budget on off-screen/scrolled-past
 * content before ever reaching what's actually on screen (measured on that same page: only ~250 of
 * ~7000 real-content nodes were actually within the window's bounds). Still recurses into an
 * off-screen node's children regardless, since a container's own bbox being stale/off doesn't mean
 * its children are.
 */
function pruneElement(node: UiElementNode, depth: number, maxDepth: number, viewport?: Rect): PrunedElement | null {
  const visible = intersectsViewport(node.visible_bbox ?? node.bbox, viewport);
  const label = visible ? nodeLabel(node) : undefined;
  const children =
    depth < maxDepth && Array.isArray(node.children)
      ? node.children.map((c) => pruneElement(c, depth + 1, maxDepth, viewport)).filter((c): c is PrunedElement => c !== null)
      : [];
  if (!label && children.length === 0) return null;
  const pruned: PrunedElement = { role: node.role_description || node.role || "element" };
  if (label) pruned.label = label;
  if (node.enabled === false) pruned.enabled = false;
  if (children.length) pruned.children = children;
  return pruned;
}

/**
 * Puts any modal element (a "sheet", the role macOS gives a Save/Open panel or similar) first in
 * a window's element list, ahead of the window's ordinary content.
 *
 * Regression, verified against a real sandbox and a real agent run: a Save sheet opened over a
 * long, already-loaded document (an IRS PDF form, in this case) genuinely does appear in the raw
 * tree as a normal sibling element -- but sitting *after* the document's own content in that
 * array. summarizeTree()'s char cap (see maxChars below) then truncates the JSON before ever
 * reaching it, so the model's read_accessibility_tree call came back with no trace of the sheet it
 * had just opened -- not because anything failed to expose it, but because 24000 characters of the
 * host document's own text came first and used up the entire budget. The agent then spent 30+
 * steps hunting through menus for a dialog that was real and on screen the whole time, just
 * invisible to it. A modal sheet is always exactly what a "what's on screen right now" read most
 * needs to see, so it's worth guaranteeing it survives the cap regardless of how much ordinary
 * content precedes it.
 */
function sortModalFirst(elements: PrunedElement[]): PrunedElement[] {
  const isModal = (e: PrunedElement) => normRole(e.role).includes("sheet");
  const modals = elements.filter(isModal);
  if (!modals.length) return elements;
  return [...modals, ...elements.filter((e) => !isModal(e))];
}

export interface UiSummaryOptions {
  /** Hard cap on the returned JSON string's length. A full tree can run to hundreds of KB. */
  maxChars?: number;
  /** How many levels deep to walk each window's element tree. Deep by default (native app dialogs
   * rarely nest past 6-8 levels, but a rendered web page's real text routinely sits 15-18 levels
   * deep in nested generic groups -- verified against a real loaded Wikipedia page) since the
   * viewport filter above is what actually keeps the output small, not this. */
  maxDepth?: number;
}

/**
 * Cuts a JSON string down to (approximately) `maxChars`, without ever cutting in the middle of a
 * string literal.
 *
 * Regression, verified against a real agent run: the naive version of this (a plain
 * `json.slice(0, maxChars)` with a human-readable suffix glued directly onto it) routinely lands
 * mid-string on a large document (a long IRS PDF form, in this case) -- producing something like
 * `..."label":"Jordan Riv…(truncated, 23426 chars total)`, i.e. text that reads exactly like a
 * real (very oddly-named) element label, glued right onto a real one with no separator. The model
 * took that bait twice in the same run, calling click_element with the literal label
 * `"(23426 chars total)"` -- the truncation marker itself, mistaken for something real on screen.
 * Scanning for string boundaries (toggling on every unescaped `"`) and only cutting once we're
 * back outside a string avoids ever producing that shape again; a newline before the marker also
 * keeps it visually and structurally distinct from any preceding JSON value.
 */
function truncateJsonSafely(json: string, maxChars: number): string {
  let inString = false;
  let cut = maxChars;
  for (let i = 0; i < maxChars; i++) {
    if (json[i] === '"' && json[i - 1] !== "\\") inString = !inString;
  }
  if (inString) {
    // Still inside a string at the cap -- extend forward to that string's closing quote (or to
    // the end of the JSON, if the string itself is what's enormous) rather than slicing through it.
    cut = json.indexOf('"', maxChars);
    if (cut === -1) cut = json.length;
    else cut += 1; // include the closing quote itself
  }
  return `${json.slice(0, cut)}\n…(truncated, ${json.length} chars total)`;
}

/**
 * Turn a raw uiTree() dump into a compact JSON summary of what's on screen — running/frontmost
 * apps, and per on-screen window (including dialogs, sheets and alerts, each with its role) a
 * pruned accessibility tree. Only obvious OS chrome is dropped, so a blocking dialog is never
 * hidden. If an app is frontmost but shows no window, that is called out explicitly, since that
 * "active but nothing to act on" state (e.g. an app still launching) is otherwise invisible.
 */
function summarizeTree(raw: UiTreeResponse, opts: UiSummaryOptions = {}): string {
  // 7000 was sized for compact native-app dialogs; a real, fully-loaded web page's single viewport
  // -- verified against a live Wikipedia page, post-viewport-filtering -- still runs to ~20000
  // chars once real article content is included, so this needs real headroom above that or every
  // web-reading task truncates before reaching the text it was asked to read.
  const maxChars = opts.maxChars ?? 24000;
  const maxDepth = opts.maxDepth ?? 24;

  const apps = (raw.applications ?? [])
    .filter((a) => a.info.active || a.windows.length > 0)
    .map((a) => ({ name: a.info.name, active: a.info.active }));

  // The frontmost app's menu-bar menus (Apple, File, Edit, …) so the model knows what it can open.
  const menus = (raw.menubar_items ?? []).map((m) => m.title).filter((t): t is string => !!t);

  // Every on-screen window that isn't OS chrome — dialogs and sheets included, and blank/not-yet-
  // rendered windows too (an empty window of the frontmost app is itself a useful signal).
  const windows = (raw.windows ?? [])
    .filter((w) => w.is_on_screen && !SYSTEM_CHROME_OWNERS.has(w.owner))
    .map((w) => ({
      app: w.owner,
      role: w.role,
      title: w.name || undefined,
      elements: sortModalFirst(
        (w.children ?? []).map((c) => pruneElement(c, 0, maxDepth, reliableViewport(w))).filter((c): c is PrunedElement => c !== null),
      ),
    }));

  const shownOwners = new Set(windows.map((w) => w.app));
  const noWindow = (raw.applications ?? [])
    .filter((a) => a.info.active && !shownOwners.has(a.info.name) && !SYSTEM_CHROME_OWNERS.has(a.info.name))
    .map((a) => a.info.name);
  const note = noWindow.length
    ? `${noWindow.join(", ")} frontmost but showing no window (still launching, or a dialog may be blocking it).`
    : undefined;

  // note first so this key diagnostic survives the char cap even when windows is large.
  const json = JSON.stringify({ note, apps, menus, windows });
  return json.length > maxChars ? truncateJsonSafely(json, maxChars) : json;
}

/**
 * Compact JSON summary of what's on screen — meant to be read by the agent before it acts.
 * `sandbox.uiTree()` itself is an untyped, unbounded dump of the native macOS accessibility tree
 * (routinely tens of KB even for an idle desktop), so this always prunes and hard-caps the result.
 */
export async function uiTreeSummary(sandbox: SandboxHandle, opts: UiSummaryOptions = {}): Promise<string> {
  return summarizeTree((await sandbox.uiTree()) as UiTreeResponse, opts);
}

/** True once the named app owns an on-screen (non-chrome) window that has rendered some content. */
function appHasWindow(raw: UiTreeResponse, app: string): boolean {
  const appLc = app.toLowerCase();
  return (raw.windows ?? []).some(
    (w) =>
      w.is_on_screen &&
      !SYSTEM_CHROME_OWNERS.has(w.owner) &&
      (w.owner ?? "").toLowerCase().includes(appLc) &&
      Array.isArray(w.children) &&
      w.children.length > 0,
  );
}

/**
 * Launch or focus an app and wait until it actually presents a rendered window, then return the
 * on-screen summary (same shape as uiTreeSummary). This replaces the brittle "activate then guess
 * a delay" pattern: if the app never shows a usable window within the timeout, the returned
 * summary's `note` says it's frontmost with nothing on screen (and any blank window or blocking
 * dialog appears in `windows`), so the caller can react instead of acting on nothing.
 *
 * `activate`'s own exit code is checked first and surfaced as a `note` too, distinctly from a slow
 * launch: verified against a real sandbox that `tell application "iOS Simulator" to activate` (a
 * name a model can very plausibly guess -- the actual app is just called "Simulator") fails
 * immediately with a real AppleScript error ("Can't get application ‘iOS Simulator’"), which this
 * function used to silently swallow and then poll for a window that could never appear -- making a
 * flat-out wrong app name look identical to one that's just slow to launch, until the timeout
 * expired with no explanation either way.
 */
export async function openApp(sandbox: SandboxHandle, app: string, timeoutSeconds = 15): Promise<string> {
  const activation = await runAppleScript(sandbox, `tell application "${escapeAppleScript(app)}" to activate`);
  if (activation.exitCode !== 0) {
    const detail = (activation.stderr || activation.stdout).trim() || `exit code ${activation.exitCode}`;
    const parsed = JSON.parse(summarizeTree((await sandbox.uiTree()) as UiTreeResponse)) as { note?: string };
    const activationNote = `"${app}" could not be activated (this is not just a slow launch) -- macOS reported: ${detail}. Double-check the exact app name and try again.`;
    parsed.note = parsed.note ? `${activationNote} ${parsed.note}` : activationNote;
    return JSON.stringify(parsed);
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  let raw = (await sandbox.uiTree()) as UiTreeResponse;
  while (!appHasWindow(raw, app) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    raw = (await sandbox.uiTree()) as UiTreeResponse;
  }
  return summarizeTree(raw);
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function escapeAppleScript(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

export interface UiClickOptions {
  /** Restrict to windows owned by this app (the window's `app` in the tree). Optional. */
  app?: string;
  /** Element role from the tree (e.g. "button", "menu item"); matched loosely. Optional. */
  role?: string;
  /** The element's visible label — matched against its name, description, then value. */
  label: string;
  /** 1-based choice among candidates, used to resolve a prior "ambiguous" result. */
  index?: number;
  /** How long to keep re-reading the tree while the element is absent (polling every 0.5s). */
  timeoutSeconds?: number;
}

export interface UiActionResult {
  status: "ok" | "not-found" | "ambiguous" | "error";
  message?: string;
  /** For an ambiguous match: the matching elements, so the model can retry with `index`. */
  candidates?: string[];
  /** The on-screen summary right after the action, so the model can decide the next step without
   * a separate read_accessibility_tree call. */
  screen?: string;
}

interface FoundElement {
  role: string;
  label: string;
  cx: number;
  cy: number;
}

/** Attach the current on-screen summary to an action result; settle first if the action changed
 * something, so animations/transitions have finished before we read. */
async function withScreen(sandbox: SandboxHandle, result: UiActionResult): Promise<UiActionResult> {
  if (result.status === "ok") await sleep(600);
  const screen = summarizeTree((await sandbox.uiTree()) as UiTreeResponse);
  return { ...result, screen };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Center of a node's on-screen rectangle (prefer the visible portion), or null if it has none. */
function nodeCenter(node: UiElementNode): { cx: number; cy: number } | null {
  const area = (b?: number[]) => (Array.isArray(b) && b.length === 4 ? Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) : 0);
  const box = area(node.visible_bbox) > 1 ? node.visible_bbox : node.bbox;
  if (!Array.isArray(box) || box.length !== 4) return null;
  const [x1, y1, x2, y2] = box.map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
}

/** Normalize a role for tolerant matching: lowercase, drop spaces and a leading "AX". */
function normRole(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "").replace(/^ax/, "");
}

/** "AXTextArea" -> "text area", "AXStaticText" -> "static text". */
function humanizeRole(role: string): string {
  return role
    .replace(/^AX/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

/**
 * Roles worth surfacing (and clicking into) even with no text yet -- an empty input's accessible
 * name/value is normally blank until something is typed, which would otherwise make it vanish
 * entirely from both the tree summary and collectClickable() below (both require a label). Verified
 * against a real sandbox: a brand-new, empty Notes document's whole editor is exactly this -- an
 * `AXTextArea` with no name, description, or value at all -- so without this fallback there is
 * *no way* to ever see or click into it once it's empty.
 */
const EMPTY_LABELABLE_ROLE_HINTS = ["textarea", "textfield", "textentryarea", "searchfield", "combobox"];

/** How much of a text-content role's `value` to keep (see `nodeLabel` below). Kept generous --
 * this is the only way to ever read Terminal's scrollback or a long document's body -- but capped
 * so one huge terminal session or document doesn't blow the whole tree summary's char budget.
 * When cut, keeps the *end* of the string: for a scrolling log/shell, the most recent lines (what
 * a "what happened" question is almost always about) are always last, not first. */
const MAX_TEXT_VALUE_CHARS = 4000;

/** Real name first, then (for a text-content role -- see EMPTY_LABELABLE_ROLE_HINTS) its `value`,
 * then description, then value again for every other role; for an otherwise-unlabeled input-shaped
 * control, a synthetic "(empty text area)"-style placeholder instead of nothing, so it stays
 * visible and clickable by that exact string. Shared by pruneElement() (what the model reads) and
 * collectClickable() (what click_element can target), so a label the model sees in the tree is
 * always one it can click.
 *
 * value is checked *before* description for text-content roles specifically because of a real,
 * verified case: Terminal.app's own text area reports `description: "shell"` (a static, useless
 * accessibility hint, always exactly that word) while `value` holds the actual scrollback text --
 * with the old `name || description || value` order, "shell" always won and the real output was
 * silently unreachable no matter what command ran. Roles where `description` is itself the useful
 * bit (most non-text-content controls) are unaffected, since this branch only fires for roles
 * matching EMPTY_LABELABLE_ROLE_HINTS in the first place.
 */
function nodeLabel(node: UiElementNode): string | undefined {
  const role = node.role_description || node.role;
  const isTextContentRole = !!role && EMPTY_LABELABLE_ROLE_HINTS.some((k) => normRole(role).includes(k));
  const rawValue = typeof node.value === "string" && node.value ? node.value : undefined;
  const value = rawValue && rawValue.length > MAX_TEXT_VALUE_CHARS ? `…(truncated)${rawValue.slice(-MAX_TEXT_VALUE_CHARS)}` : rawValue;
  const real = node.name || (isTextContentRole ? value : undefined) || node.description || value || undefined;
  if (real) return real;
  if (!role) return undefined;
  return isTextContentRole ? `(empty ${humanizeRole(role)})` : undefined;
}

/** Every clickable, labeled element currently on screen, with the point to click. */
function collectClickable(raw: UiTreeResponse, app?: string): FoundElement[] {
  const out: FoundElement[] = [];
  const appLc = app?.toLowerCase();
  const walk = (node: UiElementNode) => {
    const label = nodeLabel(node);
    const center = nodeCenter(node);
    if (label && center) {
      out.push({ role: node.role_description || node.role || "element", label: String(label), ...center });
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const w of raw.windows ?? []) {
    if (!w.is_on_screen || SYSTEM_CHROME_OWNERS.has(w.owner)) continue;
    if (appLc && !(w.owner ?? "").toLowerCase().includes(appLc)) continue;
    for (const child of w.children ?? []) walk(child);
  }
  // Menu-bar menus (File, Edit, Product, …) — click one to open it, then the tree shows its items.
  for (const m of raw.menubar_items ?? []) {
    const b = m.bounds;
    if (m.title && b && Number.isFinite(b.x)) {
      out.push({ role: "menu bar item", label: String(m.title), cx: b.x + b.width / 2, cy: b.y + b.height / 2 });
    }
  }
  return out;
}

/**
 * Roles considered actually clickable/actionable in the sense a caller means when they say "click
 * X" without specifying a role -- as opposed to a plain, inert text label. Used only to break ties
 * in clickElement() when the label alone is ambiguous.
 */
const INTERACTIVE_ROLE_HINTS = [
  "button",
  "menuitem",
  "menubaritem",
  "checkbox",
  "radiobutton",
  "tab",
  "link",
  "cell",
  "row",
  "popupbutton",
  "textfield",
  "textentryarea",
  "textarea",
  "combobox",
];

/** 2 = an interactive control, 1 = anything else, 0 = plain inert text. Higher wins a tie when
 * clickElement() has multiple same-label matches and no explicit role/index to disambiguate. */
function interactionRank(role: string): number {
  const r = normRole(role);
  if (r === "text" || r === "statictext") return 0;
  return INTERACTIVE_ROLE_HINTS.some((k) => r.includes(k)) ? 2 : 1;
}

function matchElements(all: FoundElement[], role: string | undefined, label: string): FoundElement[] {
  const wantRole = role ? normRole(role) : "";
  const labelLc = label.toLowerCase();
  const roleMatches = (e: FoundElement, exact: boolean): boolean => {
    if (!wantRole) return true;
    const r = normRole(e.role);
    return exact ? r === wantRole : r.includes(wantRole) || wantRole.includes(r);
  };

  for (const labelExact of [true, false]) {
    const byLabel = all.filter((e) => (labelExact ? e.label.toLowerCase() === labelLc : e.label.toLowerCase().includes(labelLc)));
    if (!byLabel.length) continue;
    // An exact role match always wins over a loose substring one within this label tier -- e.g. an
    // explicit role: "text entry area" must not be diluted by plain "text" nodes just because
    // "text" happens to be a substring of the normalized role name "textentryarea".
    const exactRole = byLabel.filter((e) => roleMatches(e, true));
    if (exactRole.length) return exactRole;
    const looseRole = byLabel.filter((e) => roleMatches(e, false));
    if (looseRole.length) return looseRole;
  }
  return [];
}

/**
 * Click an on-screen element located by role + label, using the same gateway UI tree the agent
 * reads. It finds the element in that tree — which sees standard *and* SwiftUI apps, dialogs,
 * sheets and menu-bar menus — and clicks its center via the mouse, so it can act on anything it
 * can see (unlike System Events, which can't reach many SwiftUI controls). Re-reads the tree until
 * the element appears or the timeout elapses, so it doubles as a wait.
 */
export async function clickElement(sandbox: SandboxHandle, opts: UiClickOptions): Promise<UiActionResult> {
  const deadline = Date.now() + (opts.timeoutSeconds ?? 5) * 1000;
  let matches: FoundElement[] = [];
  for (;;) {
    const raw = (await sandbox.uiTree()) as UiTreeResponse;
    matches = matchElements(collectClickable(raw, opts.app), opts.role, opts.label);
    if (matches.length > 0 || Date.now() >= deadline) break;
    await sleep(500);
  }
  if (matches.length === 0) {
    return withScreen(sandbox, { status: "not-found", message: `no on-screen element matching label "${opts.label}"${opts.role ? ` (role "${opts.role}")` : ""}` });
  }
  // Silently break the single most common tie before it ever reaches the model: an AppKit
  // button/cell/row and its own nested text label routinely expose the exact same accessible name
  // (e.g. a sidebar's "New Note" row is both a clickable cell *and* a plain text child both named
  // "New Note"). When narrowing to the highest interaction rank leaves exactly one candidate, use
  // it directly instead of forcing a round trip to ask which one was meant. A genuine tie at the
  // same rank (e.g. two buttons sharing a label) still falls through to "ambiguous" below, and this
  // narrowing happens before `index` is resolved so a retry's index lines up with what was reported.
  if (matches.length > 1) {
    const maxRank = Math.max(...matches.map((m) => interactionRank(m.role)));
    matches = matches.filter((m) => interactionRank(m.role) === maxRank);
  }
  let target: FoundElement;
  if (opts.index && opts.index > 0) {
    if (opts.index > matches.length) return withScreen(sandbox, { status: "error", message: `index ${opts.index} out of range (${matches.length} matches)` });
    target = matches[opts.index - 1];
  } else if (matches.length === 1) {
    target = matches[0];
  } else {
    return withScreen(sandbox, {
      status: "ambiguous",
      message: `${matches.length} elements match — retry with a more specific label/role, or call again with "index" to pick one`,
      candidates: matches.slice(0, 10).map((m, i) => `${i + 1}) ${m.role} "${m.label}"`),
    });
  }
  await sandbox.mouse.click(Math.round(target.cx), Math.round(target.cy));
  return withScreen(sandbox, { status: "ok" });
}

/** Type text into whatever control currently has keyboard focus (click it first). */
export async function typeText(sandbox: SandboxHandle, text: string): Promise<UiActionResult> {
  await sandbox.keyboard.type(text);
  return withScreen(sandbox, { status: "ok" });
}

/** Press a key or shortcut, e.g. "return", "escape", "tab", "cmd+shift+n", "cmd+r". */
export async function pressKeys(sandbox: SandboxHandle, keys: string): Promise<UiActionResult> {
  const combo = keys.trim();
  if (combo.includes("+")) await sandbox.keyboard.hotkey(combo);
  else await sandbox.keyboard.press(combo);
  return withScreen(sandbox, { status: "ok" });
}

/** URL of the gateway's compressed-screenshot endpoint with JPEG parameters. */
export function screenshotUrl(baseUrl: string, sandboxId: string, opts: ScreenshotOptions = {}): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/v1/sandboxes/${sandboxId}/screenshot/compressed`);
  url.searchParams.set("format", "jpeg");
  url.searchParams.set("quality", String(opts.quality ?? 80));
  if (opts.scale !== undefined) url.searchParams.set("scale", String(opts.scale));
  return url.toString();
}

/**
 * JPEG screenshot via the raw HTTP endpoint.
 *
 * Why not `sandbox.screenshot.takeCompressed()`: use-computer-sdk 0.1.13 sends
 * no format/quality params, so the gateway returns a ~1.6 MB PNG that takes
 * 30-60 s to transfer (~50 KB/s egress). A JPEG at quality 80 is ~100 KB and
 * arrives in 2-3 s. The Python SDK exposes these params; the npm one does not yet.
 */
export async function takeScreenshot(sandbox: SandboxHandle, opts: ScreenshotOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const baseUrl = process.env.USE_COMPUTER_BASE_URL || DEFAULT_BASE_URL;
  const res = await fetch(screenshotUrl(baseUrl, sandbox.sandboxId, opts), {
    headers: { Authorization: `Bearer ${requireEnv("USE_COMPUTER_API_KEY")}` },
  });
  if (!res.ok) throw new Error(`Screenshot failed: HTTP ${res.status} ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Download a finished recording's raw bytes, preserving the response's content-type so the
 * caller can pick a correct file extension.
 *
 * Why not `sandbox.recording.download()`: use-computer-sdk's `HttpClient.getBytes()` (what that
 * method calls) discards the response headers and returns only a `Uint8Array` -- the same
 * metadata-loss problem `takeScreenshot()` above works around for screenshots. Verified against a
 * real sandbox: the gateway returns `video/mp4` (a genuine ISO Media / MP4 container, confirmed
 * with `file`), but this still returns the actual header rather than hard-coding that, in case it
 * ever varies.
 */
export async function downloadRecording(sandbox: SandboxHandle, recordingId: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const baseUrl = process.env.USE_COMPUTER_BASE_URL || DEFAULT_BASE_URL;
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/sandboxes/${sandbox.sandboxId}/recordings/${recordingId}/download`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${requireEnv("USE_COMPUTER_API_KEY")}` } });
  if (!res.ok) throw new Error(`Recording download failed: HTTP ${res.status} ${await res.text()}`);
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
}

export interface SetResolutionResult {
  status: "ok" | "not-found" | "error";
  message?: string;
  size?: { width: number; height: number };
}

const RESIZE_SCRIPT_PATH = "/tmp/macos-computer-use-resize.swift";

/**
 * Executed via `swift <path> ...` over SSH -- no GUI, no third-party tool install (Xcode's
 * command-line tools, already required by this product, ship `swift`).
 *
 * A bare `CGDisplaySetDisplayMode(display, mode, nil)` call reports `.success` but silently does
 * nothing on these sandboxes (verified) -- macOS's own Displays pane, and tools like
 * `displayplacer`, actually go through a `CGBeginDisplayConfiguration` /
 * `CGConfigureDisplayWithDisplayMode` / `CGCompleteDisplayConfiguration` transaction, which does
 * take effect immediately (also verified, both via `displayInfo()` and an independent
 * `screencapture`+`sips` pixel check).
 */
const RESIZE_DISPLAY_SWIFT = `
import CoreGraphics
import Foundation

let args = CommandLine.arguments
let mainDisplay = CGMainDisplayID()

func allModes() -> [CGDisplayMode] {
    let options = [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary
    guard let modes = CGDisplayCopyAllDisplayModes(mainDisplay, options) as? [CGDisplayMode] else { return [] }
    return modes
}

if args.count >= 2 && args[1] == "list" {
    for mode in allModes() where mode.isUsableForDesktopGUI() {
        print("\\(mode.width)x\\(mode.height)")
    }
    exit(0)
}

guard args.count >= 3, let w = Int32(args[1]), let h = Int32(args[2]) else {
    print("USAGE")
    exit(1)
}

guard let target = allModes().first(where: { $0.width == Int(w) && $0.height == Int(h) && $0.isUsableForDesktopGUI() }) else {
    print("NOT_FOUND")
    exit(2)
}

var configRef: CGDisplayConfigRef?
guard CGBeginDisplayConfiguration(&configRef) == .success, let config = configRef else {
    print("BEGIN_FAILED")
    exit(3)
}
let configureErr = CGConfigureDisplayWithDisplayMode(config, mainDisplay, target, nil)
let completeErr = CGCompleteDisplayConfiguration(config, .permanently)
if configureErr == .success && completeErr == .success {
    print("OK \\(target.width)x\\(target.height)")
} else {
    print("FAILED configure=\\(configureErr.rawValue) complete=\\(completeErr.rawValue)")
    exit(4)
}
`;

async function uploadResizeScript(sandbox: SandboxHandle): Promise<void> {
  await sandbox.upload(new TextEncoder().encode(RESIZE_DISPLAY_SWIFT), RESIZE_SCRIPT_PATH);
}

/** Every usable display resolution the sandbox's virtual display currently offers (observed:
 * 11 modes from 800x600 up to 1920x1080, a much wider set than System Settings' default short
 * list of 3). */
export async function listDisplayResolutions(sandbox: SandboxHandle): Promise<{ width: number; height: number }[]> {
  await uploadResizeScript(sandbox);
  const result = await sandbox.execSsh(`swift ${RESIZE_SCRIPT_PATH} list`, 30_000);
  if (result.exitCode !== 0) throw new Error(`Listing display resolutions failed: ${result.stderr || result.stdout}`);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [w, h] = line.split("x").map(Number);
      return { width: w, height: h };
    });
}

/**
 * Change the sandbox's screen resolution directly via CoreGraphics -- no GUI automation, no
 * System Settings, no click_element. Runs a tiny Swift script over SSH (see
 * `RESIZE_DISPLAY_SWIFT`) that finds a usable `CGDisplayMode` matching `width`x`height` and
 * applies it in a display-configuration transaction.
 *
 * These sandboxes run macOS as an Apple Virtualization.framework VM (`Model Identifier:
 * VirtualMac2,1`), not bare-metal hardware, but the guest genuinely re-renders its framebuffer at
 * whatever resolution is set here -- confirmed against a real sandbox with both
 * `sandbox.displayInfo()` and an actual `screencapture`+`sips` pixel check, immediately and
 * stably (re-checked 3s later). There is no gateway API for this (`/display/resize` and similar
 * guesses all 404) and no pre-installed CLI tool (`displayplacer`/`m1ddc`/`ddcctl` are absent) --
 * this SSH+CoreGraphics approach was chosen over driving System Settings' Displays pane by click
 * because it's faster (~1s vs ~20s), more robust (no locale/OS-version-dependent UI to find), and
 * exposes every mode the virtual display actually supports rather than only the 3 System Settings
 * shows by default.
 */
export async function setDisplayResolution(sandbox: SandboxHandle, width: number, height: number): Promise<SetResolutionResult> {
  await uploadResizeScript(sandbox);
  const result = await sandbox.execSsh(`swift ${RESIZE_SCRIPT_PATH} ${width} ${height}`, 30_000);
  const out = result.stdout.trim();

  if (out === "NOT_FOUND") {
    return { status: "not-found", message: `no usable display mode ${width}x${height} on this sandbox` };
  }
  if (!out.startsWith("OK")) {
    return { status: "error", message: out || result.stderr || `swift exited ${result.exitCode}` };
  }

  // Defensive: SandboxHandle.displayInfo() is typed as `{width,height}` (matching
  // use-computer-sdk's own .d.ts), but a real SDK-created sandbox actually returns the gateway's
  // raw `{ success, size: { width, height } }` at runtime -- verified directly, see the interface
  // doc comment in sandbox-handle.ts. Accept either shape.
  const info = (await sandbox.displayInfo()) as unknown as { width?: number; height?: number; size?: { width: number; height: number } };
  const size = info.size ?? (info.width !== undefined && info.height !== undefined ? { width: info.width, height: info.height } : undefined);
  if (size?.width === width && size?.height === height) return { status: "ok", size };
  return { status: "error", message: `resolution did not change (now ${size?.width}x${size?.height})`, size };
}
