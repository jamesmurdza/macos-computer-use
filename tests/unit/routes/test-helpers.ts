import { vi } from "vitest";
import type { SandboxHandle } from "../../../src/lib/sandbox-handle.js";

/** A SandboxHandle with no real network behind it, for route-handler unit tests. */
export function fakeHandle(sandboxId = "sb-1"): SandboxHandle {
  return {
    sandboxId,
    host: "mm001",
    vncUrl: `https://gw.example/vnc?sandbox=${sandboxId}`,
    uiTree: vi.fn(async () => ({})),
    displayInfo: vi.fn(async () => ({ width: 1920, height: 1080 })),
    recording: {
      start: vi.fn(async () => "rec-1"),
      stop: vi.fn(async () => ({ recordingId: "rec-1", fileSize: 0 })),
    },
    execSsh: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    upload: vi.fn(async () => {}),
    mouse: { click: vi.fn(async () => {}) },
    keyboard: { type: vi.fn(async () => {}), press: vi.fn(async () => {}), hotkey: vi.fn(async () => {}) },
    close: vi.fn(async () => {}),
  };
}
