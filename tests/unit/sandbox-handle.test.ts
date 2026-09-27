import { describe, expect, it, vi } from "vitest";
import { isGone, withSandbox, type SandboxHandle, type SandboxRef } from "../../src/lib/sandbox-handle.js";

function fakeHandle(sandboxId: string): SandboxHandle {
  return {
    sandboxId,
    vncUrl: `https://gw/vnc?sandbox=${sandboxId}`,
    host: "mm001",
    uiTree: async () => ({}),
    displayInfo: async () => ({ width: 1920, height: 1080 }),
    recording: { start: async () => "rec-1", stop: async () => ({ recordingId: "rec-1", fileSize: 0 }) },
    execSsh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    upload: async () => {},
    mouse: { click: async () => {} },
    keyboard: { type: async () => {}, press: async () => {}, hotkey: async () => {} },
    close: async () => {},
  };
}

describe("isGone", () => {
  it("is true for the SDK's 404 and 410 errors", () => {
    expect(isGone(new Error("404 /v1/sandboxes/sb-1/exec: not found"))).toBe(true);
    expect(isGone(new Error("410 /v1/sandboxes/sb-1/screenshot: gone"))).toBe(true);
  });

  it("is false for other errors and non-errors", () => {
    expect(isGone(new Error("500 /v1/sandboxes/sb-1/exec: boom"))).toBe(false);
    expect(isGone(new Error("sandbox 404 mentioned later"))).toBe(false);
    expect(isGone("404")).toBe(false);
  });
});

describe("withSandbox", () => {
  it("runs fn against the current handle and returns its result when nothing goes wrong", async () => {
    const ref: SandboxRef = { current: fakeHandle("sb-1") };
    const result = await withSandbox(ref, async (s) => s.sandboxId);
    expect(result).toBe("sb-1");
    expect(ref.current.sandboxId).toBe("sb-1"); // unchanged
  });

  it("recreates the sandbox and retries once when fn reports the sandbox is gone", async () => {
    const ref: SandboxRef = { current: fakeHandle("sb-1") };
    const create = vi.fn(async () => fakeHandle("sb-2"));
    let calls = 0;
    const fn = vi.fn(async (s: SandboxHandle) => {
      calls++;
      if (calls === 1) throw new Error("404 /v1/sandboxes/sb-1/exec: not found");
      return s.sandboxId;
    });

    const result = await withSandbox(ref, fn, { create });

    expect(result).toBe("sb-2");
    // ref.current is the single source of truth for "which sandbox did this end up using" --
    // there's no separate onRotate callback to assert on; a caller that needs to know just reads
    // ref.current (e.g. via toDescriptor()) after withSandbox resolves.
    expect(ref.current.sandboxId).toBe("sb-2");
    expect(create).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-gone error without recreating", async () => {
    const ref: SandboxRef = { current: fakeHandle("sb-1") };
    const create = vi.fn(async () => fakeHandle("sb-2"));
    await expect(
      withSandbox(ref, async () => {
        throw new Error("500 /v1/sandboxes/sb-1/exec: boom");
      }, { create }),
    ).rejects.toThrow(/^500 /);
    expect(create).not.toHaveBeenCalled();
    expect(ref.current.sandboxId).toBe("sb-1");
  });

  it("propagates the retry's own error if the new sandbox also fails", async () => {
    const ref: SandboxRef = { current: fakeHandle("sb-1") };
    const create = vi.fn(async () => fakeHandle("sb-2"));
    await expect(
      withSandbox(
        ref,
        async () => {
          throw new Error("404 /v1/sandboxes/x/exec: not found");
        },
        { create },
      ),
    ).rejects.toThrow(/^404 /);
    expect(ref.current.sandboxId).toBe("sb-2"); // still swapped in, even though the retry also failed
  });
});
