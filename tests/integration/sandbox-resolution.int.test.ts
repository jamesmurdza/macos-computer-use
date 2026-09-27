import { describe, expect, it } from "vitest";
import { createSandbox } from "../../src/lib/sandbox-handle.js";
import { listDisplayResolutions, setDisplayResolution } from "../../src/lib/sandbox.js";

describe("setDisplayResolution against a real sandbox", () => {
  it("switches the sandbox's actual display resolution via CoreGraphics -- no GUI automation", async () => {
    // These sandboxes are Apple Virtualization.framework VMs (verified: `Model Identifier:
    // VirtualMac2,1`) that boot at 1920x1080. There is no gateway API or pre-installed CLI
    // (displayplacer/m1ddc/ddcctl are absent) for changing this, but a CGConfigureDisplayWithDisplayMode
    // transaction run via a tiny Swift script over SSH genuinely re-renders the framebuffer
    // (confirmed separately with `displayInfo()` and an independent `screencapture` + `sips`
    // pixel check) -- no clicking through System Settings required.
    const sandbox = await createSandbox();
    try {
      const modes = await listDisplayResolutions(sandbox);
      expect(modes.length).toBeGreaterThan(3);
      expect(modes).toContainEqual({ width: 1280, height: 720 });

      const result = await setDisplayResolution(sandbox, 1280, 720);
      expect(result.status).toBe("ok");
      expect(result.size).toEqual({ width: 1280, height: 720 });
    } finally {
      await sandbox.close();
    }
  }, 60_000);
});
