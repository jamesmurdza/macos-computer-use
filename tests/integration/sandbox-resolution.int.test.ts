import { describe, expect, it } from "vitest";
import { createSandbox } from "../../src/lib/sandbox-handle.js";
import { setDisplayResolution } from "../../src/lib/sandbox.js";

describe("setDisplayResolution against a real sandbox", () => {
  it("switches the sandbox's actual display resolution via System Settings > Displays", async () => {
    // These sandboxes are Apple Virtualization.framework VMs (verified: `Model Identifier:
    // VirtualMac2,1`) that boot at 1920x1080. There is no gateway API or in-guest CLI
    // (displayplacer/m1ddc/ddcctl are absent) for changing this -- driving System Settings'
    // Displays pane the same way a person (or the agent) would is the only way, and it genuinely
    // re-renders the framebuffer (confirmed separately with `screencapture` + `sips`).
    const sandbox = await createSandbox();
    try {
      const result = await setDisplayResolution(sandbox, 1280, 720);
      expect(result.status).toBe("ok");
      expect(result.size).toEqual({ width: 1280, height: 720 });
    } finally {
      await sandbox.close();
    }
  }, 60_000);
});
