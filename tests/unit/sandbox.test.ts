import { describe, expect, it, vi } from "vitest";
import type { SandboxHandle } from "../../src/lib/sandbox-handle.js";
import { clickElement, openApp, screenshotUrl, typeText, uiTreeSummary } from "../../src/lib/sandbox.js";

/** A trimmed real `uiTree()` response: one background app, one real window with nested elements. */
function fakeSandbox(uiTree: unknown): SandboxHandle {
  return { uiTree: async () => uiTree } as unknown as SandboxHandle;
}

/** A sandbox whose `activate` AppleScript (via upload+execSsh) returns a fixed result, for
 * exercising openApp()'s handling of a failed vs. successful activation. */
function fakeAppSandbox(activation: { stdout: string; stderr: string; exitCode: number }, uiTree: unknown): SandboxHandle {
  return { upload: async () => {}, execSsh: async () => activation, uiTree: async () => uiTree } as unknown as SandboxHandle;
}

/** A clickable node: a labeled, on-screen element with a real rectangle to compute a click point from. */
function node(role: string, label: string, bbox: [number, number, number, number]) {
  return { name: label, role, bbox };
}

/** One on-screen window owned by `app`, holding the given clickable nodes. */
function windowWith(app: string, children: unknown[]) {
  return { name: app, owner: app, role: "app", is_on_screen: true, children };
}

/** `uiTree()` fake plus a `mouse.click` spy, for exercising clickElement() end to end. */
function fakeClickSandbox(windows: unknown[]) {
  const click = vi.fn(async () => {});
  const sandbox = { uiTree: async () => ({ windows }), mouse: { click } } as unknown as SandboxHandle;
  return { sandbox, click };
}

