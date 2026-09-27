import { describe, expect, it, vi } from "vitest";
import type { SandboxHandle } from "../../src/lib/sandbox-handle.js";
import { clickElement, screenshotUrl, uiTreeSummary } from "../../src/lib/sandbox.js";

/** A trimmed real `uiTree()` response: one background app, one real window with nested elements. */
function fakeSandbox(uiTree: unknown): SandboxHandle {
  return { uiTree: async () => uiTree } as unknown as SandboxHandle;
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

  it("drops an off-screen (scrolled-past) element's label but still keeps an on-screen sibling", async () => {
    // Regression: verified against a real, loaded Wikipedia page that its window carries a real
    // `bounds` rect, and that without this filter a deep web page's off-screen content (nav menus,
    // scrolled-past paragraphs) drowns out the ~250 nodes actually visible in the viewport out of
    // ~7000 total, blowing the char budget before ever reaching what's on screen.
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
            { name: "Visible heading", role: "AXHeading", bbox: [10, 10, 200, 40] },
            { name: "Scrolled past", role: "AXStaticText", bbox: [10, 5000, 200, 5030] },
          ],
        },
      ],
    };
    const json = await uiTreeSummary(fakeSandbox(withMixedVisibility));
    const parsed = JSON.parse(json);
    expect(parsed.windows[0].elements).toEqual([{ role: "AXHeading", label: "Visible heading" }]);
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
