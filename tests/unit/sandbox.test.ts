import { describe, expect, it, vi } from "vitest";
import type { SandboxHandle } from "../../src/lib/sandbox-handle.js";
import { clickElement, openApp, screenshotUrl, uiTreeSummary } from "../../src/lib/sandbox.js";

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
    expect(parsed.windows.map((w: { app: string }) => w.app)).toEqual(["Finder", "Xcode"]);
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