describe("uiTreeSummary", () => {
  const sample = {
    applications: [
      { info: { name: "Finder", active: false }, windows: [10] },
      { info: { name: "Xcode", active: true }, windows: [38] },
      { info: { name: "universalaccessd", active: false }, windows: [] }, // no windows, not active -> dropped
    ],
    windows: [
      { name: "Unnamed Window", owner: "Finder", role: "app", is_on_screen: true, children: [] },
      {
        name: "Welcome to Xcode",
        owner: "Xcode",
        role: "app",
        is_on_screen: true,
        children: [
          {
            name: null,
            role: "AXGroup",
            description: null,
            value: null,
            enabled: false,
            children: [
              { name: null, role: "AXButton", description: "Close", value: null, enabled: true, children: [] },
              { name: null, role: "AXGroup", description: null, value: null, enabled: true, children: [] }, // empty wrapper -> dropped
            ],
          },
        ],
      },
      { name: "Menubar", owner: "Window Server", role: "menubar", is_on_screen: true, children: [] }, // not role "app" -> dropped
      { name: "Backstop", owner: "Window Server", role: "desktop", is_on_screen: true, children: [] }, // dropped
      { name: "Hidden window", owner: "Finder", role: "app", is_on_screen: false, children: [] }, // off-screen -> dropped
      { name: "Tips", owner: "Notification Center", role: "app", is_on_screen: true, children: [{ name: "unrelated widget copy" }] }, // system chrome -> dropped
    ],
  };

  it("keeps only active or windowed apps, and only on-screen app-role windows", async () => {
    const json = await uiTreeSummary(fakeSandbox(sample));
    const parsed = JSON.parse(json);
    expect(parsed.apps).toEqual([
      { name: "Finder", active: false },
      { name: "Xcode", active: true },
    ]);
    expect(parsed.windows).toHaveLength(2);
    // Xcode (the active/frontmost app) sorts first -- see the windows-array sort in
    // summarizeTree(): the active app's own window is what a "what's on screen" read most needs,
    // so it's prioritized to survive the char cap ahead of any background window.
    expect(parsed.windows.map((w: { app: string }) => w.app)).toEqual(["Xcode", "Finder"]);
  });

  it("prunes elements to role/label, dropping empty wrappers and geometry", async () => {
    const json = await uiTreeSummary(fakeSandbox(sample));
    const parsed = JSON.parse(json);
    const xcodeWindow = parsed.windows.find((w: { app: string }) => w.app === "Xcode");
    // The outer AXGroup survives only because it has a labeled descendant (the Close button);
    // the sibling empty AXGroup is dropped entirely.
    expect(xcodeWindow.elements).toEqual([
      { role: "AXGroup", enabled: false, children: [{ role: "AXButton", label: "Close" }] },
    ]);
  });

  it("hard-caps the output length, since a real tree can run to hundreds of KB", async () => {
    const json = await uiTreeSummary(fakeSandbox(sample), { maxChars: 40 });
    expect(json.length).toBeGreaterThan(40); // cap + truncation marker
    expect(json).toContain("…(truncated");
  });

  it("never cuts truncation in the middle of a string, even when the cap lands there", async () => {
    // Regression: verified against a real agent run that a naive `json.slice(0, maxChars)` +
    // suffix routinely lands mid-string on a large document, producing
    // `..."label":"Jordan Riv…(truncated, 23426 chars total)` -- text that reads exactly like a
    // real (if oddly-named) element label, fused onto a real one with no separator. The model took
    // that bait and called click_element with the literal truncation marker as the label. Sweep
    // every maxChars from 1 up through comfortably past the real JSON's length so the boundary is
    // hit at every possible offset, not just one lucky/unlucky value -- and specifically assert
    // the fused-label shape (a quote immediately followed by the marker, no separator) never
    // occurs, not just that some marker is present somewhere.
    const withLongLabel = {
      applications: [{ info: { name: "Safari", active: true }, windows: [1] }],
      windows: [
        {
          name: "fw9.pdf",
          owner: "Safari",
          role: "app",
          is_on_screen: true,
          children: [{ name: "Jordan Rivera and a long run of ordinary text well past any reasonable cap", role: "AXStaticText", bbox: [0, 0, 100, 20] }],
        },
      ],
    };
    const fullJson = JSON.stringify({
      note: undefined,
      apps: [{ name: "Safari", active: true }],
      menus: [],
      windows: [{ app: "Safari", role: "app", title: "fw9.pdf", elements: [{ role: "AXStaticText", label: withLongLabel.windows[0].children[0].name }] }],
    });
    for (let maxChars = 1; maxChars < fullJson.length + 5; maxChars++) {
      const json = await uiTreeSummary(fakeSandbox(withLongLabel), { maxChars });
      if (!json.includes("truncated")) continue; // maxChars was big enough that nothing was cut
      const dataPart = json.slice(0, json.indexOf("\n…(truncated"));
      // A left-open string (the actual failure mode: the marker fused onto live text with no
      // closing quote in between) means an odd number of unescaped quotes in what's kept.
      const quoteCount = (dataPart.match(/(?<!\\)"/g) ?? []).length;
      expect(quoteCount % 2).toBe(0);
    }
  });

  it("gives an empty-but-interactive element a synthetic label instead of dropping it", async () => {
    // Regression: verified against a real sandbox that a brand-new, empty Notes document's entire
    // editor is exactly this -- an AXTextArea with no name, description, or value at all -- which
    // otherwise vanishes from the tree (and from click_element, since both require a label),
    // leaving no way to ever click into an empty input once it's been created.
    const withEmptyEditor = {
      applications: [{ info: { name: "Notes", active: true }, windows: [1] }],
      windows: [
        {
          name: "Notes",
          owner: "Notes",
          role: "app",
          is_on_screen: true,
          children: [{ name: null, role: "AXTextArea", description: null, value: null, children: [] }],
        },
      ],
    };
    const json = await uiTreeSummary(fakeSandbox(withEmptyEditor));
    const parsed = JSON.parse(json);
    expect(parsed.windows[0].elements).toEqual([{ role: "AXTextArea", label: "(empty text area)" }]);
  });

  it("reads a text area's real content from value, not a generic description that masks it", async () => {
    // Regression: verified against a real sandbox that Terminal.app's shell view reports
    // `description: "shell"` (a static, useless accessibility hint -- always exactly that word,
    // never the actual output) while `value` holds the real scrollback text. With the old
    // `name || description || value` order, "shell" always won and command output was completely
    // unreachable no matter what ran -- e.g. `system_profiler` genuinely executing with no way to
    // ever read its result back. `description` still wins for non-text-content roles (a button's
    // hint, say), since this reordering only applies to roles in EMPTY_LABELABLE_ROLE_HINTS.
    const withTerminalOutput = {
      applications: [{ info: { name: "Terminal", active: true }, windows: [1] }],
      windows: [
        {
          name: "Terminal",
          owner: "Terminal",
          role: "app",
          is_on_screen: true,
          children: [
            {
              name: null,
              role: "AXTextArea",
              role_description: "text entry area",
              description: "shell",
              value: "lume@lumes-Virtual-Machine ~ % echo HELLO\nHELLO\nlume@lumes-Virtual-Machine ~ % ",
              children: [],
            },
          ],
        },
      ],
    };
    const json = await uiTreeSummary(fakeSandbox(withTerminalOutput));
    const parsed = JSON.parse(json);
    expect(parsed.windows[0].elements).toEqual([
      { role: "text entry area", label: "lume@lumes-Virtual-Machine ~ % echo HELLO\nHELLO\nlume@lumes-Virtual-Machine ~ % " },
    ]);
  });

  it("reads a text field's real typed value, not its own static caption masking it", async () => {
    // Regression, verified against a real sandbox: Xcode's "New Project" sheet reports the
    // Product Name field's `name` as "Product_Name:" -- the field's own static caption, unchanged
    // whether the field is empty or full -- while `value` holds whatever was actually typed. With
    // the old `name || value || description` order, the caption always won: a real agent run typed
    // "HelloTimer", read the tree, saw only "Product_Name:" with no sign its own typing had
    // landed, concluded the type had failed, and retyped into the same field without clearing it
    // first -- producing "HelloTimerHelloTimer" in the actual project. `name` still wins for
    // non-text-content roles, since this reordering only applies to roles in
    // EMPTY_LABELABLE_ROLE_HINTS.
    const withTypedProductName = {
      applications: [{ info: { name: "Xcode", active: true }, windows: [1] }],
      windows: [
        {
          name: "Unnamed Window",
          owner: "Xcode",
          role: "app",
          is_on_screen: true,
          children: [{ name: "Product_Name:", role: "AXTextField", role_description: "text field", value: "HelloTimer", children: [] }],
        },
      ],
    };
    const json = await uiTreeSummary(fakeSandbox(withTypedProductName));
    const parsed = JSON.parse(json);
    expect(parsed.windows[0].elements).toEqual([{ role: "text field", label: "HelloTimer" }]);
  });

  it("truncates a huge text area value, keeping the end (most recent output), not the start", async () => {
    const longValue = `${"x".repeat(5000)}TAIL_MARKER`;
    const withHugeScrollback = {
      applications: [{ info: { name: "Terminal", active: true }, windows: [1] }],
      windows: [
        {
          name: "Terminal",
          owner: "Terminal",
          role: "app",
          is_on_screen: true,
          children: [{ name: null, role: "AXTextArea", role_description: "text entry area", description: "shell", value: longValue, children: [] }],
        },
      ],
    };
    const json = await uiTreeSummary(fakeSandbox(withHugeScrollback));
    const parsed = JSON.parse(json);
    const label = parsed.windows[0].elements[0].label as string;
    expect(label.length).toBeLessThan(longValue.length);
    expect(label.endsWith("TAIL_MARKER")).toBe(true);
  });

  it("drops an off-screen (scrolled-past) element's label but still keeps an on-screen sibling", async () => {
    // Regression: verified against a real, loaded Wikipedia page that its window carries a real
    // `bounds` rect, and that without this filter a deep web page's off-screen content (nav menus,
    // scrolled-past paragraphs) drowns out the ~250 nodes actually visible in the viewport out of
    // ~7000 total, blowing the char budget before ever reaching what's on screen.
    // Nested inside a container (a scroll area), like real content actually is -- not a direct
    // child of the window itself, which only ever holds top-level regions (toolbars, content
    // panes, sheets) that reliableViewport() separately sanity-checks against the window's bounds.
    const withMixedVisibility = {
      applications: [{ info: { name: "Safari", active: true }, windows: [1] }],
      windows: [
        {
          name: "Safari",
          owner: "Safari",
          role: "app",
          is_on_screen: true,
          bounds: { x: 0, y: 0, width: 1280, height: 960 },
          children: [
            {
              name: null,
              role: "AXScrollArea",
              bbox: [0, 0, 1280, 960],
              children: [
                { name: "Visible heading", role: "AXHeading", bbox: [10, 10, 200, 40] },
                { name: "Scrolled past", role: "AXStaticText", bbox: [10, 5000, 200, 5030] },
              ],
            },
          ],
        },
      ],
    };
    const json = await uiTreeSummary(fakeSandbox(withMixedVisibility));
    const parsed = JSON.parse(json);
    expect(parsed.windows[0].elements).toEqual([{ role: "AXScrollArea", children: [{ role: "AXHeading", label: "Visible heading" }] }]);
  });

  it("doesn't filter by visibility at all when a window has no bounds to filter against", async () => {
    const noBounds = {
      applications: [{ info: { name: "Calculator", active: true }, windows: [1] }],
      windows: [
        {
          name: "Calculator",
          owner: "Calculator",
          role: "app",
          is_on_screen: true,
          children: [{ name: "9999", role: "AXStaticText", bbox: [-500, -500, -400, -400] }],
        },
      ],
    };
    const json = await uiTreeSummary(fakeSandbox(noBounds));
    const parsed = JSON.parse(json);
    expect(parsed.windows[0].elements).toEqual([{ role: "AXStaticText", label: "9999" }]);
  });

  it("ignores an implausible window bounds when a direct child is far bigger than it", async () => {
    // Regression: verified against a real sandbox that Finder's Desktop icon layer reports itself
    // as a window with a tiny bounds rect (88x21 px, evidently some incidental UI detail, not the
    // desktop's own area) while its actual child content spans the full screen. Naively filtering
    // against that rect made a freshly-created desktop folder's icon (and its in-progress rename
    // field) vanish from the tree right when an agent most needs to see it.
    const bogusWindowBounds = {
      applications: [{ info: { name: "Finder", active: true }, windows: [1] }],
      windows: [
        {
          name: "Finder",
          owner: "Finder",
          role: "app",
          is_on_screen: true,
          bounds: { x: 1810, y: 106, width: 88, height: 21 }, // implausibly tiny vs. its child below
          children: [
            {
              name: null,
              role: "AXGroup",
              description: "desktop",
              bbox: [0, 0, 1920, 1080], // far bigger than the window's own claimed bounds
              children: [{ name: "untitled_folder", role: "AXImage", bbox: [1822, 38, 1886, 102] }],
            },
          ],
        },
      ],
    };
    const json = await uiTreeSummary(fakeSandbox(bogusWindowBounds));
    const parsed = JSON.parse(json);
    expect(parsed.windows[0].elements).toEqual([{ role: "AXGroup", label: "desktop", children: [{ role: "AXImage", label: "untitled_folder" }] }]);
  });

  it("ignores a window's bounds when a modal sheet renders outside them", async () => {
    // Regression: verified against a real sandbox that TextEdit's Save panel is reported as nested
    // inside its owning document window's children, but the sheet's own raw bbox extended from
    // x=75 to x=955 while the document window underneath it claimed bounds of only x=213 to x=816.
    // Filtering the sheet's own children (its location sidebar -- Desktop, Documents, ...) against
    // the document window's bounds silently deleted every sidebar label to the left of x=213,
    // removing the one control needed to actually choose a save location.
    const sheetOutsideWindow = {
      applications: [{ info: { name: "TextEdit", active: true }, windows: [1] }],
      windows: [
        {
          name: "Untitled",
          owner: "TextEdit",
          role: "app",
          is_on_screen: true,
          bounds: { x: 213, y: 77, width: 603, height: 505 }, // x: 213-816
          children: [
            {
              name: null,
              role: "AXSheet",
              description: "save",
              bbox: [75, 145, 955, 593], // extends left of 213 and right of 816
              visible_bbox: [213, 145, 816, 582], // macOS itself already clipped this to the window
              children: [{ name: "Desktop", role: "AXStaticText", bbox: [128, 170, 208, 188] }], // left of x=213
            },
          ],
        },
      ],
    };
    const json = await uiTreeSummary(fakeSandbox(sheetOutsideWindow));
    const parsed = JSON.parse(json);
    expect(parsed.windows[0].elements).toEqual([{ role: "AXSheet", label: "save", children: [{ role: "AXStaticText", label: "Desktop" }] }]);
  });

  it("still drops an empty element whose role isn't an input (e.g. a bare wrapper AXGroup)", async () => {
    const withEmptyGroup = {
      applications: [{ info: { name: "Notes", active: true }, windows: [1] }],
      windows: [
        {
          name: "Notes",
          owner: "Notes",
          role: "app",
          is_on_screen: true,
          children: [{ name: null, role: "AXGroup", description: null, value: null, children: [] }],
        },
      ],
    };
    const json = await uiTreeSummary(fakeSandbox(withEmptyGroup));
    const parsed = JSON.parse(json);
    expect(parsed.windows[0].elements).toEqual([]);
  });

  it("surfaces a Safari Cmd+S sheet's real controls, nested as a normal child of the main window", async () => {
    // A path investigated and ruled out while root-causing the tax-form demo's save failures:
    // Safari's own gateway-provided uiTree() *does* also emit a separate, always-empty top-level
    // pseudo-window for this same sheet (owner "Safari", children: []) -- easy to mistake for "the
    // sheet is unreadable" if that's the only entry inspected. But the sheet's real content lives
    // nested as a plain child (role "sheet") of the *main* content window, exactly like any other
    // dialog, and was already fully readable and clickable there with no special-casing needed --
    // verified against a real sandbox, including that click_element("fw9")/click_element("Save")
    // both resolve unambiguously. This test pins that down as a real regression guard: an app's
    // own text field for a sheet's filename typically has no `name`/`description` of its own here,
    // so this also exercises nodeLabel()'s value fallback for a plain (non-Terminal) text field.
    const withSheet = {
      applications: [{ info: { name: "Safari", active: true }, windows: [1] }],
      windows: [
        {
          name: "https://www.irs.gov/pub/irs-pdf/fw9.pdf",
          owner: "Safari",
          role: "app",
          is_on_screen: true,
          children: [
            {
              name: null,
              role: "AXSheet",
              role_description: "sheet",
              children: [
                {
                  name: null,
                  role: "AXSplitGroup",
                  role_description: "split group",
                  children: [
                    { name: "Save As:", role: "AXStaticText", role_description: "text", bbox: [814, 448, 868, 466] },
                    { name: null, role: "AXTextField", role_description: "text field", value: "fw9", bbox: [874, 444, 1106, 470] },
                    { name: "Cancel", role: "AXButton", role_description: "button", bbox: [968, 562, 1044, 588] },
                    { name: "Save", role: "AXButton", role_description: "button", bbox: [1050, 562, 1126, 588] },
                  ],
                },
              ],
            },
          ],
        },
        // The gateway's own separate, always-empty pseudo-window for the same sheet -- present
        // alongside the real one above; must not be mistaken for "the sheet has no content".
        { name: null, owner: "Safari", role: "app", is_on_screen: true, children: [] },
      ],
    };
    const sandbox = fakeSandbox(withSheet);

    const json = await uiTreeSummary(sandbox);
    const parsed = JSON.parse(json);
    // Both windows are owned by Safari (the active app), so the active-app-first sort ties between
    // them and falls through to size -- the empty duplicate pseudo-window (0 elements) legitimately
    // sorts ahead of the real content window here, which is fine: unlike the truncation case this
    // guards against, both fit comfortably under the cap regardless of order. Find the real one by
    // content rather than assuming an index.
    const mainWindow = parsed.windows.find((w: { elements: unknown[] }) => w.elements.length > 0);
    expect(mainWindow.elements).toEqual([
      {
        role: "sheet",
        children: [
          {
            role: "split group",
            children: [
              { role: "text", label: "Save As:" },
              { role: "text field", label: "fw9" },
              { role: "button", label: "Cancel" },
              { role: "button", label: "Save" },
            ],
          },
        ],
      },
    ]);

    const clickResult = await clickElement(fakeClickSandbox([withSheet.windows[0]]).sandbox, { label: "fw9", role: "text field" });
    expect(clickResult.status).toBe("ok");
    const saveResult = await clickElement(fakeClickSandbox([withSheet.windows[0]]).sandbox, { label: "Save", role: "button" });
    expect(saveResult.status).toBe("ok");
  });

  it("keeps a modal sheet visible even when huge preceding content would otherwise truncate it away", async () => {
    // Regression: verified against a real sandbox and a real agent run -- a Save sheet opened over
    // an already-loaded IRS PDF form genuinely appears in the raw tree as a normal sibling
    // element, positioned *after* the form's own (huge) content. The default 24000-char cap
    // truncated the JSON while still inside that content, so the model's read_accessibility_tree
    // came back with zero trace of the sheet it had just opened -- not a real gap, just bad luck
    // in array order -- and it burned 30+ steps hunting through menus for a dialog that was on
    // screen the entire time. sortModalFirst() (used by summarizeTree()) guarantees a "sheet" role
    // sorts ahead of ordinary content, so it survives the cap regardless of how much precedes it.
    const hugeContent = { name: null, role: "AXStaticText", description: "x".repeat(5000), value: null };
    const sheet = {
      name: null,
      role: "AXSheet",
      role_description: "sheet",
      children: [{ name: "Save", role: "AXButton", role_description: "button", bbox: [1050, 562, 1126, 588] }],
    };
    const withHugeContentThenSheet = {
      applications: [{ info: { name: "Safari", active: true }, windows: [1] }],
      windows: [
        {
          name: "huge.pdf",
          owner: "Safari",
          role: "app",
          is_on_screen: true,
          // Several huge nodes before the sheet -- enough to blow well past a small maxChars.
          children: [hugeContent, hugeContent, hugeContent, sheet],
        },
      ],
    };
    const json = await uiTreeSummary(fakeSandbox(withHugeContentThenSheet), { maxChars: 2000 });
    expect(json).toContain("truncated"); // the huge content really did get cut off, this isn't a no-op cap
    // The sheet and its Save button still made it into the (truncated) output at all, proving they
    // were moved ahead of the huge content rather than being pushed past the cap by it.
    expect(json).toContain('"role":"sheet"');
    expect(json).toContain('"label":"Save"');
  });

  it("keeps a different app's real dialog window visible ahead of another app's huge window", async () => {
    // The window-level counterpart to the sheet regression above, and the actual root cause of a
    // real failure: verified against a real sandbox that Preview's own "Open" file dialog is a
    // genuine, separate top-level window (real content: the Documents sidebar, the file list,
    // Open/Cancel buttons) -- not nested inside Safari's window as a sheet, so sortModalFirst()
    // alone can't help it. It sat right after Safari's window for the same huge IRS PDF in the
    // gateway's own array order, so the char cap truncated deep inside Safari's content before
    // ever reaching Preview's dialog. cmd+o had genuinely worked every time; three separate real
    // agent runs "saw" it fail anyway and burned dozens of steps retrying/giving up. Preview was
    // the active/frontmost app in all of them, so sorting the active app's window first (ahead of
    // any background window, regardless of size) fixes exactly this.
    const safariHugeContent = { name: null, role: "AXStaticText", description: "x".repeat(3000), value: null };
    const withActiveAppDialogBehindHugeBackground = {
      applications: [
        { info: { name: "Safari", active: false }, windows: [1] },
        { info: { name: "Preview", active: true }, windows: [1] },
      ],
      windows: [
        {
          name: "https://www.irs.gov/pub/irs-pdf/fw9.pdf",
          owner: "Safari",
          role: "app",
          is_on_screen: true,
          children: [safariHugeContent, safariHugeContent, safariHugeContent, safariHugeContent],
        },
        {
          name: "Open",
          owner: "Preview",
          role: "app",
          is_on_screen: true,
          children: [
            { name: "fw9.pdf", role: "AXTextField", role_description: "text field", bbox: [0, 0, 100, 20] },
            { name: "Open", role: "AXButton", role_description: "button", bbox: [0, 0, 20, 20] },
          ],
        },
      ],
    };
    const json = await uiTreeSummary(fakeSandbox(withActiveAppDialogBehindHugeBackground), { maxChars: 500 });
    expect(json).toContain("truncated"); // Safari's content really did get cut, this isn't a no-op cap
    // Preview's dialog -- the active app's own window -- still made it in, proving it was sorted
    // ahead of Safari's window rather than pushed past the cap by it.
    expect(json).toContain('"title":"Open"');
    expect(json).toContain('"label":"fw9.pdf"');
  });

  it("marks the single most-frontmost window (highest z_index) among several same-owner windows", async () => {
    // Verified against a real sandbox: repeated cmd+shift+s ("Duplicate") in Preview leaves
    // several windows open at once, all owned by "Preview" -- "fw9.pdf", "fw9 copy", and an
    // "Unnamed Window" (a stray color-picker/toolbar window, confirmed the real cause of one
    // agent run spiraling trying to figure out which window it was actually looking at). The raw
    // gateway data's own z_index (higher = more frontmost, confirmed by cycling focus between two
    // real TextEdit windows and watching the numbers swap) is the only signal that tells them
    // apart -- this pins down that it's surfaced and that exactly one window ends up marked.
    const raw = {
      applications: [{ info: { name: "Preview", active: true }, windows: [1, 2, 3] }],
      windows: [
        { name: "fw9.pdf", owner: "Preview", role: "app", is_on_screen: true, z_index: 7, children: [] },
        { name: "fw9 copy", owner: "Preview", role: "app", is_on_screen: true, z_index: 8, children: [] },
        { name: "Unnamed Window", owner: "Preview", role: "app", is_on_screen: true, z_index: 9, children: [] },
      ],
    };
    const parsed = JSON.parse(await uiTreeSummary(fakeSandbox(raw)));
    const previewWindows = parsed.windows.filter((w: { app: string }) => w.app === "Preview");
    expect(previewWindows).toHaveLength(3);
    expect(previewWindows.filter((w: { frontmost?: boolean }) => w.frontmost)).toHaveLength(1);
    expect(previewWindows[0]).toMatchObject({ title: "Unnamed Window", frontmost: true, zIndex: 9 });
    // Sorted by z_index descending within the tied-active-app group, not left in gateway order.
    expect(previewWindows.map((w: { title: string }) => w.title)).toEqual(["Unnamed Window", "fw9 copy", "fw9.pdf"]);
  });

  it("omits frontmost/zIndex entirely for a lone window -- nothing to disambiguate", async () => {
    const raw = {
      applications: [{ info: { name: "Preview", active: true }, windows: [1] }],
      windows: [{ name: "fw9.pdf", owner: "Preview", role: "app", is_on_screen: true, z_index: 7, children: [] }],
    };
    const json = await uiTreeSummary(fakeSandbox(raw));
    expect(json).not.toContain("frontmost");
    expect(json).not.toContain("zIndex");
  });
});

describe("clickElement", () => {
  it("can click an empty text area by the same synthetic label uiTreeSummary shows for it", async () => {
    // End-to-end version of the uiTreeSummary regression above: an unlabeled AXTextArea (a
    // brand-new, empty Notes document, verified against a real sandbox) must be clickable by
    // exactly the synthetic label the model would have read from the tree -- not just a plain
    // element that already happens to be named that.
    const emptyEditor = { name: null, role: "AXTextArea", description: null, value: null, bbox: [10, 20, 210, 220] };
    const { sandbox, click } = fakeClickSandbox([windowWith("Notes", [emptyEditor])]);
    const result = await clickElement(sandbox, { label: "(empty text area)" });
    expect(result.status).toBe("ok");
    expect(click).toHaveBeenCalledWith(110, 120);
  });

  it("auto-resolves a button and its own nested text label sharing one name, instead of asking", async () => {
    // The extremely common AppKit pattern this targets: a sidebar row is both a clickable button
    // and contains a plain text child with the identical accessible name -- e.g. Notes' "New Note".
    const { sandbox, click } = fakeClickSandbox([
      windowWith("Notes", [node("AXStaticText", "New Note", [10, 10, 90, 30]), node("AXButton", "New Note", [0, 0, 100, 40])]),
    ]);
    const result = await clickElement(sandbox, { label: "New Note" });
    expect(result.status).toBe("ok");
    expect(click).toHaveBeenCalledWith(50, 20); // the button's center, not the text's
  });

  it("still reports ambiguous for a genuine tie between two equally-ranked elements", async () => {
    const { sandbox, click } = fakeClickSandbox([
      windowWith("Finder", [node("AXButton", "OK", [0, 0, 20, 20]), node("AXButton", "OK", [100, 100, 120, 120])]),
    ]);
    const result = await clickElement(sandbox, { label: "OK" });
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
    expect(click).not.toHaveBeenCalled();
  });

  it("an exact role match isn't diluted by a same-label node whose role loosely contains it as a substring", async () => {
    // Regression: normRole("text entry area") = "textentryarea", which naively .includes("text") --
    // a plain AXStaticText node must not sneak into an explicit role: "text entry area" match.
    const { sandbox, click } = fakeClickSandbox([
      windowWith("Notes", [node("AXStaticText", "Shopping List", [0, 0, 10, 10]), node("AXTextEntryArea", "Shopping List", [50, 50, 150, 150])]),
    ]);
    const result = await clickElement(sandbox, { label: "Shopping List", role: "text entry area" });
    expect(result.status).toBe("ok");
    expect(click).toHaveBeenCalledWith(100, 100); // the text entry area's center, not the plain text's
  });

  it("reports not-found when nothing matches the label", async () => {
    const { sandbox } = fakeClickSandbox([windowWith("Finder", [node("AXButton", "Cancel", [0, 0, 20, 20])])]);
    const result = await clickElement(sandbox, { label: "OK", timeoutSeconds: 0 });
    expect(result.status).toBe("not-found");
  });

  it("an explicit index still selects correctly among a genuine tie", async () => {
    const { sandbox, click } = fakeClickSandbox([
      windowWith("Finder", [node("AXButton", "OK", [0, 0, 20, 20]), node("AXButton", "OK", [100, 100, 120, 120])]),
    ]);
    const result = await clickElement(sandbox, { label: "OK", index: 2 });
    expect(result.status).toBe("ok");
    expect(click).toHaveBeenCalledWith(110, 110);
  });

  it("re-activates the target's own app first when some other app is frontmost", async () => {
    // Regression: reproduced against a real sandbox and a real agent run. A click dispatched at
    // the exact right screen coordinates into a *background* (non-frontmost) window's control is
    // accepted by macOS as "bring this window forward" only -- it does not also perform the
    // control's actual action -- and clickElement has no way to detect that from the click call
    // itself, which never errors. Concretely: the agent opened Preview's file-open dialog, then
    // called open_app("Safari") (switching focus away for an unrelated reason), then clicked the
    // file in that still-open dialog and its Open button -- both reported "ok", but the file never
    // actually opened, because Preview was no longer the frontmost app when the clicks landed.
    const raw = {
      applications: [
        { info: { name: "Safari", active: true }, windows: [1] },
        { info: { name: "Preview", active: false }, windows: [1] },
      ],
      windows: [windowWith("Preview", [node("AXButton", "Open", [0, 0, 20, 20])])],
    };
    const click = vi.fn(async () => {});
    const execSsh = vi.fn(async (_cmd: string) => ({ stdout: "", stderr: "", exitCode: 0 }));
    const sandbox = { uiTree: async () => raw, mouse: { click }, upload: async () => {}, execSsh } as unknown as SandboxHandle;

    const result = await clickElement(sandbox, { label: "Open" });
    expect(result.status).toBe("ok");
    expect(execSsh).toHaveBeenCalledTimes(1);
    expect(execSsh.mock.calls[0][0]).toContain("osascript"); // the activate script actually ran
    // Activation must happen strictly before the click, not just at some point during the call.
    expect(execSsh.mock.invocationCallOrder[0]).toBeLessThan(click.mock.invocationCallOrder[0]);
  });

  it("skips re-activation when the target's app is already frontmost", async () => {
    const raw = {
      applications: [{ info: { name: "Finder", active: true }, windows: [1] }],
      windows: [windowWith("Finder", [node("AXButton", "OK", [0, 0, 20, 20])])],
    };
    const click = vi.fn(async () => {});
    const execSsh = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const sandbox = { uiTree: async () => raw, mouse: { click }, upload: async () => {}, execSsh } as unknown as SandboxHandle;

    const result = await clickElement(sandbox, { label: "OK" });
    expect(result.status).toBe("ok");
    expect(execSsh).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledWith(10, 10);
  });

  it("clicks to the left of a matched element's own left edge when clickOffsetLeftPx is given", async () => {
    // Regression: verified against a real W-9 PDF form open in Preview. The "Individual/sole
    // proprietor" tax-classification checkbox never appears as its own accessible element -- only
    // its plain, disabled `text` description does, at bbox [284, 239, 347, 246]. Clicking that text
    // node directly reports "ok" but never toggles the box; a raw click a few pixels to its left
    // (where the actual glyph is drawn, verified with before/after screenshots) does. This test
    // pins down clickOffsetLeftPx's coordinate math against that exact real bbox rather than an
    // invented one.
    const { sandbox, click } = fakeClickSandbox([windowWith("Preview", [node("AXStaticText", "Individual/sole proprietor", [284, 239, 347, 246])])]);

    const result = await clickElement(sandbox, { label: "Individual/sole proprietor", clickOffsetLeftPx: 10 });

    expect(result.status).toBe("ok");
    // x1 (284) - 10 = 274; y is the untouched vertical center of [239, 246], Math.round(242.5) = 243.
    expect(click).toHaveBeenCalledWith(274, 243);
  });

  it("clicks the element's own center when clickOffsetLeftPx is omitted, even though x1 is known", async () => {
    const { sandbox, click } = fakeClickSandbox([windowWith("Preview", [node("AXButton", "Save", [284, 239, 347, 246])])]);

    const result = await clickElement(sandbox, { label: "Save" });

    expect(result.status).toBe("ok");
    expect(click).toHaveBeenCalledWith(Math.round((284 + 347) / 2), expect.any(Number));
  });

  it("with nearLabel, picks the ambiguous match geometrically closest to a stable anchor label", async () => {
    // The actual fix for the session's most-repeated real bug: a PDF form's blank fields all
    // share one generic label ("(empty text field)"), so disambiguating by `index` means "the Nth
    // field still empty" -- which points at a different physical field every time an earlier one
    // gets filled in. Verified end-to-end against a real W-9 form (nearLabel: "5 Address" and
    // nearLabel: "6 City" both landed text correctly, confirmed via typeText's own verification).
    // This test pins the geometry: two empty fields, an anchor label sitting right next to one of
    // them -- clickElement must pick that one, not just the first/lowest-index match.
    const farField = { name: null, role: "AXTextField", description: null, value: null, bbox: [500, 500, 700, 515] };
    const nearField = { name: null, role: "AXTextField", description: null, value: null, bbox: [280, 240, 480, 255] };
    const anchor = { name: "5 Address (number, street, and apt. or suite no.)", role: "AXStaticText", role_description: "text", bbox: [260, 220, 500, 235] };
    const { sandbox, click } = fakeClickSandbox([windowWith("Preview", [farField, anchor, nearField])]);

    const result = await clickElement(sandbox, { label: "(empty text field)", role: "text field", nearLabel: "5 Address" });

    expect(result.status).toBe("ok");
    // Center of nearField, not farField -- proves distance-to-anchor won, not array/tree order.
    expect(click).toHaveBeenCalledWith(Math.round((280 + 480) / 2), Math.round((240 + 255) / 2));
  });

  it("nearLabel reports not-found (naming the anchor) when the anchor itself isn't on screen", async () => {
    const field1 = { name: null, role: "AXTextField", description: null, value: null, bbox: [280, 240, 480, 255] };
    const field2 = { name: null, role: "AXTextField", description: null, value: null, bbox: [500, 500, 700, 515] };
    const { sandbox } = fakeClickSandbox([windowWith("Preview", [field1, field2])]);

    const result = await clickElement(sandbox, { label: "(empty text field)", role: "text field", nearLabel: "5 Address" });

    expect(result.status).toBe("not-found");
    expect(result.message).toContain("5 Address");
  });
});

describe("typeText", () => {
  /** A sandbox whose `keyboard.type` is a no-op spy and `uiTree()` returns a fixed tree
   * afterward -- for exercising typeText()'s post-type verification without a real sandbox. */
  function fakeTypeSandbox(uiTree: unknown) {
    const type = vi.fn(async () => {});
    const sandbox = { keyboard: { type }, uiTree: async () => uiTree } as unknown as SandboxHandle;
    return { sandbox, type };
  }

  it("leaves verified unset when the typed text actually shows up in some field's value", async () => {
    const raw = { windows: [windowWith("Preview", [{ name: null, role: "AXTextField", role_description: "text field", value: "123 Market Street", bbox: [0, 0, 100, 20] }])] };
    const { sandbox, type } = fakeTypeSandbox(raw);

    const result = await typeText(sandbox, "123 Market Street");

    expect(type).toHaveBeenCalledWith("123 Market Street");
    expect(result.status).toBe("ok");
    expect(result.verified).toBeUndefined();
  });

  it("flags verified: false when the typed text lands nowhere on screen", async () => {
    // Regression, verified against a real sandbox: a checkbox click (via clickOffsetLeftPx) drops
    // keyboard focus out of any text field entirely -- typing right after it previously landed
    // silently nowhere, with the old blind "ok" the only signal a caller ever got either way. This
    // is the actual gap that let a real agent run confidently report typing "San Francisco, CA
    // 94103" into the City field when the saved PDF's field was provably empty.
    const raw = { windows: [windowWith("Preview", [{ name: null, role: "AXTextField", role_description: "text field", value: "Rivera Consulting LLC", bbox: [0, 0, 100, 20] }])] };
    const { sandbox } = fakeTypeSandbox(raw);

    const result = await typeText(sandbox, "SHOULD_NOT_LAND_ANYWHERE");

    expect(result.status).toBe("ok"); // the keystrokes really were sent -- this isn't a new failure state
    expect(result.verified).toBe(false);
    expect(result.message).toContain("SHOULD_NOT_LAND_ANYWHERE");
  });

  it("verifies a multi-line note even when the app reformats individual lines", async () => {
    // Regression, from a real captured run: typed a title + 3 bulleted lines into Notes in one
    // type_text call (the exact multi-line pattern this repo's own system prompt recommends).
    // Notes exposed the real content via the node's raw `name` (not `value`) -- a first bug fixed
    // by treeContainsText() reusing nodeLabel(). But even with that fix, an exact whole-block
    // match still failed: Notes' auto-bulleted-list formatting silently dropped the leading "• "
    // from the first bulleted line specifically (later lines in the same note kept theirs) and
    // changed a typed straight apostrophe to a curly one -- both purely cosmetic, app-applied
    // changes, not a sign the typing failed. This is why verification is line-by-line and
    // normalized rather than one exact substring check.
    const typed =
      "Lake Tahoe Hike Ideas\n• Cave Rock – A popular hike.\n• Maggie's Peak – Great views.\n• Eagle Lake Trail – A scenic alpine lake.";
    // Actual on-screen content, byte-for-byte as captured: no "• " before "Cave Rock", but "• "
    // preserved before the later lines, and a curly apostrophe in "Maggie's".
    const actualOnScreen =
      "Lake Tahoe Hike Ideas\nCave Rock – A popular hike.\n• Maggie’s Peak – Great views.\n• Eagle Lake Trail – A scenic alpine lake.";
    const raw = {
      windows: [windowWith("Notes", [{ name: actualOnScreen, role: "AXTextArea", role_description: "text entry area", value: null, bbox: [0, 0, 400, 300] }])],
    };
    const { sandbox } = fakeTypeSandbox(raw);

    const result = await typeText(sandbox, typed);

    expect(result.status).toBe("ok");
    expect(result.verified).toBeUndefined();
  });

  it("still flags a genuinely missing line even after normalization", async () => {
    const raw = { windows: [windowWith("Notes", [{ name: "Lake Tahoe Hike Ideas\nCave Rock – A popular hike.", role: "AXTextArea", role_description: "text entry area", value: null, bbox: [0, 0, 400, 300] }])] };
    const { sandbox } = fakeTypeSandbox(raw);

    const result = await typeText(sandbox, "Lake Tahoe Hike Ideas\n• Cave Rock – A popular hike.\n• A line that never actually landed anywhere.");

    expect(result.verified).toBe(false);
    expect(result.message).toContain("never actually landed");
  });
});

describe("screenshotUrl", () => {
  it("requests a JPEG at quality 80 by default", () => {
    expect(screenshotUrl("https://api.use.computer", "sb-1")).toBe(
      "https://api.use.computer/v1/sandboxes/sb-1/screenshot/compressed?format=jpeg&quality=80",
    );
  });

  it("passes quality and scale through", () => {
    expect(screenshotUrl("https://api.use.computer", "sb-1", { quality: 60, scale: 0.5 })).toBe(
      "https://api.use.computer/v1/sandboxes/sb-1/screenshot/compressed?format=jpeg&quality=60&scale=0.5",
    );
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(screenshotUrl("https://api.use.computer/", "sb-1")).toContain("computer/v1/sandboxes/sb-1/");
  });
});

describe("openApp", () => {
  it("surfaces a failed activation instead of silently polling for a window that can never appear", async () => {
    // Regression: verified against a real sandbox that `tell application "iOS Simulator" to
    // activate` (a name a model can very plausibly guess -- the real app is just called
    // "Simulator") fails immediately with a real AppleScript error, which used to be silently
    // swallowed, making a flat-out wrong app name look identical to a slow launch.
    const activationError = {
      stdout: "",
      stderr: '36:44: execution error: Can’t get application "iOS Simulator". (-1728)\n',
      exitCode: 1,
    };
    const idleDesktop = { applications: [], windows: [] };
    const result = await openApp(fakeAppSandbox(activationError, idleDesktop), "iOS Simulator");
    const parsed = JSON.parse(result);
    expect(parsed.note).toMatch(/could not be activated/);
    expect(parsed.note).toMatch(/iOS Simulator/);
    expect(parsed.note).toMatch(/Can.t get application/);
  });

  it("still returns a normal window summary when activation succeeds", async () => {
    const ok = { stdout: "", stderr: "", exitCode: 0 };
    const withWindow = {
      applications: [{ info: { name: "Simulator", active: true }, windows: [1] }],
      windows: [{ name: "iPhone 16 Plus", owner: "Simulator", role: "app", is_on_screen: true, children: [{ name: "Safari", role: "AXButton" }] }],
    };
    const result = await openApp(fakeAppSandbox(ok, withWindow), "Simulator");
    const parsed = JSON.parse(result);
    expect(parsed.note).toBeUndefined();
    expect(parsed.windows[0].elements).toEqual([{ role: "AXButton", label: "Safari" }]);
  });
});
