import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/storage.js", () => ({
  listRunIds: vi.fn(),
  downloadRunArtifact: vi.fn(),
  uploadRunArtifact: vi.fn(async () => {}),
}));

const { listRunIds, downloadRunArtifact, uploadRunArtifact } = await import("../../src/lib/storage.js");
const { rebuildGalleryIndex, addRunToGalleryIndex } = await import("../../src/lib/gallery.js");

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const OLD_OK_META = {
  runId: "run-old-ok",
  prompt: "open safari and go to example.com",
  modelChoice: "haiku",
  videoStartedAt: 1000,
  videoEndedAt: 5000,
  videoFile: "video.mp4",
  status: "ok" as const,
};
const NEW_OK_META = {
  runId: "run-new-ok",
  prompt: "open TextEdit and type Hello World",
  modelChoice: "openrouter:qwen/qwen3.7-flash",
  videoStartedAt: 2_000_000,
  videoEndedAt: 2_010_000,
  videoFile: "video.mp4",
  status: "ok" as const,
  inputTokens: 12_000,
  outputTokens: 800,
  costUsd: 0.00046,
};

describe("rebuildGalleryIndex (repair/backfill: scans R2 meta.json files, overwrites index.json)", () => {
  beforeEach(() => {
    vi.mocked(listRunIds).mockReset();
    vi.mocked(downloadRunArtifact).mockReset();
    vi.mocked(uploadRunArtifact).mockClear();
  });

  it("includes any run with a video regardless of status, newest first, and writes index.json", async () => {
    // "run-failed" has no videoFile at all (a run that died before ever starting the recording) --
    // that's what excludes it here, not its status:"error". A run that errored/was killed *after*
    // getting a real video is included -- see the dedicated test below for that case.
    vi.mocked(listRunIds).mockResolvedValue(["run-old-ok", "run-failed", "run-new-ok", "run-corrupt"]);
    vi.mocked(downloadRunArtifact).mockImplementation(async (key: string) => {
      if (key === "runs/run-old-ok/meta.json") return jsonBytes(OLD_OK_META);
      if (key === "runs/run-failed/meta.json") return jsonBytes({ runId: "run-failed", prompt: "do something", modelChoice: "haiku", status: "error" });
      if (key === "runs/run-new-ok/meta.json") return jsonBytes(NEW_OK_META);
      if (key === "runs/run-corrupt/meta.json") return new TextEncoder().encode("{not json");
      return undefined;
    });

    const entries = await rebuildGalleryIndex();

    expect(entries.map((e) => e.runId)).toEqual(["run-new-ok", "run-old-ok"]);
    expect(entries[0]).toMatchObject({
      description: "open TextEdit and type Hello World",
      durationMs: 10_000,
      videoKey: "runs/run-new-ok/video.mp4",
      thumbnailKey: "runs/run-new-ok/thumbnail.jpg",
      model: "openrouter:qwen/qwen3.7-flash",
      inputTokens: 12_000,
      outputTokens: 800,
      costUsd: 0.00046,
      status: "ok",
    });
    expect(entries[1]).toMatchObject({ model: "haiku", inputTokens: undefined, outputTokens: undefined, costUsd: undefined, status: "ok" });
    expect(uploadRunArtifact).toHaveBeenCalledWith("index.json", expect.any(Uint8Array), "application/json");
  });

  it("includes a run that errored or was killed mid-task, as long as it has a real video", async () => {
    // The actual behavior this file guards: a run isn't withheld from the gallery just because it
    // didn't finish cleanly -- an incomplete run is still real output worth being able to watch
    // (same principle as CLAUDE.md's "never delete a user-requested run without being asked").
    const killedMidTask = {
      runId: "run-killed",
      prompt: "fill out the W-9 form",
      modelChoice: "openrouter:qwen/qwen3.7-flash",
      videoStartedAt: 3_000_000,
      videoEndedAt: 3_090_000,
      videoFile: "video.mp4",
      status: "error" as const,
      error: "Terminated by SIGTERM after 12 step(s) (recording preserved below).",
    };
    vi.mocked(listRunIds).mockResolvedValue(["run-killed"]);
    vi.mocked(downloadRunArtifact).mockImplementation(async (key: string) =>
      key === "runs/run-killed/meta.json" ? jsonBytes(killedMidTask) : undefined,
    );

    const entries = await rebuildGalleryIndex();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: "run-killed", status: "error", durationMs: 90_000 });
  });

  it("skips a run whose meta.json is missing entirely", async () => {
    vi.mocked(listRunIds).mockResolvedValue(["run-gone"]);
    vi.mocked(downloadRunArtifact).mockResolvedValue(undefined);

    const entries = await rebuildGalleryIndex();
    expect(entries).toEqual([]);
  });
});

describe("addRunToGalleryIndex (normal per-run path: one read + one write against index.json)", () => {
  beforeEach(() => {
    vi.mocked(downloadRunArtifact).mockReset();
    vi.mocked(uploadRunArtifact).mockClear();
  });

  it("appends to an empty/missing index", async () => {
    vi.mocked(downloadRunArtifact).mockResolvedValue(undefined);

    const entries = await addRunToGalleryIndex("run-new-ok", NEW_OK_META);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: "run-new-ok", videoKey: "runs/run-new-ok/video.mp4" });
    expect(uploadRunArtifact).toHaveBeenCalledWith("index.json", expect.any(Uint8Array), "application/json");
  });

  it("prepends a new run ahead of an existing older one (newest first)", async () => {
    const existing = [
      {
        runId: "run-old-ok",
        description: "open safari and go to example.com",
        date: new Date(1000).toISOString(),
        durationMs: 4000,
        videoKey: "runs/run-old-ok/video.mp4",
        thumbnailKey: "runs/run-old-ok/thumbnail.jpg",
      },
    ];
    vi.mocked(downloadRunArtifact).mockResolvedValue(jsonBytes(existing));

    const entries = await addRunToGalleryIndex("run-new-ok", NEW_OK_META);

    expect(entries.map((e) => e.runId)).toEqual(["run-new-ok", "run-old-ok"]);
  });

  it("replaces an existing entry for the same runId instead of duplicating it", async () => {
    const existing = [
      {
        runId: "run-new-ok",
        description: "stale description",
        date: new Date(1).toISOString(),
        durationMs: 1,
        videoKey: "runs/run-new-ok/old-video.mp4",
        thumbnailKey: "runs/run-new-ok/thumbnail.jpg",
      },
    ];
    vi.mocked(downloadRunArtifact).mockResolvedValue(jsonBytes(existing));

    const entries = await addRunToGalleryIndex("run-new-ok", NEW_OK_META);

    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe("open TextEdit and type Hello World");
  });

  it("does not add a run with no video (regardless of status), and leaves the index untouched", async () => {
    vi.mocked(downloadRunArtifact).mockResolvedValue(undefined);

    const entries = await addRunToGalleryIndex("run-failed", { runId: "run-failed", prompt: "do something", modelChoice: "haiku", status: "error" });

    expect(entries).toEqual([]);
    expect(uploadRunArtifact).not.toHaveBeenCalled();
  });

  it("treats a corrupt existing index as empty rather than throwing", async () => {
    vi.mocked(downloadRunArtifact).mockResolvedValue(new TextEncoder().encode("{not json"));

    const entries = await addRunToGalleryIndex("run-new-ok", NEW_OK_META);
    expect(entries).toHaveLength(1);
  });
});
